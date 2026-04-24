// engine/crates/rf-layout/src/domain/errors.rs
use thiserror::Error;

#[derive(Error, Debug)]
pub enum PackError {
    #[error("pack: no bins provided")]
    NoBins,
    #[error("pack: no items provided")]
    NoItems,
    #[error("pack: invalid polygon on part '{shape_id}': {source}")]
    InvalidPolygon {
        shape_id: String,
        #[source]
        source: rf_geom::domain::GeomError,
    },
    #[error("pack: engine failed: {0}")]
    EngineFailed(String),
    #[error("pack: timeout after {0}ms")]
    Timeout(u64),
}
