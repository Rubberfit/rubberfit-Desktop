// engine/crates/rf-geom/src/application/mod.rs
pub mod convex_hull;
pub mod inscribed;
pub mod normalize;
pub mod sat;

pub use convex_hull::convex_hull;
pub use inscribed::largest_inscribed_rect;
pub use normalize::{bbox_of, normalize_polygon};
pub use sat::sat_overlap;
