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
}
