// engine/crates/rf-geom/src/domain/rect.rs
use crate::domain::point::Point2D;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn area(&self) -> f64 {
        self.width * self.height
    }

    pub fn min_corner(&self) -> Point2D {
        Point2D::new(self.x, self.y)
    }

    pub fn max_corner(&self) -> Point2D {
        Point2D::new(self.x + self.width, self.y + self.height)
    }

    pub fn contains(&self, p: Point2D) -> bool {
        p.x >= self.x && p.x <= self.x + self.width && p.y >= self.y && p.y <= self.y + self.height
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn area_is_width_times_height() {
        assert_eq!(Rect::new(0.0, 0.0, 3.0, 4.0).area(), 12.0);
    }

    #[test]
    fn contains_point_inside() {
        let r = Rect::new(0.0, 0.0, 10.0, 10.0);
        assert!(r.contains(Point2D::new(5.0, 5.0)));
    }

    #[test]
    fn does_not_contain_point_outside() {
        let r = Rect::new(0.0, 0.0, 10.0, 10.0);
        assert!(!r.contains(Point2D::new(15.0, 5.0)));
    }
}
