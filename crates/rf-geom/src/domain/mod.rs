// engine/crates/rf-geom/src/domain/mod.rs
pub mod errors;
pub mod point;
pub mod polygon;
pub mod rect;

pub use errors::GeomError;
pub use point::Point2D;
pub use polygon::Polygon;
pub use rect::Rect;
