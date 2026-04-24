// engine/crates/rf-geom/src/application/normalize.rs
use crate::domain::{GeomError, Point2D, Polygon};

/// Compute the axis-aligned bounding box of a slice of points.
///
/// Returns `(min, max)` where `min` has the smallest x/y values and `max`
/// the largest. Rejects empty slices with `GeomError::PolygonTooFewVertices`.
pub fn bbox_of(points: &[Point2D]) -> Result<(Point2D, Point2D), GeomError> {
    if points.is_empty() {
        return Err(GeomError::PolygonTooFewVertices { count: 0 });
    }
    let mut min = points[0];
    let mut max = points[0];
    for p in &points[1..] {
        if p.x < min.x {
            min.x = p.x;
        }
        if p.y < min.y {
            min.y = p.y;
        }
        if p.x > max.x {
            max.x = p.x;
        }
        if p.y > max.y {
            max.y = p.y;
        }
    }
    Ok((min, max))
}

/// Normalize a polygon to CCW winding with min-corner at (0, 0).
pub fn normalize_polygon(points: Vec<Point2D>) -> Result<Polygon, GeomError> {
    if points.len() < 3 {
        return Err(GeomError::PolygonTooFewVertices {
            count: points.len(),
        });
    }
    let min_x = points.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
    let min_y = points.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
    let translated: Vec<Point2D> = points
        .iter()
        .map(|p| Point2D::new(p.x - min_x, p.y - min_y))
        .collect();

    let polygon = Polygon::new(translated)?;
    if polygon.signed_area() >= 0.0 {
        Ok(polygon)
    } else {
        let mut reversed: Vec<Point2D> = polygon.points().to_vec();
        reversed.reverse();
        Polygon::new(reversed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_to_origin() {
        let raw = vec![
            Point2D::new(5.0, 10.0),
            Point2D::new(8.0, 10.0),
            Point2D::new(8.0, 14.0),
            Point2D::new(5.0, 14.0),
        ];
        let p = normalize_polygon(raw).unwrap();
        let (min, _) = p.bbox();
        assert_eq!(min, Point2D::new(0.0, 0.0));
    }

    #[test]
    fn reverses_cw_to_ccw() {
        // CW in math coords: (0,0) → (0,1) → (1,1) → (1,0)
        let cw = vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(0.0, 1.0),
            Point2D::new(1.0, 1.0),
            Point2D::new(1.0, 0.0),
        ];
        let p = normalize_polygon(cw).unwrap();
        assert!(p.signed_area() > 0.0, "normalized polygon must be CCW");
    }

    #[test]
    fn rejects_fewer_than_three_vertices() {
        let too_few = vec![Point2D::new(0.0, 0.0), Point2D::new(1.0, 0.0)];
        assert!(normalize_polygon(too_few).is_err());
    }
}

#[cfg(test)]
mod bbox_of_tests {
    use super::*;

    #[test]
    fn bbox_of_computes_min_and_max() {
        let pts = vec![
            Point2D::new(2.0, 3.0),
            Point2D::new(8.0, 3.0),
            Point2D::new(8.0, 7.0),
            Point2D::new(2.0, 7.0),
        ];
        let (min, max) = bbox_of(&pts).unwrap();
        assert_eq!(min, Point2D::new(2.0, 3.0));
        assert_eq!(max, Point2D::new(8.0, 7.0));
    }

    #[test]
    fn bbox_of_rejects_empty_slice() {
        let pts: Vec<Point2D> = vec![];
        assert!(bbox_of(&pts).is_err());
    }
}
