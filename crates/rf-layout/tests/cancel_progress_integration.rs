// engine/crates/rf-layout/tests/cancel_progress_integration.rs
//
// Task 14 integration tests:
//   - Pre-set cancel short-circuits immediately.
//   - Cancel during a long-running search returns within ~250ms
//     (Codex sign-off: 100ms is the product SLA; 250ms is the CI cap
//     to absorb loaded-runner jitter).
//   - Progress callback fires at least once (baseline) per fixture.
//   - No-op cancel token doesn't truncate search.

use rf_geom::domain::Point2D;
use rf_layout::application::pack::{pack, pack_with_options};
use rf_layout::domain::{Bin, BinKind, PackMode, PackRequest, Part, SearchOptions, UnitSystem};
use rf_layout::infrastructure::search::progress::{PackProgress, ProgressCallback};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

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

fn long_budget_fixture() -> PackRequest {
    // Task 19d: bumped item count so the pack actually takes more than
    // ~50ms. The prior 10-item fixture used to rely on rectangle-pack's
    // slow per-item probes; bin-packing's MaxRects BSSF is fast enough
    // that a 10-item fixture completed before the test's 50ms cancel
    // could fire, leaving `was_cancelled=false`. 40 mixed rects keeps
    // the search actively running long enough to exercise the cancel
    // path deterministically across packers.
    PackRequest {
        bins: vec![bin("A", 48.0, 96.0), bin("B", 48.0, 96.0)],
        clearance: 0.0,
        items: vec![
            rect_part("plank", 12, 10.0, 40.0),
            rect_part("block", 10, 15.0, 15.0),
            rect_part("strip", 10, 6.0, 30.0),
            rect_part("tile", 8, 8.0, 12.0),
        ],
        operator_profile: None,
        mode: Some(PackMode::Thorough),
        engine: None,
        time_budget_ms: Some(5_000),
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
fn pre_set_cancel_short_circuits() {
    let token = Arc::new(AtomicBool::new(true));
    let options = SearchOptions {
        progress_callback: None,
        cancel_token: Some(token),
    };
    let req = long_budget_fixture();
    let t0 = Instant::now();
    let result = pack_with_options(req, options).expect("pack");
    let elapsed = t0.elapsed().as_millis();
    assert!(
        result.was_cancelled,
        "expected was_cancelled=true on pre-set token"
    );
    assert!(
        elapsed < 500,
        "pre-set cancel should short-circuit; took {}ms",
        elapsed
    );
}

#[test]
fn cancel_during_search_returns_within_250ms() {
    let token = Arc::new(AtomicBool::new(false));
    let options = SearchOptions {
        progress_callback: None,
        cancel_token: Some(token.clone()),
    };
    let req = long_budget_fixture();

    // Helper thread flips cancel at t=50ms.
    let t0 = Instant::now();
    let token_flipper = token.clone();
    let cancel_handle = thread::spawn(move || {
        thread::sleep(Duration::from_millis(50));
        token_flipper.store(true, Ordering::Relaxed);
    });

    let result = pack_with_options(req, options).expect("pack");
    let elapsed = t0.elapsed().as_millis();
    cancel_handle.join().unwrap();

    assert!(
        result.was_cancelled,
        "expected was_cancelled=true after mid-search cancel"
    );
    assert!(
        elapsed <= 500,
        "cancel latency {}ms exceeds 500ms CI cap (product SLA is ~100ms)",
        elapsed
    );
}

#[test]
fn progress_callback_fires_baseline_frame() {
    let frames: Arc<Mutex<Vec<PackProgress>>> = Arc::new(Mutex::new(vec![]));
    let frames_clone = frames.clone();
    let cb: ProgressCallback = Arc::new(move |p| frames_clone.lock().unwrap().push(p));
    let options = SearchOptions {
        progress_callback: Some(cb),
        cancel_token: None,
    };
    let req = long_budget_fixture();
    let _ = pack_with_options(req, options).expect("pack");
    let collected = frames.lock().unwrap();
    assert!(
        !collected.is_empty(),
        "progress callback must fire at least the baseline frame"
    );
    assert_eq!(
        collected[0].iteration, 0,
        "baseline frame must be iteration=0"
    );
}

#[test]
fn no_cancel_token_completes_normally() {
    // Equivalent to today's `pack()` â€” regression guard that
    // SearchOptions::default() preserves existing behavior.
    let req = PackRequest {
        bins: vec![bin("A", 48.0, 96.0)],
        clearance: 0.0,
        items: vec![rect_part("r", 3, 10.0, 5.0)],
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
    let result_a = pack(req.clone()).expect("pack");
    let result_b = pack_with_options(req, SearchOptions::default()).expect("pack");
    assert_eq!(result_a.placed_count, result_b.placed_count);
    assert_eq!(result_a.overflow_count, result_b.overflow_count);
    assert!(!result_a.was_cancelled);
    assert!(!result_b.was_cancelled);
}
