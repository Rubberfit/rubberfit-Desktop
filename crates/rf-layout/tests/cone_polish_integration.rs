use rf_geom::domain::Point2D;
use rf_layout::application::ConePackingMode;
use rf_layout::application::{default_cone_segments, strategy_for};
use rf_layout::domain::{Bin, BinKind, PackMode, PackRequest, Part, Placement, ShapeSpec};
use std::collections::HashMap;

const EPS: f64 = 1e-7;

fn auto_nest_cone_request() -> PackRequest {
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
            quantity: 4,
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
fn convex_hull_mode_does_not_return_overlapping_auto_nest_cones() {
    // The SAT-based `convex_polygons_overlap` check below is only
    // meaningful for convex pack surfaces. Now that the default is
    // `AnnularSector` (non-convex), this regression test must opt
    // into `ConvexHull` explicitly to keep the SAT assertion valid.
    let mut request = auto_nest_cone_request();
    request.cone_packing_mode = Some(ConePackingMode::ConvexHull);

    let result = strategy_for(None)
        .pack(request)
        .expect("convex-hull strategy should pack AutoNest cone request");

    assert_eq!(
        result.placed_count, 4,
        "regression fixture should place every requested cone"
    );
    assert!(
        !placements_have_pack_surface_overlap(&result.placements),
        "convex-hull strategy returned overlapping cone pack surfaces"
    );
}

#[test]
fn convex_hull_mode_emits_hull_pack_overlay_for_cones() {
    // Default is now AnnularSector — opt into ConvexHull to verify
    // the hull overlay path still works.
    let mut request = auto_nest_cone_request();
    request.cone_packing_mode = Some(ConePackingMode::ConvexHull);

    let result = strategy_for(None)
        .pack(request)
        .expect("convex-hull strategy should pack AutoNest cone request");
    let expected_segments = default_cone_segments(28.0, 120.0);

    assert!(
        result
            .placements
            .iter()
            .all(|p| p.polygon.len() == 2 * (expected_segments + 1)),
        "render polygon should be the annular sector"
    );
    assert!(
        result.placements.iter().all(|p| p
            .pack_polygon
            .as_ref()
            .is_some_and(|poly| poly.len() == expected_segments + 3)),
        "ConvexHull mode should emit a hull pack overlay"
    );
}

#[test]
fn annular_sector_packing_mode_packs_real_cone_polygon_without_overlay() {
    let mut request = auto_nest_cone_request();
    request.cone_packing_mode = Some(ConePackingMode::AnnularSector);

    let result = strategy_for(None)
        .pack(request)
        .expect("annular-sector pack mode should pack AutoNest cone request");

    assert_eq!(
        result.placed_count, 4,
        "annular-sector regression fixture should place every requested cone"
    );
    let expected_vertices = 2 * (default_cone_segments(28.0, 120.0) + 1);
    assert!(
        result
            .placements
            .iter()
            .all(|p| p.polygon.len() == expected_vertices),
        "pack/render polygon should be the real annular sector"
    );
    assert!(
        result.placements.iter().all(|p| p.pack_polygon.is_none()),
        "annular-sector pack mode should not emit a hull overlay"
    );
}

fn placements_have_pack_surface_overlap(placements: &[Placement]) -> bool {
    for i in 0..placements.len() {
        for j in (i + 1)..placements.len() {
            if convex_polygons_overlap(surface(&placements[i]), surface(&placements[j])) {
                return true;
            }
        }
    }
    false
}

fn surface(p: &Placement) -> &[Point2D] {
    p.pack_polygon
        .as_deref()
        .filter(|poly| poly.len() >= 3)
        .unwrap_or(&p.polygon)
}

fn convex_polygons_overlap(a: &[Point2D], b: &[Point2D]) -> bool {
    if a.len() < 3 || b.len() < 3 {
        return false;
    }
    !has_separating_axis(a, b) && !has_separating_axis(b, a)
}

fn has_separating_axis(a: &[Point2D], b: &[Point2D]) -> bool {
    for i in 0..a.len() {
        let p1 = a[i];
        let p2 = a[(i + 1) % a.len()];
        let axis = Point2D::new(-(p2.y - p1.y), p2.x - p1.x);
        if axis.x.abs() <= EPS && axis.y.abs() <= EPS {
            continue;
        }
        let (a_min, a_max) = project(a, axis);
        let (b_min, b_max) = project(b, axis);
        if a_max <= b_min + EPS || b_max <= a_min + EPS {
            return true;
        }
    }
    false
}

fn project(points: &[Point2D], axis: Point2D) -> (f64, f64) {
    points
        .iter()
        .map(|p| p.x * axis.x + p.y * axis.y)
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(mn, mx), d| {
            (mn.min(d), mx.max(d))
        })
}
