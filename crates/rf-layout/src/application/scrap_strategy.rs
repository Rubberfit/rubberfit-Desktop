// engine/crates/rf-layout/src/application/scrap_strategy.rs
//
// Strategy pattern for scrap-extraction pipelines.
//
// Two implementations today:
//
//   - `LegacyScrapStrategy` — the pre-fix behaviour:
//     `clip_difference(stock, placed_polygons)` plus iterative inscribed-
//     rectangle classification (`Reusable` ≥ 11.5×12 or 6×24, else
//     `Scrap`). Kept as an A/B / rollback path.
//
//   - `TwoSignalScrapStrategy` — Free Roam parity. Same bin-level diff,
//     but additionally emits per-part `bbox(polygon) − polygon`
//     "shape-trapped" crescents so cones, ellipses, ngons, triangles,
//     stars, and rings render their corner waste explicitly. Cones in
//     ConvexHull packing mode show the hull-minus-sector donut as scrap
//     too. Production default.
//
// Both impls delegate the actual offcut-rectangle classification to an
// `OffcutExtractionStrategy` (`application::offcut_extraction_strategy`)
// held on the struct. That sub-strategy decides *how* the rectangles
// are computed (greedy max-rect today; future stripe-partition or
// post-loop merge variants tracked in issue #14). The scrap strategy
// decides *what* counts as scrap vs offcut and assembles the bin-level
// signals around that.
//
// Same shape as `application::strategy::NestingStrategy` and
// `application::cone_strategy::ConePolygonStrategy`: trait + factory,
// not a bare match. Adding a new pipeline (e.g. operator-tuned scrap
// thresholds) = new struct + impl + one extra match arm in
// `scrap_strategy_for`, nothing else.
//
// Wire-driven via `PackRequest.scrap_strategy` and
// `PackRequest.offcut_extraction_strategy`. Both absent →
// `TwoSignal` + `GreedyMaxRect`.

use crate::application::offcut_extraction_strategy::{
    offcut_extraction_strategy_for, OffcutExtractionStrategy, OffcutExtractionStrategyKind,
};
use crate::domain::{Bin, ClassifiedOffcut, Placement};
use rf_geom::domain::Polygon;
use serde::{Deserialize, Serialize};

/// One scrap-extraction pipeline. Stateless w.r.t. the request — any
/// tunables live in the impl's own config struct, constructed at
/// strategy-creation time.
pub trait ScrapStrategy: Send + Sync + 'static {
    /// Stable identifier for logs and parity-test assertions.
    fn name(&self) -> &'static str;

    /// Compute `(free_regions, classified_offcuts)` for one bin.
    fn extract(
        &self,
        bin: &Bin,
        placements: &[&Placement],
    ) -> (Vec<Polygon>, Vec<ClassifiedOffcut>);
}

/// Wire-format identifier for the active scrap strategy. Serialised on
/// `PackRequest.scrap_strategy`; absent means `TwoSignal` (production
/// default — Free Roam parity).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ScrapStrategyKind {
    /// Pre-fix behaviour: bin-level Clipper diff + inscribed-rect
    /// classification only. Kept for A/B comparison and rollback.
    Legacy,
    /// Free Roam parity: bin-level diff PLUS per-part
    /// bbox-minus-polygon shape-trapped crescents.
    #[default]
    TwoSignal,
}

pub struct LegacyScrapStrategy {
    offcut: Box<dyn OffcutExtractionStrategy>,
}

pub struct TwoSignalScrapStrategy {
    offcut: Box<dyn OffcutExtractionStrategy>,
}

impl LegacyScrapStrategy {
    pub fn new(offcut: Box<dyn OffcutExtractionStrategy>) -> Self {
        Self { offcut }
    }
}

impl Default for LegacyScrapStrategy {
    fn default() -> Self {
        Self::new(offcut_extraction_strategy_for(
            OffcutExtractionStrategyKind::default(),
        ))
    }
}

impl TwoSignalScrapStrategy {
    pub fn new(offcut: Box<dyn OffcutExtractionStrategy>) -> Self {
        Self { offcut }
    }
}

impl Default for TwoSignalScrapStrategy {
    fn default() -> Self {
        Self::new(offcut_extraction_strategy_for(
            OffcutExtractionStrategyKind::default(),
        ))
    }
}

impl ScrapStrategy for LegacyScrapStrategy {
    fn name(&self) -> &'static str {
        "scrap_legacy"
    }

    fn extract(
        &self,
        bin: &Bin,
        placements: &[&Placement],
    ) -> (Vec<Polygon>, Vec<ClassifiedOffcut>) {
        crate::application::free_space::extract_free_space_legacy_with(
            bin,
            placements,
            self.offcut.as_ref(),
        )
    }
}

impl ScrapStrategy for TwoSignalScrapStrategy {
    fn name(&self) -> &'static str {
        "scrap_two_signal"
    }

    fn extract(
        &self,
        bin: &Bin,
        placements: &[&Placement],
    ) -> (Vec<Polygon>, Vec<ClassifiedOffcut>) {
        crate::application::free_space::extract_free_space_two_signal_with(
            bin,
            placements,
            self.offcut.as_ref(),
        )
    }
}

/// Map a `(ScrapStrategyKind, OffcutExtractionStrategyKind)` pair to a
/// concrete strategy. New scrap pipeline = new struct + impl + one
/// extra match arm here, nothing else; new offcut pipeline = new arm
/// in `offcut_extraction_strategy_for`.
pub fn scrap_strategy_for(
    scrap_kind: ScrapStrategyKind,
    offcut_kind: OffcutExtractionStrategyKind,
) -> Box<dyn ScrapStrategy> {
    let offcut = offcut_extraction_strategy_for(offcut_kind);
    match scrap_kind {
        ScrapStrategyKind::Legacy => Box::new(LegacyScrapStrategy::new(offcut)),
        ScrapStrategyKind::TwoSignal => Box::new(TwoSignalScrapStrategy::new(offcut)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn factory_dispatches_to_named_impl() {
        assert_eq!(
            scrap_strategy_for(
                ScrapStrategyKind::Legacy,
                OffcutExtractionStrategyKind::default()
            )
            .name(),
            "scrap_legacy"
        );
        assert_eq!(
            scrap_strategy_for(
                ScrapStrategyKind::TwoSignal,
                OffcutExtractionStrategyKind::default()
            )
            .name(),
            "scrap_two_signal"
        );
    }

    #[test]
    fn default_kind_is_two_signal() {
        assert_eq!(ScrapStrategyKind::default(), ScrapStrategyKind::TwoSignal);
    }

    #[test]
    fn scrap_strategy_kind_serialises_camel_case() {
        let s = serde_json::to_string(&ScrapStrategyKind::TwoSignal).unwrap();
        assert_eq!(s, "\"twoSignal\"");
        let s = serde_json::to_string(&ScrapStrategyKind::Legacy).unwrap();
        assert_eq!(s, "\"legacy\"");
        let k: ScrapStrategyKind = serde_json::from_str("\"twoSignal\"").unwrap();
        assert_eq!(k, ScrapStrategyKind::TwoSignal);
        let k: ScrapStrategyKind = serde_json::from_str("\"legacy\"").unwrap();
        assert_eq!(k, ScrapStrategyKind::Legacy);
    }
}
