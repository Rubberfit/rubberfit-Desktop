// engine/crates/rf-geom/src/domain/point.rs
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Point2D {
    pub x: f64,
    pub y: f64,
}

impl Point2D {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_constructs_point() {
        let p = Point2D::new(3.0, 4.0);
        assert_eq!(p.x, 3.0);
        assert_eq!(p.y, 4.0);
    }

    #[test]
    fn serializes_as_camel_case_identity() {
        let p = Point2D::new(1.5, 2.5);
        let json = serde_json::to_string(&p).unwrap();
        assert_eq!(json, r#"{"x":1.5,"y":2.5}"#);
    }

    #[test]
    fn deserializes_from_json() {
        let p: Point2D = serde_json::from_str(r#"{"x":1.5,"y":2.5}"#).unwrap();
        assert_eq!(p, Point2D::new(1.5, 2.5));
    }
}
