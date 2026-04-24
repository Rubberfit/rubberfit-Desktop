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
    request: PackRequest,
    options: SearchOptions,
) -> Result<PackResult, PackError> {
    if request.bins.is_empty() {
        return Err(PackError::NoBins);
    }
    if request.items.is_empty() {
        return Err(PackError::NoItems);
    }

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

    for (bin, seed) in request.bins.iter().zip(refined.per_bin) {
        let mut used_area = 0.0_f64;
        let mut occupied_width = 0.0_f64;
        let mut occupied_height = 0.0_f64;

        for p in seed.placements {
            // Global `instance_index` renumbering per shape — stays in
            // pack.rs post-processing per Codex sign-off (§8). The
            // search layer emits bin-local indices; this makes them
            // globally unique across the whole PackResult.
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
                shape_id: p.shape_id,
                instance_index,
                bin_id: p.bin_id,
                x: p.x,
                y: p.y,
                rotation_rad: p.rotation_rad,
                polygon: p.polygon,
                width: p.width,
                height: p.height,
                difficulty: None,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Bin, BinKind, PackMode, Part};
    use rf_geom::domain::Point2D;

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
        // Task 10 regression: input order is small→small→big across 2
        // bins where naive per-bin spillover overflows but FFD
        // (area-desc sort) fits everything.
        //
        // Bins: A=20×20, B=20×15. Items in request order:
        //   small1 = 10×10, small2 = 10×5, big = 20×20.
        //
        // Naive (pre-Task-10): big tries bin A after smalls, 10+5+20=35>20
        // fails; big tries bin B, 20>15 fails → overflow=1.
        // FFD: big first → bin A. smalls next → bin B (each fits).
        // → overflow_count == 0.
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
        };
        let result = pack(req).unwrap();
        assert_eq!(result.placed_count, 3);
        assert_eq!(result.overflow_count, 0);
        let bins_used: std::collections::HashSet<String> =
            result.placements.iter().map(|p| p.bin_id.clone()).collect();
        assert!(bins_used.len() > 1, "rect-a should span multiple bins");
    }
}
