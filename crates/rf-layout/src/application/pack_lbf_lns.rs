// engine/crates/rf-layout/src/application/pack_lbf_lns.rs
//
// Phase 2 — density-changing LNS on top of LBF.
//
// LBF gets us to 32/37 on the production fixture by doing pure constructive
// placement (one-shot, no backtracking). The last 1-5 items remain
// unplaced because LBF's greedy sampler has no mechanism to RELOCATE
// already-placed items to make room.
//
// Upstream sparrow's outer loop (src/optimizer/explore.rs upstream) calls
// `Separator::change_strip_width` to FORCE overlaps when a feasible
// solution is reached, then re-runs the separator to resolve. For BPP
// the analogue is: force an unplaced item into the feasible layout
// (creating controlled overlap) and let the separator rearrange to
// absorb it.
//
// pack_lbf_lns = pack_lbf → for each bin, try to grow the bin one item
// at a time, running the GLS separator on each attempted growth. Accept
// feasible growths, revert infeasible ones. Stop when no more items fit
// or the budget runs out.
//
// See `.claude/research/sparrow-integration/lbf-finding.md` for the
// two-phase plan that this file implements.

use crate::application::{
    pack_lbf_with_config, polish_placements, polish_score, try_cross_bin_moveout, PackLbfConfig,
    PolishConfig,
};
use crate::domain::{Bin, BinResult, PackError, PackRequest, PackResult, Placement};
use crate::infrastructure::jagua_adapter::to_jagua_instance;
use crate::infrastructure::search::cancel;
use crate::infrastructure::search::gls::explore::{
    exploration_phase, ExplorationConfig, ExplorationOutcome,
};
use crate::infrastructure::search::gls::separator::{NoopListener, Separator, SeparatorConfig};
use crate::infrastructure::search::rng;
use crate::infrastructure::search::terminator::BasicTerminator;
use jagua_rs::entities::{Instance, Layout, LayoutSnapshot, PlacedItem};
use jagua_rs::geometry::DTransformation;
use jagua_rs::io::export::int_to_ext_transformation;
use jagua_rs::probs::bpp::entities::BPInstance;
use rand::SeedableRng;
use rand_distr::Uniform;
use rand_xoshiro::Xoshiro256PlusPlus;
use rf_geom::domain::Point2D;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Configuration for `pack_lbf_lns`.
#[derive(Clone, Debug)]
pub struct PackLbfLnsConfig {
    /// Underlying LBF config for the initial constructive phase.
    pub lbf: PackLbfConfig,
    /// Per-grow-attempt GLS time budget. Default 200 ms.
    pub per_grow_budget_ms: u64,
    /// How many distinct overlap-seeds to try per unplaced item before
    /// giving up on that item. Each retry uses a different RNG seed.
    pub attempts_per_item: usize,
    /// Maximum number of successful grow operations. Safety valve.
    pub max_growth_ops: usize,
}

impl Default for PackLbfLnsConfig {
    fn default() -> Self {
        Self {
            lbf: PackLbfConfig::default(),
            per_grow_budget_ms: 200,
            attempts_per_item: 3,
            max_growth_ops: 10,
        }
    }
}

/// `pack_lbf` followed by density-changing LNS.
///
/// For multi-bin requests, processes bins SEQUENTIALLY: runs LBF + LNS
/// on bin #1 with the full item set (concentrating placement), routes
/// overflow to bin #2, and so on. This mirrors legacy's concentration
/// behavior — previously-uniform distribution (pack_lbf's natural
/// multi-bin output) gave away Fab Score by leaving more scrap on the
/// earlier bins. Single-bin requests go straight through.
pub fn pack_lbf_lns(request: PackRequest) -> Result<PackResult, PackError> {
    pack_lbf_lns_with_config(request, PackLbfLnsConfig::default())
}

pub fn pack_lbf_lns_with_config(
    request: PackRequest,
    cfg: PackLbfLnsConfig,
) -> Result<PackResult, PackError> {
    if request.bins.len() <= 1 {
        return pack_lbf_lns_single_bin(request, cfg);
    }

    // Sequential multi-bin: for each bin in request order, run
    // single-bin LBF+LNS on the remaining items, collect results,
    // decrement per-shape quantities by what was placed.
    let started_at = Instant::now();
    let mut remaining_items = request.items.clone();

    let mut all_placements: Vec<Placement> = Vec::new();
    let mut per_bin: Vec<BinResult> = Vec::new();
    let mut index_counters: HashMap<String, u32> = HashMap::new();

    for bin in &request.bins {
        // Build a single-bin subrequest with current remaining_items.
        // Filter to items with positive remaining quantity.
        let sub_items: Vec<_> = remaining_items
            .iter()
            .filter(|p| p.quantity > 0)
            .cloned()
            .collect();

        if sub_items.is_empty() {
            // No items left — emit an empty BinResult for this bin so
            // per_bin.len() stays aligned with request.bins.
            per_bin.push(BinResult {
                bin_id: bin.bin_id.clone(),
                used_area: 0.0,
                waste_area: bin.width * bin.height,
                occupied_width: bin.width,
                occupied_height: bin.height,
                efficiency: 0.0,
                scrap_ratio: 1.0,
            });
            continue;
        }

        let sub_request = PackRequest {
            bins: vec![bin.clone()],
            clearance: request.clearance,
            items: sub_items,
            operator_profile: request.operator_profile.clone(),
            mode: request.mode,
            engine: request.engine,
            time_budget_ms: request.time_budget_ms,
            improvement_budget_ms: request.improvement_budget_ms,
            seed: request.seed,
            units: request.units,
        };

        let sub_result = pack_lbf_lns_single_bin(sub_request, cfg.clone())?;

        // Extract this bin's per_bin row (must exist — single-bin result
        // always has exactly one BinResult).
        let sub_bin_result = sub_result
            .per_bin
            .into_iter()
            .next()
            .ok_or_else(|| PackError::EngineFailed("empty per_bin in sub-result".into()))?;
        per_bin.push(sub_bin_result);

        // Gather placements, renumber instance_index globally.
        let mut placed_counts: HashMap<String, u32> = HashMap::new();
        for mut p in sub_result.placements {
            *placed_counts.entry(p.shape_id.clone()).or_insert(0) += 1;
            let c = index_counters.entry(p.shape_id.clone()).or_insert(0);
            p.instance_index = *c;
            *c += 1;
            all_placements.push(p);
        }

        // Decrement remaining_items by what this bin placed.
        for part in &mut remaining_items {
            if let Some(&placed) = placed_counts.get(&part.shape_id) {
                part.quantity = part.quantity.saturating_sub(placed);
            }
        }
    }

    let placed_count = all_placements.len() as u32;
    let total_requested: u32 = request.items.iter().map(|p| p.quantity).sum();
    let total_overflow = total_requested.saturating_sub(placed_count);
    let total_used_area: f64 = per_bin.iter().map(|b| b.used_area).sum();
    let total_waste_area: f64 = per_bin.iter().map(|b| b.waste_area).sum();
    let overall_density = if total_used_area + total_waste_area > 0.0 {
        total_used_area / (total_used_area + total_waste_area)
    } else {
        0.0
    };

    let mut result = PackResult {
        placements: all_placements,
        placed_count,
        overflow_count: total_overflow,
        per_bin,
        total_used_area,
        total_waste_area,
        overall_density,
        run_time_ms: None, // finalized below
        was_cancelled: false,
    };

    // Phase 3 follow-up — cross-bin move-out. Tries to reduce Σ(occ×w)
    // across bins by moving a protruding item from one bin to another.
    // Only accepts moves that strictly improve total occupied area.
    // Gated by `REMA_DISABLE_CROSSBIN=true` for benches / debugging;
    // on by default since moves that don't improve are rejected
    // internally (never regresses).
    if std::env::var("REMA_DISABLE_CROSSBIN").as_deref() != Ok("true") {
        result = try_cross_bin_moveout(result, &request.bins, request.clearance, 3);
    }

    result.run_time_ms = Some(started_at.elapsed().as_millis() as u64);
    Ok(result)
}

/// Single-bin core for `pack_lbf_lns`. Processes one bin. The multi-bin
/// entry point calls this in a per-bin loop with item quantities
/// decremented by what earlier bins placed.
fn pack_lbf_lns_single_bin(
    request: PackRequest,
    cfg: PackLbfLnsConfig,
) -> Result<PackResult, PackError> {
    if request.bins.is_empty() {
        return Err(PackError::NoBins);
    }
    if request.items.is_empty() {
        return Err(PackError::NoItems);
    }

    let started_at = Instant::now();

    // Phase 1: LBF constructive.
    let lbf_result = pack_lbf_with_config(request.clone(), cfg.lbf.clone())?;

    if lbf_result.overflow_count == 0 {
        // Nothing left to grow, but we still want to polish the layout
        // so roll-2-style "fits with gaps" outputs get compacted.
        let mut r = lbf_result;
        if polish_enabled() {
            r = polish_pack_result(r, &request.bins, request.clearance);
        }
        r.run_time_ms = Some(started_at.elapsed().as_millis() as u64);
        return Ok(r);
    }

    // Phase 2: grow each bin one item at a time.
    //
    // The strategy: for each BIN in LBF's output, identify the items
    // that are missing (part of overflow) and attempt to force them
    // into the bin with the GLS separator resolving collisions.
    //
    // Bins are processed in their request order — typically the first
    // bin has the most free space because LBF greedily opens layouts
    // in order.

    // Global counter of placements so far per shape — used to decide
    // which copies remain to be placed. Matches PackResult semantics
    // (quantity = total demand, placements per shape ≤ quantity).
    let mut placed_by_shape: HashMap<String, u32> = HashMap::new();
    for p in &lbf_result.placements {
        *placed_by_shape.entry(p.shape_id.clone()).or_insert(0) += 1;
    }

    let remaining_copies: Vec<(usize, u32)> = request
        .items
        .iter()
        .enumerate()
        .filter_map(|(item_id, part)| {
            let placed = placed_by_shape
                .get(part.shape_id.as_str())
                .copied()
                .unwrap_or(0);
            let remaining = part.quantity.saturating_sub(placed);
            if remaining > 0 {
                Some((item_id, remaining))
            } else {
                None
            }
        })
        .collect();

    if remaining_copies.is_empty() {
        let mut r = lbf_result;
        r.run_time_ms = Some(started_at.elapsed().as_millis() as u64);
        return Ok(r);
    }

    // For simplicity, Phase 2 tries to grow only the FIRST non-empty bin.
    // Multi-bin growth can be added later; the 37-part production fixture
    // already has all items on a single-bin target.
    let target_bin_idx = request
        .bins
        .iter()
        .enumerate()
        .find(|(idx, _)| {
            lbf_result
                .per_bin
                .get(*idx)
                .is_some_and(|br| br.used_area > 0.0)
        })
        .map(|(idx, _)| idx);

    // No bin has placements → fall back to LBF result.
    let Some(target_bin_idx) = target_bin_idx else {
        let mut r = lbf_result;
        r.run_time_ms = Some(started_at.elapsed().as_millis() as u64);
        return Ok(r);
    };

    let target_bin = &request.bins[target_bin_idx];

    // Build a single-bin BPInstance for the grow-separate loop — the
    // separator operates on one layout at a time.
    let single_bin_instance = to_jagua_instance(
        std::slice::from_ref(target_bin),
        &request.items,
        request.clearance,
    )?;

    // Reconstruct the target bin's current LayoutSnapshot from LBF's
    // placements. Separator needs a fresh Layout seeded from existing
    // external-space placements.
    let mut current_snapshot: LayoutSnapshot = {
        let container = single_bin_instance.container(0).clone();
        let mut layout = Layout::new(container);
        for p in &lbf_result.placements {
            if p.bin_id != target_bin.bin_id {
                continue;
            }
            // Look up jagua item_id by shape_id (Codex R3 discipline:
            // the request.items vector is the canonical ordering).
            let item_id = request
                .items
                .iter()
                .position(|part| part.shape_id == p.shape_id)
                .ok_or_else(|| {
                    PackError::EngineFailed(format!(
                        "LBF placement references unknown shape_id '{}'",
                        p.shape_id
                    ))
                })?;
            let item = single_bin_instance.item(item_id);
            let ext_dt = DTransformation::new(p.rotation_rad as f32, (p.x as f32, p.y as f32));
            // ext_to_int conversion happens in replay pipeline; we are
            // placing in EXTERNAL-coord frame by composing jagua's
            // pre_transform inverse manually.
            let int_dt = jagua_rs::io::import::ext_to_int_transformation(
                &ext_dt,
                &item.shape_orig.pre_transform,
            );
            layout.place_item(item, int_dt);
        }
        layout.save()
    };

    let mut growth_ops = 0usize;
    let mut attempts_made = 0usize;

    // For each unplaced copy of each shape (area-desc order — try
    // hardest to place items first so the separator has the most
    // meaningful rearrangement work to do).
    let mut order: Vec<usize> = remaining_copies.iter().map(|(id, _)| *id).collect();
    order.sort_by(|a, b| {
        let area = |id: &usize| -> f32 {
            let item = single_bin_instance.item(*id);
            item.shape_cd.bbox.width() * item.shape_cd.bbox.height()
        };
        area(b)
            .partial_cmp(&area(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut remaining_qty: HashMap<usize, u32> = remaining_copies.iter().copied().collect();

    'outer: for item_id in order {
        while *remaining_qty.get(&item_id).unwrap_or(&0) > 0 && growth_ops < cfg.max_growth_ops {
            // Try up to `attempts_per_item` randomly-seeded placements
            // of this item. First valid resolution wins.
            let mut grew = false;
            for attempt in 0..cfg.attempts_per_item {
                attempts_made += 1;
                let seed = request
                    .seed
                    .unwrap_or(42)
                    .wrapping_add(growth_ops as u64 * 1024)
                    .wrapping_add(attempt as u64);

                if let Some(new_snapshot) = attempt_grow(
                    &single_bin_instance,
                    &current_snapshot,
                    item_id,
                    seed,
                    cfg.per_grow_budget_ms,
                ) {
                    current_snapshot = new_snapshot;
                    growth_ops += 1;
                    *remaining_qty.get_mut(&item_id).unwrap() -= 1;
                    grew = true;
                    break;
                }
            }
            if !grew {
                // Could not grow this item after attempts_per_item tries.
                // Skip to the next item.
                break;
            }

            // If we've hit the wall-clock budget from the original
            // request, stop growing.
            if let Some(budget_ms) = request.time_budget_ms {
                if started_at.elapsed() >= Duration::from_millis(budget_ms) {
                    break 'outer;
                }
            }
        }
    }

    // Rebuild PackResult from the (possibly grown) target-bin snapshot +
    // the original LBF placements for the other bins.
    let mut final_result = rebuild_pack_result(
        &request,
        &lbf_result,
        target_bin_idx,
        &current_snapshot,
        &single_bin_instance,
        started_at,
        GrowthStats {
            growth_ops,
            attempts_made,
        },
    )?;

    // Phase 3 — score-aware polish. Slides each bin's placements toward
    // (0, 0) so waste aggregates into one corner reusable rectangle.
    // On by default; set `REMA_DISABLE_POLISH=true` to skip. See
    // application/polish.rs and
    // `.claude/research/sparrow-integration/lbf-finding.md` Phase 3.
    if polish_enabled() {
        final_result = polish_pack_result(final_result, &request.bins, request.clearance);
    }

    Ok(final_result)
}

/// Polish is on by default. Explicitly disable via
/// `REMA_DISABLE_POLISH=true` for benches or when debugging the
/// pre-polish layout.
fn polish_enabled() -> bool {
    std::env::var("REMA_DISABLE_POLISH").as_deref() != Ok("true")
}

/// Apply the Fab-reusable polish to each bin of a PackResult. Per bin:
///   1. Slice out placements belonging to that bin.
///   2. Compute pre-polish score.
///   3. Run polish_placements toward (0, 0).
///   4. Compute post-polish score; keep only if it's strictly better.
///   5. Recompute this bin's BinResult stats from the polished placements.
///   6. Update top-level totals + overall_density.
fn polish_pack_result(mut result: PackResult, bins: &[Bin], clearance: f64) -> PackResult {
    let cfg = PolishConfig {
        clearance,
        ..PolishConfig::default()
    };

    // Group placements by bin_id.
    let mut per_bin_placements: std::collections::HashMap<String, Vec<Placement>> =
        std::collections::HashMap::new();
    for p in result.placements.drain(..) {
        per_bin_placements
            .entry(p.bin_id.clone())
            .or_default()
            .push(p);
    }

    // Polish each bin independently; keep the polished version only if it
    // improves the score (defensive: never accept a regression even on
    // the score proxy).
    let mut polished_all: Vec<Placement> = Vec::new();
    let mut new_per_bin: Vec<BinResult> = Vec::with_capacity(bins.len());

    for bin in bins {
        let bin_placements = per_bin_placements.remove(&bin.bin_id).unwrap_or_default();
        if bin_placements.is_empty() {
            new_per_bin.push(BinResult {
                bin_id: bin.bin_id.clone(),
                used_area: 0.0,
                waste_area: bin.width * bin.height,
                occupied_width: bin.width,
                occupied_height: bin.height,
                efficiency: 0.0,
                scrap_ratio: 1.0,
            });
            continue;
        }

        let pre_score = polish_score(&bin_placements, bin.width, bin.height);
        let polished = polish_placements(&bin_placements, bin.width, bin.height, &cfg);
        let post_score = polish_score(&polished, bin.width, bin.height);

        let selected = if post_score.is_better_than(&pre_score) {
            polished
        } else {
            bin_placements
        };

        // Recompute per-bin stats from `selected`.
        let used_area: f64 = selected.iter().map(|p| polygon_area(&p.polygon)).sum();
        let occupied_width = selected
            .iter()
            .flat_map(|p| p.polygon.iter())
            .map(|v| v.x)
            .fold(0.0_f64, f64::max);
        let occupied_height = selected
            .iter()
            .flat_map(|p| p.polygon.iter())
            .map(|v| v.y)
            .fold(0.0_f64, f64::max);
        let stock_area = bin.width * bin.height;
        let waste_area = (stock_area - used_area).max(0.0);
        let efficiency = if stock_area > 0.0 {
            used_area / stock_area
        } else {
            0.0
        };

        new_per_bin.push(BinResult {
            bin_id: bin.bin_id.clone(),
            used_area,
            waste_area,
            occupied_width: if occupied_width > 0.0 {
                occupied_width
            } else {
                bin.width
            },
            occupied_height: if occupied_height > 0.0 {
                occupied_height
            } else {
                bin.height
            },
            efficiency,
            scrap_ratio: 1.0 - efficiency,
        });

        polished_all.extend(selected);
    }

    // Recompute top-level totals.
    let total_used_area: f64 = new_per_bin.iter().map(|b| b.used_area).sum();
    let total_waste_area: f64 = new_per_bin.iter().map(|b| b.waste_area).sum();
    let overall_density = if total_used_area + total_waste_area > 0.0 {
        total_used_area / (total_used_area + total_waste_area)
    } else {
        0.0
    };

    result.placements = polished_all;
    result.per_bin = new_per_bin;
    result.total_used_area = total_used_area;
    result.total_waste_area = total_waste_area;
    result.overall_density = overall_density;
    result
}

/// Attempt one grow operation: find a position for `item_id` in the
/// existing `base_snapshot`, run the GLS separator to resolve any
/// collisions the new placement creates, and return the new snapshot
/// if feasibility was reached. Returns `None` if the separator could
/// not resolve within `budget_ms`.
fn attempt_grow(
    instance: &BPInstance,
    base_snapshot: &LayoutSnapshot,
    item_id: usize,
    seed: u64,
    budget_ms: u64,
) -> Option<LayoutSnapshot> {
    // Build a fresh layout from base_snapshot, then add the new item
    // at a sampled position (possibly overlapping).
    let container = instance.container(0).clone();
    let mut layout = Layout::new(container);
    // Replay all placed_items from base_snapshot using their existing
    // internal-space transforms. These are already internal coords
    // because LayoutSnapshot stores them that way post-restore.
    for pi in base_snapshot.placed_items.values() {
        let item = instance.item(pi.item_id);
        layout.place_item(item, pi.d_transf);
    }

    // Sample a random placement for the new item within the bin's
    // bbox. We use a quick random sample — LBF-style local search
    // would be more precise but the separator's disrupt mechanism
    // is what ultimately makes this work, so the starting position
    // matters less than one might think.
    let item = instance.item(item_id);
    let bbox = layout.container.outer_cd.bbox;
    let mut rng = Xoshiro256PlusPlus::seed_from_u64(seed);

    // Account for the item's size so the initial position is at least
    // in-bounds. Sample in the shrunk rect.
    let item_w = item.shape_cd.bbox.width();
    let item_h = item.shape_cd.bbox.height();
    let x_range = (bbox.x_min, (bbox.x_max - item_w).max(bbox.x_min));
    let y_range = (bbox.y_min, (bbox.y_max - item_h).max(bbox.y_min));

    let ux = Uniform::new_inclusive(x_range.0, x_range.1).ok()?;
    let uy = Uniform::new_inclusive(y_range.0, y_range.1).ok()?;
    let tx: f32 = rand_distr::Distribution::sample(&ux, &mut rng);
    let ty: f32 = rand_distr::Distribution::sample(&uy, &mut rng);

    // Rotation: pick the first allowed orientation if discrete, else 0.
    // Continuous rotation will be explored by the separator's sampling.
    let rot = match &item.allowed_rotation {
        jagua_rs::geometry::geo_enums::RotationRange::None => 0.0,
        jagua_rs::geometry::geo_enums::RotationRange::Continuous => 0.0,
        jagua_rs::geometry::geo_enums::RotationRange::Discrete(angles) => {
            *angles.first().unwrap_or(&0.0)
        }
    };

    let ext_dt = DTransformation::new(rot, (tx, ty));
    let int_dt =
        jagua_rs::io::import::ext_to_int_transformation(&ext_dt, &item.shape_orig.pre_transform);
    layout.place_item(item, int_dt);

    // Run GLS: Separator + exploration_phase, small budget.
    let rng_sep = rng::from_seed(Some(seed));
    let mut sep = Separator::new(
        instance.clone(),
        layout,
        rng_sep,
        SeparatorConfig::exploration(),
    );

    let deadline = BasicTerminator::with_timeout(Duration::from_millis(budget_ms));
    let term = cancel::CompositeTerminator::new(deadline, None);
    let mut listener = NoopListener;
    let outcome = exploration_phase(
        &mut sep,
        &term,
        &mut listener,
        &ExplorationConfig::paper_defaults(),
    );

    match outcome {
        ExplorationOutcome::Feasible(snap) => Some(snap),
        ExplorationOutcome::Infeasible { .. } => None,
    }
}

#[derive(Clone, Copy, Debug)]
struct GrowthStats {
    growth_ops: usize,
    attempts_made: usize,
}

fn rebuild_pack_result(
    request: &PackRequest,
    lbf_result: &PackResult,
    target_bin_idx: usize,
    new_snapshot: &LayoutSnapshot,
    instance: &BPInstance,
    started_at: Instant,
    growth_stats: GrowthStats,
) -> Result<PackResult, PackError> {
    let target_bin = &request.bins[target_bin_idx];

    // Pull out the grown target-bin placements from the new snapshot.
    let mut grown_placements: Vec<Placement> = Vec::new();
    let mut entries: Vec<&PlacedItem> = new_snapshot.placed_items.values().collect();
    entries.sort_by_key(|pi| {
        (
            pi.item_id,
            pi.d_transf.translation.0.into_inner().to_bits(),
            pi.d_transf.translation.1.into_inner().to_bits(),
            pi.d_transf.rotation.into_inner().to_bits(),
        )
    });

    for pi in entries {
        let item = instance.item(pi.item_id);
        let pre_transf = &item.shape_orig.pre_transform;
        let abs_transf = int_to_ext_transformation(&pi.d_transf, pre_transf);

        let part = &request.items[pi.item_id];
        let polygon: Vec<Point2D> = part
            .polygon
            .iter()
            .map(|p| apply_dtransformation_to_point(&abs_transf, *p))
            .collect();

        let (min_x, min_y, max_x, max_y) = polygon.iter().fold(
            (
                f64::INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
            ),
            |(mnx, mny, mxx, mxy), p| (mnx.min(p.x), mny.min(p.y), mxx.max(p.x), mxy.max(p.y)),
        );

        grown_placements.push(Placement {
            shape_id: part.shape_id.clone(),
            instance_index: 0, // global renumbering below
            bin_id: target_bin.bin_id.clone(),
            x: abs_transf.translation.0.into_inner() as f64,
            y: abs_transf.translation.1.into_inner() as f64,
            rotation_rad: abs_transf.rotation.into_inner() as f64,
            polygon,
            width: (max_x - min_x).max(0.0),
            height: (max_y - min_y).max(0.0),
            difficulty: None,
        });
    }

    // Merge: grown target-bin placements + other-bin placements from LBF.
    let mut all_placements: Vec<Placement> = lbf_result
        .placements
        .iter()
        .filter(|p| p.bin_id != target_bin.bin_id)
        .cloned()
        .collect();
    all_placements.extend(grown_placements);

    // Global instance_index renumbering per shape.
    let mut index_counters: HashMap<String, u32> = HashMap::new();
    for p in all_placements.iter_mut() {
        let c = index_counters.entry(p.shape_id.clone()).or_insert(0);
        p.instance_index = *c;
        *c += 1;
    }

    // Per-bin stats.
    let mut per_bin: Vec<BinResult> = Vec::with_capacity(request.bins.len());
    for bin in &request.bins {
        let mut used_area = 0.0f64;
        let mut occupied_width = 0.0f64;
        let mut occupied_height = 0.0f64;
        for p in all_placements.iter().filter(|p| p.bin_id == bin.bin_id) {
            used_area += polygon_area(&p.polygon);
            for v in &p.polygon {
                if v.x > occupied_width {
                    occupied_width = v.x;
                }
                if v.y > occupied_height {
                    occupied_height = v.y;
                }
            }
        }
        let stock_area = bin.width * bin.height;
        let waste_area = (stock_area - used_area).max(0.0);
        let efficiency = if stock_area > 0.0 {
            used_area / stock_area
        } else {
            0.0
        };
        per_bin.push(BinResult {
            bin_id: bin.bin_id.clone(),
            used_area,
            waste_area,
            occupied_width: if occupied_width > 0.0 {
                occupied_width
            } else {
                bin.width
            },
            occupied_height: if occupied_height > 0.0 {
                occupied_height
            } else {
                bin.height
            },
            efficiency,
            scrap_ratio: 1.0 - efficiency,
        });
    }

    // Overall figures.
    let mut placed_by_shape: HashMap<&str, u32> = HashMap::new();
    for p in &all_placements {
        *placed_by_shape.entry(p.shape_id.as_str()).or_insert(0) += 1;
    }
    let total_overflow: u32 = request
        .items
        .iter()
        .map(|r| {
            let placed = placed_by_shape
                .get(r.shape_id.as_str())
                .copied()
                .unwrap_or(0);
            r.quantity.saturating_sub(placed)
        })
        .sum();

    let total_used_area: f64 = per_bin.iter().map(|b| b.used_area).sum();
    let total_waste_area: f64 = per_bin.iter().map(|b| b.waste_area).sum();
    let overall_density = if total_used_area + total_waste_area > 0.0 {
        total_used_area / (total_used_area + total_waste_area)
    } else {
        0.0
    };
    let run_time_ms = started_at.elapsed().as_millis() as u64;
    let placed_count = all_placements.len() as u32;

    log::debug!(
        "[LNS] growth_ops={} attempts_made={} placed_count={} overflow={}",
        growth_stats.growth_ops,
        growth_stats.attempts_made,
        placed_count,
        total_overflow
    );

    Ok(PackResult {
        placements: all_placements,
        placed_count,
        overflow_count: total_overflow,
        per_bin,
        total_used_area,
        total_waste_area,
        overall_density,
        run_time_ms: Some(run_time_ms),
        was_cancelled: false,
    })
}

fn apply_dtransformation_to_point(dt: &DTransformation, p: Point2D) -> Point2D {
    let theta = dt.rotation.into_inner();
    let cos = theta.cos();
    let sin = theta.sin();
    let (px, py) = (p.x as f32, p.y as f32);
    let rx = px * cos - py * sin + dt.translation.0.into_inner();
    let ry = px * sin + py * cos + dt.translation.1.into_inner();
    Point2D::new(rx as f64, ry as f64)
}

fn polygon_area(poly: &[Point2D]) -> f64 {
    let mut s = 0.0;
    for i in 0..poly.len() {
        let a = poly[i];
        let b = poly[(i + 1) % poly.len()];
        s += a.x * b.y - b.x * a.y;
    }
    s.abs() / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Bin, BinKind, PackMode, Part};

    fn rect_part(id: &str, qty: u32, w: f64, h: f64) -> Part {
        Part {
            shape_id: id.into(),
            quantity: qty,
            polygon: vec![
                Point2D::new(0.0, 0.0),
                Point2D::new(w, 0.0),
                Point2D::new(w, h),
                Point2D::new(0.0, h),
            ],
            shape_spec: None,
            allow_rotation: true,
            grain_axis: None,
            difficulty: None,
        }
    }

    fn bin(id: &str, w: f64, h: f64) -> Bin {
        Bin {
            bin_id: id.into(),
            width: w,
            height: h,
            kind: BinKind::Fresh,
            priority: None,
        }
    }

    fn simple_request(bins: Vec<Bin>, items: Vec<Part>) -> PackRequest {
        PackRequest {
            bins,
            clearance: 0.0,
            items,
            operator_profile: None,
            mode: Some(PackMode::Fast),
            engine: None,
            time_budget_ms: None,
            improvement_budget_ms: None,
            seed: Some(42),
            units: Default::default(),
        }
    }

    #[test]
    fn rejects_empty_bins() {
        let req = simple_request(vec![], vec![rect_part("a", 1, 10.0, 5.0)]);
        assert!(matches!(pack_lbf_lns(req), Err(PackError::NoBins)));
    }

    #[test]
    fn rejects_empty_items() {
        let req = simple_request(vec![bin("b1", 48.0, 96.0)], vec![]);
        assert!(matches!(pack_lbf_lns(req), Err(PackError::NoItems)));
    }

    #[test]
    fn matches_lbf_when_everything_fits() {
        // LBF already fits all 3 → no growth work to do. LNS must not
        // regress.
        let req = simple_request(
            vec![bin("b1", 48.0, 96.0)],
            vec![rect_part("rect-a", 3, 10.0, 5.0)],
        );
        let r = pack_lbf_lns(req).unwrap();
        assert_eq!(r.placed_count, 3);
        assert_eq!(r.overflow_count, 0);
    }
}
