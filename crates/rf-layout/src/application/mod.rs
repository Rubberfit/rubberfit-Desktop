// engine/crates/rf-layout/src/application/mod.rs
pub mod cone_strategy;
pub mod crossbin;
pub mod free_space;
pub mod offcut_classifier;
pub mod pack;
pub mod pack_lbf;
pub mod pack_lbf_lns;
pub mod polish;
pub mod strategy;

pub use cone_strategy::{
    cone_dims_from_part, cone_strategy_for, materialise_polygon, materialise_request_polygons,
    parse_cone_dimensions, AnnularSectorStrategy, ConeDimensions, ConePolygonStrategy,
    ConeStrategyKind, ConvexWedgeStrategy,
};
pub use crossbin::try_cross_bin_moveout;
pub use pack::pack;
pub use pack_lbf::{pack_lbf, pack_lbf_with_config, PackLbfConfig};
pub use pack_lbf_lns::{pack_lbf_lns, pack_lbf_lns_with_config, PackLbfLnsConfig};
pub use polish::{polish_placements, polish_score, PolishConfig, PolishScore};
pub use strategy::{strategy_for, LbfLnsStrategy, LbfStrategy, LegacyStrategy, NestingStrategy};
