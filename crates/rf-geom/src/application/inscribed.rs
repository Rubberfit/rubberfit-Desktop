// engine/crates/rf-geom/src/application/inscribed.rs
use crate::domain::{Point2D, Polygon, Rect};

/// Find the largest axis-aligned inscribed rectangle inside a polygon.
/// Uses a grid + histogram + monotonic stack (O(RC) time).
/// `grid_step` controls grid density.
pub fn largest_inscribed_rect(polygon: &Polygon, grid_step: f64) -> Option<Rect> {
    largest_inscribed_rect_avoiding(polygon, &[], grid_step)
}

/// Largest axis-aligned inscribed rectangle inside `polygon`, with the
/// guarantee that no cell of the rect's interior falls inside any of the
/// `obstacles` polygons. Used by the post-pack scrap pipeline so
/// reusable rectangles don't extend through placed parts (the
/// rf-geom Clipper wrapper returns "outer + hole" pairs as two positive
/// polygons, so the bare polygon-only path treats the bin as a clean
/// rectangle and emits offcuts straight through cones — see
/// `rf-layout/src/application/free_space.rs` for the consumer).
///
/// `obstacles` should be in the same coordinate frame as `polygon`.
/// Empty slice == identical behaviour to `largest_inscribed_rect`.
pub fn largest_inscribed_rect_avoiding(
    polygon: &Polygon,
    obstacles: &[Polygon],
    grid_step: f64,
) -> Option<Rect> {
    let (min, max) = polygon.bbox();
    if grid_step <= 0.0 || (max.x - min.x) < grid_step || (max.y - min.y) < grid_step {
        return None;
    }
    let cols = ((max.x - min.x) / grid_step).ceil() as usize;
    let rows = ((max.y - min.y) / grid_step).ceil() as usize;

    // Mark cells as inside (true) or outside (false). Both loops need the
    // r/c indices for coordinate reconstruction (center-of-cell sampling),
    // so iterator-based scanning would only obscure the arithmetic.
    let mut grid = vec![vec![false; cols]; rows];
    #[allow(clippy::needless_range_loop)]
    for r in 0..rows {
        for c in 0..cols {
            let cx = min.x + (c as f64 + 0.5) * grid_step;
            let cy = min.y + (r as f64 + 0.5) * grid_step;
            let p = Point2D::new(cx, cy);
            if !point_in_polygon(p, polygon) {
                continue;
            }
            if obstacles.iter().any(|o| point_in_polygon(p, o)) {
                continue;
            }
            grid[r][c] = true;
        }
    }

    // Histogram heights
    let mut heights = vec![0usize; cols];
    let mut best: Option<(usize, usize, usize, usize)> = None; // (area, r_end, c_lo, c_hi)
    #[allow(clippy::needless_range_loop)]
    for r in 0..rows {
        for c in 0..cols {
            heights[c] = if grid[r][c] { heights[c] + 1 } else { 0 };
        }
        if let Some((area, c_lo, c_hi, h)) = largest_in_histogram(&heights) {
            let current = best.map(|(a, _, _, _)| a).unwrap_or(0);
            if area > current {
                best = Some((area, r, c_lo, c_hi));
                let _ = h;
            }
        }
    }

    let (area, r_end, c_lo, c_hi) = best?;
    let h_cells = area / (c_hi - c_lo + 1);
    Some(Rect::new(
        min.x + (c_lo as f64) * grid_step,
        min.y + ((r_end + 1 - h_cells) as f64) * grid_step,
        ((c_hi - c_lo + 1) as f64) * grid_step,
        (h_cells as f64) * grid_step,
    ))
}

/// Snap a candidate axis-aligned `rect` to the actual geometric edges
/// of `polygon` and `obstacles`. Each side may grow OR shrink by up to
/// `max_snap`. Returns the snapped rect (or the input unchanged if no
/// adjustment is needed).
///
/// The grid sampler in `largest_inscribed_rect_avoiding` is conservative
/// at borders: a cell whose centre sits exactly on a polygon/obstacle
/// boundary may be excluded, leaving up to half a grid step of free
/// space along each side that the sampler can't represent. Worse, when
/// an obstacle's boundary lands BETWEEN cell centres on the other side
/// (e.g. an obstacle's right edge at x=6.0068 with the cell at x=5.875
/// occupied and the cell at x=6.125 free), the inscribed rect's left
/// edge sits at the cell boundary x=6.0 — INSIDE the obstacle. The
/// post-pack offcut extractor (`rf_layout::application::free_space`)
/// uses this helper to (a) recover the half-cell gap when an obstacle
/// is fully outside the candidate rect, and (b) push the candidate
/// rect inward when an obstacle straddles its edge.
///
/// Snap distance is capped at `max_snap` per side. Pass the same
/// `grid_step` the sampler used — both directions are bounded by it,
/// so the worst case is "rect loses one grid cell on a side that
/// overlapped an obstacle." Obstacles always win over polygon edges
/// (snap targets are pushed strictly outside obstacles via `+EPS`).
///
/// Curved / diagonal edges of the polygon and obstacles are handled
/// conservatively: snap stops at the bbox of any non-axis-aligned edge
/// whose perpendicular extent overlaps the rect, never crossing into
/// the curve. This preserves correctness for cones / sectors / ngons —
/// the snapped rect stays outside the curve's true silhouette.
pub fn snap_rect_to_polygon_and_obstacles(
    rect: Rect,
    polygon: &Polygon,
    obstacles: &[Polygon],
    max_snap: f64,
) -> Rect {
    let max_snap = max_snap.max(0.0);
    if max_snap == 0.0 {
        return rect;
    }

    let rx0 = rect.x;
    let ry0 = rect.y;
    let rx1 = rect.x + rect.width;
    let ry1 = rect.y + rect.height;

    // Snap targets, initialised to the maximum-allowed outward
    // extension. Edge processing then pushes them toward (or past) the
    // rect's edge:
    //   left/bottom — `new_x_min` and `new_y_min` rise as obstacles or
    //                 polygon edges block extension. Obstacles whose
    //                 edges are slightly INSIDE the rect push past
    //                 the rect's edge, shrinking the rect inward.
    //   right/top   — `new_x_max` and `new_y_max` fall, symmetrically.
    // After processing all edges the snap targets are clamped to
    // [rect_edge - max_snap, rect_edge + max_snap] so snap can grow OR
    // shrink the rect by up to `max_snap` per side.
    let mut new_x_min = rx0 - max_snap;
    let mut new_x_max = rx1 + max_snap;
    let mut new_y_min = ry0 - max_snap;
    let mut new_y_max = ry1 + max_snap;

    process_polygon_for_snap(
        polygon,
        EdgeOrigin::Polygon,
        rx0,
        ry0,
        rx1,
        ry1,
        max_snap,
        &mut new_x_min,
        &mut new_x_max,
        &mut new_y_min,
        &mut new_y_max,
    );
    for o in obstacles {
        process_polygon_for_snap(
            o,
            EdgeOrigin::Obstacle,
            rx0,
            ry0,
            rx1,
            ry1,
            max_snap,
            &mut new_x_min,
            &mut new_x_max,
            &mut new_y_min,
            &mut new_y_max,
        );
    }

    // Cap snap distance per side. Range allows snap to grow OR shrink
    // by up to `max_snap` per side — shrinkage covers the case where
    // an obstacle straddles the rect's edge (see file header docs).
    let snapped_x_min = new_x_min.clamp(rx0 - max_snap, rx0 + max_snap);
    let snapped_x_max = new_x_max.clamp(rx1 - max_snap, rx1 + max_snap);
    let snapped_y_min = new_y_min.clamp(ry0 - max_snap, ry0 + max_snap);
    let snapped_y_max = new_y_max.clamp(ry1 - max_snap, ry1 + max_snap);

    // Re-establish min ≤ max on each axis. With both edges allowed to
    // shrink, an obstacle that crosses the entire rect on one axis
    // could in principle drive the two clamps past each other; that
    // collapses the rect to width/height 0 here rather than producing
    // a negative dimension.
    let snapped_x_max = snapped_x_max.max(snapped_x_min);
    let snapped_y_max = snapped_y_max.max(snapped_y_min);

    Rect::new(
        snapped_x_min,
        snapped_y_min,
        snapped_x_max - snapped_x_min,
        snapped_y_max - snapped_y_min,
    )
}

#[derive(Clone, Copy)]
enum EdgeOrigin {
    Polygon,
    Obstacle,
}

/// Walk each edge of `poly` and pull the four snap targets outward as
/// the edge allows. Helper for `snap_rect_to_polygon_and_obstacles`.
#[allow(clippy::too_many_arguments)]
fn process_polygon_for_snap(
    poly: &Polygon,
    origin: EdgeOrigin,
    rx0: f64,
    ry0: f64,
    rx1: f64,
    ry1: f64,
    max_snap: f64,
    new_x_min: &mut f64,
    new_x_max: &mut f64,
    new_y_min: &mut f64,
    new_y_max: &mut f64,
) {
    // Tiny epsilon to keep the snapped rect strictly outside obstacles.
    const EPS: f64 = 1e-6;
    // Slack on overlap test so an edge that only touches the rect at a
    // single corner doesn't count as crossing the rect's extent.
    const OVERLAP_SLACK: f64 = 1e-9;

    let pts = poly.points();
    let n = pts.len();
    if n < 2 {
        return;
    }

    for i in 0..n {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        let dx = (b.x - a.x).abs();
        let dy = (b.y - a.y).abs();
        let x_lo = a.x.min(b.x);
        let x_hi = a.x.max(b.x);
        let y_lo = a.y.min(b.y);
        let y_hi = a.y.max(b.y);

        let y_overlaps_rect = y_hi > ry0 + OVERLAP_SLACK && y_lo < ry1 - OVERLAP_SLACK;
        let x_overlaps_rect = x_hi > rx0 + OVERLAP_SLACK && x_lo < rx1 - OVERLAP_SLACK;

        if dx <= EPS && dy > EPS {
            // Axis-aligned vertical edge.
            if !y_overlaps_rect {
                continue;
            }
            let x = x_lo;
            match origin {
                EdgeOrigin::Polygon => {
                    if x <= rx0 + EPS && x > *new_x_min {
                        *new_x_min = x;
                    } else if x >= rx1 - EPS && x < *new_x_max {
                        *new_x_max = x;
                    }
                }
                EdgeOrigin::Obstacle => {
                    // Trigger window is `rx0 + max_snap` (not `+EPS`)
                    // so obstacle edges that landed slightly INSIDE the
                    // candidate rect — typical of grid quantization
                    // when the obstacle's right edge falls between
                    // cell centres — also snap-correct. The clamp
                    // below caps the inward push at `max_snap`.
                    if x <= rx0 + max_snap {
                        let snapped_to = x + EPS;
                        if snapped_to > *new_x_min {
                            *new_x_min = snapped_to;
                        }
                    } else if x >= rx1 - max_snap {
                        let snapped_to = x - EPS;
                        if snapped_to < *new_x_max {
                            *new_x_max = snapped_to;
                        }
                    }
                }
            }
        } else if dy <= EPS && dx > EPS {
            // Axis-aligned horizontal edge.
            if !x_overlaps_rect {
                continue;
            }
            let y = y_lo;
            match origin {
                EdgeOrigin::Polygon => {
                    if y <= ry0 + EPS && y > *new_y_min {
                        *new_y_min = y;
                    } else if y >= ry1 - EPS && y < *new_y_max {
                        *new_y_max = y;
                    }
                }
                EdgeOrigin::Obstacle => {
                    // Trigger window is `ry0 + max_snap` for the same
                    // reason as the vertical-edge branch above —
                    // obstacle edges that landed slightly inside the
                    // candidate rect get snap-corrected by inward push.
                    if y <= ry0 + max_snap {
                        let snapped_to = y + EPS;
                        if snapped_to > *new_y_min {
                            *new_y_min = snapped_to;
                        }
                    } else if y >= ry1 - max_snap {
                        let snapped_to = y - EPS;
                        if snapped_to < *new_y_max {
                            *new_y_max = snapped_to;
                        }
                    }
                }
            }
        } else if dx > EPS && dy > EPS {
            // Curved / diagonal edge — conservative bbox clamp. The
            // edge may bulge into the rect's perpendicular extent
            // anywhere along its span, so we never let the rect cross
            // the edge's bbox on that side.
            //
            // Polygon vs. obstacle gates use different conditions:
            //   - POLYGON: edge must be ENTIRELY on one side of the
            //     rect (`x_hi <= rx0` for snap-left, `x_lo >= rx1` for
            //     snap-right). The polygon is the inscribed source —
            //     edges that straddle the rect would mean the rect
            //     already pokes outside the polygon, which the
            //     inscribed-rect classifier rules out.
            //   - OBSTACLE: edge must NOT be crossed even if it
            //     straddles the rect's edge. A polyline approximating a
            //     curve has chords that connect to other chords; if
            //     snap considered each chord independently and only
            //     clamped on chords entirely outside the rect, an
            //     adjacent chord straddling the rect's edge would be
            //     ignored, and snap would happily pull the rect past
            //     that chord into the obstacle. The connected boundary
            //     between the two chord endpoints would then sit
            //     inside the snapped rect. Clamping by `x_lo <= rx0`
            //     (any portion of the chord at or past the rect's
            //     edge) closes that hole — for straddling chords the
            //     clamp resolves to "no snap on that side," which is
            //     correct: snap can't safely grow the rect when the
            //     obstacle's boundary already crosses it.
            if y_overlaps_rect {
                match origin {
                    EdgeOrigin::Polygon => {
                        if x_hi <= rx0 + EPS {
                            let snapped_to = x_hi + EPS;
                            if snapped_to > *new_x_min {
                                *new_x_min = snapped_to;
                            }
                        } else if x_lo >= rx1 - EPS {
                            let snapped_to = x_lo - EPS;
                            if snapped_to < *new_x_max {
                                *new_x_max = snapped_to;
                            }
                        }
                    }
                    EdgeOrigin::Obstacle => {
                        if x_lo <= rx0 + EPS {
                            let snapped_to = x_hi + EPS;
                            if snapped_to > *new_x_min {
                                *new_x_min = snapped_to;
                            }
                        }
                        if x_hi >= rx1 - EPS {
                            let snapped_to = x_lo - EPS;
                            if snapped_to < *new_x_max {
                                *new_x_max = snapped_to;
                            }
                        }
                    }
                }
            }
            if x_overlaps_rect {
                match origin {
                    EdgeOrigin::Polygon => {
                        if y_hi <= ry0 + EPS {
                            let snapped_to = y_hi + EPS;
                            if snapped_to > *new_y_min {
                                *new_y_min = snapped_to;
                            }
                        } else if y_lo >= ry1 - EPS {
                            let snapped_to = y_lo - EPS;
                            if snapped_to < *new_y_max {
                                *new_y_max = snapped_to;
                            }
                        }
                    }
                    EdgeOrigin::Obstacle => {
                        if y_lo <= ry0 + EPS {
                            let snapped_to = y_hi + EPS;
                            if snapped_to > *new_y_min {
                                *new_y_min = snapped_to;
                            }
                        }
                        if y_hi >= ry1 - EPS {
                            let snapped_to = y_lo - EPS;
                            if snapped_to < *new_y_max {
                                *new_y_max = snapped_to;
                            }
                        }
                    }
                }
            }
        }
        // dx <= EPS && dy <= EPS → degenerate zero-length edge, skip.
    }
}

fn point_in_polygon(p: Point2D, polygon: &Polygon) -> bool {
    // Ray casting PIP
    let pts = polygon.points();
    let n = pts.len();
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let pi = pts[i];
        let pj = pts[j];
        if (pi.y > p.y) != (pj.y > p.y) && p.x < (pj.x - pi.x) * (p.y - pi.y) / (pj.y - pi.y) + pi.x
        {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn largest_in_histogram(heights: &[usize]) -> Option<(usize, usize, usize, usize)> {
    // Returns (area, c_lo, c_hi, h)
    let mut stack: Vec<usize> = Vec::new();
    let mut best: Option<(usize, usize, usize, usize)> = None;
    for i in 0..=heights.len() {
        let h = if i == heights.len() { 0 } else { heights[i] };
        while let Some(&top) = stack.last() {
            if heights[top] <= h {
                break;
            }
            stack.pop();
            let c_lo = stack.last().map(|&s| s + 1).unwrap_or(0);
            let c_hi = i - 1;
            let area = heights[top] * (c_hi - c_lo + 1);
            let current = best.map(|(a, _, _, _)| a).unwrap_or(0);
            if area > current {
                best = Some((area, c_lo, c_hi, heights[top]));
            }
        }
        stack.push(i);
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit_square() -> Polygon {
        Polygon::new(vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(10.0, 0.0),
            Point2D::new(10.0, 10.0),
            Point2D::new(0.0, 10.0),
        ])
        .unwrap()
    }

    #[test]
    fn inscribed_rect_of_square_is_approximately_the_square() {
        let r = largest_inscribed_rect(&unit_square(), 1.0).unwrap();
        assert!(r.area() >= 81.0); // allowing 1-cell border due to grid quantization
    }

    #[test]
    fn none_when_grid_step_too_large() {
        assert!(largest_inscribed_rect(&unit_square(), 20.0).is_none());
    }

    #[test]
    fn obstacles_carve_inscribed_rect() {
        // 10x10 outer with a 4x4 obstacle in the middle. Largest rect
        // available avoids the obstacle — should be one of the side
        // strips ~10x3 = 30, not the unobstructed 81 we'd see without
        // the obstacle.
        let obstacle = Polygon::new(vec![
            Point2D::new(3.0, 3.0),
            Point2D::new(7.0, 3.0),
            Point2D::new(7.0, 7.0),
            Point2D::new(3.0, 7.0),
        ])
        .unwrap();
        let r = largest_inscribed_rect_avoiding(&unit_square(), &[obstacle], 1.0)
            .expect("should find a rect in the strips around the obstacle");
        // Three strips available (top, bottom, left, right of the obstacle);
        // largest is 10x3 = 30 in the obstructed square, give or take grid
        // quantization.
        assert!(
            r.area() <= 35.0 && r.area() >= 25.0,
            "expected rect ~30 (a side strip), got {:?} with area {}",
            r,
            r.area()
        );
    }

    #[test]
    fn no_obstacles_matches_legacy_path() {
        let with_empty = largest_inscribed_rect_avoiding(&unit_square(), &[], 1.0).unwrap();
        let legacy = largest_inscribed_rect(&unit_square(), 1.0).unwrap();
        assert_eq!(with_empty.x, legacy.x);
        assert_eq!(with_empty.y, legacy.y);
        assert_eq!(with_empty.width, legacy.width);
        assert_eq!(with_empty.height, legacy.height);
    }

    // ── snap_rect_to_polygon_and_obstacles ─────────────────────────

    #[test]
    fn snap_axis_aligned_left_wall() {
        // Rect inset 1" from every wall of a 10×10 polygon, no obstacles.
        // Snap with max_snap=1.0 should expand it back to fill the box.
        let r = Rect::new(1.0, 1.0, 8.0, 8.0);
        let snapped = snap_rect_to_polygon_and_obstacles(r, &unit_square(), &[], 1.0);
        assert!((snapped.x - 0.0).abs() < 1e-9, "x={}", snapped.x);
        assert!((snapped.y - 0.0).abs() < 1e-9, "y={}", snapped.y);
        assert!((snapped.width - 10.0).abs() < 1e-9, "w={}", snapped.width);
        assert!((snapped.height - 10.0).abs() < 1e-9, "h={}", snapped.height);
    }

    #[test]
    fn snap_already_at_edge() {
        // Rect already covers the full polygon: snap is a no-op.
        let r = Rect::new(0.0, 0.0, 10.0, 10.0);
        let snapped = snap_rect_to_polygon_and_obstacles(r, &unit_square(), &[], 1.0);
        assert!((snapped.x - 0.0).abs() < 1e-9);
        assert!((snapped.y - 0.0).abs() < 1e-9);
        assert!((snapped.width - 10.0).abs() < 1e-9);
        assert!((snapped.height - 10.0).abs() < 1e-9);
    }

    #[test]
    fn snap_stops_at_obstacle_right_edge() {
        // 10×10 outer; 4×4 obstacle at (3,3)-(7,7). Candidate to the
        // right of the obstacle: (7.25, 0, 2.5, 10). Snap-left should
        // halt at the obstacle's right wall (x=7), not cross into it.
        // Snap-right should reach the polygon's right wall at x=10.
        let obstacle = Polygon::new(vec![
            Point2D::new(3.0, 3.0),
            Point2D::new(7.0, 3.0),
            Point2D::new(7.0, 7.0),
            Point2D::new(3.0, 7.0),
        ])
        .unwrap();
        let r = Rect::new(7.25, 0.0, 2.5, 10.0);
        let snapped = snap_rect_to_polygon_and_obstacles(r, &unit_square(), &[obstacle], 1.0);
        assert!(
            snapped.x >= 7.0 && snapped.x <= 7.0 + 1e-5,
            "snapped.x = {}, expected ≈7.0",
            snapped.x
        );
        let right = snapped.x + snapped.width;
        assert!((right - 10.0).abs() < 1e-9, "right={}", right);
        assert!((snapped.y - 0.0).abs() < 1e-9);
        assert!((snapped.height - 10.0).abs() < 1e-9);
    }

    #[test]
    fn snap_curved_edge_conservative() {
        // Polygon with a diagonal edge (not axis-aligned) crossing the
        // snap range to the left of the rect. Snap must NOT cross the
        // diagonal — it stops at the diagonal's bbox (x_hi).
        // Polygon (CCW): triangle with hypotenuse on the left.
        //   (3,0) - (10,0) - (10,10) - (3,10) - hypotenuse-ish via (1,5)
        // We construct a 5-vertex polygon with one explicit diagonal
        // edge from (3,0) to (1,5), so x_hi=3.0 along that edge.
        let poly = Polygon::new(vec![
            Point2D::new(1.0, 5.0),
            Point2D::new(3.0, 0.0),
            Point2D::new(10.0, 0.0),
            Point2D::new(10.0, 10.0),
            Point2D::new(1.0, 10.0),
        ])
        .unwrap();
        // Candidate well inside the right portion. y-range overlaps the
        // diagonal edge's y-range [0, 5].
        let r = Rect::new(4.0, 1.0, 4.0, 3.0);
        let snapped = snap_rect_to_polygon_and_obstacles(r, &poly, &[], 1.0);
        // Snap-left must not move x_min below 3.0+EPS (the diagonal's
        // x_hi). The diagonal edge at (3,0)-(1,5) has x_hi=3.0 — the
        // conservative clamp keeps the rect at x>=3.0+1e-6.
        assert!(
            snapped.x >= 3.0 && snapped.x <= 4.0,
            "snapped.x={}, expected in [3.0, 4.0]",
            snapped.x
        );
        // x_min was 4.0; we expect snap to have grown left toward but
        // not past 3.0. Sanity: the snap moved (i.e. < 4.0 by at least
        // a small amount).
        assert!(
            snapped.x < 4.0,
            "snap should grow left, got x={}",
            snapped.x
        );
    }

    /// Issue B / Issue #20 regression. The inscribed-rect search
    /// returns rectangles aligned to grid cell boundaries, so an
    /// obstacle whose right edge lands BETWEEN cell centres can sit
    /// slightly inside the candidate rect's left edge. Snap must push
    /// the rect's left edge inward (rightward) to clear the obstacle —
    /// pre-fix it clamped back to rx0 and the rect overlapped the
    /// obstacle by up to one grid step.
    #[test]
    fn snap_pulls_left_edge_in_when_axis_aligned_obstacle_right_edge_just_inside_rect() {
        // 24×24 polygon. Obstacle's right edge at x=6.0068 (1/72" past
        // the inscribed rect's grid-aligned left edge at x=6.0).
        let poly = Polygon::new(vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(24.0, 0.0),
            Point2D::new(24.0, 24.0),
            Point2D::new(0.0, 24.0),
        ])
        .unwrap();
        let obstacle = Polygon::new(vec![
            Point2D::new(0.0, 12.0),
            Point2D::new(6.0068, 12.0),
            Point2D::new(6.0068, 18.0),
            Point2D::new(0.0, 18.0),
        ])
        .unwrap();
        let r = Rect::new(6.0, 0.0, 18.0, 24.0);
        let snapped = snap_rect_to_polygon_and_obstacles(r, &poly, &[obstacle], 0.25);
        assert!(
            snapped.x >= 6.0068 && snapped.x <= 6.0068 + 1e-3,
            "snapped.x={} should sit just past obstacle's right edge 6.0068",
            snapped.x
        );
        let right = snapped.x + snapped.width;
        assert!(
            (right - 24.0).abs() < 1e-9,
            "right={}, expected 24.0",
            right
        );
    }

    /// Same regression but with a polygon whose top/bottom edges are
    /// slightly diagonal — mimics the f32-rotated polygon jagua emits
    /// for parts placed at rotation ≈ π/2. The diagonal-obstacle branch
    /// (`x_lo <= rx0 + EPS`) fires on the straddling top/bottom edges
    /// and the new clamp lets the resulting `x_hi + EPS` snap target
    /// take effect.
    #[test]
    fn snap_pulls_left_edge_in_when_diagonal_obstacle_right_edge_just_inside_rect() {
        let poly = Polygon::new(vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(24.0, 0.0),
            Point2D::new(24.0, 24.0),
            Point2D::new(0.0, 24.0),
        ])
        .unwrap();
        // Vertices mirror an actual jagua p[29] from the user's repro:
        // 90°-rotated 6×6 placed flush-ish at the left wall, with f32
        // noise leaving the top edge tilted.
        let obstacle = Polygon::new(vec![
            Point2D::new(6.006848, 18.403025),
            Point2D::new(0.006848, 18.403172),
            Point2D::new(0.006701, 12.403172),
            Point2D::new(6.006701, 12.403025),
        ])
        .unwrap();
        let r = Rect::new(6.0, 0.0, 18.0, 24.0);
        let snapped = snap_rect_to_polygon_and_obstacles(r, &poly, &[obstacle], 0.25);
        // Snap should push left edge to obstacle's max x (~6.006848)
        // plus EPS. Anything ≥ 6.006848 is correct; allow a small slop
        // for the +EPS push.
        assert!(
            snapped.x >= 6.006848 && snapped.x <= 6.006848 + 1e-3,
            "snapped.x={} should sit just past obstacle's max x 6.006848",
            snapped.x
        );
    }

    #[test]
    fn snap_does_not_shrink_when_no_obstacle_overlap() {
        // Pure extension case: obstacle fully to the left of the rect's
        // left edge. Snap should grow leftward toward the obstacle's
        // right edge, not shrink.
        let poly = Polygon::new(vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(24.0, 0.0),
            Point2D::new(24.0, 24.0),
            Point2D::new(0.0, 24.0),
        ])
        .unwrap();
        let obstacle = Polygon::new(vec![
            Point2D::new(0.0, 12.0),
            Point2D::new(5.875, 12.0),
            Point2D::new(5.875, 18.0),
            Point2D::new(0.0, 18.0),
        ])
        .unwrap();
        let r = Rect::new(6.0, 0.0, 18.0, 24.0);
        let snapped = snap_rect_to_polygon_and_obstacles(r, &poly, &[obstacle], 0.25);
        assert!(
            snapped.x >= 5.875 && snapped.x <= 5.875 + 1e-3,
            "snapped.x={} should snap left to obstacle's right edge 5.875",
            snapped.x
        );
        let right = snapped.x + snapped.width;
        assert!((right - 24.0).abs() < 1e-9);
    }

    #[test]
    fn snap_distance_capped_at_max() {
        // Rect deep inside a 10×10 polygon, max_snap=0.25 → each side
        // grows by ≤ 0.25 even though walls are >2" away.
        let r = Rect::new(2.0, 2.0, 6.0, 6.0);
        let snapped = snap_rect_to_polygon_and_obstacles(r, &unit_square(), &[], 0.25);
        assert!(snapped.x >= 2.0 - 0.25 - 1e-9, "x={}", snapped.x);
        assert!(
            snapped.x <= 2.0 + 1e-9,
            "snap should not shrink, x={}",
            snapped.x
        );
        let right = snapped.x + snapped.width;
        assert!(right <= 8.0 + 0.25 + 1e-9, "right={}", right);
        assert!(right >= 8.0 - 1e-9);
        assert!(snapped.y >= 2.0 - 0.25 - 1e-9 && snapped.y <= 2.0 + 1e-9);
        let top = snapped.y + snapped.height;
        assert!(top <= 8.0 + 0.25 + 1e-9 && top >= 8.0 - 1e-9);
    }
}
