// engine/crates/rf-geom/src/domain/polygon.rs
use crate::domain::errors::GeomError;
use crate::domain::point::Point2D;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(transparent)]
pub struct Polygon {
    points: Vec<Point2D>,
}

impl Polygon {
    pub fn new(points: Vec<Point2D>) -> Result<Self, GeomError> {
        if points.len() < 3 {
            return Err(GeomError::PolygonTooFewVertices {
                count: points.len(),
            });
        }
        Ok(Self { points })
    }

    pub fn points(&self) -> &[Point2D] {
        &self.points
    }

    pub fn into_points(self) -> Vec<Point2D> {
        self.points
    }

    pub fn signed_area(&self) -> f64 {
        let mut s = 0.0;
        for i in 0..self.points.len() {
            let a = self.points[i];
            let b = self.points[(i + 1) % self.points.len()];
            s += a.x * b.y - b.x * a.y;
        }
        s / 2.0
    }

    pub fn area(&self) -> f64 {
        self.signed_area().abs()
    }

    pub fn bbox(&self) -> (Point2D, Point2D) {
        let mut min = self.points[0];
        let mut max = self.points[0];
        for p in &self.points[1..] {
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
        (min, max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit_square() -> Polygon {
        Polygon::new(vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(1.0, 0.0),
            Point2D::new(1.0, 1.0),
            Point2D::new(0.0, 1.0),
        ])
        .unwrap()
    }

    #[test]
    fn rejects_fewer_than_three_vertices() {
        let r = Polygon::new(vec![Point2D::new(0.0, 0.0), Point2D::new(1.0, 0.0)]);
        assert!(matches!(
            r,
            Err(GeomError::PolygonTooFewVertices { count: 2 })
        ));
    }

    #[test]
    fn accepts_triangle() {
        let tri = Polygon::new(vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(1.0, 0.0),
            Point2D::new(0.0, 1.0),
        ]);
        assert!(tri.is_ok());
    }

    #[test]
    fn unit_square_has_area_one() {
        assert!((unit_square().area() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn unit_square_signed_area_is_positive_when_ccw() {
        assert!(unit_square().signed_area() > 0.0);
    }

    #[test]
    fn bbox_of_unit_square_is_zero_to_one() {
        let (min, max) = unit_square().bbox();
        assert_eq!(min, Point2D::new(0.0, 0.0));
        assert_eq!(max, Point2D::new(1.0, 1.0));
    }

    #[test]
    fn serde_roundtrip_as_transparent_array() {
        let p = unit_square();
        let json = serde_json::to_string(&p).unwrap();
        assert_eq!(
            json,
            r#"[{"x":0.0,"y":0.0},{"x":1.0,"y":0.0},{"x":1.0,"y":1.0},{"x":0.0,"y":1.0}]"#
        );
    }
}
