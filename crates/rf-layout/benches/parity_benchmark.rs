// engine/crates/rf-layout/benches/parity_benchmark.rs
//
// Task 17: Criterion benchmark harness for the 9 RF parity fixtures.
//
// Runs each fixture × 3 modes (Fast / Balanced / Thorough) × 2 seeds
// (42, 43) through the production `pack()` entry point. Writes a
// markdown results table to `docs/superpowers/benchmarks/...` for
// cross-engine comparison (legacy TS vs current Rust).
//
// Usage:
//   cd engine
//   cargo bench --bench parity_benchmark
//
// The benchmark is time-consuming; by default criterion runs each
// (fixture, mode, seed) triple 10+ samples. Override via env:
//   RF_BENCH_SAMPLE_SIZE=3 cargo bench --bench parity_benchmark
//
// Output: `target/criterion/` (Criterion's standard HTML report) +
// a companion `docs/superpowers/benchmarks/2026-04-18-s2.5-results.md`
// that a final test pass regenerates.

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use rf_layout::application::pack::pack;
use rf_layout::domain::{PackMode, PackRequest};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn load_request(name: &str) -> PackRequest {
    let path = fixture_dir().join(name);
    let content =
        fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&content).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

fn sample_size() -> usize {
    std::env::var("RF_BENCH_SAMPLE_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(10)
}

fn bench_parity_fixtures(c: &mut Criterion) {
    // Use the 9 production-calibrated fixtures that parity.rs covers.
    let fixtures = [
        "single-rect.json",
        "multi-rect-same-size.json",
        "rect-grid.json",
        "circle-grid.json",
        "trapezoid-mix.json",
        "mixed-rect-circle.json",
        "overflow.json",
        "multi-sheet-remnant.json",
        "cone-array.json",
    ];
    let modes = [
        (PackMode::Fast, "fast", 2_000u64),
        (PackMode::Balanced, "balanced", 10_000u64),
        (PackMode::Thorough, "thorough", 30_000u64),
    ];
    let seeds = [42u64, 43u64];

    let mut group = c.benchmark_group("parity_fixtures");
    group.sample_size(sample_size());
    // Fixtures at Thorough can approach 30s each — keep bench time sane.
    group.measurement_time(Duration::from_secs(20));
    group.warm_up_time(Duration::from_millis(500));

    for name in fixtures {
        let base = load_request(name);
        for (mode, mode_label, budget_ms) in &modes {
            for &seed in &seeds {
                let mut req = base.clone();
                req.mode = Some(*mode);
                req.time_budget_ms = Some(*budget_ms);
                req.seed = Some(seed);

                let param = format!("{name}/{mode_label}/seed_{seed}");
                group.throughput(Throughput::Elements(req.items.len() as u64));
                group.bench_with_input(BenchmarkId::from_parameter(&param), &req, |b, req| {
                    b.iter_batched(
                        || req.clone(),
                        |r| {
                            let _ = pack(r);
                        },
                        criterion::BatchSize::SmallInput,
                    );
                });
            }
        }
    }

    group.finish();
}

criterion_group!(benches, bench_parity_fixtures);
criterion_main!(benches);
