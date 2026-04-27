// engine/crates/rf-layout/src/application/strategy.rs
//
// Strategy pattern for nesting engine selection.
//
// Each variant of `PackEngine` maps to one concrete `NestingStrategy`
// via the `strategy_for` factory. Adding a new engine = new struct
// implementing `NestingStrategy` + one extra match arm in
// `strategy_for`. The Tauri command (`src-tauri/src/commands/pack.rs`)
// and any other call site never names a concrete pipeline directly —
// they call `strategy_for(request.engine).pack(request)`.
//
// Why a trait rather than `match request.engine { … }` inline at the
// call site:
//   - Each engine carries its own typed tunables (`PackLbfLnsConfig`,
//     `PackLbfConfig`, `PolishConfig`-adjacent state, etc.) constructed
//     at strategy-creation time, not request-time.
//   - Test doubles (e.g. a stub strategy that returns a canned
//     `PackResult` fixture) drop in without touching production code.
//   - Future engines (libnest2d FFI, experimental SA, …) ship as a new
//     struct + impl with no churn in `pack.rs` or any TS layer.
//
// `Box<dyn NestingStrategy>` adds one virtual call per pack job, which
// is rounding error against multi-second pipelines.

use crate::application::{
    pack_lbf::{pack_lbf_with_config, PackLbfConfig},
    pack_lbf_lns::{pack_lbf_lns_with_config, PackLbfLnsConfig},
};
use crate::domain::{PackEngine, PackError, PackRequest, PackResult};
use std::collections::HashMap;

/// One nesting algorithm pipeline. Implementors are stateless w.r.t.
/// the request — any tunables live in the impl's own config struct,
/// constructed at strategy-creation time.
pub trait NestingStrategy: Send + Sync + 'static {
    /// Stable identifier for logs, telemetry, and parity-test
    /// assertions. Must match the underlying pipeline's name (e.g.
    /// `"pack_lbf_lns"`, `"pack_lbf"`, `"pack_legacy"`).
    fn name(&self) -> &'static str;

    /// Run the pipeline. The request is consumed because LBF strategies
    /// move ownership into jagua-rs; the legacy `pack()` does the same
    /// internally.
    fn pack(&self, request: PackRequest) -> Result<PackResult, PackError>;
}

// ── Concrete strategies ────────────────────────────────────────────

/// LBF + LNS — the polygon-aware constructive placer (Left-Bottom Fill)
/// followed by density-changing Large Neighborhood Search refinement.
/// This is the production default: ~34/37 placements on the production
/// rectangle fixture vs. ~13/37 for the legacy FFD+GLS pipeline.
#[derive(Default)]
pub struct LbfLnsStrategy {
    pub config: PackLbfLnsConfig,
}

impl NestingStrategy for LbfLnsStrategy {
    fn name(&self) -> &'static str {
        "pack_lbf_lns"
    }

    fn pack(&self, request: PackRequest) -> Result<PackResult, PackError> {
        let cfg = self.config.clone();
        run_with_tag_echo(request, |req| pack_lbf_lns_with_config(req, cfg))
    }
}

/// Constructive LBF only — no LNS refinement. Used for benches /
/// tuning when you want to isolate constructive placement quality
/// without LNS noise. Caller can opt in via `request.engine = Lbf`.
#[derive(Default)]
pub struct LbfStrategy {
    pub config: PackLbfConfig,
}

impl NestingStrategy for LbfStrategy {
    fn name(&self) -> &'static str {
        "pack_lbf"
    }

    fn pack(&self, request: PackRequest) -> Result<PackResult, PackError> {
        let cfg = self.config.clone();
        run_with_tag_echo(request, |req| pack_lbf_with_config(req, cfg))
    }
}

/// Pre-Phase-3 FFD + GLS multi-bin pipeline. Lower placement quality
/// than LBF+LNS but kept available for benches, A/B comparisons, and
/// any caller that needs the Task-14 `SearchOptions` hooks (progress
/// streaming + cooperative cancellation) — the LBF variants don't
/// expose those today.
pub struct LegacyStrategy;

impl Default for LegacyStrategy {
    fn default() -> Self {
        Self
    }
}

impl NestingStrategy for LegacyStrategy {
    fn name(&self) -> &'static str {
        "pack_legacy"
    }

    fn pack(&self, request: PackRequest) -> Result<PackResult, PackError> {
        run_with_tag_echo(request, crate::application::pack::pack)
    }
}

// ── Factory ────────────────────────────────────────────────────────

/// Map a `PackEngine` (or `None`, meaning "default") to a concrete
/// strategy. Adding a new engine: add the variant to `PackEngine`,
/// add a new strategy struct + `impl NestingStrategy`, then add one
/// match arm here. Nothing else in the call graph changes.
pub fn strategy_for(engine: Option<PackEngine>) -> Box<dyn NestingStrategy> {
    match engine.unwrap_or(PackEngine::Default) {
        PackEngine::Default => Box::new(LbfLnsStrategy::default()),
        PackEngine::Lbf => Box::new(LbfStrategy::default()),
        PackEngine::Legacy => Box::new(LegacyStrategy),
    }
}

// ── Post-pack pipeline: tag echo + free-space extraction ──────────

/// Wrap a raw pipeline call with the two post-processing passes every
/// strategy needs:
///
///   1. **Tag echo.** Snapshots the `shape_id → tag` mapping from
///      `request.items` before consuming the request, then stamps
///      every produced `Placement.tag` from that snapshot. Rust never
///      inspects, mutates, or fabricates the tag — it round-trips a
///      TypeScript-owned value per the architectural decision (see
///      memory `feedback_strategy_*` and the migration plan).
///
///   2. **Free-space extraction.** For each `BinResult`, computes the
///      `free_regions` polygons (bin minus union of placed parts) and
///      the classified `offcuts` (largest-inscribed-rect → reusable /
///      scrap classification). Lets the AutoNest UI render waste
///      polygons + offcut overlays without doing any geometry on the
///      TypeScript side.
///
/// Strategies funnel through here so this behaviour lives in exactly
/// one place. A pipeline that internally emits `tag: None` and empty
/// `free_regions` / `offcuts` (which all three current pipelines do)
/// is brought up to the public-API contract here.
fn run_with_tag_echo<F>(request: PackRequest, run: F) -> Result<PackResult, PackError>
where
    F: FnOnce(PackRequest) -> Result<PackResult, PackError>,
{
    // Build the tag lookup AND clone the bin definitions BEFORE moving
    // `request` into the pipeline — both are needed during post-
    // processing and the pipeline takes ownership of `request`. Same
    // for `scrap_strategy` which selects the post-pack scrap pipeline.
    let tag_by_shape: HashMap<String, String> = request
        .items
        .iter()
        .filter_map(|p| p.tag.as_ref().map(|t| (p.shape_id.clone(), t.clone())))
        .collect();
    let bins_by_id: HashMap<String, crate::domain::Bin> = request
        .bins
        .iter()
        .map(|b| (b.bin_id.clone(), b.clone()))
        .collect();
    let scrap = crate::application::scrap_strategy::scrap_strategy_for(
        request.scrap_strategy.unwrap_or_default(),
        request.offcut_extraction_strategy.unwrap_or_default(),
    );

    let mut result = run(request)?;

    // 1. Tag echo.
    if !tag_by_shape.is_empty() {
        for placement in &mut result.placements {
            if let Some(tag) = tag_by_shape.get(&placement.shape_id) {
                placement.tag = Some(tag.clone());
            }
        }
    }

    // 2. Free-space + offcut extraction. We re-walk per_bin and
    //    populate the two new fields. Skips bins that already have
    //    free_regions populated (some future pipeline might pre-
    //    compute them; we don't want to clobber that). Pipeline
    //    selection is wire-driven via `request.scrap_strategy` —
    //    `TwoSignal` (default) emits per-part shape-trapped crescents
    //    on top of the bin-level diff; `Legacy` is the pre-fix path.
    for bin_result in &mut result.per_bin {
        if !bin_result.free_regions.is_empty() || !bin_result.offcuts.is_empty() {
            continue;
        }
        let Some(bin) = bins_by_id.get(&bin_result.bin_id) else {
            continue;
        };
        let placements: Vec<&crate::domain::Placement> = result
            .placements
            .iter()
            .filter(|p| p.bin_id == bin_result.bin_id)
            .collect();
        let (free_regions, offcuts) = scrap.extract(bin, &placements);
        bin_result.free_regions = free_regions;
        bin_result.offcuts = offcuts;
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Bin, BinKind, PackRequest, Part};
    use rf_geom::domain::Point2D;

    fn rect_part_tagged(id: &str, qty: u32, w: f64, h: f64, tag: Option<&str>) -> Part {
        Part {
            shape_id: id.into(),
            quantity: qty,
            polygon: Some(vec![
                Point2D::new(0.0, 0.0),
                Point2D::new(w, 0.0),
                Point2D::new(w, h),
                Point2D::new(0.0, h),
            ]),
            shape_spec: None,
            allow_rotation: true,
            grain_axis: None,
            difficulty: None,
            tag: tag.map(|s| s.to_string()),
        }
    }

    fn fresh_bin(id: &str, w: f64, h: f64) -> Bin {
        Bin {
            bin_id: id.into(),
            width: w,
            height: h,
            kind: BinKind::Fresh,
            priority: None,
        }
    }

    #[test]
    fn factory_returns_lbf_lns_for_default() {
        let s = strategy_for(None);
        assert_eq!(s.name(), "pack_lbf_lns");

        let s = strategy_for(Some(PackEngine::Default));
        assert_eq!(s.name(), "pack_lbf_lns");
    }

    #[test]
    fn factory_returns_lbf_for_lbf_variant() {
        let s = strategy_for(Some(PackEngine::Lbf));
        assert_eq!(s.name(), "pack_lbf");
    }

    #[test]
    fn factory_returns_legacy_for_legacy_variant() {
        let s = strategy_for(Some(PackEngine::Legacy));
        assert_eq!(s.name(), "pack_legacy");
    }

    #[test]
    fn tag_round_trips_through_default_strategy() {
        // Two shapes, distinct tags. Pack a small fixture that
        // comfortably fits and assert every placement carries the
        // correct echo of the source Part.tag.
        let request = PackRequest {
            bins: vec![fresh_bin("b1", 48.0, 96.0)],
            clearance: 0.125,
            items: vec![
                rect_part_tagged("rect-a", 2, 8.0, 4.0, Some("A")),
                rect_part_tagged("rect-b", 2, 8.0, 4.0, Some("B")),
            ],
            operator_profile: None,
            mode: Some(crate::domain::PackMode::Fast),
            engine: None,
            time_budget_ms: Some(500),
            improvement_budget_ms: None,
            seed: Some(7),
            units: Default::default(),
            cone_strategy: None,
            cone_packing_mode: None,
            scrap_strategy: None,
            offcut_extraction_strategy: None,
            use_warm_start: None,
        };

        let result = strategy_for(None)
            .pack(request)
            .expect("default strategy should pack tiny fixture");

        assert!(result.placed_count > 0, "fixture should yield placements");
        for p in &result.placements {
            let expected = match p.shape_id.as_str() {
                "rect-a" => Some("A"),
                "rect-b" => Some("B"),
                other => panic!("unexpected shape_id {other}"),
            };
            assert_eq!(p.tag.as_deref(), expected);
        }
    }

    #[test]
    fn untagged_parts_yield_untagged_placements() {
        // Sanity check: when the source Part has tag = None, the
        // echo helper must NOT fabricate a tag. Lookup miss means
        // placement.tag stays None.
        let request = PackRequest {
            bins: vec![fresh_bin("b1", 48.0, 96.0)],
            clearance: 0.125,
            items: vec![rect_part_tagged("rect-a", 1, 8.0, 4.0, None)],
            operator_profile: None,
            mode: Some(crate::domain::PackMode::Fast),
            engine: None,
            time_budget_ms: Some(500),
            improvement_budget_ms: None,
            seed: Some(7),
            units: Default::default(),
            cone_strategy: None,
            cone_packing_mode: None,
            scrap_strategy: None,
            offcut_extraction_strategy: None,
            use_warm_start: None,
        };

        let result = strategy_for(None)
            .pack(request)
            .expect("strategy should pack tiny fixture");

        for p in &result.placements {
            assert_eq!(p.tag, None);
        }
    }
}
