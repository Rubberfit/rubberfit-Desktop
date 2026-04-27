// engine/crates/rf-layout/src/application/pack_lbf.rs
//
// Phase 1 LBF adoption (opt-in parallel path to pack()).
//
// Wraps jagua-rs's `LBFOptimizerBP` with a deterministic multistart and
// maps its BPSolution back into REMA's `PackResult` shape. This path
// bypasses the FFD + cross-bin-swap + GLS pipeline entirely â€” LBF does
// its own bin-selection greedily (open layouts first, then fresh bins).
//
// Empirical basis: `tests/lbf_bench.rs` shows LBF placing 32/37 (up from
// BSSF's 13/37) on the production 37-part rectangle fixture with a 20-seed
// multistart completing in ~300 ms. On irregular fixtures (trapezoids,
// concave annular cones), LBF places 100 % of demand.
//
// See `.claude/research/sparrow-integration/lbf-finding.md` for the full
// bench data and why LBF was missed in prior sparrow research rounds.

use crate::domain::{BinResult, PackError, PackRequest, PackResult, Placement};
use crate::infrastructure::jagua_adapter::{shift_dtransformation, to_jagua_instance};
use jagua_rs::entities::{Instance, LayoutSnapshot, PlacedItem};
use jagua_rs::geometry::DTransformation;
use jagua_rs::io::export::int_to_ext_transformation;
use jagua_rs::probs::bpp::entities::{BPInstance, BPLayoutType, BPPlacement};
use lbf::config::LBFConfig;
use lbf::opt::lbf_bpp::LBFOptimizerBP;
use rand::rngs::SmallRng;
use rand::SeedableRng;
use rf_geom::domain::Point2D;
use std::collections::HashMap;
use std::time::Instant;

/// Default sample budget per item per attempt. 5_000 is the empirical
/// sweet-spot from `tests/lbf_bench.rs` â€” below this the solver leaves
/// items unplaced; above this the LBF loss function (x_max*10 + y_max)
/// over-tightens and strands the tail.
const DEFAULT_N_SAMPLES: usize = 5_000;

/// Local-search fraction of the sample budget. Matches the lbf crate's
/// default.
const DEFAULT_LS_FRAC: f32 = 0.2;

/// How many seeds to try when no seed is supplied by the caller.
/// Multistart dominates single-run because LBF is a randomized greedy
/// heuristic with no backtracking; the bench shows wide variance across
/// seeds (seed=42 â†’ 24/37, seed=3 â†’ 32/37 at matching configs).
const DEFAULT_MULTISTART_SEEDS: usize = 10;

/// Configuration knobs for `pack_lbf`.
///
/// Most callers should use [`PackLbfConfig::default`]. The advanced
/// fields are exposed for the bench harness and future tuning work.
#[derive(Clone, Debug)]
pub struct PackLbfConfig {
    /// Sample budget per item per layout per attempt.
    pub n_samples: usize,
    /// Fraction of samples spent on local-search refinement.
    pub ls_frac: f32,
    /// Number of multistart attempts. Each attempt uses a different
    /// seed derived from the base seed. The best-placed result wins.
    pub multistart_seeds: usize,
    /// Option C: when true (default), run a deterministic rectangle
    /// warm-start (`warm_start::greedy_bottom_left`) before LBF samples.
    /// Pre-places every rect-shaped item via `BPProblem::place_item` so
    /// LBF only has to find positions for non-rect remainders. Closes
    /// #18 (LBF probabilistic-sampler tight-fit failures) for any job
    /// containing rectangles. Set to false for speed-comparison testing
    /// against the legacy probabilistic-only pipeline.
    pub use_warm_start: bool,
}

impl Default for PackLbfConfig {
    fn default() -> Self {
        Self {
            n_samples: DEFAULT_N_SAMPLES,
            ls_frac: DEFAULT_LS_FRAC,
            multistart_seeds: DEFAULT_MULTISTART_SEEDS,
            use_warm_start: true,
        }
    }
}

/// Polygon-aware multi-bin packer backed by jagua-rs `LBFOptimizerBP`.
///
/// Drop-in alternative to [`crate::application::pack::pack`] â€” same
/// input, same output. Set `USE_LBF_ENGINE=true` at the pack-cli caller
/// to route through this path.
pub fn pack_lbf(request: PackRequest) -> Result<PackResult, PackError> {
    pack_lbf_with_config(request, PackLbfConfig::default())
}

/// Extended entry point exposing [`PackLbfConfig`] for benches / tuning.
pub fn pack_lbf_with_config(
    mut request: PackRequest,
    cfg: PackLbfConfig,
) -> Result<PackResult, PackError> {
    if request.bins.is_empty() {
        return Err(PackError::NoBins);
    }
    if request.items.is_empty() {
        return Err(PackError::NoItems);
    }
    if cfg.multistart_seeds == 0 {
        return Err(PackError::EngineFailed(
            "multistart_seeds must be â‰¥ 1".into(),
        ));
    }

    crate::application::shape_builder::materialise_request_polygons(&mut request)?;

    let started_at = Instant::now();

    let instance = to_jagua_instance(&request.bins, &request.items, request.clearance)?;

    // Option C: deterministic rectangle warm-start. Pre-places every
    // rect-shaped item at corner-tight positions before LBF samples,
    // so the probabilistic sampler only needs to find spots for non-
    // rect items (cones, circles, trapezoids). Closes #18 for any job
    // that contains rectangles. Falls back to empty (LBF runs as today)
    // when the toggle is off or no rects are present.
    //
    // Per-request override: PackRequest.use_warm_start, when set,
    // takes precedence over cfg.use_warm_start. Lets the AutoNest UI
    // toggle speed-compare against the legacy pipeline without rebuilding.
    let use_warm_start = request.use_warm_start.unwrap_or(cfg.use_warm_start);
    let warm_start: Vec<(usize, BPPlacement)> = if use_warm_start {
        run_greedy_warm_start(&request)
    } else {
        Vec::new()
    };

    // Honour the caller's time budget. We stop launching new multistart
    // attempts once the deadline elapses — the best result so far is
    // returned. At least one attempt always runs.
    // `resolved_time_budget_ms` covers both an explicit `time_budget_ms`
    // AND the mode-based fallback (Fast=2s, Balanced=10s, Thorough=30s);
    // reading the raw field alone would skip the deadline whenever the
    // caller specified a mode without an explicit ms.
    let deadline = started_at + std::time::Duration::from_millis(request.resolved_time_budget_ms());

    // Deterministic seed sequence from the caller's (optional) base seed.
    // Falls back to a fixed 42 when the request omits the seed so results
    // stay reproducible across runs. Multistart derives attempt seeds by
    // `base + offset` â€” each attempt explores a different RNG trajectory.
    let base_seed = request.seed.unwrap_or(42);

    // Skip multistart redundancy when the warm-start placed every item
    // OR when all items are axis-aligned rectangles. In both cases LBF
    // has nothing useful to discover beyond the deterministic warm-start:
    //   - Warm-start covers all → solve() iterates with all demand=0,
    //     no actual sampling work
    //   - All-rect partial → greedy already determined the bin's max
    //     capacity (provably optimal for axis-aligned rect grids), so
    //     LBF's probabilistic sampler has no chance of finding more
    //     positions. Each extra attempt is pure clone + place_item
    //     overhead.
    let total_demand: usize = request.items.iter().map(|p| p.quantity as usize).sum();
    let all_rectangles = request.items.iter().all(is_axis_aligned_rect);
    let attempts = if warm_start.len() >= total_demand || (use_warm_start && all_rectangles) {
        1
    } else {
        cfg.multistart_seeds
    };

    let seeds: Vec<u64> = (0..attempts as u64)
        .map(|i| base_seed.wrapping_add(i))
        .collect();

    // Run multistart, keep the best-placed attempt. Ties broken by
    // higher density (more compact layout when placement count matches).
    // The first attempt always seeds `best_*` so we have a baseline even
    // when every attempt places zero items â€” "zero placements" is a
    // valid result (e.g. all items oversized vs the bins) and must not
    // degrade into an Err.
    let mut best_solution: Option<jagua_rs::probs::bpp::entities::BPSolution> = None;
    let mut best_placed: usize = 0;
    let mut best_bins_used: usize = usize::MAX;
    let mut best_density: f32 = 0.0;
    for (attempts_run, seed) in seeds.into_iter().enumerate() {
        // Deadline check â€” but always run the first attempt so the
        // caller gets a valid result even if the budget is too tight.
        if attempts_run > 0 && std::time::Instant::now() >= deadline {
            break;
        }

        let sol = run_single_lbf_with_warm_start(
            &instance,
            seed,
            cfg.n_samples,
            cfg.ls_frac,
            &warm_start,
        );
        let placed: usize = sol
            .layout_snapshots
            .values()
            .map(|ls| ls.placed_items.len())
            .sum();
        // Number of bins this attempt actually used. layout_snapshots
        // only contains layouts that received at least one item, so
        // this is naturally "non-empty bins".
        let bins_used = sol.layout_snapshots.len();
        let density = sol.density(&instance);

        // Prefer (in order): more items placed → fewer bins used →
        // higher density. The bins-used tiebreaker matters when the
        // auto-fill allocator over-allocates: LBF is first-fit but
        // probabilistic sampling can spill items into new bins they
        // could have fit in already-open ones. Among multistart
        // attempts that placed the same items, the consolidated layout
        // wins.
        let is_better = best_solution.is_none()
            || placed > best_placed
            || (placed == best_placed && bins_used < best_bins_used)
            || (placed == best_placed && bins_used == best_bins_used && density > best_density);
        if is_better {
            best_solution = Some(sol);
            best_placed = placed;
            best_bins_used = bins_used;
            best_density = density;
        }
    }

    let solution = best_solution.expect("multistart_seeds â‰¥ 1 guarantees a best_solution");

    let mut placements: Vec<Placement> = Vec::new();
    let mut per_bin: Vec<BinResult> = Vec::new();
    let mut index_counters: HashMap<String, u32> = HashMap::new();

    // The order of `request.bins` matters â€” it determines per_bin ordering
    // in the output. We walk it explicitly so an empty bin appears as a
    // zero-filled BinResult and so bin ordering is request-stable rather
    // than SlotMap-key-order. `to_jagua_instance` assigns container.id =
    // the bin's index in request.bins, so `enumerate()` is the natural
    // lookup â€” no O(nÂ²) inner search needed.
    for (bin_idx, bin) in request.bins.iter().enumerate() {
        let layout = solution
            .layout_snapshots
            .values()
            .find(|ls| ls.container.id == bin_idx);

        let mut used_area = 0.0_f64;
        let mut occupied_width = 0.0_f64;
        let mut occupied_height = 0.0_f64;

        if let Some(ls) = layout {
            let placements_this_bin = snapshot_to_placements(
                ls,
                &instance,
                &request.items,
                &bin.bin_id,
                request.cone_strategy.unwrap_or_default(),
                request.cone_packing_mode.unwrap_or_default(),
                request.clearance,
            );

            for p in placements_this_bin {
                // Global `instance_index` renumbering per shape â€” same
                // convention as `pack.rs` so downstream consumers don't
                // need to know which path produced the result.
                let counter = index_counters.entry(p.shape_id.clone()).or_insert(0);
                let instance_index = *counter;
                *counter += 1;

                let area = polygon_area(&p.polygon);
                used_area += area;

                for v in &p.polygon {
                    if v.x > occupied_width {
                        occupied_width = v.x;
                    }
                    if v.y > occupied_height {
                        occupied_height = v.y;
                    }
                }

                placements.push(Placement {
                    instance_index,
                    ..p
                });
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
            free_regions: Vec::new(),
            offcuts: Vec::new(),
        });
    }

    // Overflow = sum of requested quantities minus placed.
    let mut placed_by_shape: HashMap<&str, u32> = HashMap::new();
    for p in &placements {
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
    let placed_count = placements.len() as u32;

    Ok(PackResult {
        placements,
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

/// Run one LBF attempt with optional warm-start pre-placements. Pass
/// an empty slice for the legacy probabilistic-only behavior.
///
/// Each warm-start placement decrements `item_demand_qtys[item_id]` by
/// 1; jagua's solver loop walks items via `while
/// item_demand_qtys[item_id] > 0` (lbf_bpp.rs) so warm-started items
/// are naturally skipped — `solve()` only places remaining demand.
///
/// Warm-start items use `BPLayoutType::Closed { bin_id }`; the first
/// placement to a bin opens its layout and we re-key subsequent
/// placements to that bin to `BPLayoutType::Open(lkey)` so they all
/// land in the same layout instead of opening a fresh one each time.
fn run_single_lbf_with_warm_start(
    instance: &BPInstance,
    seed: u64,
    n_samples: usize,
    ls_frac: f32,
    warm_start: &[(usize, BPPlacement)],
) -> jagua_rs::probs::bpp::entities::BPSolution {
    let config = LBFConfig {
        n_samples,
        ls_frac,
        prng_seed: Some(seed),
        poly_simpl_tolerance: None,
        narrow_concavity_cutoff: None,
        ..LBFConfig::default()
    };

    let rng = SmallRng::seed_from_u64(seed);
    let mut opt = LBFOptimizerBP::new(instance.clone(), config, rng);

    // Pre-place the warm-start. Track LayKey per bin so the second+
    // placement to the same bin lands in its open layout instead of
    // opening a duplicate.
    let mut bin_to_lkey: HashMap<usize, jagua_rs::probs::bpp::entities::LayKey> = HashMap::new();
    for (_item_id, bp_placement) in warm_start {
        let mut placement = *bp_placement;
        if let BPLayoutType::Closed { bin_id } = placement.layout_id {
            if let Some(&lkey) = bin_to_lkey.get(&bin_id) {
                placement.layout_id = BPLayoutType::Open(lkey);
            }
        }
        let bin_id = match bp_placement.layout_id {
            BPLayoutType::Closed { bin_id } => bin_id,
            BPLayoutType::Open(_) => continue, // shouldn't happen for warm-start input
        };
        let (lkey, _) = opt.problem.place_item(placement);
        bin_to_lkey.entry(bin_id).or_insert(lkey);
    }

    opt.solve()
}

/// True when the part is an axis-aligned rectangle the greedy packer
/// can handle. See `run_greedy_warm_start` for filter rationale.
pub fn is_axis_aligned_rect(p: &crate::domain::Part) -> bool {
    if matches!(p.shape_spec.as_ref().map(|s| s.kind.as_str()), Some("rect")) {
        return true;
    }
    if p.shape_spec.is_some() {
        return false;
    }
    // No shape_spec: detect 4-vertex axis-aligned rectangle by polygon.
    let poly = p.polygon_slice();
    if poly.len() != 4 {
        return false;
    }
    // Axis-aligned: every edge is either horizontal or vertical.
    for i in 0..4 {
        let a = poly[i];
        let b = poly[(i + 1) % 4];
        let dx = (a.x - b.x).abs();
        let dy = (a.y - b.y).abs();
        let horizontal = dy < 1e-9 && dx > 1e-9;
        let vertical = dx < 1e-9 && dy > 1e-9;
        if !(horizontal || vertical) {
            return false;
        }
    }
    true
}

/// Build a deterministic warm-start for jagua's BPProblem by running
/// `warm_start::greedy_bottom_left` on the rect-only subset of items,
/// per bin in request order. Returns `(item_id, BPPlacement)` pairs
/// suitable for `run_single_lbf_with_warm_start`.
///
/// Filtering: items with `shape_spec.kind == "rect"` are eligible. This
/// includes user rectangles AND unrolled cylinders (the TS layer ships
/// cylinders as `kind: "rect"` with width = π·diameter). Cones, circles,
/// trapezoids, and raw-polygon parts skip the warm-start and flow
/// straight to LBF.
///
/// Per-bin loop: greedy_bottom_left runs against the remaining-demand
/// rect items for each bin; we decrement demand by what greedy placed
/// before invoking the next bin. Mirrors the per-bin pattern in
/// `pack_lbf_lns_with_config`'s sequential loop.
///
/// item_id: each greedy `SeedPlacement.shape_id` is mapped back to the
/// original `request.items[i]` index (jagua's `BPInstance::item_id`).
/// Items with `quantity > 1` consume one item_id per placement.
fn run_greedy_warm_start(request: &PackRequest) -> Vec<(usize, BPPlacement)> {
    use crate::infrastructure::warm_start::greedy_bottom_left;

    // Filter rect-only items with their original index preserved.
    // Accept either:
    //   (a) explicit shape_spec.kind == "rect" — production AutoNest path
    //       (templateToPart in AutoNest.tsx sets this for both rectangles
    //       AND unrolled cylinders)
    //   (b) no shape_spec AND polygon is an axis-aligned 4-vertex
    //       rectangle — used by Rust unit-test fixtures that build Parts
    //       directly without going through the shape_builder pipeline
    let rect_indexed: Vec<(usize, &crate::domain::Part)> = request
        .items
        .iter()
        .enumerate()
        .filter(|(_, p)| is_axis_aligned_rect(p))
        .collect();

    if rect_indexed.is_empty() {
        return Vec::new();
    }

    // Per-shape remaining demand. Decremented as bins consume items.
    let mut remaining_qty: HashMap<String, u32> = rect_indexed
        .iter()
        .map(|(_, p)| (p.shape_id.clone(), p.quantity))
        .collect();
    // Fresh per-shape instance counter — yields the next item_id slot
    // for jagua. Must mirror the order jagua sees in to_jagua_instance,
    // which numbers items 0..N by their position in request.items.
    // Each shape may have quantity > 1; the demand is split into
    // separate jagua items at import time? No — looking at jagua-rs's
    // BPP import: a single ExtItem with `demand: q` becomes ONE jagua
    // item with multiple "instances." So item_id is per-shape, not
    // per-instance. Each `BPProblem::place_item` call decrements that
    // shape's `item_demand_qtys[item_id]` by 1.
    let mut warm_start: Vec<(usize, BPPlacement)> = Vec::new();

    for (bin_idx, bin) in request.bins.iter().enumerate() {
        // Build the rect-only Part list for this bin from remaining_qty.
        let bin_items: Vec<crate::domain::Part> = rect_indexed
            .iter()
            .filter_map(|(_, p)| {
                let q = *remaining_qty.get(&p.shape_id)?;
                if q == 0 {
                    return None;
                }
                let mut clone = (*p).clone();
                clone.quantity = q;
                Some(clone)
            })
            .collect();

        if bin_items.is_empty() {
            break; // every rect-shape demand satisfied
        }

        let seed_result = match greedy_bottom_left(bin, &bin_items, request.clearance) {
            Ok(r) => r,
            Err(_) => continue,
        };

        for seed in &seed_result.placements {
            // Map shape_id back to the original request.items index.
            let item_id = match rect_indexed
                .iter()
                .find(|(_, p)| p.shape_id == seed.shape_id)
            {
                Some((idx, _)) => *idx,
                None => continue,
            };
            let bp_placement = crate::infrastructure::jagua_adapter::seed_to_bp_placement(
                seed,
                item_id,
                BPLayoutType::Closed { bin_id: bin_idx },
            );
            warm_start.push((item_id, bp_placement));

            // Decrement remaining demand.
            if let Some(q) = remaining_qty.get_mut(&seed.shape_id) {
                *q = q.saturating_sub(1);
            }
        }
    }

    warm_start
}

/// Translate a single-bin `LayoutSnapshot` into RF `Placement`s.
///
/// Mirrors `search::mod::snapshot_to_seed` but writes `Placement` (the
/// domain output type) directly instead of passing through `SeedPlacement`.
/// The `instance_index` field is left as a per-bin counter here â€” the
/// top-level caller renumbers across bins to match the `pack.rs`
/// convention.
fn snapshot_to_placements(
    snap: &LayoutSnapshot,
    instance: &BPInstance,
    items: &[crate::domain::Part],
    bin_id: &str,
    cone_strategy_kind: crate::application::cone_strategy::ConeStrategyKind,
    cone_packing_mode: crate::application::cone_strategy::ConePackingMode,
    clearance: f64,
) -> Vec<Placement> {
    let mut entries: Vec<&PlacedItem> = snap.placed_items.values().collect();
    entries.sort_by_key(|pi| {
        (
            pi.item_id,
            pi.d_transf.translation.0.into_inner().to_bits(),
            pi.d_transf.translation.1.into_inner().to_bits(),
            pi.d_transf.rotation.into_inner().to_bits(),
        )
    });

    // Resolve the cone strategy once. Reused for every placement that
    // turns out to be a cone — avoids per-placement Box allocations.
    let cone_strategy = crate::application::cone_strategy::cone_strategy_for(cone_strategy_kind);

    let mut placements = Vec::with_capacity(entries.len());
    let shift = -clearance as f32;
    for pi in entries {
        let item = instance.item(pi.item_id);
        let pre_transf = &item.shape_orig.pre_transform;
        // Shift translation back into original-bin coords. `build_ext_bin`
        // expanded the bin by `clearance` on every side; subtracting
        // `clearance` here puts placements where the visualizer + free-space
        // extractor expect them (origin (0,0), bounds (W, H)).
        let abs_transf = shift_dtransformation(
            &int_to_ext_transformation(&pi.d_transf, pre_transf),
            shift,
            shift,
        );

        let part = &items[pi.item_id];
        let pack_polygon: Vec<Point2D> = part
            .polygon_slice()
            .iter()
            .map(|p| apply_dtransformation_to_point(&abs_transf, *p))
            .collect();

        // Cones get the strategy's render polygon (e.g. the concave
        // annular crescent for AnnularSector). For cones we also keep
        // the transformed convex hull on the Placement (`pack_polygon`)
        // so the visualizer can show the surface jagua actually
        // collided on.
        //
        // CRITICAL: render-polygon vertices are transformed via the
        // SAME `apply_dtransformation_to_point` call used for the
        // pack polygon. This guarantees bit-identical transform math
        // for both polygons — they cannot drift apart in placed
        // coords no matter what the rotation or translation is. The
        // earlier (now-removed) approach used a parallel f64-based
        // transform that produced visibly misaligned polygons under
        // non-trivial rotations.
        let (polygon, placement_pack_polygon) =
            match crate::application::cone_strategy::cone_dims_from_part(part) {
                Some(_)
                    if cone_packing_mode
                        == crate::application::cone_strategy::ConePackingMode::AnnularSector =>
                {
                    (pack_polygon, None)
                }
                Some(d) => match cone_strategy.render_polygon_local(d) {
                    Some(local) => {
                        let render: Vec<Point2D> = local
                            .iter()
                            .map(|p| apply_dtransformation_to_point(&abs_transf, *p))
                            .collect();
                        (render, Some(pack_polygon))
                    }
                    // Wedge strategy: render polygon == pack polygon,
                    // no overlay needed (they're the same shape).
                    None => (pack_polygon, None),
                },
                None => (pack_polygon, None),
            };

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

        placements.push(Placement {
            shape_id: part.shape_id.clone(),
            // Renumbered globally in pack_lbf_with_config; locally 0 is
            // a placeholder.
            instance_index: 0,
            bin_id: bin_id.to_string(),
            x: abs_transf.translation.0.into_inner() as f64,
            y: abs_transf.translation.1.into_inner() as f64,
            rotation_rad: abs_transf.rotation.into_inner() as f64,
            polygon,
            width,
            height,
            difficulty: None,
            tag: None,
            pack_polygon: placement_pack_polygon,
        });
    }
    placements
}

/// Apply a jagua `DTransformation` (rotate about origin, then translate)
/// to a `Point2D`.
///
/// Precision: jagua-rs exposes transformations in f32, so the f64â†’f32â†’f64
/// round-trip here caps output precision at ~7 significant digits. For
/// REMA's typical coordinate range (0â€“400 inches) that's safely below
/// 0.0001" â€” finer than any physical cut tolerance.
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
            polygon: Some(vec![
                Point2D::new(0.0, 0.0),
                Point2D::new(w, 0.0),
                Point2D::new(w, h),
                Point2D::new(0.0, h),
            ]),
            shape_spec: None,
            allow_rotation: true,
            grain_axis: None,
            difficulty: None,
            tag: None,
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
            cone_strategy: None,
            cone_packing_mode: None,
            scrap_strategy: None,
            offcut_extraction_strategy: None,
            use_warm_start: None,
        }
    }

    #[test]
    fn rejects_empty_bins() {
        let req = simple_request(vec![], vec![rect_part("a", 1, 10.0, 5.0)]);
        assert!(matches!(pack_lbf(req), Err(PackError::NoBins)));
    }

    #[test]
    fn rejects_empty_items() {
        let req = simple_request(vec![bin("b1", 48.0, 96.0)], vec![]);
        assert!(matches!(pack_lbf(req), Err(PackError::NoItems)));
    }

    #[test]
    fn packs_simple_rectangle_fixture() {
        // 3 rects on a generous bin â€” all must fit.
        let req = simple_request(
            vec![bin("b1", 48.0, 96.0)],
            vec![rect_part("rect-a", 3, 10.0, 5.0)],
        );
        let result = pack_lbf(req).unwrap();
        assert_eq!(
            result.placed_count, 3,
            "all 3 rects should fit on a 48x96 bin"
        );
        assert_eq!(result.overflow_count, 0);
        assert_eq!(result.per_bin.len(), 1);
        assert_eq!(result.per_bin[0].bin_id, "b1");
        // Density is >0, efficiency sum sanity.
        assert!(
            result.overall_density > 0.0 && result.overall_density < 1.0,
            "density out of (0,1): {}",
            result.overall_density
        );
    }

    #[test]
    fn rolls_to_second_bin_on_overflow() {
        // 3 rects each almost-full on their respective bin. LBF's uniform
        // sampling is probabilistic; an exactly-fitting item (20Ã—10 in
        // 20Ã—10) would require sampling x=0, y=0 exactly, which has
        // zero probability under continuous uniform sampling. Use 18Ã—9
        // rects so there is 2Ã—1 of slack â€” LBF has positive probability
        // per sample of finding a feasible position.
        let req = simple_request(
            vec![bin("A", 20.0, 10.0), bin("B", 20.0, 10.0)],
            vec![rect_part("big", 3, 18.0, 9.0)],
        );
        let result = pack_lbf(req).unwrap();
        assert_eq!(
            result.placed_count, 2,
            "each 20x10 bin can hold one 18x9; third should overflow"
        );
        assert_eq!(result.overflow_count, 1);
    }

    #[test]
    fn deterministic_under_seed() {
        let req = simple_request(
            vec![bin("b1", 48.0, 96.0)],
            vec![rect_part("r", 5, 10.0, 5.0)],
        );
        let a = pack_lbf(req.clone()).unwrap();
        let b = pack_lbf(req).unwrap();

        assert_eq!(a.placed_count, b.placed_count);
        assert_eq!(a.placements.len(), b.placements.len());
        for (pa, pb) in a.placements.iter().zip(b.placements.iter()) {
            assert_eq!(pa.shape_id, pb.shape_id);
            assert_eq!(pa.instance_index, pb.instance_index);
            assert!(
                (pa.x - pb.x).abs() < 1e-6,
                "x differs: {} vs {}",
                pa.x,
                pb.x
            );
            assert!((pa.y - pb.y).abs() < 1e-6);
            assert!((pa.rotation_rad - pb.rotation_rad).abs() < 1e-6);
        }
    }

    #[test]
    fn run_time_ms_populated() {
        let req = simple_request(
            vec![bin("b1", 48.0, 96.0)],
            vec![rect_part("r", 2, 10.0, 5.0)],
        );
        let result = pack_lbf(req).unwrap();
        assert!(result.run_time_ms.is_some());
    }
}
