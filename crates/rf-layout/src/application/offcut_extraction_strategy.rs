// engine/crates/rf-layout/src/application/offcut_extraction_strategy.rs
//
// Strategy pattern for reusable-offcut extraction algorithms.
//
// One implementation today:
//
//   - `GreedyMaxRectStrategy` — current production behaviour. Iterative
//     maximal-inscribed-rectangle extraction: find the largest
//     axis-aligned rect inside the working free-space polygons (avoiding
//     placed parts as obstacles), classify it, subtract it via Clipper,
//     repeat until 16 offcuts emitted, working set empty, or the
//     500 ms per-bin deadline trips. No post-loop merging or
//     backtracking. Body lives in
//     `application::free_space::extract_offcuts_with_obstacles`.
//
// Future strategies under exploration in issue #14 (post-loop pairwise
// merge, stripe partition, all-maximal-rect enumeration). Adding a new
// pipeline = new struct + impl + one extra match arm in
// `offcut_extraction_strategy_for`, nothing else.
//
// Same shape as `application::scrap_strategy`,
// `application::cone_strategy`, and `application::strategy`: trait +
// factory, not a bare match.
//
// Wire-driven via `PackRequest.offcut_extraction_strategy`. Absent →
// `GreedyMaxRect`.

use crate::domain::ClassifiedOffcut;
use rf_geom::domain::Polygon;
use serde::{Deserialize, Serialize};

/// One offcut-extraction pipeline. Stateless w.r.t. the request — any
/// tunables live in the impl's own config struct, constructed at
/// strategy-creation time.
pub trait OffcutExtractionStrategy: Send + Sync + 'static {
    /// Stable identifier for logs and parity-test assertions.
    fn name(&self) -> &'static str;

    /// Extract classified rectangles from `free_regions`, treating each
    /// polygon in `obstacles` as a forbidden zone the emitted rects
    /// must not overlap. Empty `obstacles` is allowed (legacy path).
    fn extract(
        &self,
        bin_id: &str,
        free_regions: &[Polygon],
        obstacles: &[Polygon],
    ) -> Vec<ClassifiedOffcut>;
}

/// Wire-format identifier for the active offcut-extraction strategy.
/// Serialised on `PackRequest.offcut_extraction_strategy`; absent
/// means `GreedyMaxRect` (production default — current behaviour).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum OffcutExtractionStrategyKind {
    /// Iterative greedy maximal-inscribed-rectangle extraction. Current
    /// production behaviour; produces unmerged adjacent rects when the
    /// residual free space is L-shaped (issue #14).
    #[default]
    GreedyMaxRect,
}

/// Greedy iterative maximal-inscribed-rectangle extractor — current
/// production algorithm. Wraps `extract_offcuts_with_obstacles` so the
/// algorithm body stays in `free_space.rs` next to its helpers.
pub struct GreedyMaxRectStrategy;

impl OffcutExtractionStrategy for GreedyMaxRectStrategy {
    fn name(&self) -> &'static str {
        "offcut_greedy_max_rect"
    }

    fn extract(
        &self,
        bin_id: &str,
        free_regions: &[Polygon],
        obstacles: &[Polygon],
    ) -> Vec<ClassifiedOffcut> {
        crate::application::free_space::extract_offcuts_with_obstacles(
            bin_id,
            free_regions,
            obstacles,
        )
    }
}

/// Map an `OffcutExtractionStrategyKind` to a concrete strategy. New
/// strategy = new struct + impl + one extra match arm here, nothing
/// else.
pub fn offcut_extraction_strategy_for(
    kind: OffcutExtractionStrategyKind,
) -> Box<dyn OffcutExtractionStrategy> {
    match kind {
        OffcutExtractionStrategyKind::GreedyMaxRect => Box::new(GreedyMaxRectStrategy),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn factory_dispatches_to_named_impl() {
        assert_eq!(
            offcut_extraction_strategy_for(OffcutExtractionStrategyKind::GreedyMaxRect).name(),
            "offcut_greedy_max_rect"
        );
    }

    #[test]
    fn default_kind_is_greedy_max_rect() {
        assert_eq!(
            OffcutExtractionStrategyKind::default(),
            OffcutExtractionStrategyKind::GreedyMaxRect
        );
    }

    #[test]
    fn kind_serialises_camel_case() {
        let s = serde_json::to_string(&OffcutExtractionStrategyKind::GreedyMaxRect).unwrap();
        assert_eq!(s, "\"greedyMaxRect\"");
        let k: OffcutExtractionStrategyKind = serde_json::from_str("\"greedyMaxRect\"").unwrap();
        assert_eq!(k, OffcutExtractionStrategyKind::GreedyMaxRect);
    }
}
