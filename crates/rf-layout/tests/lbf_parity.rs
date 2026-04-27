// engine/crates/rf-layout/tests/lbf_parity.rs
//
// Phase 1 validation for `pack_lbf()` — compares the LBF path against the
// current `pack()` path across every parity fixture. Purpose: confirm LBF
// does not regress correctness on any existing fixture before promoting
// it from opt-in to default.
//
// Behaviour we assert:
//   1. LBF produces a valid PackResult (no errors) on every fixture.
//   2. LBF places AT LEAST as many items as `pack()` on every fixture
//      (the Task 19b rust-≥-legacy guard, now extended to LBF-≥-pack).
//      Equal is acceptable; regressions are not.
//   3. Deterministic under fixed seed — re-running any fixture twice
//      produces identical placement counts.
//
// Not asserted (intentional): specific (x,y) coordinates. LBF is a
// randomized sampler; rigid coordinate parity would be over-constraint.

use rf_layout::application::{pack, pack_lbf};
use rf_layout::domain::PackRequest;
use std::fs;
use std::path::PathBuf;

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn load_request(path: &std::path::Path) -> PackRequest {
    let content = fs::read_to_string(path).expect("read fixture");
    serde_json::from_str(&content).unwrap_or_else(|e| panic!("parse {}: {}", path.display(), e))
}

#[test]
fn lbf_does_not_regress_vs_pack_on_any_fixture() {
    let dir = fixture_dir();
    let mut paths: Vec<PathBuf> = fs::read_dir(&dir)
        .expect("fixtures dir")
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    paths.sort();

    let mut regressions: Vec<String> = Vec::new();

    for path in &paths {
        let name = path.file_stem().unwrap().to_string_lossy().to_string();

        let request = load_request(path);

        let pack_result = pack(request.clone()).unwrap_or_else(|e| panic!("pack {name}: {e}"));

        let lbf_result = pack_lbf(request).unwrap_or_else(|e| panic!("pack_lbf {name}: {e}"));

        println!(
            "[parity] {:<24} pack={:>3}/{:<3} lbf={:>3}/{:<3}",
            name,
            pack_result.placed_count,
            pack_result.placed_count + pack_result.overflow_count,
            lbf_result.placed_count,
            lbf_result.placed_count + lbf_result.overflow_count,
        );

        if lbf_result.placed_count < pack_result.placed_count {
            regressions.push(format!(
                "{}: lbf {} < pack {} (regression of {})",
                name,
                lbf_result.placed_count,
                pack_result.placed_count,
                pack_result.placed_count - lbf_result.placed_count
            ));
        }
    }

    assert!(
        regressions.is_empty(),
        "LBF regressed placement count on {} fixture(s):\n  {}",
        regressions.len(),
        regressions.join("\n  ")
    );
}

#[test]
fn lbf_deterministic_across_runs() {
    // Pick three representative fixtures, run each twice, assert
    // placement counts match. Full-result equality is too tight because
    // LBF renumbers `instance_index` globally and two runs produce the
    // SAME count but in a deterministic order — we check placed_count
    // as the headline invariant and run the bit-exact coord check on
    // the first placement as a spot-check.
    let dir = fixture_dir();
    for fixture in &["single-rect.json", "rect-grid.json", "trapezoid-mix.json"] {
        let path = dir.join(fixture);
        // Fail explicitly if a target fixture is renamed/deleted — silent
        // skipping would weaken the determinism guard over time.
        assert!(
            path.exists(),
            "required fixture {fixture} not found at {}; update this test if the file was renamed",
            path.display()
        );
        let request = load_request(&path);

        let first = pack_lbf(request.clone()).unwrap();
        let second = pack_lbf(request).unwrap();

        assert_eq!(
            first.placed_count, second.placed_count,
            "determinism broken on {fixture}: {} vs {}",
            first.placed_count, second.placed_count
        );

        // Spot-check on the FIRST placement only — full per-placement
        // equality would couple the test to SlotMap iteration order
        // (upstream does not guarantee it's stable) and snapshot_to_
        // placements already sorts deterministically by (item_id, tx,
        // ty, rot). One stable bit-exact sample is enough to catch the
        // "nondeterminism snuck into the RNG path" regression class.
        if !first.placements.is_empty() {
            let a = &first.placements[0];
            let b = &second.placements[0];
            assert_eq!(a.shape_id, b.shape_id);
            assert!(
                (a.x - b.x).abs() < 1e-6 && (a.y - b.y).abs() < 1e-6,
                "coord drift on {fixture}: ({},{}) vs ({},{})",
                a.x,
                a.y,
                b.x,
                b.y
            );
        }
    }
}
