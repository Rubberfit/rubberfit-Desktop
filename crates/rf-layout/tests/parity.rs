use rf_layout::application::pack;
use rf_layout::domain::PackRequest;
use std::fs;
use std::path::PathBuf;

const EXPECTED_FIXTURE_COUNT: usize = 9;

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

#[test]
fn every_fixture_packs_without_error() {
    let dir = fixture_dir();
    let mut paths: Vec<PathBuf> = fs::read_dir(&dir)
        .expect("fixtures dir")
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    paths.sort();

    for path in &paths {
        let content = fs::read_to_string(path).expect("read fixture");
        let request: PackRequest = serde_json::from_str(&content)
            .unwrap_or_else(|e| panic!("parse {}: {}", path.display(), e));
        let result = pack(request).unwrap_or_else(|e| panic!("pack {}: {}", path.display(), e));
        assert!(
            result.placed_count > 0 || result.overflow_count > 0,
            "{}: nothing placed AND no overflow — suspicious",
            path.display()
        );
    }

    assert_eq!(
        paths.len(),
        EXPECTED_FIXTURE_COUNT,
        "expected exactly {EXPECTED_FIXTURE_COUNT} fixtures, found {}",
        paths.len()
    );
}
