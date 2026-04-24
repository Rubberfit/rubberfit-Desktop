// engine/crates/rf-layout/src/application/pack_lbf.rs
//
// Phase 1 LBF adoption (opt-in parallel path to pack()).
//
// Wraps jagua-rs's `LBFOptimizerBP` with a deterministic multistart and
// maps its BPSolution back into REMA's `PackResult` shape. This path
// bypasses the FFD + cross-bin-swap + GLS pipeline entirely — LBF does
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
use crate::infrastructure::jagua_adapter::to_jagua_instance;
use jagua_rs::entities::{Instance, LayoutSnapshot, PlacedItem};
use jagua_rs::geometry::DTransformation;
use jagua_rs::io::export::int_to_ext_transformation;
use jagua_rs::probs::bpp::entities::BPInstance;
use lbf::config::LBFConfig;
use lbf::opt::lbf_bpp::LBFOptimizerBP;
use rand::rngs::SmallRng;
use rand::SeedableRng;
use rf_geom::domain::Point2D;
use std::collections::HashMap;
use std::time::Instant;

/// Default sample budget per item per attempt. 5_000 is the empirical
/// sweet-spot from `tests/lbf_bench.rs` — below this the solver leaves
/// items unplaced; above this the LBF loss function (x_max*10 + y_max)
/// over-tightens and strands the tail.
const DEFAULT_N_SAMPLES: usize = 5_000;

/// Local-search fraction of the sample budget. Matches the lbf crate's
/// default.
const DEFAULT_LS_FRAC: f32 = 0.2;

/// How many seeds to try when no seed is supplied by the caller.
/// Multistart dominates single-run because LBF is a randomized greedy
/// heuristic with no backtracking; the bench shows wide variance across
/// seeds (seed=42 → 24/37, seed=3 → 32/37 at matching configs).
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
}

impl Default for PackLbfConfig {
    fn default() -> Self {
        Self {
            n_samples: DEFAULT_N_SAMPLES,
            ls_frac: DEFAULT_LS_FRAC,
            multistart_seeds: DEFAULT_MULTISTART_SEEDS,
        }
    }
}

/// Polygon-aware multi-bin packer backed by jagua-rs `LBFOptimizerBP`.
///
/// Drop-in alternative to [`crate::application::pack::pack`] — same
/// input, same output. Set `USE_LBF_ENGINE=true` at the pack-cli caller
/// to route through this path.
pub fn pack_lbf(request: PackRequest) -> Result<PackResult, PackError> {
    pack_lbf_with_config(request, PackLbfConfig::default())
}

/// Extended entry point exposing [`PackLbfConfig`] for benches / tuning.
pub fn pack_lbf_with_config(
    request: PackRequest,
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
            "multistart_seeds must be ≥ 1".into(),
        ));
    }

    let started_at = Instant::now();

    let instance = to_jagua_instance(&request.bins, &request.items, request.clearance)?;

    // Honour the caller's time_budget_ms if supplied. We stop launching
    // new multistart attempts once the deadline elapses — the best
    // result so far is returned. At least one attempt always runs.
    let deadline = request
        .time_budget_ms
        .map(|ms| started_at + std::time::Duration::from_millis(ms));

    // Deterministic seed sequence from the caller's (optional) base seed.
    // Falls back to a fixed 42 when the request omits the seed so results
    // stay reproducible across runs. Multistart derives attempt seeds by
    // `base + offset` — each attempt explores a different RNG trajectory.
    let base_seed = request.seed.unwrap_or(42);
    let seeds: Vec<u64> = (0..cfg.multistart_seeds as u64)
        .map(|i| base_seed.wrapping_add(i))
        .collect();

    // Run multistart, keep the best-placed attempt. Ties broken by
    // higher density (more compact layout when placement count matches).
    // The first attempt always seeds `best_*` so we have a baseline even
    // when every attempt places zero items — "zero placements" is a
    // valid result (e.g. all items oversized vs the bins) and must not
    // degrade into an Err.
    let mut best_solution: Option<jagua_rs::probs::bpp::entities::BPSolution> = None;
    let mut best_placed: usize = 0;
    let mut best_density: f32 = 0.0;
    for (attempts_run, seed) in seeds.into_iter().enumerate() {
        // Deadline check — but always run the first attempt so the
        // caller gets a valid result even if the budget is too tight.
        if attempts_run > 0 && deadline.is_some_and(|d| std::time::Instant::now() >= d) {
            break;
        }

        let sol = run_single_lbf(&instance, seed, cfg.n_samples, cfg.ls_frac);
        let placed: usize = sol
            .layout_snapshots
            .values()
            .map(|ls| ls.placed_items.len())
            .sum();
        let density = sol.density(&instance);

        let is_better = best_solution.is_none()
            || placed > best_placed
            || (placed == best_placed && density > best_density);
        if is_better {
            best_solution = Some(sol);
            best_placed = placed;
            best_density = density;
        }
    }

    let solution = best_solution.expect("multistart_seeds ≥ 1 guarantees a best_solution");

    let mut placements: Vec<Placement> = Vec::new();
    let mut per_bin: Vec<BinResult> = Vec::new();
    let mut index_counters: HashMap<String, u32> = HashMap::new();

    // The order of `request.bins` matters — it determines per_bin ordering
    // in the output. We walk it explicitly so an empty bin appears as a
    // zero-filled BinResult and so bin ordering is request-stable rather
    // than SlotMap-key-order. `to_jagua_instance` assigns container.id =
    // the bin's index in request.bins, so `enumerate()` is the natural
    // lookup — no O(n²) inner search needed.
    for (bin_idx, bin) in request.bins.iter().enumerate() {
        let layout = solution
            .layout_snapshots
            .values()
            .find(|ls| ls.container.id == bin_idx);

        let mut used_area = 0.0_f64;
        let mut occupied_width = 0.0_f64;
        let mut occupied_height = 0.0_f64;

        if let Some(ls) = layout {
            let placements_this_bin =
                snapshot_to_placements(ls, &instance, &request.items, &bin.bin_id);

            for p in placements_this_bin {
                // Global `instance_index` renumbering per shape — same
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

/// Run one LBF attempt. Mirrors `tests/lbf_bench.rs::run_lbf` but lives
/// inside the crate so the pack path and the bench can't drift.
fn run_single_lbf(
    instance: &BPInstance,
    seed: u64,
    n_samples: usize,
    ls_frac: f32,
) -> jagua_rs::probs::bpp::entities::BPSolution {
    // Pre-simplification + concavity smoothing are jagua-rs knobs for
    // reducing CDE load. RF polygons come from user CSVs and already
    // match domain units exactly; we do not want surprising geometry
    // changes inside the solver.
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
    opt.solve()
}

/// Translate a single-bin `LayoutSnapshot` into RF `Placement`s.
///
/// Mirrors `search::mod::snapshot_to_seed` but writes `Placement` (the
/// domain output type) directly instead of passing through `SeedPlacement`.
/// The `instance_index` field is left as a per-bin counter here — the
/// top-level caller renumbers across bins to match the `pack.rs`
/// convention.
fn snapshot_to_placements(
    snap: &LayoutSnapshot,
    instance: &BPInstance,
    items: &[crate::domain::Part],
    bin_id: &str,
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
        });
    }
    placements
}

/// Apply a jagua `DTransformation` (rotate about origin, then translate)
/// to a `Point2D`.
///
/// Precision: jagua-rs exposes transformations in f32, so the f64→f32→f64
/// round-trip here caps output precision at ~7 significant digits. For
/// REMA's typical coordinate range (0–400 inches) that's safely below
/// 0.0001" — finer than any physical cut tolerance.
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
        assert!(matches!(pack_lbf(req), Err(PackError::NoBins)));
    }

    #[test]
    fn rejects_empty_items() {
        let req = simple_request(vec![bin("b1", 48.0, 96.0)], vec![]);
        assert!(matches!(pack_lbf(req), Err(PackError::NoItems)));
    }

    #[test]
    fn packs_simple_rectangle_fixture() {
        // 3 rects on a generous bin — all must fit.
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
        // sampling is probabilistic; an exactly-fitting item (20×10 in
        // 20×10) would require sampling x=0, y=0 exactly, which has
        // zero probability under continuous uniform sampling. Use 18×9
        // rects so there is 2×1 of slack — LBF has positive probability
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
