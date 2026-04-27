// Reproduces the user-reported scenario: place a single cone in a
// fresh bin and assert that the production pipeline emits scrap
// signal — both visible free-region polygons AND a non-zero
// wasteArea on the BinResult.

use rf_layout::application::strategy_for;
use rf_layout::domain::{Bin, BinKind, PackMode, PackRequest, Part, ShapeSpec};
use std::collections::HashMap;

fn single_cone_request() -> PackRequest {
    let mut params = HashMap::new();
    params.insert("innerRadius".into(), serde_json::json!(10.0));
    params.insert("outerRadius".into(), serde_json::json!(28.0));
    params.insert("arcDegrees".into(), serde_json::json!(120.0));

    PackRequest {
        bins: vec![Bin {
            bin_id: "stock-1".into(),
            width: 96.0,
            height: 48.0,
            kind: BinKind::Fresh,
            priority: None,
        }],
        clearance: 0.125,
        items: vec![Part {
            shape_id: "cone-120".into(),
            quantity: 1,
            polygon: None,
            shape_spec: Some(ShapeSpec {
                kind: "sector".into(),
                params,
            }),
            allow_rotation: true,
            grain_axis: None,
            difficulty: None,
            tag: None,
        }],
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
fn single_cone_emits_nonzero_waste_area() {
    let result = strategy_for(None)
        .pack(single_cone_request())
        .expect("default strategy should pack single-cone request");

    assert_eq!(result.placed_count, 1);
    let bin = &result.per_bin[0];

    let stock_area = 96.0 * 48.0;
    let placement_area = result.placements[0]
        .polygon
        .windows(2)
        .map(|w| w[0].x * w[1].y - w[1].x * w[0].y)
        .sum::<f64>()
        .abs()
        / 2.0;

    assert!(
        bin.waste_area > 0.0,
        "single cone in 48×96 bin should leave waste, got waste_area={}",
        bin.waste_area
    );
    assert!(
        bin.waste_area > stock_area * 0.5,
        "single cone leaves >50% waste, got {} / {}",
        bin.waste_area,
        stock_area
    );
    println!(
        "stock={}, placement_polygon_area≈{:.1}, waste_area={:.1}, free_regions={}, offcuts={}",
        stock_area,
        placement_area,
        bin.waste_area,
        bin.free_regions.len(),
        bin.offcuts.len()
    );
}

#[test]
fn single_cone_emits_visible_free_region_polygons() {
    let result = strategy_for(None)
        .pack(single_cone_request())
        .expect("default strategy should pack single-cone request");

    let bin = &result.per_bin[0];
    assert!(
        !bin.free_regions.is_empty(),
        "single cone should produce at least the L-shape free region around it; got 0 polygons"
    );

    let total_free_area: f64 = bin.free_regions.iter().map(|p| p.area()).sum();
    println!(
        "free_regions: {} polygons, total area = {:.1} (waste_area={:.1})",
        bin.free_regions.len(),
        total_free_area,
        bin.waste_area
    );
}

#[test]
fn single_cone_dump_free_regions() {
    // Diagnostic: print every free_region polygon's area and bbox so we
    // can see exactly what reaches the frontend.
    let result = strategy_for(None)
        .pack(single_cone_request())
        .expect("pack");
    let bin = &result.per_bin[0];
    println!("=== BinResult dump ===");
    println!("waste_area = {}", bin.waste_area);
    println!("used_area  = {}", bin.used_area);
    println!("efficiency = {}", bin.efficiency);
    println!("scrap_ratio= {}", bin.scrap_ratio);
    for (i, poly) in bin.free_regions.iter().enumerate() {
        let pts = poly.points();
        let min_x = pts.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
        let max_x = pts.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
        let min_y = pts.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
        let max_y = pts.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
        println!(
            "free_region[{}]: area={:.2} bbox=({:.1},{:.1})-({:.1},{:.1}) verts={}",
            i,
            poly.area(),
            min_x,
            min_y,
            max_x,
            max_y,
            pts.len()
        );
    }
    let mut reusable_sum = 0.0;
    let mut scrap_sum = 0.0;
    for o in &bin.offcuts {
        let area = o.width * o.height;
        match o.kind {
            rf_layout::domain::OffcutKind::Reusable => reusable_sum += area,
            rf_layout::domain::OffcutKind::Scrap => scrap_sum += area,
        }
    }
    println!(
        "offcuts: {} total, reusable_sum={:.1}, scrap_sum={:.1}",
        bin.offcuts.len(),
        reusable_sum,
        scrap_sum
    );
}

#[test]
fn single_cone_two_signal_visible_scrap_unhidden_by_reusable() {
    // The user-facing fix: with TwoSignal the reusable amber rect
    // sum stays below wasteArea, so the frontend formula
    // `scrap = waste − reusable_capped` yields a non-zero scrap
    // value (= the bbox-trapped ring + slivers). With Legacy the
    // reusable rects extend through the cone hull, sum exceeds
    // waste, get capped, and scrap collapses to 0%.
    use rf_layout::application::ScrapStrategyKind;
    use rf_layout::domain::OffcutKind;

    let mut req = single_cone_request();
    req.scrap_strategy = Some(ScrapStrategyKind::TwoSignal);
    let two_result = strategy_for(None).pack(req).expect("two-signal pack");
    let bin = &two_result.per_bin[0];

    let reusable_sum: f64 = bin
        .offcuts
        .iter()
        .filter(|o| o.kind == OffcutKind::Reusable)
        .map(|o| o.width * o.height)
        .sum();
    let capped = reusable_sum.min(bin.waste_area);
    let scrap = (bin.waste_area - capped).max(0.0);

    println!(
        "two_signal: waste={:.1}, reusable={:.1}, scrap={:.1}, free_regions={}",
        bin.waste_area,
        reusable_sum,
        scrap,
        bin.free_regions.len()
    );
    assert!(
        scrap > 50.0,
        "two-signal should leave non-trivial visible scrap; got scrap={:.2} (waste={:.2}, reusable={:.2})",
        scrap,
        bin.waste_area,
        reusable_sum
    );
    assert!(
        !bin.free_regions.is_empty(),
        "two-signal should emit at least the shape-trapped ring around the cone"
    );
}
