// engine/crates/rf-layout/tests/orchestrator_integration.rs
//
// Task 12 integration tests â€” optimize_multi wired through pack()
// exercises the full FFD â†’ operators â†’ per-bin GLS pipeline.

use rf_geom::domain::Point2D;
use rf_layout::application::pack::pack;
use rf_layout::domain::{Bin, BinKind, PackMode, PackRequest, Part, UnitSystem};

fn rect_part(id: &str, qty: u32, w: f64, h: f64) -> Part {
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
        allow_rotation: false,
        grain_axis: None,
        difficulty: None,
        tag: None,
    }
}

fn bin(id: &str, w: f64, h: f64) -> Bin {
    Bin {
        bin_id: id.into(),
        width: w,
        height: h,
        kind: BinKind::Fresh,
        priority: None,
    }
}

fn small_multi_bin_request() -> PackRequest {
    PackRequest {
        bins: vec![bin("A", 40.0, 40.0), bin("B", 40.0, 40.0)],
        clearance: 0.0,
        items: vec![rect_part("a", 2, 15.0, 15.0), rect_part("b", 1, 10.0, 10.0)],
        operator_profile: None,
        mode: Some(PackMode::Fast),
        engine: None,
        time_budget_ms: Some(300),
        improvement_budget_ms: None,
        seed: Some(42),
        units: UnitSystem::default(),
        cone_strategy: None,
        cone_packing_mode: None,
        scrap_strategy: None,
        offcut_extraction_strategy: None,
        use_warm_start: None,
    }
}

#[test]
fn pack_multi_bin_small_fixture() {
    let req = small_multi_bin_request();
    let total_requested: u32 = req.items.iter().map(|p| p.quantity).sum();
    let result = pack(req).expect("pack should succeed on small multi-bin fixture");
    assert_eq!(
        result.placed_count + result.overflow_count,
        total_requested,
        "cardinality preserved across FFD + optimize_multi"
    );
    // Instance indices must be globally unique per shape.
    let mut seen: std::collections::HashMap<(String, u32), usize> =
        std::collections::HashMap::new();
    for p in &result.placements {
        let prev = seen.insert((p.shape_id.clone(), p.instance_index), 1);
        assert!(
            prev.is_none(),
            "duplicate (shape_id, instance_index) = ({}, {})",
            p.shape_id,
            p.instance_index
        );
    }
}

#[test]
fn pack_multi_bin_large_fixture() {
    let req = PackRequest {
        bins: vec![
            bin("A", 48.0, 96.0),
            bin("B", 48.0, 96.0),
            bin("C", 48.0, 96.0),
        ],
        clearance: 0.0,
        items: vec![
            rect_part("plank", 6, 10.0, 40.0),
            rect_part("block", 4, 15.0, 15.0),
            rect_part("chip", 3, 5.0, 5.0),
        ],
        operator_profile: None,
        mode: Some(PackMode::Fast),
        engine: None,
        time_budget_ms: Some(500),
        improvement_budget_ms: None,
        seed: Some(42),
        units: UnitSystem::default(),
        cone_strategy: None,
        cone_packing_mode: None,
        scrap_strategy: None,
        offcut_extraction_strategy: None,
        use_warm_start: None,
    };
    let total_requested: u32 = req.items.iter().map(|p| p.quantity).sum();
    let result = pack(req).expect("pack should succeed on large multi-bin fixture");
    assert_eq!(result.placed_count + result.overflow_count, total_requested);
    assert!(
        result.overall_density >= 0.0 && result.overall_density <= 1.0,
        "density out of range: {}",
        result.overall_density
    );
}

#[test]
fn pack_single_bin_parity_holds() {
    // Single-bin fast path must produce results equivalent to
    // Task 9's passing gls_integration tests â€” bin size + item set
    // matches `three_rects_stack` fixture.
    let req = PackRequest {
        bins: vec![bin("b", 48.0, 96.0)],
        clearance: 0.0,
        items: vec![rect_part("a", 3, 10.0, 5.0)],
        operator_profile: None,
        mode: Some(PackMode::Fast),
        engine: None,
        time_budget_ms: Some(200),
        improvement_budget_ms: None,
        seed: Some(42),
        units: UnitSystem::default(),
        cone_strategy: None,
        cone_packing_mode: None,
        scrap_strategy: None,
        offcut_extraction_strategy: None,
        use_warm_start: None,
    };
    let result = pack(req).expect("pack should succeed on single-bin fixture");
    assert_eq!(result.placed_count, 3, "all 3 items should fit");
    assert_eq!(result.overflow_count, 0);
    assert_eq!(result.per_bin.len(), 1);
}
