// engine/crates/rf-geom/src/application/convex_hull.rs
use crate::domain::{GeomError, Point2D, Polygon};

/// Andrew's monotone chain convex hull. Returns points in CCW order.
pub fn convex_hull(points: &[Point2D]) -> Result<Polygon, GeomError> {
    if points.len() < 3 {
        return Err(GeomError::PolygonTooFewVertices {
            count: points.len(),
        });
    }
    let mut pts: Vec<Point2D> = points.to_vec();
    pts.sort_by(|a, b| {
        a.x.partial_cmp(&b.x)
            .unwrap()
            .then(a.y.partial_cmp(&b.y).unwrap())
    });

    let mut lower: Vec<Point2D> = Vec::new();
    for p in &pts {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], *p) <= 0.0 {
            lower.pop();
        }
        lower.push(*p);
    }

    let mut upper: Vec<Point2D> = Vec::new();
    for p in pts.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], *p) <= 0.0 {
            upper.pop();
        }
        upper.push(*p);
    }

    lower.pop();
    upper.pop();
    lower.extend(upper);
    Polygon::new(lower)
}

fn cross(o: Point2D, a: Point2D, b: Point2D) -> f64 {
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn triangle_is_its_own_hull() {
        let pts = vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(4.0, 0.0),
            Point2D::new(2.0, 3.0),
        ];
        let hull = convex_hull(&pts).unwrap();
        assert_eq!(hull.points().len(), 3);
    }

    #[test]
    fn discards_interior_points() {
        let pts = vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(4.0, 0.0),
            Point2D::new(4.0, 4.0),
            Point2D::new(0.0, 4.0),
            Point2D::new(2.0, 2.0), // interior — should be discarded
        ];
        let hull = convex_hull(&pts).unwrap();
        assert_eq!(hull.points().len(), 4);
    }

    #[test]
    fn hull_is_ccw() {
        let pts = vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(4.0, 0.0),
            Point2D::new(4.0, 4.0),
            Point2D::new(0.0, 4.0),
        ];
        let hull = convex_hull(&pts).unwrap();
        assert!(hull.signed_area() > 0.0);
    }
}
