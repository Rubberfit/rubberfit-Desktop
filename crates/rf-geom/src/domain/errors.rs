// engine/crates/rf-geom/src/domain/errors.rs
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum GeomError {
    #[error("polygon must have at least 3 vertices, got {count}")]
    PolygonTooFewVertices { count: usize },
    #[error("polygon is self-intersecting")]
    SelfIntersecting,
    #[error("polygon has zero area")]
    ZeroArea,
    #[error("clipper operation failed: {0}")]
    ClipperFailed(String),
}
