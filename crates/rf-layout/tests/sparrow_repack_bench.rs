// engine/crates/rf-layout/tests/sparrow_repack_bench.rs
//
// Sparrow fixed-bin repack spike bench — production 37-part fixture.
//
// Marked `#[ignore]` because it spends meaningful time (up to ~3s per
// variant) and exists to measure, not to assert a stable outcome. Run
// explicitly with:
//
//   cargo test --manifest-path engine/Cargo.toml --release \
//     --test sparrow_repack_bench -- --ignored --nocapture
//
// Fixture data mirrors tools/bench-production/revised_sizes_rev1.csv
// (29 unique parts, 37 total copies, 78×396 stock) so the numbers are
// directly comparable to the legacy/Rust side-by-side bench that the
// session's baseline captured.

use rf_geom::domain::Point2D;
use rf_layout::domain::{Bin, BinKind, Part};
use rf_layout::infrastructure::search::{fixed_bin_sparrow_repack, FixedBinRepackConfig};
use rf_layout::infrastructure::warm_start::{greedy_bottom_left, PackerStrategy};
use std::time::{Duration, Instant};

/// Quantity, shape_id, length (in), width (in) — row-for-row from
/// revised_sizes_rev1.csv. "Width" here is the narrow dim; "Length" is
/// the long one. The production bin is 78" wide × 396" long.
const FIXTURE: &[(u32, &str, f64, f64)] = &[
    (3, "G1", 120.75, 35.5),
    (1, "G2", 96.75, 35.5),
    (1, "H3", 32.625, 35.5),
    (1, "G4", 96.75, 35.5),
    (1, "G5", 114.625, 35.5),
    (1, "G6", 57.875, 35.5),
    (1, "T7", 155.75, 35.8125),
    (2, "V7", 156.5, 11.0),
    (1, "F8", 35.5, 12.0),
    (1, "AA9", 36.9375, 11.8125),
    (1, "AB9", 36.0625, 13.1875),
    (1, "AC9", 36.9375, 36.5),
    (1, "AD9", 11.0, 9.375),
    (1, "AE9", 11.0, 10.3125),
    (2, "S10", 14.625, 13.25),
    (2, "T10", 20.1875, 13.25),
    (4, "V10", 22.5, 15.8125),
    (1, "V11", 20.4375, 15.125),
    (1, "W11", 19.25, 13.3125),
    (1, "Y11", 14.8125, 14.25),
    (1, "Z11", 15.75, 14.625),
    (1, "AA11", 12.75, 2.125),
    (1, "AB11", 11.3125, 5.1875),
    (1, "V12", 23.0, 16.125),
    (1, "W12", 20.25, 13.25),
    (1, "Y12", 14.8125, 14.625),
    (1, "Z12", 15.75, 14.625),
    (1, "AA12", 12.75, 2.125),
    (1, "AB12", 11.0, 8.6875),
];

fn production_bin() -> Bin {
    // Bin width (narrow) = 78", height (long) = 396". Orient so that
    // Part width = narrow-dim, Part height = long-dim to match CSV
    // semantics (the bench runs the CSV's "Width" through Part bbox
    // width, then the greedy packer rotates if allow_rotation=true).
    Bin {
        bin_id: "roll-1".into(),
        width: 78.0,
        height: 396.0,
        kind: BinKind::Fresh,
        priority: None,
    }
}

fn production_items() -> Vec<Part> {
    FIXTURE
        .iter()
        .map(|(qty, id, length, width)| Part {
            shape_id: (*id).into(),
            quantity: *qty,
            // CSV "Width" ≤ bin.width (78"), "Length" runs up the long axis.
            polygon: vec![
                Point2D::new(0.0, 0.0),
                Point2D::new(*width, 0.0),
                Point2D::new(*width, *length),
                Point2D::new(0.0, *length),
            ],
            shape_spec: None,
            allow_rotation: false,
            grain_axis: None,
            difficulty: None,
        })
        .collect()
}

#[test]
#[ignore]
fn sparrow_repack_vs_bssf_on_production_fixture() {
    let bin = production_bin();
    let items = production_items();
    let total_copies: u32 = items.iter().map(|p| p.quantity).sum();
    println!(
        "\nfixture: {} unique parts, {} total copies, bin {}x{}",
        items.len(),
        total_copies,
        bin.width,
        bin.height
    );

    // --- Baseline: current BSSF dispatcher.
    let bssf_start = Instant::now();
    let bssf = greedy_bottom_left(&bin, &items, 0.0).unwrap();
    let bssf_elapsed = bssf_start.elapsed();
    println!(
        "BSSF baseline: placed={:<3}  overflow={:<3}  elapsed={:?}",
        bssf.placements.len(),
        bssf.overflow,
        bssf_elapsed
    );

    // --- Sparrow repack across a few starting Ns. 2026-04-19 result:
    // every variant returns the BSSF baseline of 13 placements — the
    // mechanism cannot lift density on this fixture. See
    // .claude/research/sparrow-integration/spike-result.md for the
    // architectural root cause. Kept as a regression surface; a future
    // fix (NFP port or full sparrow LNS) should lift these numbers.
    for &(label, start_n, total_ms) in &[
        ("start=14 (bssf+1)", 14, 1_500u64),
        ("start=20", 20, 2_000u64),
        ("start=30", 30, 3_000u64),
    ] {
        let cfg = FixedBinRepackConfig {
            total_budget_ms: total_ms,
            min_attempt_budget_ms: 400,
            start_count: Some(start_n),
            seed: Some(42),
        };
        let start = Instant::now();
        let out = fixed_bin_sparrow_repack(&bin, &items, 0.0, cfg).unwrap();
        let elapsed = start.elapsed();
        println!(
            "sparrow {}: placed={:<3}  overflow={:<3}  elapsed={:?}  delta_vs_bssf=+{}",
            label,
            out.placements.len(),
            out.overflow,
            elapsed,
            out.placements.len() as i32 - bssf.placements.len() as i32
        );
    }

    // Also record which strategy variants the stock warm-start hits so
    // the measurement captures the full picture.
    let _ = PackerStrategy::Bssf; // silence unused-import lint on `PackerStrategy`
    let _ = Duration::from_millis(0); // silence unused-import lint on Duration
}
