// engine/crates/rf-layout/src/domain/mod.rs
pub mod errors;
pub mod options;
pub mod request;
pub mod result;

pub use errors::PackError;
pub use options::SearchOptions;
pub use request::{
    Bin, BinKind, GrainAxis, OperatorProfile, PackEngine, PackMode, PackRequest, Part, ShapeSpec,
    UnitSystem,
};
pub use request::{BALANCED_MS, FAST_MS, THOROUGH_MS};
pub use result::{BinResult, ClassifiedOffcut, OffcutKind, PackResult, Placement};
