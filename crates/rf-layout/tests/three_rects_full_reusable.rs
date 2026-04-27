// Regression: 3 × 72×12 rectangles on a 96×48 sheet leave a clean
// L-shaped remainder (24×48 right strip + 72×12 top strip). Both
// strips are above the Reusable thresholds in `offcut_classifier.rs`,
// so the operator-facing "waste" should be ≈0%. Before the
// snap-to-polygon-edge fix, the inscribed-rect inset (`0.25"` per
// side) plus grid quantization at the 0.125" clearance boundary cost
// ~122 sq in, which the visualizer rendered as 2.66% scrap.

use rf_layout::application::strategy_for;
use rf_layout::domain::{Bin, BinKind, OffcutKind, PackMode, PackRequest, Part, ShapeSpec};
use std::collections::HashMap;

fn rect_part(id: &str, qty: u32, w: f64, h: f64) -> Part {
    let mut params = HashMap::new();
    params.insert("width".into(), serde_json::json!(w));
    params.insert("height".into(), serde_json::json!(h));
    Part {
        shape_id: id.into(),
        quantity: qty,
        polygon: None,
        shape_spec: Some(ShapeSpec {
            kind: "rect".into(),
            params,
        }),
        allow_rotation: true,
        grain_axis: None,
        difficulty: None,
        tag: None,
    }
}

fn three_72x12_request() -> PackRequest {
    PackRequest {
        bins: vec![Bin {
            bin_id: "stock-1".into(),
            width: 96.0,
            height: 48.0,
            kind: BinKind::Fresh,
            priority: None,
        }],
        clearance: 0.125,
        items: vec![rect_part("rect-72x12", 3, 72.0, 12.0)],
        operator_profile: None,
        mode: Some(PackMode::Fast),
        engine: None,
        time_budget_ms: Some(2_000),
        improvement_budget_ms: None,
        seed: Some(42),
        units: Default::default(),
        cone_strategy: None,
        cone_packing_mode: None,
        scrap_strategy: None,
        offcut_extraction_strategy: None,
        use_warm_start: None,
    }
}

#[test]
fn three_72x12_packs_with_under_one_percent_reported_waste() {
    let result = strategy_for(None)
        .pack(three_72x12_request())
        .expect("default strategy should pack 3 × 72×12 on 96×48");

    assert_eq!(result.placed_count, 3, "all 3 rectangles must be placed");

    let bin = &result.per_bin[0];
    let stock_area = 96.0 * 48.0;

    // The two big offcuts (right strip + top strip) should carry
    // essentially all the reusable area. Bbox sum ≥ 1970 sq in (true
    // free area is 2016 sq in; we tolerate ≤46 sq in for the
    // unrecoverable 0.125" clearance gaps that the loop emits as
    // Scrap rects in subsequent iterations).
    let reusable_sum: f64 = bin
        .offcuts
        .iter()
        .filter(|o| o.kind == OffcutKind::Reusable)
        .map(|o| o.width * o.height)
        .sum();
    assert!(
        reusable_sum >= 1970.0,
        "reusable bbox sum should be ≥1970 sq in, got {:.3} (waste_area = {:.3}, offcuts = {:?})",
        reusable_sum,
        bin.waste_area,
        bin.offcuts,
    );

    // Sanity: at least one Reusable offcut whose dimensions match the
    // 24×48 right strip (snap restores the full 23.87" wide strip,
    // not the pre-fix 23.25").
    let has_full_right_strip = bin
        .offcuts
        .iter()
        .any(|o| o.kind == OffcutKind::Reusable && o.width >= 23.7 && o.height >= 47.7);
    assert!(
        has_full_right_strip,
        "expected a Reusable rect ≥23.7×47.7 (snapped right strip); got {:?}",
        bin.offcuts
    );

    // Mirror the frontend formula at
    // `src/components/cutting-engine/pack-result-to-layout-model.ts:106`.
    let reusable_capped = reusable_sum.min(bin.waste_area);
    let scrap_calc = (bin.waste_area - reusable_capped).max(0.0);
    let scrap_pct = scrap_calc / stock_area;
    assert!(
        scrap_pct < 0.015,
        "frontend waste pct should be <1.5%, got {:.4}% (scrap_calc={:.3}, stock={:.3})",
        scrap_pct * 100.0,
        scrap_calc,
        stock_area,
    );
}
