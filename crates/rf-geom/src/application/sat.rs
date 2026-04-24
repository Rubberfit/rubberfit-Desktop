// engine/crates/rf-geom/src/application/sat.rs
use crate::domain::{Point2D, Polygon};

/// Test whether two convex polygons overlap using the Separating Axis Theorem.
/// Touching edges do NOT count as overlap (strict overlap only).
pub fn sat_overlap(a: &Polygon, b: &Polygon) -> bool {
    !has_separating_axis(a, b) && !has_separating_axis(b, a)
}

fn has_separating_axis(a: &Polygon, b: &Polygon) -> bool {
    let a_pts = a.points();
    for i in 0..a_pts.len() {
        let p1 = a_pts[i];
        let p2 = a_pts[(i + 1) % a_pts.len()];
        let axis = Point2D::new(-(p2.y - p1.y), p2.x - p1.x);
        let (a_min, a_max) = project(a, axis);
        let (b_min, b_max) = project(b, axis);
        if a_max <= b_min || b_max <= a_min {
            return true;
        }
    }
    false
}

fn project(p: &Polygon, axis: Point2D) -> (f64, f64) {
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for pt in p.points() {
        let d = pt.x * axis.x + pt.y * axis.y;
        if d < min {
            min = d;
        }
        if d > max {
            max = d;
        }
    }
    (min, max)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square_at(ox: f64, oy: f64, size: f64) -> Polygon {
        Polygon::new(vec![
            Point2D::new(ox, oy),
            Point2D::new(ox + size, oy),
            Point2D::new(ox + size, oy + size),
            Point2D::new(ox, oy + size),
        ])
        .unwrap()
    }

    #[test]
    fn overlapping_squares_overlap() {
        assert!(sat_overlap(
            &square_at(0.0, 0.0, 10.0),
            &square_at(5.0, 5.0, 10.0)
        ));
    }

    #[test]
    fn disjoint_squares_do_not_overlap() {
        assert!(!sat_overlap(
            &square_at(0.0, 0.0, 10.0),
            &square_at(20.0, 0.0, 10.0)
        ));
    }

    #[test]
    fn touching_squares_do_not_overlap() {
        // Edge-adjacent squares: strict overlap is false
        assert!(!sat_overlap(
            &square_at(0.0, 0.0, 10.0),
            &square_at(10.0, 0.0, 10.0)
        ));
    }
}
