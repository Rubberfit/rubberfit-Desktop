// engine/crates/rf-layout/src/application/crossbin.rs
//
// Phase 3 follow-up — Codex's Option E: cross-bin move-out.
//
// After the sequential LBF+LNS+polish pipeline produces a multi-bin
// layout, this operator tries to reduce the Fab `Nesting` component
// by moving ONE item at a time between bins. Nesting = totalUsed /
// totalOccupiedArea; the only way to improve it at fixed totalUsed
// is to reduce `totalOccupiedArea` = Σ(bin.width × occupied_height).
//
// The move-out idea: if roll-1 has an item protruding at its top
// (i.e., removing it drops roll-1's occupied_height), AND that item
// can slot into roll-2 WITHOUT increasing roll-2's occupied_height
// by a larger amount, the total shrinks and Nesting rises.
//
// Per the research:
//   - Gemini called this "Option E, +1.5-3 Fab points on fixtures
//     with a 'keystone' item."
//   - Codex ranked it second after the core polish.
//
// On the production 37-part fixture this operator may be a no-op
// because the items that CAN reduce roll-1's max_y don't fit into
// roll-2 without bumping roll-2's max_y more. We still ship it —
// (a) other fixtures may benefit, (b) it's a clean safety net that
// never regresses (we accept moves only on strict improvement).

use crate::application::polish::{polish_placements, PolishConfig};
use crate::domain::{Bin, PackResult, Placement};
use rf_geom::domain::Point2D;
use std::collections::HashMap;

/// Minimum improvement (sq in of freed occupied area) to accept a move.
/// Keeps us from churning on near-ties.
const MIN_IMPROVEMENT_SQIN: f64 = 1.0;

/// Try to move one item between bins to reduce Σ(bin.width ×
/// occupied_height). Iterates up to `max_iterations` times; each
/// iteration applies the single best single-item move across all
/// (src, dst) pairs, or stops if no improvement is available.
///
/// Preserves placement count, bin assignment count, and the Placement
/// pool itself — only bin_id and polygon positions change for the
/// moved item. Runs polish on affected bins after each move so the
/// target bin compacts the newly-added item against its existing
/// layout.
pub fn try_cross_bin_moveout(
    mut result: PackResult,
    bins: &[Bin],
    clearance: f64,
    max_iterations: usize,
) -> PackResult {
    if bins.len() < 2 || result.placements.is_empty() {
        return result;
    }

    let polish_cfg = PolishConfig {
        clearance,
        ..PolishConfig::default()
    };

    for _iter in 0..max_iterations {
        let baseline_occ = total_occupied_area(&result, bins);
        let Some(best) = find_best_move(&result, bins, clearance, baseline_occ, &polish_cfg) else {
            break;
        };
        if best.improvement < MIN_IMPROVEMENT_SQIN {
            break;
        }
        result = apply_move(result, bins, clearance, &best, &polish_cfg);
    }

    // Final consistency refresh of top-level totals.
    refresh_totals(&mut result);
    result
}

#[derive(Debug, Clone)]
struct MoveCandidate {
    src_bin_idx: usize,
    dst_bin_idx: usize,
    /// Index into `result.placements` of the item being moved.
    placement_idx: usize,
    improvement: f64,
}

fn find_best_move(
    result: &PackResult,
    bins: &[Bin],
    clearance: f64,
    baseline_occ: f64,
    polish_cfg: &PolishConfig,
) -> Option<MoveCandidate> {
    let mut best: Option<MoveCandidate> = None;

    for src_bin_idx in 0..bins.len() {
        for dst_bin_idx in 0..bins.len() {
            if src_bin_idx == dst_bin_idx {
                continue;
            }
            let src_bin = &bins[src_bin_idx];
            // Every placement currently on the source bin is a
            // candidate. We iterate by index so we can rebuild
            // the simulated `Placement` vec cheaply per trial.
            for (pi, placement) in result.placements.iter().enumerate() {
                if placement.bin_id != src_bin.bin_id {
                    continue;
                }
                let Some(simulated_occ) = simulate_move_occupied(
                    result,
                    bins,
                    src_bin_idx,
                    dst_bin_idx,
                    pi,
                    clearance,
                    polish_cfg,
                ) else {
                    continue;
                };
                let improvement = baseline_occ - simulated_occ;
                if improvement > best.as_ref().map(|b| b.improvement).unwrap_or(0.0) {
                    best = Some(MoveCandidate {
                        src_bin_idx,
                        dst_bin_idx,
                        placement_idx: pi,
                        improvement,
                    });
                }
            }
        }
    }

    best
}

/// Compute the hypothetical Σ(bin.width × occ_height) if we moved
/// `placement_idx` from its current bin to `dst_bin_idx` and re-
/// polished both bins. Returns `None` if the move is infeasible
/// (item bbox doesn't fit inside dst_bin's raw dimensions).
fn simulate_move_occupied(
    result: &PackResult,
    bins: &[Bin],
    src_bin_idx: usize,
    dst_bin_idx: usize,
    placement_idx: usize,
    _clearance: f64,
    polish_cfg: &PolishConfig,
) -> Option<f64> {
    let item = &result.placements[placement_idx];
    let (i_bbox_w, i_bbox_h) = polygon_bbox_dims(&item.polygon);
    let dst_bin = &bins[dst_bin_idx];
    if i_bbox_w > dst_bin.width + 1e-6 || i_bbox_h > dst_bin.height + 1e-6 {
        return None;
    }

    // Build the simulated per-bin placement sets.
    let src_id = &bins[src_bin_idx].bin_id;
    let dst_id = &dst_bin.bin_id;

    let mut src_placements: Vec<Placement> = result
        .placements
        .iter()
        .enumerate()
        .filter(|(pi, p)| *pi != placement_idx && p.bin_id == *src_id)
        .map(|(_, p)| p.clone())
        .collect();
    let mut dst_placements: Vec<Placement> = result
        .placements
        .iter()
        .enumerate()
        .filter(|(pi, p)| *pi != placement_idx && p.bin_id == *dst_id)
        .map(|(_, p)| p.clone())
        .collect();

    // Insert the moved item on top of the destination bin's existing
    // stack. Stack bottom-up; initial y is the current max_y of dst.
    let dst_existing_max_y = dst_placements
        .iter()
        .map(|p| polygon_bbox(&p.polygon).3)
        .fold(0.0_f64, f64::max);
    // Guard: if the moved item at the top position wouldn't fit
    // within dst bin height, bail on this move.
    if dst_existing_max_y + i_bbox_h > dst_bin.height + 1e-6 {
        return None;
    }

    let moved = relocate_placement(item, dst_id, 0.0, dst_existing_max_y);
    dst_placements.push(moved);

    // Polish both bins (may compact things further).
    let src_bin = &bins[src_bin_idx];
    src_placements = polish_placements(&src_placements, src_bin.width, src_bin.height, polish_cfg);
    dst_placements = polish_placements(&dst_placements, dst_bin.width, dst_bin.height, polish_cfg);

    // Compute new total occupied area across all bins. For untouched
    // bins, reuse the baseline occ_height (no change).
    let mut total = 0.0_f64;
    for (bi, bin) in bins.iter().enumerate() {
        let occ_h = if bi == src_bin_idx {
            max_y_of(&src_placements)
        } else if bi == dst_bin_idx {
            max_y_of(&dst_placements)
        } else {
            // Other bin — pull its existing occupied height from result.
            result
                .per_bin
                .iter()
                .find(|b| b.bin_id == bin.bin_id)
                .map(|b| b.occupied_height)
                .unwrap_or(bin.height)
        };
        total += bin.width * occ_h;
    }
    Some(total)
}

fn apply_move(
    mut result: PackResult,
    bins: &[Bin],
    _clearance: f64,
    candidate: &MoveCandidate,
    polish_cfg: &PolishConfig,
) -> PackResult {
    let dst_id = bins[candidate.dst_bin_idx].bin_id.clone();
    let src_id = bins[candidate.src_bin_idx].bin_id.clone();

    // Take out the moved placement and update its bin_id; reposition
    // at (0, dst_max_y) so polish can slide it in.
    let moved_original = result.placements.remove(candidate.placement_idx);
    let dst_existing_max_y = result
        .placements
        .iter()
        .filter(|p| p.bin_id == dst_id)
        .map(|p| polygon_bbox(&p.polygon).3)
        .fold(0.0_f64, f64::max);
    let moved = relocate_placement(&moved_original, &dst_id, 0.0, dst_existing_max_y);
    result.placements.push(moved);

    // Polish affected bins.
    let src_bin = &bins[candidate.src_bin_idx];
    let dst_bin = &bins[candidate.dst_bin_idx];
    let (src_placements, dst_placements): (Vec<_>, Vec<_>) = result
        .placements
        .iter()
        .cloned()
        .partition(|p| p.bin_id == src_id);
    let (dst_placements, other_placements): (Vec<_>, Vec<_>) =
        dst_placements.into_iter().partition(|p| p.bin_id == dst_id);

    let src_polished =
        polish_placements(&src_placements, src_bin.width, src_bin.height, polish_cfg);
    let dst_polished =
        polish_placements(&dst_placements, dst_bin.width, dst_bin.height, polish_cfg);

    // Rebuild the placements list (order doesn't matter — consumers
    // identify placements by bin_id and shape_id).
    result.placements = src_polished
        .into_iter()
        .chain(dst_polished)
        .chain(other_placements)
        .collect();

    // Update per_bin stats for src + dst.
    for bi in [candidate.src_bin_idx, candidate.dst_bin_idx] {
        let bin = &bins[bi];
        let this_bin_placements: Vec<&Placement> = result
            .placements
            .iter()
            .filter(|p| p.bin_id == bin.bin_id)
            .collect();
        let used_area: f64 = this_bin_placements
            .iter()
            .map(|p| polygon_area(&p.polygon))
            .sum();
        let (_, _, max_x, max_y) = this_bin_placements
            .iter()
            .map(|p| polygon_bbox(&p.polygon))
            .fold(
                (f64::INFINITY, f64::INFINITY, 0.0_f64, 0.0_f64),
                |(mnx, mny, mxx, mxy), (a, b, c, d)| {
                    (mnx.min(a), mny.min(b), mxx.max(c), mxy.max(d))
                },
            );
        let stock_area = bin.width * bin.height;
        let waste_area = (stock_area - used_area).max(0.0);
        let efficiency = if stock_area > 0.0 {
            used_area / stock_area
        } else {
            0.0
        };

        if let Some(br) = result.per_bin.iter_mut().find(|b| b.bin_id == bin.bin_id) {
            br.used_area = used_area;
            br.waste_area = waste_area;
            br.occupied_width = if this_bin_placements.is_empty() {
                bin.width
            } else {
                max_x
            };
            br.occupied_height = if this_bin_placements.is_empty() {
                bin.height
            } else {
                max_y
            };
            br.efficiency = efficiency;
            br.scrap_ratio = 1.0 - efficiency;
        }
    }

    result
}

fn refresh_totals(result: &mut PackResult) {
    result.placed_count = result.placements.len() as u32;
    result.total_used_area = result.per_bin.iter().map(|b| b.used_area).sum();
    result.total_waste_area = result.per_bin.iter().map(|b| b.waste_area).sum();
    result.overall_density = if result.total_used_area + result.total_waste_area > 0.0 {
        result.total_used_area / (result.total_used_area + result.total_waste_area)
    } else {
        0.0
    };

    // Rebuild per-shape instance_index deterministically (same
    // convention as pack_lbf_lns / pack rebuild: shape_id sort +
    // per-shape counter from 0).
    let mut counters: HashMap<String, u32> = HashMap::new();
    for p in result.placements.iter_mut() {
        let c = counters.entry(p.shape_id.clone()).or_insert(0);
        p.instance_index = *c;
        *c += 1;
    }
}

fn total_occupied_area(result: &PackResult, bins: &[Bin]) -> f64 {
    let mut total = 0.0_f64;
    for bin in bins {
        if let Some(br) = result.per_bin.iter().find(|b| b.bin_id == bin.bin_id) {
            total += bin.width * br.occupied_height;
        } else {
            total += bin.width * bin.height;
        }
    }
    total
}

fn relocate_placement(src: &Placement, new_bin_id: &str, tx: f64, ty: f64) -> Placement {
    // Translate polygon so its bbox min is at (tx, ty).
    let (min_x, min_y, _, _) = polygon_bbox(&src.polygon);
    let dx = tx - min_x;
    let dy = ty - min_y;
    let polygon = src
        .polygon
        .iter()
        .map(|v| Point2D::new(v.x + dx, v.y + dy))
        .collect::<Vec<_>>();
    Placement {
        bin_id: new_bin_id.to_string(),
        x: src.x + dx,
        y: src.y + dy,
        polygon,
        ..src.clone()
    }
}

fn polygon_bbox(poly: &[Point2D]) -> (f64, f64, f64, f64) {
    poly.iter().fold(
        (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ),
        |(mnx, mny, mxx, mxy), v| (mnx.min(v.x), mny.min(v.y), mxx.max(v.x), mxy.max(v.y)),
    )
}

fn polygon_bbox_dims(poly: &[Point2D]) -> (f64, f64) {
    let (mnx, mny, mxx, mxy) = polygon_bbox(poly);
    ((mxx - mnx).max(0.0), (mxy - mny).max(0.0))
}

fn max_y_of(placements: &[Placement]) -> f64 {
    placements
        .iter()
        .map(|p| polygon_bbox(&p.polygon).3)
        .fold(0.0_f64, f64::max)
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
    use crate::domain::{BinKind, BinResult};

    fn rect_placement(shape_id: &str, bin_id: &str, x: f64, y: f64, w: f64, h: f64) -> Placement {
        Placement {
            shape_id: shape_id.into(),
            instance_index: 0,
            bin_id: bin_id.into(),
            x,
            y,
            rotation_rad: 0.0,
            polygon: vec![
                Point2D::new(x, y),
                Point2D::new(x + w, y),
                Point2D::new(x + w, y + h),
                Point2D::new(x, y + h),
            ],
            width: w,
            height: h,
            difficulty: None,
        }
    }

    fn test_bin(id: &str, w: f64, h: f64) -> Bin {
        Bin {
            bin_id: id.into(),
            width: w,
            height: h,
            kind: BinKind::Fresh,
            priority: None,
        }
    }

    fn test_bin_result(id: &str, occ_w: f64, occ_h: f64, used: f64, waste: f64) -> BinResult {
        BinResult {
            bin_id: id.into(),
            used_area: used,
            waste_area: waste,
            occupied_width: occ_w,
            occupied_height: occ_h,
            efficiency: if used + waste > 0.0 {
                used / (used + waste)
            } else {
                0.0
            },
            scrap_ratio: 1.0 - (used / (used + waste)).max(0.0),
        }
    }

    #[test]
    fn noop_when_single_bin() {
        let result = PackResult {
            placements: vec![rect_placement("a", "b1", 0.0, 0.0, 10.0, 10.0)],
            placed_count: 1,
            overflow_count: 0,
            per_bin: vec![test_bin_result("b1", 10.0, 10.0, 100.0, 900.0)],
            total_used_area: 100.0,
            total_waste_area: 900.0,
            overall_density: 0.1,
            run_time_ms: None,
            was_cancelled: false,
        };
        let bins = vec![test_bin("b1", 100.0, 100.0)];
        let out = try_cross_bin_moveout(result.clone(), &bins, 0.0, 3);
        assert_eq!(out.placements.len(), 1);
        assert_eq!(out.placements[0].bin_id, "b1");
    }

    #[test]
    fn accepts_move_that_reduces_total_occupied() {
        // Two bins. Bin-A has one tall item sticking up at the top
        // (y=90..100) above a filled lower region. Bin-B has room.
        // Moving the protruding item to bin-B reduces bin-A's
        // occupied_height by 10 without adding to bin-B's (bin-B
        // stack starts at 0).
        let placements = vec![
            rect_placement("keep1", "A", 0.0, 0.0, 100.0, 20.0),
            rect_placement("keep2", "A", 0.0, 20.0, 100.0, 20.0),
            rect_placement("movable", "A", 0.0, 90.0, 40.0, 10.0),
        ];
        let result = PackResult {
            placements,
            placed_count: 3,
            overflow_count: 0,
            per_bin: vec![
                test_bin_result("A", 100.0, 100.0, 4400.0, 5600.0),
                test_bin_result("B", 100.0, 0.0, 0.0, 10000.0),
            ],
            total_used_area: 4400.0,
            total_waste_area: 15600.0,
            overall_density: 0.22,
            run_time_ms: None,
            was_cancelled: false,
        };
        let bins = vec![test_bin("A", 100.0, 100.0), test_bin("B", 100.0, 100.0)];
        let out = try_cross_bin_moveout(result, &bins, 0.0, 3);

        // SOMETHING moved from A to B — don't care which specific item
        // (the operator is free to pick any shape whose move reduces
        // total occupied area; in this fixture several items are
        // equally beneficial once polish is applied).
        let b_count = out.placements.iter().filter(|p| p.bin_id == "B").count();
        assert!(b_count >= 1, "at least one item should have moved to bin B");

        // Bin A occupied height should drop substantially from 100 —
        // in this fixture polish compacts the remaining items so A ends
        // up well under 50 regardless of which single item was moved.
        let a_occ = out
            .per_bin
            .iter()
            .find(|b| b.bin_id == "A")
            .unwrap()
            .occupied_height;
        assert!(
            a_occ < 50.0,
            "bin A occupied_height should drop well below 50, got {}",
            a_occ
        );
    }

    #[test]
    fn rejects_move_that_worsens_total() {
        // Two bins evenly balanced. Moving any item from either bin
        // to the other would either leave total occupied unchanged
        // or make it worse — the operator must pass everything
        // through unchanged.
        let placements = vec![
            rect_placement("a", "A", 0.0, 0.0, 50.0, 50.0),
            rect_placement("b", "B", 0.0, 0.0, 50.0, 50.0),
        ];
        let result = PackResult {
            placements: placements.clone(),
            placed_count: 2,
            overflow_count: 0,
            per_bin: vec![
                test_bin_result("A", 50.0, 50.0, 2500.0, 7500.0),
                test_bin_result("B", 50.0, 50.0, 2500.0, 7500.0),
            ],
            total_used_area: 5000.0,
            total_waste_area: 15000.0,
            overall_density: 0.25,
            run_time_ms: None,
            was_cancelled: false,
        };
        let bins = vec![test_bin("A", 100.0, 100.0), test_bin("B", 100.0, 100.0)];
        let out = try_cross_bin_moveout(result.clone(), &bins, 0.0, 3);
        assert_eq!(out.placements.len(), 2);
        // Items should remain on their original bins.
        for p in &out.placements {
            assert_eq!(
                p.shape_id,
                p.bin_id.to_lowercase(),
                "item '{}' should still be on bin '{}'",
                p.shape_id,
                p.bin_id
            );
        }
    }
}
