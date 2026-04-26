// engine/crates/rf-layout/src/application/mod.rs
pub mod cone_strategy;
pub mod crossbin;
pub mod free_space;
pub mod offcut_classifier;
pub mod offcut_extraction_strategy;
pub mod pack;
pub mod pack_lbf;
pub mod pack_lbf_lns;
pub mod polish;
pub mod scrap_strategy;
pub mod shape_builder;
pub mod strategy;

pub use cone_strategy::{
    build_sector_polygon_from_spec, cone_dims_from_part, cone_strategy_for, default_cone_segments,
    parse_cone_dimensions, AnnularSectorStrategy, ConeDimensions, ConePackingMode,
    ConePolygonStrategy, ConeStrategyKind, ConvexWedgeStrategy,
};
pub use crossbin::try_cross_bin_moveout;
pub use offcut_extraction_strategy::{
    offcut_extraction_strategy_for, GreedyMaxRectStrategy, OffcutExtractionStrategy,
    OffcutExtractionStrategyKind,
};
pub use pack::pack;
pub use pack_lbf::{pack_lbf, pack_lbf_with_config, PackLbfConfig};
pub use pack_lbf_lns::{pack_lbf_lns, pack_lbf_lns_with_config, PackLbfLnsConfig};
pub use polish::{polish_placements, polish_score, PolishConfig, PolishScore};
pub use scrap_strategy::{
    scrap_strategy_for, LegacyScrapStrategy, ScrapStrategy, ScrapStrategyKind,
    TwoSignalScrapStrategy,
};
pub use shape_builder::{
    build_polygon_from_spec, materialise_polygon, materialise_request_polygons,
};
pub use strategy::{strategy_for, LbfLnsStrategy, LbfStrategy, LegacyStrategy, NestingStrategy};
