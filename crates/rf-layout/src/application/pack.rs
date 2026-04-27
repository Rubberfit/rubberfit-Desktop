// engine/crates/rf-layout/src/application/pack.rs
use crate::domain::{BinResult, PackError, PackRequest, PackResult, Placement, SearchOptions};
use crate::infrastructure::search::assignment::ffd::ffd_assign;
use crate::infrastructure::search::multi::optimize_multi_with_hooks;
use crate::infrastructure::search::progress::ProgressEmitter;
use std::collections::HashMap;
use std::time::Instant;

/// Top-level pack entry point without runtime hooks. Delegates to
/// `pack_with_options` with default (no callback, no cancel token).
pub fn pack(request: PackRequest) -> Result<PackResult, PackError> {
    pack_with_options(request, SearchOptions::default())
}

/// Task 14 public entry point accepting a `SearchOptions` for progress
/// streaming + cooperative cancellation. pack-cli (Task 15) attaches
/// a NDJSON-serializing callback when `--stream` is set, and a
/// stdin-driven cancel token when cancel lines appear on stdin.
pub fn pack_with_options(
    mut request: PackRequest,
    options: SearchOptions,
) -> Result<PackResult, PackError> {
    if request.bins.is_empty() {
        return Err(PackError::NoBins);
    }
    if request.items.is_empty() {
        return Err(PackError::NoItems);
    }

    // Materialise polygons up front so downstream search/jagua code
    // can assume every part has a polygon. See
    // `application::shape_builder` (rect/circle/trapezoid/ngon/sector
    // are all built Rust-side from `Part.shape_spec`).
    crate::application::shape_builder::materialise_request_polygons(&mut request)?;

    let started_at = Instant::now();

    // Task 10: single up-front FFD pass decides which items go to which
    // bin. Task 12: `optimize_multi` refines across bins via cross-bin
    // swap operators + per-bin GLS. Task 14: hooks via SearchOptions.
    let assignment = ffd_assign(&request.bins, &request.items, request.clearance)?;

    let emitter = options
        .progress_callback
        .clone()
        .map(|cb| ProgressEmitter::new(Some(cb), started_at));
    let outcome =
        optimize_multi_with_hooks(assignment, &request, options.cancel_token.clone(), emitter)?;
    let refined = outcome.assignment;
    let was_cancelled = outcome.was_cancelled;

    let mut placements: Vec<Placement> = Vec::new();
    let mut per_bin: Vec<BinResult> = Vec::new();
    let mut index_counters: HashMap<String, u32> = HashMap::new();

    // Resolve the cone render strategy once. Reused for every cone
    // placement in the loop below — avoids per-placement Box allocations.
    let cone_strategy = crate::application::cone_strategy::cone_strategy_for(
        request.cone_strategy.unwrap_or_default(),
    );
    let cone_packing_mode = request.cone_packing_mode.unwrap_or_default();
    // Lookup table from shape_id to (optional) cone dimensions, so the
    // hot loop below avoids rescanning request.items per placement.
    let cone_dims_by_shape: HashMap<String, crate::application::cone_strategy::ConeDimensions> =
        request
            .items
            .iter()
            .filter_map(|p| {
                crate::application::cone_strategy::cone_dims_from_part(p)
                    .map(|d| (p.shape_id.clone(), d))
            })
            .collect();

    for (bin, seed) in request.bins.iter().zip(refined.per_bin) {
        let mut used_area = 0.0_f64;
        let mut occupied_width = 0.0_f64;
        let mut occupied_height = 0.0_f64;

        for p in seed.placements {
            // Global `instance_index` renumbering per shape â€” stays in
            // pack.rs post-processing per Codex sign-off (Â§8). The
            // search layer emits bin-local indices; this makes them
            // globally unique across the whole PackResult.
            let counter = index_counters.entry(p.shape_id.clone()).or_insert(0);
            let instance_index = *counter;
            *counter += 1;

            // Cones get the strategy-chosen render polygon (annular
            // crescent for AnnularSector); every other shape passes
            // its transformed pack polygon straight through. For
            // cones, also stash the transformed pack polygon (=
            // SeedPlacement.polygon = the transformed convex hull)
            // on the Placement so the visualizer can paint it as a
            // debug overlay.
            //
            // Render-polygon vertices are transformed via the same
            // f32-round-trip math jagua used for the pack polygon
            // (see `apply_placement_transform` below) so pack and
            // render stay bit-aligned in placed coords.
            let (polygon, pack_polygon) = match cone_dims_by_shape.get(&p.shape_id) {
                Some(_)
                    if cone_packing_mode
                        == crate::application::cone_strategy::ConePackingMode::AnnularSector =>
                {
                    (p.polygon, None)
                }
                Some(d) => match cone_strategy.render_polygon_local(*d) {
                    Some(local) => {
                        let render: Vec<rf_geom::domain::Point2D> = local
                            .iter()
                            .map(|q| apply_placement_transform(*q, p.x, p.y, p.rotation_rad))
                            .collect();
                        let pack = p.polygon.clone();
                        (render, Some(pack))
                    }
                    None => (p.polygon, None),
                },
                None => (p.polygon, None),
            };

            let area = polygon_area(&polygon);
            used_area += area;

            for v in &polygon {
                if v.x > occupied_width {
                    occupied_width = v.x;
                }
                if v.y > occupied_height {
                    occupied_height = v.y;
                }
            }

            placements.push(Placement {
                shape_id: p.shape_id,
                instance_index,
                bin_id: p.bin_id,
                x: p.x,
                y: p.y,
                rotation_rad: p.rotation_rad,
                polygon,
                width: p.width,
                height: p.height,
                difficulty: None,
                tag: None,
                pack_polygon,
            });
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

        let _ = seed.overflow;
    }

    // Overflow = total requested across all shapes minus total placed.
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
        was_cancelled,
    })
}

fn polygon_area(poly: &[rf_geom::domain::Point2D]) -> f64 {
    let mut s = 0.0;
    for i in 0..poly.len() {
        let a = poly[i];
        let b = poly[(i + 1) % poly.len()];
        s += a.x * b.y - b.x * a.y;
    }
    s.abs() / 2.0
}

/// Bit-identical replica of jagua-rs's `apply_dtransformation_to_point`
/// (in `pack_lbf.rs`) but parameterised on f64 inputs from a
/// `SeedPlacement`. SeedPlacement.x/y/rotation_rad came from
/// `abs_transf.{translation, rotation}.into_inner() as f64` — i.e.
/// f32 values losslessly widened — so casting back to f32 here
/// produces the same f32 values jagua used. Then the f32 rotation +
/// f32 translation arithmetic matches jagua's exactly.
///
/// Used to align cone render polygons with cone pack polygons in
/// placed (bin-local) coords without depending on jagua's
/// `DTransformation` type from this orchestration layer.
fn apply_placement_transform(
    p: rf_geom::domain::Point2D,
    tx: f64,
    ty: f64,
    rotation_rad: f64,
) -> rf_geom::domain::Point2D {
    let theta = rotation_rad as f32;
    let cos = theta.cos();
    let sin = theta.sin();
    let (px, py) = (p.x as f32, p.y as f32);
    let rx = px * cos - py * sin + (tx as f32);
    let ry = px * sin + py * cos + (ty as f32);
    rf_geom::domain::Point2D::new(rx as f64, ry as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Bin, BinKind, PackMode, Part};
    use rf_geom::domain::Point2D;

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

    #[test]
    fn rejects_empty_bins() {
        let req = PackRequest {
            bins: vec![],
            clearance: 0.125,
            items: vec![rect_part("a", 1, 10.0, 5.0)],
            operator_profile: None,
            mode: None,
            engine: None,
            time_budget_ms: None,
            improvement_budget_ms: None,
            seed: None,
            units: Default::default(),
            cone_strategy: None,
            cone_packing_mode: None,
            scrap_strategy: None,
            offcut_extraction_strategy: None,
            use_warm_start: None,
        };
        assert!(matches!(pack(req), Err(PackError::NoBins)));
    }

    #[test]
    fn rejects_empty_items() {
        let req = PackRequest {
            bins: vec![bin("b1", 48.0, 96.0)],
            clearance: 0.125,
            items: vec![],
            operator_profile: None,
            mode: None,
            engine: None,
            time_budget_ms: None,
            improvement_budget_ms: None,
            seed: None,
            units: Default::default(),
            cone_strategy: None,
            cone_packing_mode: None,
            scrap_strategy: None,
            offcut_extraction_strategy: None,
            use_warm_start: None,
        };
        assert!(matches!(pack(req), Err(PackError::NoItems)));
    }

    #[test]
    fn packs_single_bin_homogeneous() {
        let req = PackRequest {
            bins: vec![bin("b1", 48.0, 96.0)],
            clearance: 0.125,
            items: vec![rect_part("rect-a", 3, 10.0, 5.0)],
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
        };
        let result = pack(req).unwrap();
        assert_eq!(result.placed_count, 3);
        assert_eq!(result.overflow_count, 0);
        assert_eq!(result.per_bin.len(), 1);
        assert_eq!(result.per_bin[0].bin_id, "b1");
    }

    #[test]
    fn instance_indices_are_globally_unique_per_shape() {
        let req = PackRequest {
            bins: vec![bin("b1", 20.0, 20.0), bin("b2", 20.0, 20.0)],
            clearance: 0.0, // items exactly fill bin width; clearance tested elsewhere
            items: vec![rect_part("rect-a", 8, 20.0, 5.0)],
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
        };
        let result = pack(req).unwrap();
        let a_indices: Vec<u32> = result
            .placements
            .iter()
            .filter(|p| p.shape_id == "rect-a")
            .map(|p| p.instance_index)
            .collect();
        // All instance_indices must be unique across bins
        let mut sorted = a_indices.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(
            a_indices.len(),
            sorted.len(),
            "instance_index must be globally unique per shape"
        );
    }

    #[test]
    fn overflow_counted_when_bin_too_small() {
        let req = PackRequest {
            bins: vec![bin("b1", 10.0, 10.0)],
            clearance: 0.0, // items exactly fill bin width; clearance tested elsewhere
            items: vec![rect_part("rect-a", 5, 10.0, 5.0)], // only 2 fit
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
        };
        let result = pack(req).unwrap();
        assert_eq!(result.placed_count, 2);
        assert_eq!(result.overflow_count, 3);
    }

    #[test]
    fn run_time_ms_populated_and_density_computed() {
        let req = PackRequest {
            bins: vec![bin("b1", 48.0, 96.0)],
            clearance: 0.125,
            items: vec![rect_part("rect-a", 3, 10.0, 5.0)],
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
        };
        let result = pack(req).unwrap();
        assert!(
            result.run_time_ms.is_some(),
            "run_time_ms must be populated"
        );
        assert!(result.overall_density > 0.0);
        assert!(result.overall_density <= 1.0);
    }

    #[test]
    fn pack_uses_ffd_routing() {
        // Task 10 regression: input order is smallâ†’smallâ†’big across 2
        // bins where naive per-bin spillover overflows but FFD
        // (area-desc sort) fits everything.
        //
        // Bins: A=20Ã—20, B=20Ã—15. Items in request order:
        //   small1 = 10Ã—10, small2 = 10Ã—5, big = 20Ã—20.
        //
        // Naive (pre-Task-10): big tries bin A after smalls, 10+5+20=35>20
        // fails; big tries bin B, 20>15 fails â†’ overflow=1.
        // FFD: big first â†’ bin A. smalls next â†’ bin B (each fits).
        // â†’ overflow_count == 0.
        let req = PackRequest {
            bins: vec![bin("A", 20.0, 20.0), bin("B", 20.0, 15.0)],
            clearance: 0.0,
            items: vec![
                rect_part("small1", 1, 10.0, 10.0),
                rect_part("small2", 1, 10.0, 5.0),
                rect_part("big", 1, 20.0, 20.0),
            ],
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
        };
        let result = pack(req).unwrap();
        assert_eq!(
            result.overflow_count, 0,
            "FFD routing must fit all items across bins; got {} overflow",
            result.overflow_count
        );
        assert_eq!(result.placed_count, 3);
    }

    #[test]
    fn wall_flush_placements_stay_in_original_bin_bounds() {
        // After the wall-flush change (jagua_adapter expands bin by
        // clearance + snapshot_to_placements shifts by -clearance),
        // every placement polygon must stay within [0, W] × [0, H] of
        // the ORIGINAL bin — not the expanded one. This catches a
        // misapplied shift (e.g., wrong sign, doubled, missed).
        let req = PackRequest {
            bins: vec![bin("b1", 24.0, 24.0)],
            clearance: 0.125,
            items: vec![rect_part("rect-a", 4, 6.0, 6.0)],
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
        };
        let result = pack(req).unwrap();
        assert!(result.placed_count > 0, "at least some parts must place");
        for p in &result.placements {
            for v in &p.polygon {
                assert!(
                    v.x >= -1e-6,
                    "polygon vertex {:?} has x < 0 (shift bug?)",
                    v
                );
                assert!(
                    v.y >= -1e-6,
                    "polygon vertex {:?} has y < 0 (shift bug?)",
                    v
                );
                assert!(
                    v.x <= 24.0 + 1e-6,
                    "polygon vertex {:?} has x > bin width (shift bug?)",
                    v
                );
                assert!(
                    v.y <= 24.0 + 1e-6,
                    "polygon vertex {:?} has y > bin height (shift bug?)",
                    v
                );
            }
        }
    }

    // R6 — three tests documenting that wall-flush + Option C greedy
    // warm-start let near-bin-size rectangles fit reliably. Pre-Option-C,
    // the LBF probabilistic sampler couldn't hit the 1×1 valid centroid
    // region in a ~4636 in² container; the warm-start now places the
    // 47×95 part deterministically before LBF sampling runs. Closed #18.

    #[test]
    fn r6_near_bin_size_part_fits_via_pack_lbf() {
        // Test pack_lbf directly (no LNS, no consolidation) to isolate
        // where R6 fails.
        let req = PackRequest {
            bins: vec![bin("b1", 48.0, 96.0)],
            clearance: 0.125,
            items: vec![rect_part("near-full", 1, 47.0, 95.0)],
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
        };
        let result = crate::application::pack_lbf::pack_lbf(req).unwrap();
        assert_eq!(
            result.placed_count, 1,
            "47x95 part should fit on 48x96 bin via pack_lbf; got placed={}, overflow={}",
            result.placed_count, result.overflow_count
        );
    }

    #[test]
    fn r6_near_bin_size_part_fits_via_pack_lbf_lns() {
        // Same as r6_near_bin_size_part_fits_with_wall_flush but
        // routes through pack_lbf_lns (the production path the Tauri
        // frontend hits, not the FFD-orchestrated `pack` entry).
        let req = PackRequest {
            bins: vec![bin("b1", 48.0, 96.0)],
            clearance: 0.125,
            items: vec![rect_part("near-full", 1, 47.0, 95.0)],
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
        };
        let result = crate::application::pack_lbf_lns::pack_lbf_lns(req).unwrap();
        assert_eq!(
            result.placed_count, 1,
            "47x95 part should fit on 48x96 bin via pack_lbf_lns; got placed={}, overflow={}",
            result.placed_count, result.overflow_count
        );
    }

    #[test]
    fn r6_near_bin_size_part_fits_with_wall_flush() {
        // 47×95 part on a 48×96 bin with 0.125 kerf. Pre-wall-flush:
        // needed 47.25×95.25 of bin = 0×0 valid centroid region →
        // overflow. Post-wall-flush: needs exactly 47×95 = 1×1 valid
        // centroid region. LBF probabilistic sampling should still find
        // it within 5000 samples × 10 multistart seeds.
        let req = PackRequest {
            bins: vec![bin("b1", 48.0, 96.0)],
            clearance: 0.125,
            items: vec![rect_part("near-full", 1, 47.0, 95.0)],
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
        };
        let result = pack(req).unwrap();
        assert_eq!(
            result.placed_count, 1,
            "47x95 part should fit on 48x96 bin post-wall-flush; got placed={}, overflow={}",
            result.placed_count, result.overflow_count
        );
    }

    #[test]
    fn user_fixture_consolidates_rectangles() {
        // Mimic the user's reported scenario: ~8× 6x6 rectangles on
        // 24x24 stock with 0.125 kerf. Auto-fill estimate would be
        // ceil(8×36/576 × 1.54) = ceil(0.77) = 1 bin needed, but the
        // allocator clamps to MIN_SHEETS=1. Pretend the operator
        // demanded more parts than fit (e.g., 12) so allocator gives 2
        // bins. Verify the outer pack_lbf_lns loop actually fills bin 1
        // before spilling to bin 2.
        let mut bins = Vec::with_capacity(5);
        for i in 0..5 {
            bins.push(bin(&format!("b{i}"), 24.0, 24.0));
        }
        let req = PackRequest {
            bins,
            clearance: 0.125,
            // 5× 6x6 — should ALL fit in 1 bin (3x3=9 max)
            items: vec![rect_part("rect-a", 5, 6.0, 6.0)],
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
        };
        let result = pack(req).unwrap();
        let bins_with_placements: std::collections::HashSet<&str> = result
            .placements
            .iter()
            .map(|p| p.bin_id.as_str())
            .collect();
        let parts_per_bin: std::collections::HashMap<&str, u32> =
            result
                .placements
                .iter()
                .fold(Default::default(), |mut m, p| {
                    *m.entry(p.bin_id.as_str()).or_insert(0) += 1;
                    m
                });
        // 5× 6x6 in 24x24 (kerf 0.125): max 9 per bin, all 5 should
        // consolidate to a single bin.
        assert_eq!(
            bins_with_placements.len(),
            1,
            "5× 6x6 parts should fit in 1 bin, got {} bins: {:?}",
            bins_with_placements.len(),
            parts_per_bin
        );
    }

    #[test]
    fn small_part_count_consolidates_to_fewest_bins() {
        // 4 small parts (3×3) with the auto-fill allocator declaring 5
        // bins of 24×24 — same shape as the multi-sheet over-allocation
        // case. Pre-fix: LBF spreads parts across 2-5 bins because
        // probabilistic sampling occasionally misses a fit in the open
        // bin and spills to a new one. Post-fix: the bins-used
        // tiebreaker in the multistart selection favors the attempt
        // that put everything in one bin.
        let mut bins = Vec::with_capacity(5);
        for i in 0..5 {
            bins.push(bin(&format!("b{i}"), 24.0, 24.0));
        }
        let req = PackRequest {
            bins,
            clearance: 0.125,
            items: vec![rect_part("rect-a", 4, 3.0, 3.0)],
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
        };
        let result = pack(req).unwrap();
        assert_eq!(result.placed_count, 4);
        assert_eq!(result.overflow_count, 0);
        let bins_with_placements: std::collections::HashSet<&str> = result
            .placements
            .iter()
            .map(|p| p.bin_id.as_str())
            .collect();
        assert_eq!(
            bins_with_placements.len(),
            1,
            "4 small parts on a 24x24 bin should consolidate to a single bin (got {} bins: {:?})",
            bins_with_placements.len(),
            bins_with_placements
        );
    }

    #[test]
    fn auto_fill_overallocation_skips_empty_bins() {
        // The frontend auto-fill bin allocator over-allocates by ~1.54×
        // (1/PACKING_EFFICIENCY_FLOOR). 10 declared bins where parts
        // comfortably fit in ~2 should run fast; this proves the empty
        // bins jagua creates are essentially free.
        let mut bins = Vec::with_capacity(10);
        for i in 0..10 {
            bins.push(bin(&format!("b{i}"), 20.0, 20.0));
        }
        let req = PackRequest {
            bins,
            clearance: 0.125,
            // 8 small parts, each 5×5 — easily 16 per 20×20 bin, so all
            // 8 fit in bin 0; bins 1..9 stay empty.
            items: vec![rect_part("rect-a", 8, 5.0, 5.0)],
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
        };
        let start = std::time::Instant::now();
        let result = pack(req).unwrap();
        let elapsed = start.elapsed();
        assert_eq!(result.placed_count, 8);
        assert_eq!(result.overflow_count, 0);
        // 2s ceiling sized for debug builds; release is well under
        // 100ms. Empty bins fall out of the per-bin loop with zero
        // placements.
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "over-allocation should be cheap; got {elapsed:?}"
        );
        let bins_with_placements: std::collections::HashSet<String> =
            result.placements.iter().map(|p| p.bin_id.clone()).collect();
        assert!(
            bins_with_placements.len() <= 2,
            "8 parts of 5x5 should fit in 1-2 bins; saw {} bins used",
            bins_with_placements.len()
        );
    }

    #[test]
    fn multi_bin_overflow_rollover() {
        let req = PackRequest {
            bins: vec![bin("b1", 20.0, 10.0), bin("b2", 20.0, 10.0)],
            clearance: 0.0, // items exactly fill bin width; clearance tested elsewhere
            items: vec![rect_part("rect-a", 3, 20.0, 5.0)], // 2 fit on b1, 1 spills to b2
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
        };
        let result = pack(req).unwrap();
        assert_eq!(result.placed_count, 3);
        assert_eq!(result.overflow_count, 0);
        let bins_used: std::collections::HashSet<String> =
            result.placements.iter().map(|p| p.bin_id.clone()).collect();
        assert!(bins_used.len() > 1, "rect-a should span multiple bins");
    }
}
