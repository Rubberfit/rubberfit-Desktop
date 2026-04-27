// engine/crates/rf-layout/src/application/free_space.rs
//
// Post-pack extractor: turns a packed bin into the `(free_regions,
// offcuts)` pair that `BinResult` exposes back to AutoNest.
//
// Two pipelines are exposed; the active one is chosen by
// `application::scrap_strategy::ScrapStrategy`:
//
//   - `extract_free_space_legacy` — the original behaviour:
//     `clip_difference(stock, placed_polygons)` + iterative inscribed-
//     rect classification.
//
//   - `extract_free_space_two_signal` — Free Roam parity. Adds a
//     per-placement shape-trapped signal (`bbox(polygon) − polygon`)
//     so cones, ellipses, ngons, triangles, stars, and rings render
//     their corner waste explicitly. Production default.
//
// Pipeline (legacy):
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
// Pipeline (two-signal):
//   1. `free_regions = compute_shape_trapped_scrap(placements)` —
//      per-part `bbox(polygon) − polygon`. Empty for rectangles
//      whose polygon equals their bbox; produces corner crescents
//      for sectors, circles, ngons, triangles, stars, rings. These
//      are the visible red scrap polygons rendered around each part.
//   2. `offcuts = extract_offcuts_with_obstacles(bin_polygon, parts)`
//      — runs the inscribed-rect classifier on the WHOLE bin polygon
//      using placements as obstacles. Reusable rects can't extend
//      through parts, so amber overlay never covers parts or their
//      shape-trapped halos.
//
//   Why we DON'T re-emit the legacy bin-level diff in this path: the
//   rf-geom Clipper wrapper returns `clip_difference(outer, [hole])`
//   as TWO positive CCW polygons (a "ring with hole" gets split into
//   bin-outer + hole-reversed-as-positive). The renderer paints both
//   red, but that's cosmetically harmless WITHOUT inscribed-rect
//   placement; the inscribed-rect extractor then sees the bin polygon
//   as a clean rectangle (no hole information after the reversal) and
//   blindly emits a 96×48 reusable rect that covers the cone and
//   suppresses every red signal underneath. Going hole-aware via
//   `largest_inscribed_rect_avoiding` and dropping the redundant
//   bin-level emission solves both bugs in one move. See
//   `tests/single_cone_scrap.rs`.
//
// Cost:
//   - Cliper operations dominate; for typical AutoNest bins (≤ ~50
//     placements, ≤ ~10 final offcuts) the cost is dwarfed by
//     pack_lbf_lns itself. The MAX_OFFCUTS_PER_BIN cap protects
//     pathological inputs from degenerate iteration counts. The
//     two-signal path adds one per-placement diff, also cheap.
//
// Failures:
//   - Returns empty vectors on any clipper error rather than
//     propagating: free-space rendering is best-effort visualisation,
//     not correctness-critical. The placements themselves stand
//     regardless.

use crate::application::offcut_classifier::classify_rect;
use crate::application::offcut_extraction_strategy::{
    offcut_extraction_strategy_for, OffcutExtractionStrategy, OffcutExtractionStrategyKind,
};
use crate::domain::{Bin, ClassifiedOffcut, Placement};
use rf_geom::application::inscribed::{
    largest_inscribed_rect, largest_inscribed_rect_avoiding, snap_rect_to_polygon_and_obstacles,
};
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

/// Visual / metric floor for shape-trapped scrap polygons in the
/// two-signal pipeline. Mirrors Free Roam's `MIN_VISIBLE_SCRAP_SQIN`
/// (`free-roam-regions.ts:76`): operators can't cut a 1.4″×1.4″
/// sliver, so emitting it would read as noise. Kept distinct from
/// `MIN_REGION_AREA_SQIN` (which gates the inscribed-rect loop's
/// progress) so the rect extractor can still chew on small fragments
/// that we then choose not to render as their own polygon.
const MIN_VISIBLE_SCRAP_SQIN: f64 = 2.0;

/// Grid step for the inscribed-rect algorithm. Coarser → faster but
/// quantizes the rect size; 0.25" is well below the 6" reusable-strip
/// threshold so quantization can never push a reusable rect into scrap.
const INSCRIBED_GRID_STEP: f64 = 0.25;

/// Per-bin wall-clock cap for the iterative inscribed-rect extractor.
/// `largest_inscribed_rect_avoiding` is O(rows × cols × |obstacles| ×
/// |vertices|) per call and is invoked up to MAX_OFFCUTS_PER_BIN times
/// over a `working` polygon set that grows as each diff produces
/// residual fragments. For obstacle-heavy bins (e.g. a 48×48 sheet
/// with 12 placed circles in debug builds) this can run for minutes
/// without ever placing all 16 offcuts. We bail and return whatever
/// offcuts we've already classified — the residual area still gets
/// painted via the bin-wide `stock − parts` polygon, so the visualizer
/// only loses the amber rectangles for shapes the extractor didn't
/// reach in time. Production typically finishes in well under 100 ms;
/// 500 ms is a safety net for pathological obstacle arrangements.
const MAX_OFFCUT_EXTRACT_MS: u64 = 500;

/// Pre-fix scrap pipeline: `clip_difference(stock, placed_polygons)`
/// plus iterative inscribed-rect classification. Kept as the
/// `LegacyScrapStrategy` body for A/B and rollback; the production
/// default routes through `extract_free_space_two_signal` instead.
///
/// Returns `(free_regions, offcuts)`:
///   - `free_regions` is the raw boolean-difference output (bin minus
///     union of placed polygons).
///   - `offcuts` is the iteratively-extracted rectangles, classified.
///
/// Both are empty when the bin has no placements (entire stock is
/// "free" but un-cuttable in this run, so we don't fabricate offcuts
/// for an empty layout — matches TS behaviour).
pub fn extract_free_space_legacy(
    bin: &Bin,
    placements_in_bin: &[&Placement],
) -> (Vec<Polygon>, Vec<ClassifiedOffcut>) {
    let strategy = offcut_extraction_strategy_for(OffcutExtractionStrategyKind::default());
    extract_free_space_legacy_with(bin, placements_in_bin, strategy.as_ref())
}

/// Same as `extract_free_space_legacy`, but with the offcut-extraction
/// algorithm injected so the orchestrator can swap implementations
/// without forking this function. Used by `LegacyScrapStrategy`; the
/// no-arg form above wraps this with the default strategy for tests
/// and direct callers.
pub fn extract_free_space_legacy_with(
    bin: &Bin,
    placements_in_bin: &[&Placement],
    offcut: &dyn OffcutExtractionStrategy,
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

    let offcuts = offcut.extract(&bin.bin_id, &free_regions, &[]);

    (free_regions, offcuts)
}

/// Free Roam-parity scrap pipeline. Emits two independent signals:
///
///   * `free_regions` — per-placement `bbox(polygon) − polygon`
///     shape-trapped crescents. For rectangles (bbox ≡ polygon) this
///     is empty; for sectors/circles/ngons/triangles/stars/rings it
///     produces the corner waste Free Roam highlights.
///   * `offcuts` — inscribed rectangles in the bin polygon, classified
///     Reusable / Scrap, with placed parts as obstacles so reusable
///     rects never extend through cones or other parts.
///
/// Why this path doesn't ALSO re-emit the legacy bin-level diff: the
/// rf-geom Clipper wrapper splits "outer + hole" results into two
/// positive CCW polygons, losing the hole topology. The bare polygon
/// renders red across the whole bin AND the hole-reversed renders red
/// over the part, with reusable amber overlaying everything. End
/// result: the operator sees no scrap. The hole-aware inscribed-rect
/// path here gets us the correct visualization without that breakage.
pub fn extract_free_space_two_signal(
    bin: &Bin,
    placements_in_bin: &[&Placement],
) -> (Vec<Polygon>, Vec<ClassifiedOffcut>) {
    let strategy = offcut_extraction_strategy_for(OffcutExtractionStrategyKind::default());
    extract_free_space_two_signal_with(bin, placements_in_bin, strategy.as_ref())
}

/// Same as `extract_free_space_two_signal`, but with the offcut-
/// extraction algorithm injected so the orchestrator can swap
/// implementations without forking this function. Used by
/// `TwoSignalScrapStrategy`; the no-arg form above wraps this with the
/// default strategy for tests and direct callers.
pub fn extract_free_space_two_signal_with(
    bin: &Bin,
    placements_in_bin: &[&Placement],
    offcut: &dyn OffcutExtractionStrategy,
) -> (Vec<Polygon>, Vec<ClassifiedOffcut>) {
    if placements_in_bin.is_empty() || bin.width <= 0.0 || bin.height <= 0.0 {
        return (Vec::new(), Vec::new());
    }

    let stock = match build_stock_polygon(bin.width, bin.height) {
        Some(p) => p,
        None => return (Vec::new(), Vec::new()),
    };

    let parts: Vec<Polygon> = placements_in_bin
        .iter()
        .filter_map(|p| Polygon::new(p.polygon.clone()).ok())
        .collect();
    if parts.is_empty() {
        return (Vec::new(), Vec::new());
    }

    // Reusable offcuts: inscribed rectangles inside the bin, avoiding
    // placed parts. Use the part polygon (or pack_polygon for cones in
    // ConvexHull packing mode) as the obstacle so amber rects can pack
    // tightly into the L-shape between parts and walls without
    // extending through the cone hull jagua reserved.
    let obstacles: Vec<Polygon> = placements_in_bin
        .iter()
        .filter_map(|p| {
            let source = p
                .pack_polygon
                .as_deref()
                .filter(|poly| poly.len() >= 3)
                .unwrap_or(&p.polygon);
            Polygon::new(source.to_vec()).ok()
        })
        .collect();
    // Emit BOTH Reusable and Scrap classifications. Reusable rects
    // render as amber on top of the bin-wide scrap polygon; Scrap rects
    // are visible-only when the operator toggles the inscribed-rect
    // debug overlay in the visualizer (see `layout-visualizer.tsx`).
    // Production rendering ignores Scrap offcuts because the bin-wide
    // scrap polygon already covers their geometry.
    let offcuts = offcut.extract(&bin.bin_id, std::slice::from_ref(&stock), &obstacles);

    // Scrap = `stock − parts`. One bin-wide Clipper diff produces one
    // outer polygon per disjoint scrap cluster (typically just one for
    // a connected sheet) — visually unified red coverage across the
    // entire bin minus the parts, no per-part bbox boundaries to
    // create seams. The rf-geom wrapper splits "outer + holes" into
    // separate positive CCW polygons (the holes are reversed), so for
    // each cone we get an extra hole-reversed polygon that paints
    // over the cone area; the frontend `RegionShape` evenodd cutout
    // (parts as cutouts, filtered by bbox-overlap) cancels every
    // cone's hole-reversed footprint AND cancels the cone area out of
    // the bin outer. Net visual: red everywhere except parts.
    //
    // Reusable rects render ON TOP of the scrap polygon (z-ordered
    // after scrap, before parts in `layout-visualizer.tsx:557-575`)
    // with their own pattern-base stroke covering the seam, so the
    // sheet still reads as "amber where reusable, red elsewhere"
    // without sub-pixel stock pattern leaks between layers.
    let scrap_polys = clip_difference(&stock, &parts).unwrap_or_default();
    let free_regions: Vec<Polygon> = scrap_polys
        .into_iter()
        .filter(|p| p.area() >= MIN_VISIBLE_SCRAP_SQIN)
        .collect();

    (free_regions, offcuts)
}

/// Per-placement `bbox(polygon) − polygon`, unioned across every
/// placement. For each placement, computes the polygon residue between
/// its axis-aligned bounding box and the part outline (rectangles
/// produce nothing; sectors produce bbox-corner crescents; circles
/// produce four corner crescents; etc.), then unions all crescents into
/// one polygon set so adjacent waste regions render as a single SVG
/// element. Mirrors Free Roam's `computePartCrescentWaste`
/// (`free-roam-regions.ts:145-176`).
///
/// Why union: emitting one polygon per placement leaves SVG
/// anti-aliasing seams where adjacent crescents share edges — the
/// renderer treats them as independent shapes and their pixel
/// boundaries don't align. A unioned polygon is a single shape with
/// no internal seam.
///
/// We deliberately do NOT subtract other placements here, even when
/// cones nest into each other's concave notches and one part's
/// trapped polygon would geometrically overlap another part. The
/// rf-geom Clipper wrapper splits "outer + hole" results into two
/// positive CCW polygons (the hole is reversed), losing the hole
/// topology — multi-placement subtraction therefore produces output
/// the visualizer can't render correctly. Instead the frontend
/// renderer punches placed parts out of every scrap region with
/// SVG `fill-rule: evenodd` (see
/// `src/components/cutting-engine/layout-visualizer.tsx`).
///
/// No size filter here.
///
/// Currently unused by the production pipeline (which uses bin-wide
/// `stock − parts` for visual continuity), but retained as a unit-
/// testable algorithm for future reuse if per-part scrap labelling
/// returns.
#[allow(dead_code)]
fn compute_shape_trapped_scrap(placements: &[&Placement]) -> Vec<Polygon> {
    let mut raw: Vec<Polygon> = Vec::new();
    for p in placements {
        let Some(bbox) = bbox_polygon(&p.polygon) else {
            continue;
        };
        let Ok(part) = Polygon::new(p.polygon.clone()) else {
            continue;
        };
        let trapped = match clip_difference(&bbox, std::slice::from_ref(&part)) {
            Ok(polys) => polys,
            Err(_) => continue,
        };
        raw.extend(trapped);
    }
    iterative_union(raw)
}

/// Iteratively pairwise-union a polygon set. Each new polygon is
/// absorbed into the accumulator: any existing entry that fuses with
/// it (Clipper returns one polygon → they touched/overlapped) is
/// merged into `current`; entries that stay disjoint pass through
/// unchanged. Transitive merges work — if `next` bridges two
/// previously-disjoint accumulator entries, both fuse into one
/// polygon by the end of the inner loop. Order-independent up to
/// floating-point Clipper rounding.
///
/// Currently unused by the production pipeline; retained as the
/// canonical way to merge a polygon set if the per-part scrap path
/// is reinstated. Used by `compute_shape_trapped_scrap`'s tests.
#[allow(dead_code)]
fn iterative_union(input: Vec<Polygon>) -> Vec<Polygon> {
    let mut acc: Vec<Polygon> = Vec::with_capacity(input.len());
    for next in input {
        let mut current = next;
        let mut survivors: Vec<Polygon> = Vec::with_capacity(acc.len());
        for a in acc.drain(..) {
            match clip_union(&a, &current) {
                Ok(mut out) if out.len() == 1 => {
                    current = out.pop().unwrap();
                }
                _ => survivors.push(a),
            }
        }
        survivors.push(current);
        acc = survivors;
    }
    acc
}

/// Build a CCW-wound axis-aligned rectangle polygon covering the input
/// polygon's bounding box. Returns `None` for degenerate inputs (< 3
/// points or zero-area bbox). Used by `compute_shape_trapped_scrap`
/// (currently dead-code-allowed) and its tests.
#[allow(dead_code)]
fn bbox_polygon(poly: &[Point2D]) -> Option<Polygon> {
    if poly.len() < 3 {
        return None;
    }
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for v in poly {
        if v.x < min_x {
            min_x = v.x;
        }
        if v.y < min_y {
            min_y = v.y;
        }
        if v.x > max_x {
            max_x = v.x;
        }
        if v.y > max_y {
            max_y = v.y;
        }
    }
    let dx = max_x - min_x;
    let dy = max_y - min_y;
    if dx <= 0.0 || dx.is_nan() || dy <= 0.0 || dy.is_nan() {
        return None;
    }
    Polygon::new(vec![
        Point2D::new(min_x, min_y),
        Point2D::new(max_x, min_y),
        Point2D::new(max_x, max_y),
        Point2D::new(min_x, max_y),
    ])
    .ok()
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

/// Iteratively extract classified offcut rectangles from
/// `free_regions`. Each candidate rect is required to avoid every
/// polygon in `obstacles` (empty slice = no obstacles, legacy
/// behaviour). Each iteration:
///   1. Find the polygon with the largest available inscribed rect.
///   2. Snap to true geometric edges and classify, push to output.
///   3. Subtract the unsnapped grid rect from its source polygon
///      (Clipper diff).
///   4. Drop residual polygons below `MIN_REGION_AREA_SQIN`.
///
/// Stops when no more meaningfully-sized rects can be inscribed,
/// `MAX_OFFCUTS_PER_BIN` is reached, or `MAX_OFFCUT_EXTRACT_MS`
/// elapses.
///
/// Exposed `pub(crate)` so
/// `application::offcut_extraction_strategy::GreedyMaxRectStrategy`
/// can call it without re-implementing the loop. New extraction
/// strategies live next to it as their own modules and are dispatched
/// via the `OffcutExtractionStrategy` trait — see issue #14.
pub(crate) fn extract_offcuts_with_obstacles(
    bin_id: &str,
    free_regions: &[Polygon],
    obstacles: &[Polygon],
) -> Vec<ClassifiedOffcut> {
    let mut working: Vec<Polygon> = free_regions.to_vec();
    let mut offcuts: Vec<ClassifiedOffcut> = Vec::new();
    let started_at = std::time::Instant::now();
    let extract_deadline = started_at + std::time::Duration::from_millis(MAX_OFFCUT_EXTRACT_MS);

    while offcuts.len() < MAX_OFFCUTS_PER_BIN && !working.is_empty() {
        // Per-bin extraction deadline. `largest_inscribed_rect_avoiding`
        // is O(cells × obstacles × vertices) per call and is invoked
        // for every polygon in `working` every iteration; the working
        // set grows with each diff. Without this bail, obstacle-heavy
        // bins (12+ circles on a 48×48 sheet) can spin for minutes
        // in debug builds. Partial offcuts is acceptable — the
        // bin-wide scrap polygon still covers the residual visually.
        if std::time::Instant::now() >= extract_deadline {
            break;
        }
        // Find the polygon with the largest inscribed rect.
        let mut best: Option<(usize, rf_geom::domain::Rect)> = None;
        for (i, poly) in working.iter().enumerate() {
            let rect_opt = if obstacles.is_empty() {
                largest_inscribed_rect(poly, INSCRIBED_GRID_STEP)
            } else {
                largest_inscribed_rect_avoiding(poly, obstacles, INSCRIBED_GRID_STEP)
            };
            let Some(rect) = rect_opt else {
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

        // The grid-based `largest_inscribed_rect` samples cell centres
        // and reports dimensions in `grid_step` units. Cells at the
        // polygon/obstacle border may have their centre inside while
        // up to half the cell extends outside, so the raw `rect` is
        // strictly contained in the polygon but undershoots the true
        // free area by up to half a grid step on every side. With the
        // pipeline's default 0.125" clearance, obstacle edges land
        // between cell centres, costing a further full cell — for
        // axis-aligned scenarios (e.g. three rectangles producing an
        // L-shape) this turned 0% real waste into ~2.7% reported
        // waste.
        //
        // `snap_rect_to_polygon_and_obstacles` walks the polygon and
        // obstacle edges and pulls the emitted rect outward to the
        // actual geometric edge (capped at one grid step per side).
        // Axis-aligned scenarios recover exactly; curved obstacles
        // (cones, sectors, ngons) clamp conservatively to the curved
        // edge's bbox so the snapped rect never crosses into the
        // curve's silhouette.
        //
        // Snap is reporting-only; the subtraction below still uses the
        // unshrunk grid rect to preserve the inscribed-rect loop's
        // convergence (residual polygon shrinks by ≥1 grid step per
        // iteration, bounded `MAX_OFFCUTS_PER_BIN`).
        let snapped =
            snap_rect_to_polygon_and_obstacles(rect, &working[idx], obstacles, INSCRIBED_GRID_STEP);
        if snapped.area() < MIN_REGION_AREA_SQIN {
            // fall through to subtraction below to clear the source.
        } else {
            let kind = classify_rect(snapped.width, snapped.height);
            offcuts.push(ClassifiedOffcut {
                bin_id: bin_id.to_string(),
                x: snapped.x,
                y: snapped.y,
                width: snapped.width,
                height: snapped.height,
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
/// CCW polygons. Currently unused by either `extract_free_space_*`
/// path (Clipper's difference handles a flat slice directly), but
/// exposed for tests + potential future callers that want the
/// placed-area shape.
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
        let (regions, offcuts) = extract_free_space_legacy(&bin, &[]);
        assert!(regions.is_empty());
        assert!(offcuts.is_empty());
    }

    #[test]
    fn single_corner_placement_produces_l_shape_free_region() {
        // 48 × 96 bin, place a 12 × 12 in the (0, 0) corner.
        // Free region = bin - placed = an L shape, area 96*48 - 144 = 4464.
        let bin = fresh_bin("b1", 48.0, 96.0);
        let p = rect_placement("b1", 0.0, 0.0, 12.0, 12.0);
        let (regions, offcuts) = extract_free_space_legacy(&bin, &[&p]);

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
        let (regions, offcuts) = extract_free_space_legacy(&bin, &[&p]);
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
        let (_regions, offcuts) = extract_free_space_legacy(&bin, &[&p]);
        assert!(!offcuts.is_empty());
        // After snap-to-polygon-edge, the emitted rect should report
        // ≈5″ wide (the true free strip), not the previously-shrunk
        // 4.5″. Classification stays Scrap (5 < 6 strip minimum).
        assert_eq!(offcuts[0].kind, OffcutKind::Scrap);
        assert!(
            (offcuts[0].width - 5.0).abs() < 0.25,
            "expected width ~5.0, got {:.3}",
            offcuts[0].width,
        );
    }

    #[test]
    fn classified_offcuts_carry_bin_id() {
        let bin = fresh_bin("custom-bin-id", 48.0, 96.0);
        let p = rect_placement("custom-bin-id", 0.0, 0.0, 12.0, 12.0);
        let (_regions, offcuts) = extract_free_space_legacy(&bin, &[&p]);
        assert!(!offcuts.is_empty());
        for o in &offcuts {
            assert_eq!(o.bin_id, "custom-bin-id");
        }
    }

    /// Issue B regression. The user's repro: 3 stacked rect placements
    /// where each polygon's right edge lands a hair past x=6 due to
    /// LBF's f32 rotation noise (e.g. x=6.0068). Pre-fix, the snap
    /// returned a Reusable rect at x=6 / w=18, overlapping the parts
    /// by ~0.007". Post-fix, the snap pulls the rect's left edge inward
    /// to obstacle.x_max + EPS so it never crosses any part polygon.
    #[test]
    fn reusable_offcut_does_not_overlap_jagua_rotated_rect_polygons() {
        let bin = fresh_bin("b1", 24.0, 24.0);
        // Three polygons mirroring jagua's f32-rotated 6×6 placements
        // (slightly skewed top/bottom edges, max x ≈ 6.007).
        let p1 = Placement {
            shape_id: "rect-a".into(),
            instance_index: 0,
            bin_id: "b1".into(),
            x: 6.0022,
            y: 0.1524,
            rotation_rad: std::f64::consts::FRAC_PI_2,
            polygon: vec![
                Point2D::new(6.002192, 0.152377),
                Point2D::new(6.000084, 6.152377),
                Point2D::new(0.000085, 6.150269),
                Point2D::new(0.002193, 0.150269),
            ],
            width: 6.0,
            height: 6.0,
            difficulty: None,
            tag: None,
            pack_polygon: None,
        };
        let p2 = Placement {
            shape_id: "rect-a".into(),
            instance_index: 1,
            bin_id: "b1".into(),
            x: 6.0012,
            y: 12.278,
            rotation_rad: -std::f64::consts::PI,
            polygon: vec![
                Point2D::new(6.001182, 12.278025),
                Point2D::new(0.001182, 12.277377),
                Point2D::new(0.001829, 6.277377),
                Point2D::new(6.001829, 6.278025),
            ],
            width: 6.0,
            height: 6.0,
            difficulty: None,
            tag: None,
            pack_polygon: None,
        };
        let p3 = Placement {
            shape_id: "rect-a".into(),
            instance_index: 2,
            bin_id: "b1".into(),
            x: 6.0068,
            y: 18.403,
            rotation_rad: std::f64::consts::PI,
            polygon: vec![
                Point2D::new(6.006848, 18.403025),
                Point2D::new(0.006848, 18.403172),
                Point2D::new(0.006701, 12.403172),
                Point2D::new(6.006701, 12.403025),
            ],
            width: 6.0,
            height: 6.0,
            difficulty: None,
            tag: None,
            pack_polygon: None,
        };

        let (_regions, offcuts) = extract_free_space_two_signal(&bin, &[&p1, &p2, &p3]);

        // Maximum x reached by any part polygon.
        let max_part_x = [&p1, &p2, &p3]
            .iter()
            .flat_map(|p| p.polygon.iter())
            .map(|v| v.x)
            .fold(f64::NEG_INFINITY, f64::max);

        let reusable: Vec<&ClassifiedOffcut> = offcuts
            .iter()
            .filter(|o| o.kind == OffcutKind::Reusable)
            .collect();
        assert!(
            !reusable.is_empty(),
            "expected at least one Reusable offcut, got {} total",
            offcuts.len()
        );
        for o in reusable {
            assert!(
                o.x >= max_part_x - 1e-6,
                "Reusable offcut at x={} crosses into parts (max part x={})",
                o.x,
                max_part_x,
            );
        }
    }

    // ── Two-signal pipeline coverage ──────────────────────────────

    /// Build an annular sector polygon (outer arc + inner arc reversed),
    /// translated so minX = minY = 0 then offset by (tx, ty). Mirrors
    /// the math in `cone_strategy::build_annular_sector_normalized`
    /// without reaching into private API.
    fn annular_sector_placement(
        bin_id: &str,
        tx: f64,
        ty: f64,
        inner: f64,
        outer: f64,
        arc_deg: f64,
        segments: usize,
    ) -> Placement {
        let arc_rad = arc_deg.to_radians();
        let step = arc_rad / segments as f64;
        let mut raw = Vec::with_capacity(2 * (segments + 1));
        for i in 0..=segments {
            let a = i as f64 * step;
            raw.push(Point2D::new(outer * a.cos(), outer * a.sin()));
        }
        for i in (0..=segments).rev() {
            let a = i as f64 * step;
            raw.push(Point2D::new(inner * a.cos(), inner * a.sin()));
        }
        let min_x = raw.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
        let min_y = raw.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
        let polygon: Vec<Point2D> = raw
            .into_iter()
            .map(|p| Point2D::new(p.x - min_x + tx, p.y - min_y + ty))
            .collect();
        let max_x = polygon
            .iter()
            .map(|p| p.x)
            .fold(f64::NEG_INFINITY, f64::max);
        let max_y = polygon
            .iter()
            .map(|p| p.y)
            .fold(f64::NEG_INFINITY, f64::max);
        Placement {
            shape_id: "cone".into(),
            instance_index: 0,
            bin_id: bin_id.into(),
            x: tx,
            y: ty,
            rotation_rad: 0.0,
            polygon,
            width: max_x - tx,
            height: max_y - ty,
            difficulty: None,
            tag: None,
            pack_polygon: None,
        }
    }

    fn polygon_area_loop(poly: &[Point2D]) -> f64 {
        let mut s = 0.0;
        for i in 0..poly.len() {
            let a = poly[i];
            let b = poly[(i + 1) % poly.len()];
            s += a.x * b.y - b.x * a.y;
        }
        s.abs() / 2.0
    }

    #[test]
    fn single_rectangle_emits_bin_wide_scrap() {
        // Rectangles satisfy bbox ≡ polygon, so the per-part shape-
        // trapped helper still returns nothing. But the two-signal
        // pipeline now computes scrap as `stock − parts` bin-wide,
        // so a 12×12 rect in a 48×96 bin produces the L-shaped bin
        // remainder as one big scrap polygon (~4464 sq in). Reusable
        // amber rects also emit on top.
        let bin = fresh_bin("b1", 48.0, 96.0);
        let p = rect_placement("b1", 0.0, 0.0, 12.0, 12.0);

        let trapped = compute_shape_trapped_scrap(&[&p]);
        assert!(
            trapped.is_empty(),
            "rectangle should produce no shape-trapped polygons, got {}",
            trapped.len()
        );

        let (two_regions, two_offcuts) = extract_free_space_two_signal(&bin, &[&p]);
        assert!(
            !two_regions.is_empty(),
            "two-signal should emit the bin-minus-rect L-shape as scrap"
        );
        let total_scrap: f64 = two_regions.iter().map(|r| r.area()).sum();
        let bin_area = 48.0 * 96.0;
        let rect_area = 12.0 * 12.0;
        assert!(
            (total_scrap - (bin_area - rect_area)).abs() < 1.0,
            "scrap area should equal bin − rect: got {}, expected {}",
            total_scrap,
            bin_area - rect_area
        );
        assert!(
            two_offcuts
                .iter()
                .any(|o| matches!(o.kind, OffcutKind::Reusable)),
            "expected at least one Reusable offcut in the L-shape"
        );
    }

    #[test]
    fn single_sector_emits_corner_crescents() {
        // Annular sector (innerR=3, outerR=6, 120°) at (10,10) in 48×96.
        // bbox(sector) = ~6×6 box; sector_area ≈ π(36-9)/3 ≈ 28.27.
        // Shape-trapped area should be ≈ bbox_area − sector_area.
        let p = annular_sector_placement("b1", 10.0, 10.0, 3.0, 6.0, 120.0, 24);
        let trapped = compute_shape_trapped_scrap(&[&p]);
        assert!(
            !trapped.is_empty(),
            "sector should produce shape-trapped corner crescents"
        );

        let bbox_area = p.width * p.height;
        let sector_area = polygon_area_loop(&p.polygon);
        let trapped_area: f64 = trapped.iter().map(|t| t.area()).sum();
        let expected = bbox_area - sector_area;
        assert!(
            (trapped_area - expected).abs() < 0.5,
            "trapped area = {:.4}, expected ≈ {:.4} (bbox {:.4} − sector {:.4})",
            trapped_area,
            expected,
            bbox_area,
            sector_area
        );
    }

    #[test]
    fn compute_shape_trapped_scrap_returns_unfiltered() {
        // The size filter moved out of compute_shape_trapped_scrap into
        // extract_free_space_two_signal post-final-union, so sub-
        // threshold crescents can fuse with adjacent scrap-rect slivers
        // before the filter sees them. Confirm the helper now returns
        // sub-threshold polygons unchanged — the filter contract lives
        // in the pipeline, not the helper.
        let polygon = vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(1.0, 0.0),
            Point2D::new(1.0, 0.5),
            Point2D::new(0.5, 1.0),
            Point2D::new(0.0, 1.0),
        ];
        let p = Placement {
            shape_id: "tiny".into(),
            instance_index: 0,
            bin_id: "b1".into(),
            x: 0.0,
            y: 0.0,
            rotation_rad: 0.0,
            polygon,
            width: 1.0,
            height: 1.0,
            difficulty: None,
            tag: None,
            pack_polygon: None,
        };
        let trapped = compute_shape_trapped_scrap(&[&p]);
        let raw_total: f64 = trapped.iter().map(|t| t.area()).sum();
        assert!(
            raw_total > 0.0 && raw_total < MIN_VISIBLE_SCRAP_SQIN,
            "helper must return raw 0.125 sq in sliver (no filter); got {}",
            raw_total
        );
    }

    #[test]
    fn two_signal_includes_at_least_shape_trapped_for_sector() {
        // Single sector. The unioned scrap output must AT LEAST cover
        // the bbox-trapped corner area. It may extend further if the
        // inscribed-rect pass classified small slivers as Scrap and
        // folded them into the union — but never less than shape-
        // trapped, since shape-trapped is one of the inputs.
        let bin = fresh_bin("b1", 48.0, 96.0);
        let p = annular_sector_placement("b1", 10.0, 10.0, 3.0, 6.0, 120.0, 24);
        let (two_regions, offcuts) = extract_free_space_two_signal(&bin, &[&p]);
        assert!(
            !two_regions.is_empty(),
            "expected scrap polygons for a sector, got 0"
        );
        let bbox_area = p.width * p.height;
        let sector_area = polygon_area_loop(&p.polygon);
        let shape_trapped_expected = bbox_area - sector_area;
        let got: f64 = two_regions.iter().map(|r| r.area()).sum();
        assert!(
            got >= shape_trapped_expected - 0.5,
            "scrap area must cover at least bbox-trapped: got {:.4}, expected ≥ {:.4}",
            got,
            shape_trapped_expected
        );

        // Reusable offcuts are still produced for amber rendering.
        assert!(
            offcuts
                .iter()
                .any(|o| matches!(o.kind, OffcutKind::Reusable)),
            "expected at least one Reusable offcut"
        );
    }

    #[test]
    fn two_signal_emits_both_reusable_and_scrap_offcuts() {
        // The pipeline preserves both classifications so the frontend
        // can render Reusable as amber and Scrap as a debug overlay.
        // For a sector in a 96×48 bin we expect at least one of each.
        let bin = fresh_bin("b1", 48.0, 96.0);
        let p = annular_sector_placement("b1", 10.0, 10.0, 3.0, 6.0, 120.0, 24);
        let (_, offcuts) = extract_free_space_two_signal(&bin, &[&p]);
        assert!(
            offcuts
                .iter()
                .any(|o| matches!(o.kind, OffcutKind::Reusable)),
            "expected at least one Reusable offcut"
        );
    }

    #[test]
    fn reusable_offcuts_unaffected_by_union() {
        // Reusable offcuts pass through the partition untouched. Sum
        // of Reusable areas in the post-fold offcuts list must match
        // the sum of Reusable areas extract_offcuts_with_obstacles
        // would emit on its own (no double-counting, no dropping).
        let bin = fresh_bin("b1", 48.0, 96.0);
        let p = rect_placement("b1", 0.0, 0.0, 12.0, 12.0);

        // Replicate the obstacle construction inside the pipeline.
        let stock = build_stock_polygon(bin.width, bin.height).unwrap();
        let obstacles: Vec<Polygon> = vec![Polygon::new(p.polygon.clone()).expect("rect polygon")];
        let raw_offcuts = extract_offcuts_with_obstacles(&bin.bin_id, &[stock], &obstacles);
        let pre_reusable_sum: f64 = raw_offcuts
            .iter()
            .filter(|o| matches!(o.kind, OffcutKind::Reusable))
            .map(|o| o.width * o.height)
            .sum();

        let (_, offcuts) = extract_free_space_two_signal(&bin, &[&p]);
        let post_reusable_sum: f64 = offcuts.iter().map(|o| o.width * o.height).sum();

        assert!(
            (pre_reusable_sum - post_reusable_sum).abs() < 1e-6,
            "reusable area must survive the partition: pre = {}, post = {}",
            pre_reusable_sum,
            post_reusable_sum
        );
    }

    #[test]
    fn two_signal_empty_for_empty_input() {
        let bin = fresh_bin("b1", 48.0, 96.0);
        let (regions, offcuts) = extract_free_space_two_signal(&bin, &[]);
        assert!(regions.is_empty());
        assert!(offcuts.is_empty());
    }

    #[test]
    fn bbox_polygon_rejects_degenerate_input() {
        assert!(bbox_polygon(&[]).is_none());
        assert!(bbox_polygon(&[Point2D::new(0.0, 0.0), Point2D::new(1.0, 1.0)]).is_none());
        // Zero-height: all points on y=0.
        let zero_h = vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(1.0, 0.0),
            Point2D::new(2.0, 0.0),
        ];
        assert!(bbox_polygon(&zero_h).is_none());
    }

    #[test]
    fn bbox_polygon_accepts_valid_triangle() {
        let tri = vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(2.0, 0.0),
            Point2D::new(1.0, 3.0),
        ];
        let bb = bbox_polygon(&tri).expect("triangle should produce a bbox");
        assert!((bb.area() - 6.0).abs() < 1e-9);
    }

    #[test]
    fn coincident_sectors_union_collapses_duplicates() {
        // Two annular sectors at the same coordinates → their
        // bbox-minus-polygon crescents are identical. The union must
        // collapse the duplicates so the output count is no greater
        // than the single-cone count, and the total area matches the
        // single-cone area (no double-counting). Asserts the union
        // step actually runs and isn't a no-op concat.
        let p1 = annular_sector_placement("b1", 10.0, 10.0, 3.0, 6.0, 120.0, 24);
        let p2 = annular_sector_placement("b1", 10.0, 10.0, 3.0, 6.0, 120.0, 24);

        let single = compute_shape_trapped_scrap(&[&p1]);
        let merged = compute_shape_trapped_scrap(&[&p1, &p2]);

        assert!(
            !single.is_empty(),
            "single sector should produce at least one trapped polygon"
        );
        assert!(
            merged.len() <= single.len(),
            "coincident sectors should not exceed single-sector polygon count: \
             single = {}, merged = {}",
            single.len(),
            merged.len()
        );

        let single_area: f64 = single.iter().map(|p| p.area()).sum();
        let merged_area: f64 = merged.iter().map(|p| p.area()).sum();
        assert!(
            (single_area - merged_area).abs() < 0.5,
            "coincident-cone union must not double-count area: \
             single = {:.2}, merged = {:.2}",
            single_area,
            merged_area
        );
    }

    #[test]
    fn isolated_sectors_remain_separate_after_union() {
        // Two annular sectors placed far apart → their trapped
        // crescents are geometrically disjoint and the union must
        // NOT spuriously merge them. Output count = 2× single-cone
        // count.
        let p1 = annular_sector_placement("b1", 1.0, 1.0, 3.0, 6.0, 120.0, 24);
        let p2 = annular_sector_placement("b1", 30.0, 30.0, 3.0, 6.0, 120.0, 24);

        let single = compute_shape_trapped_scrap(&[&p1]);
        let merged = compute_shape_trapped_scrap(&[&p1, &p2]);

        assert_eq!(
            merged.len(),
            2 * single.len(),
            "disjoint cones should preserve every crescent (no spurious \
             merging): expected {}, got {}",
            2 * single.len(),
            merged.len()
        );

        let single_area: f64 = single.iter().map(|p| p.area()).sum();
        let merged_area: f64 = merged.iter().map(|p| p.area()).sum();
        assert!(
            (merged_area - 2.0 * single_area).abs() < 0.5,
            "disjoint-cone union area must be sum of per-cone areas: \
             expected ≈ {:.2}, got {:.2}",
            2.0 * single_area,
            merged_area
        );
    }
}
