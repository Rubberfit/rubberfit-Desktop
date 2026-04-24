// engine/crates/rf-layout/src/infrastructure/search/mod.rs
//
// Single-bin search orchestrator. Wires Task 6's `exploration_phase`
// and Task 7's identity `compression_phase` into the pipeline
// `pack.rs` calls per bin.
//
// Deviations from the sparrow upstream (documented across the ported
// GLS modules; summarized here for the wiring seam):
//   1. BPP scope: single-bin orchestrator. Multi-bin coordination
//      lives above in `application::pack.rs` today; Task 12 will swap
//      that outer loop for a cross-bin-swap coordinator.
//   2. Budget: 100% exploration, 0% compression. Compression is
//      identity in BPP (Task 7); sparrow's 80/20 split has no
//      fixed-bin analogue.
//   3. `OptimizerConfig` carries `bin: Bin`, `items: Vec<Part>`,
//      `clearance: f64` so this layer can rebuild `BPInstance`
//      without breaking the `optimize(seed, cfg)` signature locked
//      in Task 1.
//   4. `improvement_budget_ms` reserved for Task 14 — not wired yet.
//      Listener is `NoopListener`; Terminator is timeout-only
//      (`BasicTerminator::with_timeout`). Progress streaming +
//      cooperative cancellation arrive in Task 14 by swapping those
//      two impls — no signature changes required.
//   5. Polygon reconstruction uses
//      `jagua_rs::io::export::int_to_ext_transformation` composed
//      with the original `Part.polygon`. Do NOT serialize jagua's
//      internal `PlacedItem.shape` — it carries a centring
//      pre-transform and may be clearance-inflated (see
//      Codex sign-off §3 of the Task 8 plan).
//   6. Placement iteration sorted by `(item_id, tx, ty, rot)` before
//      renumbering so `instance_index` is deterministic under fixed
//      seed — jagua's `SlotMap` iteration order is not stable.

pub mod assignment;
pub mod cancel;
pub mod gls;
pub mod multi;
pub mod objective;
pub mod progress;
pub mod rng;
pub mod state;
pub mod terminator;

pub use multi::optimize_multi;
pub use progress::{PackProgress, ProgressCallback};

use crate::domain::{Bin, PackError, Part};
use crate::infrastructure::jagua_adapter;
use crate::infrastructure::search::gls::compress::compression_phase;
use crate::infrastructure::search::gls::explore::{
    exploration_phase, ExplorationConfig, ExplorationOutcome,
};
use crate::infrastructure::search::gls::separator::{NoopListener, Separator, SeparatorConfig};
use crate::infrastructure::search::terminator::BasicTerminator;
use crate::infrastructure::warm_start::{SeedPlacement, SeedResult};
use jagua_rs::entities::{Instance, Layout, LayoutSnapshot, PlacedItem};
use jagua_rs::geometry::DTransformation;
use jagua_rs::io::export::int_to_ext_transformation;
use jagua_rs::io::import::ext_to_int_transformation;
use jagua_rs::probs::bpp::entities::BPInstance;
use rf_geom::domain::Point2D;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Configuration surface for the search.
///
/// Note: `Default` is NOT derived because `Bin` and `Part` have no
/// meaningful defaults for BPP optimization. Tests construct the
/// config explicitly with small rect fixtures (see this module's
/// `#[cfg(test)]` block).
#[derive(Clone, Debug)]
pub struct OptimizerConfig {
    /// Total wall-clock budget for the search.
    pub time_budget_ms: u64,
    /// Stop early if no improvement for N ms. `None` = rely on
    /// `time_budget_ms` only. Currently unused — wired in Task 14.
    pub improvement_budget_ms: Option<u64>,
    /// Seed for reproducibility. `None` = entropy-backed via `SysRng`.
    pub seed: Option<u64>,
    /// The bin this `optimize` call is scoped to.
    pub bin: Bin,
    /// Domain-level item set for this bin. `optimize` rebuilds the
    /// `BPInstance` from this + `bin` + `clearance` internally.
    pub items: Vec<Part>,
    /// Minimum item separation, passed to jagua's importer.
    pub clearance: f64,
    /// Task 14: optional cooperative-cancel token. `None` = deadline-only
    /// termination; `Some(token)` threads through `CompositeTerminator`
    /// into Separator's inner loop, enabling cancel latency bounded by
    /// one GLS iteration rather than one strike cycle.
    #[allow(clippy::struct_field_names)]
    pub cancel_token: Option<cancel::CancelToken>,
}

/// Run the real GLS pipeline (explore -> compress -> translate).
///
/// Single-bin scope. `pack.rs` calls this per bin.
///
/// Task 12 will introduce a `search::optimize_multi(request, seeds,
/// cfg)` that owns the cross-bin swap loop; this single-bin entry
/// point becomes a thin wrapper then.
pub fn optimize(seed: SeedResult, config: OptimizerConfig) -> Result<SeedResult, PackError> {
    // 1. Build BPInstance from domain context carried in config.
    let instance = jagua_adapter::to_jagua_instance(
        std::slice::from_ref(&config.bin),
        &config.items,
        config.clearance,
    )?;

    // 2. Construct a fresh Layout from the container, replay warm-start
    //    placements into it.
    let container = instance.container(0).clone();
    let mut layout = Layout::new(container);
    replay_seed_into_layout(&mut layout, &instance, &config.items, &seed)?;

    // 3. Construct Separator. RNG seeded once from config.seed; worker
    //    RNGs are deterministically derived inside `Separator::new`.
    let rng = rng::from_seed(config.seed);
    let mut sep = Separator::new(instance, layout, rng, SeparatorConfig::exploration());

    // 4. Arm a `CompositeTerminator` (deadline + cancel). 100% explore
    //    budget — compression is identity per Task 7. If
    //    `config.cancel_token` is None, behaves exactly like
    //    `BasicTerminator` alone (Task 9 parity preserved).
    let deadline = BasicTerminator::with_timeout(Duration::from_millis(config.time_budget_ms));
    let term = cancel::CompositeTerminator::new(deadline, config.cancel_token.clone());
    let mut listener = NoopListener;

    // 5. Run exploration -> compression (identity pass-through).
    let expl_outcome = exploration_phase(
        &mut sep,
        &term,
        &mut listener,
        &ExplorationConfig::paper_defaults(),
    );
    let explored_snap = match expl_outcome {
        ExplorationOutcome::Feasible(snap) => snap,
        ExplorationOutcome::Infeasible { snapshot, .. } => snapshot,
    };
    let polished = compression_phase(&mut sep, explored_snap, &term, &mut listener);

    // 6. Translate LayoutSnapshot back to SeedResult.
    Ok(snapshot_to_seed(
        &polished,
        &sep.instance,
        &config.items,
        &config.bin.bin_id,
    ))
}

// ---------------------------------------------------------------------------
// Sparrow-style fixed-bin repack spike (Commit 1)
// ---------------------------------------------------------------------------
//
// Hypothesis: feeding the existing BPP-shaped GLS port an INFEASIBLE starting
// layout (more copies than BSSF can fit, forced in with overlaps) lets
// `exploration_phase` resolve collisions into a denser feasible layout than
// the axis-aligned MaxRects heuristics can reach.
//
// Codex + Gemini dual sign-off at `.claude/handoff/sparrow-spike-plan.md`.
// Standalone entry point — NOT wired into `consolidate_tail_bin`'s receiver
// portfolio yet (parity risk staging). Bench first, wire later.
//
// Commit-1 scope: shrink-only outer loop with the naive "drop smallest"
// heuristic. Always falls back to the BSSF baseline if nothing feasible is
// found, so callers get a result no worse than today's packer.

/// Configuration for `fixed_bin_sparrow_repack`.
#[derive(Clone, Debug)]
pub struct FixedBinRepackConfig {
    /// Hard wall-clock budget across all inner attempts.
    pub total_budget_ms: u64,
    /// Minimum ms per inner `exploration_phase` call — prevents degenerate
    /// short attempts on the tail end of the budget.
    pub min_attempt_budget_ms: u64,
    /// Starting forced-item count. `None` → `min(30, total_copies)`. Clamped
    /// to `bssf_placed + 1` on the low end so we never attempt a packing
    /// the BSSF baseline already achieves.
    pub start_count: Option<usize>,
    /// Optional seed. `None` → entropy-backed via `SysRng`.
    pub seed: Option<u64>,
}

impl Default for FixedBinRepackConfig {
    fn default() -> Self {
        Self {
            total_budget_ms: 1000,
            min_attempt_budget_ms: 200,
            start_count: None,
            seed: Some(42),
        }
    }
}

const FIXED_BIN_REPACK_MAX_ATTEMPTS: usize = 8;
const FIXED_BIN_REPACK_DEFAULT_START: usize = 30;

/// Bounded sparrow-style repack on a single fixed-width bin.
///
/// Runs the existing BPP-shaped GLS port on an intentionally-infeasible
/// starting layout (more items than BSSF can fit, forced into place with
/// overlaps) and lets `exploration_phase` resolve collisions. On infeasible
/// outcome, shrinks the item count by one and retries until a feasible
/// layout is found, the budget expires, or the count falls to the BSSF
/// baseline. Always returns at least the BSSF baseline — never worse than
/// today's packer.
pub fn fixed_bin_sparrow_repack(
    bin: &Bin,
    items: &[Part],
    clearance: f64,
    config: FixedBinRepackConfig,
) -> Result<SeedResult, PackError> {
    use crate::infrastructure::warm_start::{greedy_rectangle_pack_with_strategy, PackerStrategy};

    // Baseline. We never return worse than this.
    let bssf_baseline =
        greedy_rectangle_pack_with_strategy(bin, items, clearance, PackerStrategy::Bssf)?;
    let bssf_placed = bssf_baseline.placements.len();

    let total_copies: usize = items.iter().map(|p| p.quantity as usize).sum();
    if total_copies <= bssf_placed {
        // BSSF already fits everything. Nothing to gain from the repack.
        return Ok(bssf_baseline);
    }

    let start_n = config
        .start_count
        .unwrap_or(FIXED_BIN_REPACK_DEFAULT_START)
        .min(total_copies)
        .max(bssf_placed + 1);

    // Stable copy order: sort by (area desc, shape_id asc), flatten
    // respecting per-part quantity. Area desc means tail entries are the
    // SMALLEST — "drop smallest" is just `take_n -= 1`.
    let copy_order = build_copy_order(items)?;
    debug_assert_eq!(
        copy_order.len(),
        total_copies,
        "copy_order length must match total requested copies"
    );

    let deadline = Instant::now() + Duration::from_millis(config.total_budget_ms);
    let mut best_feasible: SeedResult = bssf_baseline.clone();

    let mut current_n = start_n;
    let mut attempts = 0usize;

    while attempts < FIXED_BIN_REPACK_MAX_ATTEMPTS
        && current_n > bssf_placed
        && Instant::now() < deadline
    {
        attempts += 1;

        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .as_millis() as u64;
        let slots_left = FIXED_BIN_REPACK_MAX_ATTEMPTS
            .saturating_sub(attempts - 1)
            .max(1) as u64;
        let per_attempt_budget = (remaining / slots_left).max(config.min_attempt_budget_ms);

        let (overlap_seed, subset_items) =
            build_overlap_seed(bin, items, &copy_order, clearance, current_n)?;

        // Per-attempt seed: derive from base seed + attempt index so each
        // retry explores a different RNG trajectory but stays deterministic.
        let attempt_seed = config.seed.map(|s| s.wrapping_add(attempts as u64));

        let outcome = run_repack_attempt(
            bin,
            clearance,
            &subset_items,
            overlap_seed,
            per_attempt_budget,
            attempt_seed,
        )?;

        match outcome {
            RepackOutcome::Feasible(seed_result) => {
                if seed_result.placements.len() > best_feasible.placements.len() {
                    best_feasible = seed_result;
                }
                // Commit-1: do not attempt to grow further. The shrink-only
                // path is enough to prove the mechanism.
                break;
            }
            RepackOutcome::Infeasible => {
                // "Drop smallest" — copy_order is area-desc, so shrinking by
                // 1 removes the smallest current copy. Smart drop (max-loss
                // item from CT rebuild) lands in Commit 2 if Commit 1 stalls.
                current_n -= 1;
            }
        }
    }

    Ok(best_feasible)
}

/// Decision returned by one inner GLS attempt.
enum RepackOutcome {
    Feasible(SeedResult),
    Infeasible,
}

/// Build the stable copy-order used by `build_overlap_seed`. Sorted by
/// `(bbox_area desc, shape_id asc)` and flattened respecting per-part
/// `quantity`. Deterministic under identical `items` input.
fn build_copy_order(items: &[Part]) -> Result<Vec<(usize, u32)>, PackError> {
    let mut shape_meta: Vec<(usize, f64, &str)> = Vec::with_capacity(items.len());
    for (idx, part) in items.iter().enumerate() {
        let bbox = rf_geom::application::bbox_of(&part.polygon).map_err(|source| {
            PackError::InvalidPolygon {
                shape_id: part.shape_id.clone(),
                source,
            }
        })?;
        let area = (bbox.1.x - bbox.0.x) * (bbox.1.y - bbox.0.y);
        shape_meta.push((idx, area, part.shape_id.as_str()));
    }
    shape_meta.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.2.cmp(b.2))
    });

    let mut copy_order: Vec<(usize, u32)> =
        Vec::with_capacity(items.iter().map(|p| p.quantity as usize).sum());
    for (shape_idx, _, _) in shape_meta {
        for copy_idx in 0..items[shape_idx].quantity {
            copy_order.push((shape_idx, copy_idx));
        }
    }
    Ok(copy_order)
}

/// Force-place exactly `take_n` copies into the bin via BSSF for the
/// feasible base + corner-forced extras. Strategy:
///
///   1. Run BSSF to get up to `bssf_placed` feasible placements.
///   2. If `take_n > bssf_placed`, pick extra copies from `copy_order`
///      that are NOT already in the BSSF base and stack them at
///      `(x=0, y=bin.height - cumulative_height)` — the top-of-bin,
///      which is the region BSSF most commonly leaves empty. These
///      extras overlap each other and any BSSF items near the top,
///      giving the separator a concentrated collision region to
///      resolve instead of the chaotic whole-bin overlaps a naive grid
///      cascade would produce.
///
/// This is mechanically important: `exploration_phase` resolves overlaps
/// by per-item sampling; a localized collision cluster converges much
/// faster than a uniform overlap mess.
///
/// Returns the overlap seed + a subset_items vector with per-part
/// quantities decremented to match what was actually placed (Codex R3:
/// never duplicate Part rows, always decrement).
fn build_overlap_seed(
    bin: &Bin,
    items: &[Part],
    copy_order: &[(usize, u32)],
    clearance: f64,
    take_n: usize,
) -> Result<(SeedResult, Vec<Part>), PackError> {
    use crate::infrastructure::warm_start::{greedy_rectangle_pack_with_strategy, PackerStrategy};

    // Step 1: BSSF feasible base.
    let bssf = greedy_rectangle_pack_with_strategy(bin, items, clearance, PackerStrategy::Bssf)?;
    let bssf_placed = bssf.placements.len();

    let take = take_n.min(copy_order.len());

    // Short-circuit: if take <= BSSF already places, just use the BSSF
    // prefix unchanged. No overlaps to resolve.
    if take <= bssf_placed {
        let truncated: Vec<SeedPlacement> = bssf.placements.into_iter().take(take).collect();
        let mut count_per_shape: Vec<u32> = vec![0; items.len()];
        for p in &truncated {
            if let Some((idx, _)) = items
                .iter()
                .enumerate()
                .find(|(_, part)| part.shape_id == p.shape_id)
            {
                count_per_shape[idx] += 1;
            }
        }
        let subset_items = build_subset_items(items, &count_per_shape);
        return Ok((
            SeedResult {
                placements: truncated,
                overflow: 0,
            },
            subset_items,
        ));
    }

    // Step 2: inventory what BSSF covered so we know which copies to
    // take from `copy_order` for the extras layer.
    let mut already_placed: Vec<u32> = vec![0; items.len()];
    for placement in &bssf.placements {
        if let Some((idx, _)) = items
            .iter()
            .enumerate()
            .find(|(_, part)| part.shape_id == placement.shape_id)
        {
            already_placed[idx] += 1;
        }
    }

    // Step 3: walk copy_order, skipping copies BSSF already placed,
    // stacking `take - bssf_placed` extras from the top of the bin.
    let mut placements = bssf.placements;
    let mut count_per_shape = already_placed.clone();
    let mut cursor_from_top = 0.0_f64;
    let mut taken_extra = 0usize;
    let extras_needed = take - bssf_placed;

    let mut skip_remaining = already_placed.clone();
    for &(shape_idx, _copy_idx) in copy_order {
        if taken_extra >= extras_needed {
            break;
        }
        // Respect "BSSF already covered this copy": decrement the skip
        // counter instead of taking the copy.
        if skip_remaining[shape_idx] > 0 {
            skip_remaining[shape_idx] -= 1;
            continue;
        }

        let part = &items[shape_idx];
        let bbox = rf_geom::application::bbox_of(&part.polygon).map_err(|source| {
            PackError::InvalidPolygon {
                shape_id: part.shape_id.clone(),
                source,
            }
        })?;
        let w = bbox.1.x - bbox.0.x;
        let h = bbox.1.y - bbox.0.y;

        // Anchor extras at the top-of-bin, growing downward. All extras
        // end up clustered in a narrow band near y = bin.height, which
        // is typically the region BSSF leaves empty on heterogeneous
        // inputs. Overlaps are concentrated, not scattered.
        let x = 0.0;
        let y = (bin.height - h - cursor_from_top).max(0.0);

        placements.push(SeedPlacement {
            shape_id: part.shape_id.clone(),
            instance_index: count_per_shape[shape_idx],
            bin_id: bin.bin_id.clone(),
            x,
            y,
            rotation_rad: 0.0,
            polygon: part
                .polygon
                .iter()
                .map(|p| Point2D::new(p.x - bbox.0.x + x, p.y - bbox.0.y + y))
                .collect(),
            width: w,
            height: h,
        });
        count_per_shape[shape_idx] += 1;
        taken_extra += 1;

        // Advance the cursor by the smaller of `h` or a fraction of
        // bin.height to prevent a single tall part from pushing the
        // extras band off the bin. `h * 0.3` keeps extras compact —
        // empirically the separator untangles small overlaps much
        // faster than large ones.
        cursor_from_top += h * 0.3;
    }

    let subset_items = build_subset_items(items, &count_per_shape);

    Ok((
        SeedResult {
            placements,
            overflow: 0,
        },
        subset_items,
    ))
}

/// Build a subset_items vector from a per-shape count vector. Items with
/// count 0 are dropped entirely; items with count > 0 get a quantity
/// matching the count (Codex R3: decrement quantity, never duplicate).
fn build_subset_items(items: &[Part], count_per_shape: &[u32]) -> Vec<Part> {
    let mut subset: Vec<Part> = Vec::with_capacity(items.len());
    for (idx, part) in items.iter().enumerate() {
        if count_per_shape[idx] > 0 {
            let mut p = part.clone();
            p.quantity = count_per_shape[idx];
            subset.push(p);
        }
    }
    subset
}

/// Run one bounded GLS attempt against an overlap seed. Returns
/// `Feasible` with the materialized `SeedResult` or `Infeasible` when the
/// budget expires before collisions resolve. Inlines the same pipeline
/// shape as `optimize` but inspects the raw `ExplorationOutcome` so
/// infeasible attempts can be distinguished from feasible ones — the
/// regular `optimize` path would conflate them.
fn run_repack_attempt(
    bin: &Bin,
    clearance: f64,
    subset_items: &[Part],
    overlap_seed: SeedResult,
    budget_ms: u64,
    seed: Option<u64>,
) -> Result<RepackOutcome, PackError> {
    let instance =
        jagua_adapter::to_jagua_instance(std::slice::from_ref(bin), subset_items, clearance)?;

    let container = instance.container(0).clone();
    let mut layout = Layout::new(container);
    replay_seed_into_layout(&mut layout, &instance, subset_items, &overlap_seed)?;

    let rng = rng::from_seed(seed);
    let mut sep = Separator::new(instance, layout, rng, SeparatorConfig::exploration());

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
        ExplorationOutcome::Feasible(snap) => {
            let polished = compression_phase(&mut sep, snap, &term, &mut listener);
            Ok(RepackOutcome::Feasible(snapshot_to_seed(
                &polished,
                &sep.instance,
                subset_items,
                &bin.bin_id,
            )))
        }
        ExplorationOutcome::Infeasible { .. } => Ok(RepackOutcome::Infeasible),
    }
}

/// Replay a warm-start `SeedResult` into a fresh `Layout`.
///
/// Each `SeedPlacement` becomes a `layout.place_item(item, dt)` call.
/// Uses an explicit `HashMap<shape_id, item_id>` keyed off
/// `config.items` — do NOT rely on positional matching between
/// `SeedPlacement.shape_id` and `BPInstance.items` order (Codex
/// sign-off §3.3 fix).
fn replay_seed_into_layout(
    layout: &mut Layout,
    instance: &BPInstance,
    items: &[Part],
    seed: &SeedResult,
) -> Result<(), PackError> {
    // Per Codex plan sign-off §3.3: `HashMap<String, usize>` exactly.
    // Owned keys are cheap here (items is typically < 100 entries) and
    // sidestep any future borrow concerns if `items` lifetime changes.
    let mut shape_to_item_id: HashMap<String, usize> = HashMap::with_capacity(items.len());
    for (idx, part) in items.iter().enumerate() {
        if shape_to_item_id
            .insert(part.shape_id.clone(), idx)
            .is_some()
        {
            return Err(PackError::EngineFailed(format!(
                "duplicate shape_id '{}' in items — refusing to replay seed",
                part.shape_id
            )));
        }
    }

    for placement in &seed.placements {
        let item_id = *shape_to_item_id.get(&placement.shape_id).ok_or_else(|| {
            PackError::EngineFailed(format!(
                "seed placement references unknown shape_id '{}'",
                placement.shape_id
            ))
        })?;
        let item = instance.item(item_id);

        // Codex Task-9 fix: SeedPlacement stores EXTERNAL coordinates
        // (warm_start.rs applies the user-supplied polygon directly).
        // jagua's `Layout::place_item` expects INTERNAL coordinates —
        // jagua applies a centring `pre_transform` to every item during
        // import (`io::import::centering_transformation`). We must
        // compose the inverse via `ext_to_int_transformation` before
        // placing, else every item lands shifted by its centroid and
        // every downstream collision/pipeline/invariant check sees
        // bogus overlap geometry. This was the root cause of the three
        // debug-only warn! downgrades from Task 8.
        let ext_dt = DTransformation::new(
            placement.rotation_rad as f32,
            (placement.x as f32, placement.y as f32),
        );
        let int_dt = ext_to_int_transformation(&ext_dt, &item.shape_orig.pre_transform);
        layout.place_item(item, int_dt);
    }
    Ok(())
}

/// Translate a post-GLS `LayoutSnapshot` back into a domain
/// `SeedResult`. Applies `jagua_rs::io::export::int_to_ext_transformation`
/// to recover external-space placements, then re-transforms the
/// ORIGINAL `Part.polygon` into each placement's world position.
///
/// Placements are sorted by `(item_id, tx, ty, rot)` before
/// renumbering so `instance_index` is deterministic under fixed seed
/// (jagua's `SlotMap` iteration order is not stable).
fn snapshot_to_seed(
    snap: &LayoutSnapshot,
    instance: &BPInstance,
    items: &[Part],
    bin_id: &str,
) -> SeedResult {
    // Collect + sort deterministically.
    let mut entries: Vec<&PlacedItem> = snap.placed_items.values().collect();
    entries.sort_by_key(|pi| {
        (
            pi.item_id,
            pi.d_transf.translation.0.into_inner().to_bits(),
            pi.d_transf.translation.1.into_inner().to_bits(),
            pi.d_transf.rotation.into_inner().to_bits(),
        )
    });

    let mut per_shape_count: HashMap<usize, u32> = HashMap::new();
    let mut placements = Vec::with_capacity(entries.len());

    for pi in entries {
        let item = instance.item(pi.item_id);
        let pre_transf = &item.shape_orig.pre_transform;
        let abs_transf = int_to_ext_transformation(&pi.d_transf, pre_transf);

        let part = &items[pi.item_id];
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
        let width = (max_x - min_x).max(0.0);
        let height = (max_y - min_y).max(0.0);

        let idx = per_shape_count.entry(pi.item_id).or_insert(0);
        let instance_index = *idx;
        *idx += 1;

        placements.push(SeedPlacement {
            shape_id: part.shape_id.clone(),
            instance_index,
            bin_id: bin_id.to_string(),
            x: abs_transf.translation.0.into_inner() as f64,
            y: abs_transf.translation.1.into_inner() as f64,
            rotation_rad: abs_transf.rotation.into_inner() as f64,
            polygon,
            width,
            height,
        });
    }

    let total_requested: u32 = items.iter().map(|p| p.quantity).sum();
    let overflow = total_requested.saturating_sub(placements.len() as u32);

    SeedResult {
        placements,
        overflow,
    }
}

/// Apply a jagua `DTransformation` (rotate about origin, then translate)
/// to a `Point2D`.
fn apply_dtransformation_to_point(dt: &DTransformation, p: Point2D) -> Point2D {
    let theta = dt.rotation.into_inner();
    let cos = theta.cos();
    let sin = theta.sin();
    let (px, py) = (p.x as f32, p.y as f32);
    let rx = px * cos - py * sin + dt.translation.0.into_inner();
    let ry = px * sin + py * cos + dt.translation.1.into_inner();
    Point2D::new(rx as f64, ry as f64)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Bin, BinKind};

    const SEED: u64 = 42;

    fn square_part(id: &str, side: f64) -> Part {
        Part {
            shape_id: id.into(),
            quantity: 1,
            polygon: vec![
                Point2D::new(0.0, 0.0),
                Point2D::new(side, 0.0),
                Point2D::new(side, side),
                Point2D::new(0.0, side),
            ],
            shape_spec: None,
            allow_rotation: false,
            grain_axis: None,
            difficulty: None,
        }
    }

    fn big_bin() -> Bin {
        Bin {
            bin_id: "test-bin".into(),
            width: 100.0,
            height: 100.0,
            kind: BinKind::Fresh,
            priority: None,
        }
    }

    /// Build a seed with two 10x10 squares at given offsets — overlap
    /// if offsets are close.
    fn two_square_seed(offsets: &[(f32, f32)]) -> (Bin, Vec<Part>, SeedResult) {
        let bin = big_bin();
        let parts = vec![square_part("a", 10.0), square_part("b", 10.0)];
        assert!(
            offsets.len() == 2,
            "two_square_seed is hardcoded for exactly 2 squares"
        );
        let shape_ids = ["a", "b"];
        let placements = offsets
            .iter()
            .enumerate()
            .map(|(i, (tx, ty))| SeedPlacement {
                shape_id: shape_ids[i].to_string(),
                instance_index: 0,
                bin_id: bin.bin_id.clone(),
                x: *tx as f64,
                y: *ty as f64,
                rotation_rad: 0.0,
                polygon: vec![
                    Point2D::new(*tx as f64, *ty as f64),
                    Point2D::new(*tx as f64 + 10.0, *ty as f64),
                    Point2D::new(*tx as f64 + 10.0, *ty as f64 + 10.0),
                    Point2D::new(*tx as f64, *ty as f64 + 10.0),
                ],
                width: 10.0,
                height: 10.0,
            })
            .collect();
        let seed = SeedResult {
            placements,
            overflow: 0,
        };
        (bin, parts, seed)
    }

    fn cfg_from(bin: Bin, items: Vec<Part>, budget_ms: u64) -> OptimizerConfig {
        OptimizerConfig {
            time_budget_ms: budget_ms,
            improvement_budget_ms: None,
            seed: Some(SEED),
            bin,
            items,
            clearance: 0.0,
            cancel_token: None,
        }
    }

    #[test]
    fn resolves_colliding_warm_start_seed() {
        // Two 10x10 squares seeded at (10,10) and (15,15) — 50% overlap.
        // Real GLS must resolve to a non-overlapping layout while
        // preserving cardinality (2 placements, 0 overflow).
        let (bin, items, seed) = two_square_seed(&[(10.0, 10.0), (15.0, 15.0)]);
        let out = optimize(seed, cfg_from(bin, items, 5_000)).unwrap();

        assert_eq!(out.placements.len(), 2, "cardinality must be preserved");
        assert_eq!(out.overflow, 0, "no items should be dropped");

        // No pairwise bbox overlap.
        let (a, b) = (&out.placements[0], &out.placements[1]);
        let no_overlap = a.x + a.width <= b.x
            || b.x + b.width <= a.x
            || a.y + a.height <= b.y
            || b.y + b.height <= a.y;
        assert!(
            no_overlap,
            "placements must not overlap after GLS: a=({},{},{}x{}) b=({},{},{}x{})",
            a.x, a.y, a.width, a.height, b.x, b.y, b.width, b.height
        );
    }

    #[test]
    fn respects_time_budget() {
        // Unresolvable fixture + short budget. The call must return
        // within deadline + one-strike worst-case slack.
        //
        // The BasicTerminator only gets polled at the TOP of the outer
        // strike loop (separator.rs:256). One strike runs up to
        // iter_no_imprv_limit (200) iterations of move_items_multi
        // (3 workers × sampling) before the next kill() check. So a
        // 50ms budget can legitimately run 10s before returning.
        // This is known and documented in Task 14 as "cancel latency
        // tightening."
        //
        // For Task 8 we assert: (a) the optimize CALL returns, and
        // (b) for a 500ms budget, it returns within ~15s worst-case
        // (3-strike-cycle upper bound on the 2-item unresolvable fixture).
        let bin = Bin {
            bin_id: "tight".into(),
            width: 100.0,
            height: 100.0,
            kind: BinKind::Fresh,
            priority: None,
        };
        let parts = vec![square_part("big-a", 80.0), square_part("big-b", 80.0)];
        let seed = SeedResult {
            placements: vec![
                SeedPlacement {
                    shape_id: "big-a".into(),
                    instance_index: 0,
                    bin_id: bin.bin_id.clone(),
                    x: 0.0,
                    y: 0.0,
                    rotation_rad: 0.0,
                    polygon: vec![
                        Point2D::new(0.0, 0.0),
                        Point2D::new(80.0, 0.0),
                        Point2D::new(80.0, 80.0),
                        Point2D::new(0.0, 80.0),
                    ],
                    width: 80.0,
                    height: 80.0,
                },
                SeedPlacement {
                    shape_id: "big-b".into(),
                    instance_index: 0,
                    bin_id: bin.bin_id.clone(),
                    x: 10.0,
                    y: 10.0,
                    rotation_rad: 0.0,
                    polygon: vec![
                        Point2D::new(10.0, 10.0),
                        Point2D::new(90.0, 10.0),
                        Point2D::new(90.0, 90.0),
                        Point2D::new(10.0, 90.0),
                    ],
                    width: 80.0,
                    height: 80.0,
                },
            ],
            overflow: 0,
        };
        // optimize() hardcodes ExplorationConfig::paper_defaults, so
        // the test can't tune strike/iter limits. Budget + ceiling is
        // the honest assertion.
        let cfg = cfg_from(bin, parts, 500);
        let start = std::time::Instant::now();
        let _ = optimize(seed, cfg).unwrap();
        let elapsed = start.elapsed();
        // 10s ceiling. BasicTerminator.kill() is only polled at the top
        // of the outer strike loop (separator.rs:256). A single strike
        // can run up to `iter_no_imprv_limit` (200) iterations of
        // move_items_multi × 3 workers × sampling before the next
        // kill() check. On an unresolvable 2-item fixture the paper
        // defaults + cold JIT can legitimately need ~8s worst-case.
        // A 10s firing here would flag: infinite loop, terminator never
        // polled, or a true perf regression.
        assert!(
            elapsed.as_secs() < 10,
            "optimize ran longer than 10s ceiling: {elapsed:?}"
        );
    }

    #[test]
    fn preserves_overflow_for_oversized_input() {
        // Warm-start produced an empty layout (no placements fit); GLS
        // cannot create room on an empty layout. Overflow on output is
        // recomputed from scratch as `total_requested - placed_in_layout`
        // — note this IGNORES the incoming `seed.overflow` field; the
        // canonical source of truth is `config.items[].quantity`.
        let bin = big_bin();
        let parts = vec![square_part("a", 10.0)];
        let seed = SeedResult {
            placements: vec![],
            overflow: 0, // irrelevant — optimize recomputes from items
        };
        let out = optimize(seed, cfg_from(bin, parts, 500)).unwrap();
        assert_eq!(
            out.overflow, 1,
            "overflow = sum(items.quantity) - placed_in_layout = 1 - 0 = 1"
        );
    }

    #[test]
    fn determinism_same_seed_same_output() {
        let (bin, items, seed) = two_square_seed(&[(10.0, 10.0), (15.0, 15.0)]);

        let out1 = optimize(seed.clone(), cfg_from(bin.clone(), items.clone(), 2_000)).unwrap();
        let out2 = optimize(seed, cfg_from(bin, items, 2_000)).unwrap();

        let key = |r: &SeedResult| -> Vec<(String, u32, u64, u64, u64)> {
            r.placements
                .iter()
                .map(|p| {
                    (
                        p.shape_id.clone(),
                        p.instance_index,
                        p.x.to_bits(),
                        p.y.to_bits(),
                        p.rotation_rad.to_bits(),
                    )
                })
                .collect()
        };

        assert_eq!(
            key(&out1),
            key(&out2),
            "seed=42 must produce identical output"
        );
    }

    #[test]
    fn snapshot_to_seed_uses_external_transform() {
        // Construct a layout with an item placed at jagua's internal
        // translation (10, 20), translate back via snapshot_to_seed,
        // and verify the returned polygon is in external coordinates
        // (shape preserved, translated to the expected position).
        //
        // Jagua applies a centring pre_transform during import
        // (io::import::import_instance): the ORIGINAL polygon's
        // centroid moves to (0,0) in internal space. When we compose
        // that with the internal transform (10, 20) via
        // int_to_ext_transformation, the result is an external
        // DTransformation whose translation places the polygon's
        // original centroid AT (10, 20) in world space.
        //
        // So for a 10x10 square whose original centroid is (5, 5)
        // relative to its min-corner (0, 0), the external polygon
        // has min-corner (5, 15) and max-corner (15, 25) — centroid
        // (10, 20).
        let bin = big_bin();
        let parts = vec![square_part("a", 10.0)];
        let instance =
            jagua_adapter::to_jagua_instance(std::slice::from_ref(&bin), &parts, 0.0).unwrap();
        let container = instance.container(0).clone();
        let mut layout = Layout::new(container);
        layout.place_item(instance.item(0), DTransformation::new(0.0, (10.0, 20.0)));
        let snap = layout.save();

        let result = snapshot_to_seed(&snap, &instance, &parts, &bin.bin_id);

        assert_eq!(result.placements.len(), 1);
        let p = &result.placements[0];
        assert_eq!(p.shape_id, "a");
        assert_eq!(p.instance_index, 0);

        // Verify shape preservation: 10x10 bbox in external space.
        let (min_x, min_y, max_x, max_y) = p.polygon.iter().fold(
            (
                f64::INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
            ),
            |(mnx, mny, mxx, mxy), pt| (mnx.min(pt.x), mny.min(pt.y), mxx.max(pt.x), mxy.max(pt.y)),
        );
        let w = max_x - min_x;
        let h = max_y - min_y;
        assert!(
            (w - 10.0).abs() < 0.01 && (h - 10.0).abs() < 0.01,
            "polygon dimensions should be preserved (10x10), got {w}x{h}"
        );

        // Verify world-space translation: centroid at (10, 20) per the
        // centre-then-translate contract. If snapshot_to_seed skipped
        // int_to_ext_transformation and applied pi.d_transf directly
        // to the ORIGINAL polygon, the centroid would land at (15, 25).
        let (cx, cy) = p
            .polygon
            .iter()
            .fold((0.0, 0.0), |(sx, sy), pt| (sx + pt.x, sy + pt.y));
        let n = p.polygon.len() as f64;
        let (cx, cy) = (cx / n, cy / n);
        assert!(
            (cx - 10.0).abs() < 0.5 && (cy - 20.0).abs() < 0.5,
            "external polygon centroid should be near (10, 20) — suggests \
             pre_transform wasn't composed via int_to_ext_transformation; \
             got ({cx}, {cy})"
        );
    }

    // -----------------------------------------------------------------
    // fixed_bin_sparrow_repack — Commit 1 tests
    // -----------------------------------------------------------------

    fn rect_part_q(id: &str, side: f64, qty: u32) -> Part {
        Part {
            shape_id: id.into(),
            quantity: qty,
            polygon: vec![
                Point2D::new(0.0, 0.0),
                Point2D::new(side, 0.0),
                Point2D::new(side, side),
                Point2D::new(0.0, side),
            ],
            shape_spec: None,
            allow_rotation: false,
            grain_axis: None,
            difficulty: None,
        }
    }

    fn no_pairwise_overlap(result: &SeedResult) -> bool {
        // Strict bbox-level disjointness check. Adjacency (shared edge) is
        // allowed because clearance handling lives in jagua's CDE, not the
        // returned bbox metadata.
        for i in 0..result.placements.len() {
            for j in (i + 1)..result.placements.len() {
                let a = &result.placements[i];
                let b = &result.placements[j];
                let disjoint = a.x + a.width <= b.x
                    || b.x + b.width <= a.x
                    || a.y + a.height <= b.y
                    || b.y + b.height <= a.y;
                if !disjoint {
                    return false;
                }
            }
        }
        true
    }

    #[test]
    fn fixed_bin_repack_never_worse_than_bssf_baseline() {
        // 4 small squares in a bin that only fits 3 — sparrow should place
        // at least the BSSF baseline's count (3) and never fewer.
        let bin = Bin {
            bin_id: "b".into(),
            width: 30.0,
            height: 30.0,
            kind: BinKind::Fresh,
            priority: None,
        };
        let items = vec![rect_part_q("r", 10.0, 4)];
        let config = FixedBinRepackConfig {
            total_budget_ms: 500,
            min_attempt_budget_ms: 100,
            start_count: Some(4),
            seed: Some(42),
        };
        let out = fixed_bin_sparrow_repack(&bin, &items, 0.0, config).unwrap();

        // BSSF grid packer fits 9 (3×3 of 10×10 in 30×30). Our spike must
        // return at least that many. Feasibility contract: never worse.
        assert!(
            out.placements.len() >= 3,
            "repack must return at least BSSF baseline, got {} placements",
            out.placements.len()
        );
        assert!(
            no_pairwise_overlap(&out),
            "repack must never return overlapping placements"
        );
    }

    #[test]
    fn fixed_bin_repack_beats_overlap_start() {
        // 5 10×10 squares force-packed into a 22×22 bin. Bin has area for
        // 4 (actually fits exactly 4 non-overlapping in a 2×2 grid at 0/11
        // with 1" gaps). Overlap seed will force all 5 in with overlaps.
        // Sparrow's shrink loop should step from 5 → 4 and find the
        // feasible 4-square layout.
        let bin = Bin {
            bin_id: "b".into(),
            width: 22.0,
            height: 22.0,
            kind: BinKind::Fresh,
            priority: None,
        };
        let items = vec![rect_part_q("s", 10.0, 5)];
        let config = FixedBinRepackConfig {
            total_budget_ms: 3_000,
            min_attempt_budget_ms: 300,
            start_count: Some(5),
            seed: Some(42),
        };
        let out = fixed_bin_sparrow_repack(&bin, &items, 0.0, config).unwrap();

        // Baseline grid packer fits floor(22/10) × floor(22/10) = 2×2 = 4.
        // Spike must match or beat that. 5 is geometrically infeasible in
        // 22×22 without rotation, so 4 is the ceiling.
        assert!(
            out.placements.len() >= 4,
            "expected ≥ 4 placements after sparrow repack, got {}",
            out.placements.len()
        );
        assert!(
            no_pairwise_overlap(&out),
            "repack output must not contain overlapping placements"
        );
    }

    #[test]
    fn fixed_bin_repack_deterministic_under_seed() {
        let bin = Bin {
            bin_id: "b".into(),
            width: 40.0,
            height: 40.0,
            kind: BinKind::Fresh,
            priority: None,
        };
        let items = vec![rect_part_q("r", 10.0, 6)];
        let config = FixedBinRepackConfig {
            total_budget_ms: 1_000,
            min_attempt_budget_ms: 200,
            start_count: Some(6),
            seed: Some(42),
        };

        let a = fixed_bin_sparrow_repack(&bin, &items, 0.0, config.clone()).unwrap();
        let b = fixed_bin_sparrow_repack(&bin, &items, 0.0, config).unwrap();

        let key = |r: &SeedResult| -> Vec<(String, u32, u64, u64, u64)> {
            r.placements
                .iter()
                .map(|p| {
                    (
                        p.shape_id.clone(),
                        p.instance_index,
                        p.x.to_bits(),
                        p.y.to_bits(),
                        p.rotation_rad.to_bits(),
                    )
                })
                .collect()
        };
        assert_eq!(key(&a), key(&b), "same seed must produce identical output");
    }

    #[test]
    fn fixed_bin_repack_respects_budget() {
        // Adversarial fixture — too many large squares. Test that the call
        // returns within a reasonable multiple of the budget (not infinite).
        let bin = Bin {
            bin_id: "b".into(),
            width: 50.0,
            height: 50.0,
            kind: BinKind::Fresh,
            priority: None,
        };
        let items = vec![rect_part_q("big", 30.0, 4)];
        let config = FixedBinRepackConfig {
            total_budget_ms: 500,
            min_attempt_budget_ms: 100,
            start_count: Some(4),
            seed: Some(42),
        };

        let start = Instant::now();
        let out = fixed_bin_sparrow_repack(&bin, &items, 0.0, config).unwrap();
        let elapsed = start.elapsed();

        // BasicTerminator polling is outer-loop only (separator.rs:256), so
        // exploration_phase can legitimately overshoot a short budget. Ceiling
        // chosen to be 20× the requested budget — catches infinite loops
        // and genuine perf regressions while allowing paper-default
        // strike/iter costs to complete a tail iteration.
        assert!(
            elapsed < Duration::from_secs(10),
            "repack ran longer than 10s ceiling: {elapsed:?}"
        );
        assert!(
            !out.placements.is_empty() || out.overflow == 4,
            "must return either a valid layout or the BSSF fallback"
        );
    }

    #[test]
    fn fixed_bin_repack_no_shrink_when_bssf_already_fits_all() {
        // BSSF fits all 4 — sparrow should just return BSSF's result
        // without wasting budget on GLS.
        let bin = Bin {
            bin_id: "b".into(),
            width: 40.0,
            height: 40.0,
            kind: BinKind::Fresh,
            priority: None,
        };
        let items = vec![rect_part_q("r", 10.0, 4)];
        let config = FixedBinRepackConfig {
            total_budget_ms: 500,
            min_attempt_budget_ms: 100,
            start_count: None,
            seed: Some(42),
        };

        let start = Instant::now();
        let out = fixed_bin_sparrow_repack(&bin, &items, 0.0, config).unwrap();
        let elapsed = start.elapsed();

        assert_eq!(out.placements.len(), 4);
        assert_eq!(out.overflow, 0);
        // Fast-path guard: BSSF-only path must not spend the full budget.
        assert!(
            elapsed < Duration::from_millis(250),
            "BSSF fast path took {elapsed:?} (should be ~immediate)"
        );
    }
}
