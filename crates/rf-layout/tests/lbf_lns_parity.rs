// engine/crates/rf-layout/tests/lbf_lns_parity.rs
//
// Phase 2 validation — confirms pack_lbf_lns does not regress placement
// count vs pack_lbf on any existing parity fixture. Parallels
// lbf_parity.rs but compares Phase 2 output to Phase 1 output instead
// of vs pack().

use rf_layout::application::{pack_lbf, pack_lbf_lns};
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
fn pack_lbf_lns_does_not_regress_vs_pack_lbf() {
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

        let lbf = pack_lbf(request.clone()).unwrap_or_else(|e| panic!("pack_lbf {name}: {e}"));
        let lns = pack_lbf_lns(request).unwrap_or_else(|e| panic!("pack_lbf_lns {name}: {e}"));

        println!(
            "[lns parity] {:<24} lbf={:>3}/{:<3} lns={:>3}/{:<3}",
            name,
            lbf.placed_count,
            lbf.placed_count + lbf.overflow_count,
            lns.placed_count,
            lns.placed_count + lns.overflow_count,
        );

        if lns.placed_count < lbf.placed_count {
            regressions.push(format!(
                "{}: lns {} < lbf {} (regression of {})",
                name,
                lns.placed_count,
                lbf.placed_count,
                lbf.placed_count - lns.placed_count
            ));
        }
    }

    assert!(
        regressions.is_empty(),
        "pack_lbf_lns regressed placement count on {} fixture(s):\n  {}",
        regressions.len(),
        regressions.join("\n  ")
    );
}
