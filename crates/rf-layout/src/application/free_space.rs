// engine/crates/rf-layout/src/application/free_space.rs
//
// Post-pack extractor: turns a packed bin into the `(free_regions,
// offcuts)` pair that `BinResult` exposes back to AutoNest.
//
// Pipeline:
//   1. Build the bin's stock polygon (axis-aligned rect of
//      `bin.width × bin.height`).
//   2. Subtract the union of every placement's polygon via
//      `rf_geom::infrastructure::clipper::difference`. Result: a
//      Vec<Polygon> of free-space regions in bin-local coordinates,
//      CCW-wound.
//   3. Iteratively pull the largest axis-aligned inscribed rectangle
//      out of those polygons, classify each via
//      `offcut_classifier::classify_rect`, and emit it as a
//      `ClassifiedOffcut`. Subtracted area is removed from the
//      working set so the next iteration sees the residual free
//      space — same algorithm as `nesting/free-space.ts`
//      `extractMaximalFreeRects`.
//
// Cost:
//   - Cliper operations dominate; for typical AutoNest bins (≤ ~50
//     placements, ≤ ~10 final offcuts) the cost is dwarfed by
//     pack_lbf_lns itself. The MAX_OFFCUTS_PER_BIN cap protects
//     pathological inputs from degenerate iteration counts.
//
// Failures:
//   - Returns empty vectors on any clipper error rather than
//     propagating: free-space rendering is best-effort visualisation,
//     not correctness-critical. The placements themselves stand
//     regardless.

use crate::application::offcut_classifier::classify_rect;
use crate::domain::{Bin, ClassifiedOffcut, Placement};
use rf_geom::application::inscribed::largest_inscribed_rect;
use rf_geom::domain::{Point2D, Polygon};
use rf_geom::infrastructure::clipper::{difference as clip_difference, union as clip_union};

/// Largest number of offcut rectangles emitted per bin. Above this
/// the residual is left as raw free-region polygons (still painted
/// as scrap shapes by the visualizer).
const MAX_OFFCUTS_PER_BIN: usize = 16;

/// Below this area (sq in), free-region polygons and inscribed rects
/// are treated as numerical noise and dropped. Same threshold as
/// `nesting/free-space.ts` MIN_REGION_AREA.
const MIN_REGION_AREA_SQIN: f64 = 1.0;

/// Grid step for the inscribed-rect algorithm. Coarser → faster but
/// quantizes the rect size; 0.25" is well below the 6" reusable-strip
/// threshold so quantization can never push a reusable rect into scrap.
const INSCRIBED_GRID_STEP: f64 = 0.25;

/// Compute free-space polygons + classified offcut rectangles for one
/// bin's worth of placements.
///
/// Returns `(free_regions, offcuts)`:
///   - `free_regions` is the raw boolean-difference output (bin minus
///     union of placed polygons).
///   - `offcuts` is the iteratively-extracted rectangles, classified.
///
/// Both are empty when the bin has no placements (entire stock is
/// "free" but un-cuttable in this run, so we don't fabricate offcuts
/// for an empty layout — matches TS behaviour).
pub fn extract_free_space(
    bin: &Bin,
    placements_in_bin: &[&Placement],
) -> (Vec<Polygon>, Vec<ClassifiedOffcut>) {
    if placements_in_bin.is_empty() || bin.width <= 0.0 || bin.height <= 0.0 {
        return (Vec::new(), Vec::new());
    }

    let stock = match build_stock_polygon(bin.width, bin.height) {
        Some(p) => p,
        None => return (Vec::new(), Vec::new()),
    };

    let placed: Vec<Polygon> = placements_in_bin
        .iter()
        .filter_map(|p| Polygon::new(p.polygon.clone()).ok())
        .collect();

    if placed.is_empty() {
        return (Vec::new(), Vec::new());
    }

    // Clipper2's difference takes the entire `b` slice as the clip set
    // and computes a single boolean diff, not stock - first then
    // - second; a flat slice is exactly what we want.
    let free_regions: Vec<Polygon> = match clip_difference(&stock, &placed) {
        Ok(polys) => polys
            .into_iter()
            .filter(|p| p.area() >= MIN_REGION_AREA_SQIN)
            .collect(),
        Err(_) => Vec::new(),
    };

    let offcuts = extract_offcuts(&bin.bin_id, &free_regions);

    (free_regions, offcuts)
}

/// Build the bin's stock as a CCW-wound axis-aligned rectangle
/// polygon. Returns `None` only if `Polygon::new` rejects the input
/// (impossible for a valid rect — included for future-proofing).
fn build_stock_polygon(width: f64, height: f64) -> Option<Polygon> {
    Polygon::new(vec![
        Point2D::new(0.0, 0.0),
        Point2D::new(width, 0.0),
        Point2D::new(width, height),
        Point2D::new(0.0, height),
    ])
    .ok()
}

/// Iteratively extract classified offcut rectangles from a list of
/// free-region polygons. Each iteration:
///   1. Find the polygon with the largest available inscribed rect.
///   2. Classify the rect, push to the output.
///   3. Subtract the rect from its source polygon (Clipper diff).
///   4. Drop residual polygons below `MIN_REGION_AREA_SQIN`.
///
/// Stops when no more meaningfully-sized rects can be inscribed or
/// `MAX_OFFCUTS_PER_BIN` is reached.
fn extract_offcuts(bin_id: &str, free_regions: &[Polygon]) -> Vec<ClassifiedOffcut> {
    let mut working: Vec<Polygon> = free_regions.to_vec();
    let mut offcuts: Vec<ClassifiedOffcut> = Vec::new();

    while offcuts.len() < MAX_OFFCUTS_PER_BIN && !working.is_empty() {
        // Find the polygon with the largest inscribed rect.
        let mut best: Option<(usize, rf_geom::domain::Rect)> = None;
        for (i, poly) in working.iter().enumerate() {
            let Some(rect) = largest_inscribed_rect(poly, INSCRIBED_GRID_STEP) else {
                continue;
            };
            if rect.area() < MIN_REGION_AREA_SQIN {
                continue;
            }
            if best
                .as_ref()
                .map(|(_, r)| rect.area() > r.area())
                .unwrap_or(true)
            {
                best = Some((i, rect));
            }
        }

        let Some((idx, rect)) = best else {
            break;
        };

        // The grid-based `largest_inscribed_rect` samples cell
        // centers, so a rect of N × M cells reports dimensions
        // (N × grid_step, M × grid_step) — but cells at the polygon
        // border can have their CENTER inside while up to half the
        // cell extends outside the polygon. Worst-case cumulative
        // overshoot across multiple disjoint free regions can push
        // emitted total above the bin's stock area when one rect
        // extends into another region's footprint. Shrink the
        // EMITTED rect by a full grid step on every side (1.5x the
        // half-cell worst case, with safety margin) to guarantee
        // strict interior containment. Use the unshrunk rect for
        // subtraction below so the algorithm still progresses past
        // borderline cells.
        let inset = INSCRIBED_GRID_STEP;
        let report_x = rect.x + inset;
        let report_y = rect.y + inset;
        let report_w = (rect.width - 2.0 * inset).max(0.0);
        let report_h = (rect.height - 2.0 * inset).max(0.0);

        // Drop the emit if the shrink reduced it to nothing — but
        // still subtract the unshrunk rect so we don't loop on the
        // same fragment.
        if report_w * report_h < MIN_REGION_AREA_SQIN {
            // fall through to subtraction below to clear the source.
        } else {
            let kind = classify_rect(report_w, report_h);
            offcuts.push(ClassifiedOffcut {
                bin_id: bin_id.to_string(),
                x: report_x,
                y: report_y,
                width: report_w,
                height: report_h,
                kind,
            });
        }

        // Subtract the rect from its source polygon. On clipper
        // failure, drop the source so we don't infinite-loop.
        let rect_poly = match Polygon::new(vec![
            Point2D::new(rect.x, rect.y),
            Point2D::new(rect.x + rect.width, rect.y),
            Point2D::new(rect.x + rect.width, rect.y + rect.height),
            Point2D::new(rect.x, rect.y + rect.height),
        ]) {
            Ok(p) => p,
            Err(_) => {
                working.remove(idx);
                continue;
            }
        };

        let source = working.remove(idx);
        let residuals = match clip_difference(&source, std::slice::from_ref(&rect_poly)) {
            Ok(polys) => polys
                .into_iter()
                .filter(|p| p.area() >= MIN_REGION_AREA_SQIN)
                .collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };
        working.extend(residuals);
    }

    offcuts
}

/// Convenience: union all placement polygons into one or more
/// CCW polygons. Currently unused by `extract_free_space` (Clipper's
/// difference handles a flat slice directly), but exposed for tests
/// + potential future callers that want the placed-area shape.
#[allow(dead_code)]
pub fn union_placements(placements: &[&Placement]) -> Vec<Polygon> {
    let polys: Vec<Polygon> = placements
        .iter()
        .filter_map(|p| Polygon::new(p.polygon.clone()).ok())
        .collect();
    if polys.is_empty() {
        return Vec::new();
    }
    let mut acc = vec![polys[0].clone()];
    for p in &polys[1..] {
        let mut next: Vec<Polygon> = Vec::new();
        for a in &acc {
            match clip_union(a, p) {
                Ok(merged) => next.extend(merged),
                Err(_) => next.push(a.clone()),
            }
        }
        acc = next;
    }
    acc
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{BinKind, OffcutKind};

    fn fresh_bin(id: &str, w: f64, h: f64) -> Bin {
        Bin {
            bin_id: id.into(),
            width: w,
            height: h,
            kind: BinKind::Fresh,
            priority: None,
        }
    }

    fn rect_placement(bin_id: &str, x: f64, y: f64, w: f64, h: f64) -> Placement {
        Placement {
            shape_id: "p".into(),
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
            tag: None,
            pack_polygon: None,
        }
    }

    #[test]
    fn empty_placements_yields_empty_output() {
        let bin = fresh_bin("b1", 48.0, 96.0);
        let (regions, offcuts) = extract_free_space(&bin, &[]);
        assert!(regions.is_empty());
        assert!(offcuts.is_empty());
    }

    #[test]
    fn single_corner_placement_produces_l_shape_free_region() {
        // 48 × 96 bin, place a 12 × 12 in the (0, 0) corner.
        // Free region = bin - placed = an L shape, area 96*48 - 144 = 4464.
        let bin = fresh_bin("b1", 48.0, 96.0);
        let p = rect_placement("b1", 0.0, 0.0, 12.0, 12.0);
        let (regions, offcuts) = extract_free_space(&bin, &[&p]);

        assert_eq!(regions.len(), 1, "L-shape should be one polygon");
        let total_area: f64 = regions.iter().map(|r| r.area()).sum();
        assert!(
            (total_area - (48.0 * 96.0 - 144.0)).abs() < 1.0,
            "free area = {} (expected ~4464)",
            total_area
        );

        // Largest inscribed rect should fit in the L's vertical leg
        // (36 × 96 = 3456) — well above the 11.5 × 12 reusable
        // threshold, so first offcut is Reusable.
        assert!(!offcuts.is_empty());
        assert_eq!(offcuts[0].kind, OffcutKind::Reusable);
        assert_eq!(offcuts[0].bin_id, "b1");
    }

    #[test]
    fn bin_filled_to_capacity_yields_no_free_regions() {
        // 10 × 10 bin filled with one 10 × 10 placement.
        let bin = fresh_bin("b1", 10.0, 10.0);
        let p = rect_placement("b1", 0.0, 0.0, 10.0, 10.0);
        let (regions, offcuts) = extract_free_space(&bin, &[&p]);
        assert!(
            regions.is_empty(),
            "fully-occupied bin should have no free regions, got {}",
            regions.len()
        );
        assert!(offcuts.is_empty());
    }

    #[test]
    fn small_strip_classifies_as_scrap() {
        // 48 × 96 bin, placement leaves only a 5″ wide strip.
        // 5 × 96 → 5 < 6 (strip min) AND 5 < 11.5 (offcut min) → Scrap.
        let bin = fresh_bin("b1", 48.0, 96.0);
        let p = rect_placement("b1", 0.0, 0.0, 43.0, 96.0);
        let (_regions, offcuts) = extract_free_space(&bin, &[&p]);
        assert!(!offcuts.is_empty());
        // The biggest inscribed rect should be ~5″ wide, classified Scrap.
        // The emitted rect is shrunk by `INSCRIBED_GRID_STEP` per side
        // (see free_space.rs `inset` doc), so the reported width is
        // ~5 − 2 × 0.25 = 4.5″.
        assert_eq!(offcuts[0].kind, OffcutKind::Scrap);
        let expected_width = 5.0 - 2.0 * INSCRIBED_GRID_STEP;
        assert!(
            (offcuts[0].width - expected_width).abs() < INSCRIBED_GRID_STEP * 1.5,
            "expected width ~{:.3}, got {:.3}",
            expected_width,
            offcuts[0].width,
        );
    }

    #[test]
    fn classified_offcuts_carry_bin_id() {
        let bin = fresh_bin("custom-bin-id", 48.0, 96.0);
        let p = rect_placement("custom-bin-id", 0.0, 0.0, 12.0, 12.0);
        let (_regions, offcuts) = extract_free_space(&bin, &[&p]);
        assert!(!offcuts.is_empty());
        for o in &offcuts {
            assert_eq!(o.bin_id, "custom-bin-id");
        }
    }
}
