// engine/crates/rf-layout/tests/lbf_bench.rs
//
// Empirical bench of jagua-rs's LBF reference BPP optimizer on REMA's
// 37-part production fixture. Polygon-aware (handles irregular shapes
// and rectangles uniformly via jagua-rs's CDE + sample-based search).
//
// #[ignore]'d because it runs for 5-30 seconds per configuration. Run
// explicitly:
//
//   cargo test --manifest-path engine/Cargo.toml --release \
//     --test lbf_bench -- --ignored --nocapture
//
// Purpose: answer the question "does LBF beat BSSF's 13/37 baseline?"
// without committing any production changes. If yes, adopting LBF as a
// production dependency is the obvious next step.

use rf_geom::domain::Point2D;
use rf_layout::application::{
    pack, pack_lbf, pack_lbf_lns, pack_lbf_lns_with_config, pack_lbf_with_config, PackLbfConfig,
    PackLbfLnsConfig,
};
use rf_layout::domain::{Bin, BinKind, PackRequest, Part};
use rf_layout::infrastructure::jagua_adapter::to_jagua_instance;
use rf_layout::infrastructure::warm_start::{
    greedy_bottom_left, greedy_rectangle_pack_with_strategy, PackerStrategy,
};

use lbf::config::LBFConfig;
use lbf::opt::lbf_bpp::LBFOptimizerBP;
use rand::rngs::SmallRng;
use rand::SeedableRng;
use std::time::Instant;

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
    Bin {
        bin_id: "roll-1".into(),
        width: 78.0,
        height: 396.0,
        kind: BinKind::Fresh,
        priority: None,
    }
}

fn production_items(allow_rotation: bool) -> Vec<Part> {
    FIXTURE
        .iter()
        .map(|(qty, id, length, width)| Part {
            shape_id: (*id).into(),
            quantity: *qty,
            polygon: Some(vec![
                Point2D::new(0.0, 0.0),
                Point2D::new(*width, 0.0),
                Point2D::new(*width, *length),
                Point2D::new(0.0, *length),
            ]),
            shape_spec: None,
            allow_rotation,
            grain_axis: None,
            difficulty: None,
            tag: None,
        })
        .collect()
}

fn run_lbf(
    bin: &Bin,
    items: &[Part],
    n_samples: usize,
    ls_frac: f32,
    seed: u64,
) -> (usize, f32, std::time::Duration) {
    let instance =
        to_jagua_instance(std::slice::from_ref(bin), items, 0.0).expect("to_jagua_instance");

    // Keep poly_simpl_tolerance small so we don't unintentionally degrade rect
    // geometry â€” our fixture is orthogonal rectangles with exact coordinates.
    let config = LBFConfig {
        n_samples,
        ls_frac,
        prng_seed: Some(seed),
        poly_simpl_tolerance: None,
        narrow_concavity_cutoff: None,
        ..LBFConfig::default()
    };

    let rng = SmallRng::seed_from_u64(seed);

    let start = Instant::now();
    let mut opt = LBFOptimizerBP::new(instance.clone(), config, rng);
    let sol = opt.solve();
    let elapsed = start.elapsed();

    let placed: usize = sol
        .layout_snapshots
        .values()
        .map(|ls| ls.placed_items.len())
        .sum();

    // Density: re-use jagua's own density fn on the solution.
    let density = sol.density(&instance);

    (placed, density, elapsed)
}

#[test]
#[ignore]
fn lbf_vs_bssf_on_production_fixture_no_rotation() {
    let bin = production_bin();
    let items = production_items(false);
    let total_copies: u32 = items.iter().map(|p| p.quantity).sum();
    println!(
        "\n[LBF bench] {} unique parts, {} total copies, bin {}x{}, rotation=false",
        items.len(),
        total_copies,
        bin.width,
        bin.height
    );

    // Baseline: BSSF.
    let bssf_start = Instant::now();
    let bssf = greedy_bottom_left(&bin, &items, 0.0).unwrap();
    let bssf_elapsed = bssf_start.elapsed();
    println!(
        "BSSF baseline: placed={}/{}, elapsed={:?}",
        bssf.placements.len(),
        total_copies,
        bssf_elapsed
    );

    // LBF across a few sample budgets + two seeds to see variance.
    for &n_samples in &[1000usize, 5000, 10000, 25000] {
        for &seed in &[42u64, 7] {
            let (placed, density, elapsed) = run_lbf(&bin, &items, n_samples, 0.2, seed);
            println!(
                "LBF n_samples={:<5} seed={}: placed={}/{}, density={:.2}%, elapsed={:?}, delta_vs_bssf={:+}",
                n_samples,
                seed,
                placed,
                total_copies,
                density * 100.0,
                elapsed,
                placed as i32 - bssf.placements.len() as i32
            );
        }
    }
}

#[test]
#[ignore]
fn pack_lbf_lns_vs_pack_lbf_on_production_fixture() {
    // Phase 2 bench â€” does the density-changing LNS close the 32 â†’ 33+
    // gap on single bin?
    let bin = production_bin();
    let items = production_items(true);
    let total_copies: u32 = items.iter().map(|p| p.quantity).sum();

    let request = PackRequest {
        bins: vec![bin.clone()],
        clearance: 0.0,
        items,
        operator_profile: None,
        mode: None,
        engine: None,
        time_budget_ms: None,
        improvement_budget_ms: None,
        seed: Some(42),
        units: Default::default(),
        cone_strategy: None,
        cone_packing_mode: None,
        scrap_strategy: None,
        offcut_extraction_strategy: None,
        use_warm_start: None,
    };

    println!(
        "\n[LNS bench] {} unique parts, {} total copies, bin {}x{}, rotation=true",
        request.items.len(),
        total_copies,
        bin.width,
        bin.height
    );

    // Phase 1 baseline
    let lbf_start = Instant::now();
    let lbf_result = pack_lbf(request.clone()).unwrap();
    let lbf_elapsed = lbf_start.elapsed();
    println!(
        "pack_lbf     : placed={}/{}  density={:.2}%  elapsed={:?}",
        lbf_result.placed_count,
        total_copies,
        lbf_result.overall_density * 100.0,
        lbf_elapsed
    );

    // Phase 2 default config (10 LNS attempts, 200ms per grow)
    let lns_start = Instant::now();
    let lns_result = pack_lbf_lns(request.clone()).unwrap();
    let lns_elapsed = lns_start.elapsed();
    println!(
        "pack_lbf_lns : placed={}/{}  density={:.2}%  elapsed={:?}  delta_vs_lbf=+{}",
        lns_result.placed_count,
        total_copies,
        lns_result.overall_density * 100.0,
        lns_elapsed,
        lns_result.placed_count as i32 - lbf_result.placed_count as i32
    );

    // Phase 2 with higher grow budget
    let aggressive_cfg = PackLbfLnsConfig {
        lbf: PackLbfConfig::default(),
        per_grow_budget_ms: 500,
        attempts_per_item: 5,
        max_growth_ops: 20,
    };
    let lns2_start = Instant::now();
    let lns2_result = pack_lbf_lns_with_config(request, aggressive_cfg).unwrap();
    let lns2_elapsed = lns2_start.elapsed();
    println!(
        "pack_lbf_lns aggressive: placed={}/{}  density={:.2}%  elapsed={:?}  delta_vs_lbf=+{}",
        lns2_result.placed_count,
        total_copies,
        lns2_result.overall_density * 100.0,
        lns2_elapsed,
        lns2_result.placed_count as i32 - lbf_result.placed_count as i32
    );
}

#[test]
#[ignore]
fn pack_lbf_two_bin_fab_score_comparison() {
    // 2-bin fixture: same 37 parts on 2Ã— 78Ã—396 rolls. Measures whether
    // pack_lbf already beats legacy on the Fab Score gap (current Rust
    // is 46 vs legacy 52 = -6 points, with 0.01" tail remnant vs 125"
    // legacy).
    let bins = vec![
        production_bin(),
        Bin {
            bin_id: "roll-2".into(),
            ..production_bin()
        },
    ];
    let items = production_items(true);
    let total_copies: u32 = items.iter().map(|p| p.quantity).sum();

    let request = PackRequest {
        bins,
        clearance: 0.0,
        items,
        operator_profile: None,
        mode: None,
        engine: None,
        time_budget_ms: None,
        improvement_budget_ms: None,
        seed: Some(42),
        units: Default::default(),
        cone_strategy: None,
        cone_packing_mode: None,
        scrap_strategy: None,
        offcut_extraction_strategy: None,
        use_warm_start: None,
    };

    println!(
        "\n[2-bin bench] {} unique parts, {} total copies, 2Ã— 78Ã—396 rolls, rotation=true",
        request.items.len(),
        total_copies
    );

    let pack_start = Instant::now();
    let pack_result = pack(request.clone()).unwrap();
    let pack_elapsed = pack_start.elapsed();
    println!(
        "pack()   : placed={}/{}  density={:.2}%  elapsed={:?}",
        pack_result.placed_count,
        total_copies,
        pack_result.overall_density * 100.0,
        pack_elapsed
    );
    for (i, b) in pack_result.per_bin.iter().enumerate() {
        println!(
            "  bin #{}: occupied_height={:.2}\"  efficiency={:.2}%",
            i,
            b.occupied_height,
            b.efficiency * 100.0
        );
    }

    let lbf_start = Instant::now();
    let lbf_result = pack_lbf(request).unwrap();
    let lbf_elapsed = lbf_start.elapsed();
    println!(
        "pack_lbf : placed={}/{}  density={:.2}%  elapsed={:?}",
        lbf_result.placed_count,
        total_copies,
        lbf_result.overall_density * 100.0,
        lbf_elapsed
    );
    for (i, b) in lbf_result.per_bin.iter().enumerate() {
        println!(
            "  bin #{}: occupied_height={:.2}\"  efficiency={:.2}%",
            i,
            b.occupied_height,
            b.efficiency * 100.0
        );
    }
}

#[test]
#[ignore]
fn bin_packing_auto_vs_bssf_on_production_fixture() {
    // Gemini's contrarian suggestion: measure `PackerStrategy::Auto` on
    // the single-bin warm-start. Auto is already wired to bin-packing
    // crate's full MaxRects + Skyline + Guillotine + BFDH + Multistart +
    // RotationSearch sweep, but it's never been called on the production
    // single-bin path â€” only from Tier 6 cross-bin-swap receiver repack.
    //
    // If Auto lifts us meaningfully above BSSF's 13/37, it's a simpler
    // intervention than adopting LBF (no new crate dep, no new engine).
    let bin = production_bin();

    for allow_rotation in [false, true] {
        println!("\n[bin-packing Auto bench] rotation={}", allow_rotation);
        let items = production_items(allow_rotation);
        let total_copies: u32 = items.iter().map(|p| p.quantity).sum();

        for strategy in [
            PackerStrategy::Bssf,
            PackerStrategy::BottomLeft,
            PackerStrategy::Auto,
        ] {
            let start = Instant::now();
            let result = greedy_rectangle_pack_with_strategy(&bin, &items, 0.0, strategy);
            let elapsed = start.elapsed();
            match result {
                Ok(r) => println!(
                    "  {:<12?}: placed={}/{}, overflow={}, elapsed={:?}",
                    strategy,
                    r.placements.len(),
                    total_copies,
                    r.overflow,
                    elapsed
                ),
                Err(e) => println!("  {:<12?}: ERROR {}", strategy, e),
            }
        }
    }
}

#[test]
#[ignore]
fn pack_lbf_vs_pack_on_production_fixture() {
    // End-to-end bench: same fixture, both engines via their public API
    // (pack vs pack_lbf). Proves the pack_lbf wrapper with multistart
    // matches the direct-LBF bench numbers (32/37).
    let bin = production_bin();
    let items = production_items(true);
    let total_copies: u32 = items.iter().map(|p| p.quantity).sum();

    let request = PackRequest {
        bins: vec![bin.clone()],
        clearance: 0.0,
        items: items.clone(),
        operator_profile: None,
        mode: None,
        engine: None,
        time_budget_ms: None,
        improvement_budget_ms: None,
        seed: Some(42),
        units: Default::default(),
        cone_strategy: None,
        cone_packing_mode: None,
        scrap_strategy: None,
        offcut_extraction_strategy: None,
        use_warm_start: None,
    };

    println!(
        "\n[pack_lbf bench] {} unique parts, {} total copies, bin {}x{}, rotation=true",
        items.len(),
        total_copies,
        bin.width,
        bin.height
    );

    // Current pack() path (FFD + MaxRects + GLS, rotation=true).
    let pack_start = Instant::now();
    let pack_result = pack(request.clone()).unwrap();
    let pack_elapsed = pack_start.elapsed();
    println!(
        "pack()          : placed={}/{}, density={:.2}%, elapsed={:?}",
        pack_result.placed_count,
        total_copies,
        pack_result.overall_density * 100.0,
        pack_elapsed
    );

    // pack_lbf with defaults (10-seed multistart).
    let lbf_start = Instant::now();
    let lbf_result = pack_lbf(request.clone()).unwrap();
    let lbf_elapsed = lbf_start.elapsed();
    println!(
        "pack_lbf (10Ã—)  : placed={}/{}, density={:.2}%, elapsed={:?}",
        lbf_result.placed_count,
        total_copies,
        lbf_result.overall_density * 100.0,
        lbf_elapsed
    );

    // pack_lbf with 20 seeds â€” matches the standalone multistart bench.
    let cfg20 = PackLbfConfig {
        n_samples: 5000,
        ls_frac: 0.2,
        multistart_seeds: 20,
        use_warm_start: true,
    };
    let lbf20_start = Instant::now();
    let lbf20_result = pack_lbf_with_config(request.clone(), cfg20).unwrap();
    let lbf20_elapsed = lbf20_start.elapsed();
    println!(
        "pack_lbf (20Ã—)  : placed={}/{}, density={:.2}%, elapsed={:?}",
        lbf20_result.placed_count,
        total_copies,
        lbf20_result.overall_density * 100.0,
        lbf20_elapsed
    );
}

#[test]
#[ignore]
fn lbf_on_irregular_trapezoid_fixture() {
    // Mirrors tests/fixtures/trapezoid-mix.json â€” 6 trapezoids on a 48x96 bin.
    // Validates that LBF handles non-rectangular polygons correctly (legacy
    // NFP's claim-to-fame over MaxRects).
    let bin = Bin {
        bin_id: "b1".into(),
        width: 48.0,
        height: 96.0,
        kind: BinKind::Fresh,
        priority: None,
    };
    let trapezoid = |id: &str, qty: u32, vertices: &[(f64, f64)]| Part {
        shape_id: id.into(),
        quantity: qty,
        polygon: Some(vertices.iter().map(|(x, y)| Point2D::new(*x, *y)).collect()),
        shape_spec: None,
        allow_rotation: true,
        grain_axis: None,
        difficulty: None,
        tag: None,
    };
    let items = vec![
        trapezoid(
            "trap-a",
            2,
            &[(0.0, 0.0), (10.0, 0.0), (8.0, 4.0), (2.0, 4.0)],
        ),
        trapezoid(
            "trap-b",
            2,
            &[(0.0, 0.0), (8.0, 0.0), (6.0, 5.0), (2.0, 5.0)],
        ),
        trapezoid(
            "trap-c",
            2,
            &[(0.0, 0.0), (8.0, 0.0), (8.0, 3.0), (0.0, 3.0)],
        ),
    ];
    let total_copies: u32 = items.iter().map(|p| p.quantity).sum();

    let instance =
        to_jagua_instance(std::slice::from_ref(&bin), &items, 0.125).expect("trapezoid instance");

    let config = LBFConfig {
        n_samples: 5000,
        ls_frac: 0.2,
        prng_seed: Some(42),
        min_item_separation: Some(0.125),
        ..LBFConfig::default()
    };

    let start = Instant::now();
    let rng = SmallRng::seed_from_u64(42);
    let sol = LBFOptimizerBP::new(instance.clone(), config, rng).solve();
    let elapsed = start.elapsed();

    let placed: usize = sol
        .layout_snapshots
        .values()
        .map(|ls| ls.placed_items.len())
        .sum();
    let density = sol.density(&instance);

    println!(
        "\n[LBF trapezoid-mix] placed={}/{}, density={:.2}%, elapsed={:?}",
        placed,
        total_copies,
        density * 100.0,
        elapsed
    );
    assert!(placed > 0, "LBF must place at least one trapezoid");
}

#[test]
#[ignore]
fn lbf_on_irregular_cone_fixture() {
    // Mirrors tests/fixtures/cone-array.json â€” 4 quarter-cone annular sectors.
    // This is the hardest concave-shape test; exercises jagua-rs CDE on
    // shapes that can in principle interlock through concave voids.
    let bin = Bin {
        bin_id: "b1".into(),
        width: 48.0,
        height: 96.0,
        kind: BinKind::Fresh,
        priority: None,
    };
    let cone_vertices: Vec<Point2D> = [
        (8.0, 0.0),
        (7.9316, 1.0442),
        (7.7274, 2.0706),
        (7.391, 3.0615),
        (6.9282, 4.0),
        (6.3468, 4.8701),
        (5.6569, 5.6569),
        (4.8701, 6.3468),
        (4.0, 6.9282),
        (3.0615, 7.391),
        (2.0706, 7.7274),
        (1.0442, 7.9316),
        (0.0, 8.0),
        (0.0, 2.0),
        (0.2611, 1.9829),
        (0.5176, 1.9319),
        (0.7654, 1.8478),
        (1.0, 1.7321),
        (1.2175, 1.5867),
        (std::f64::consts::SQRT_2, std::f64::consts::SQRT_2),
        (1.5867, 1.2175),
        (1.7321, 1.0),
        (1.8478, 0.7654),
        (1.9319, 0.5176),
        (1.9829, 0.2611),
        (2.0, 0.0),
    ]
    .iter()
    .map(|(x, y)| Point2D::new(*x, *y))
    .collect();
    let items = vec![Part {
        shape_id: "cone-a".into(),
        quantity: 4,
        polygon: Some(cone_vertices),
        shape_spec: None,
        allow_rotation: true,
        grain_axis: None,
        difficulty: None,
        tag: None,
    }];

    let instance =
        to_jagua_instance(std::slice::from_ref(&bin), &items, 0.125).expect("cone instance");

    let config = LBFConfig {
        n_samples: 5000,
        ls_frac: 0.2,
        prng_seed: Some(42),
        min_item_separation: Some(0.125),
        ..LBFConfig::default()
    };

    let start = Instant::now();
    let rng = SmallRng::seed_from_u64(42);
    let sol = LBFOptimizerBP::new(instance.clone(), config, rng).solve();
    let elapsed = start.elapsed();

    let placed: usize = sol
        .layout_snapshots
        .values()
        .map(|ls| ls.placed_items.len())
        .sum();
    let density = sol.density(&instance);

    println!(
        "\n[LBF cone-array] placed={}/4, density={:.2}%, elapsed={:?}",
        placed,
        density * 100.0,
        elapsed
    );
    assert!(placed >= 1, "LBF must place at least one cone");
}

#[test]
#[ignore]
fn lbf_multistart_with_rotation() {
    let bin = production_bin();
    let items = production_items(true);
    let total_copies: u32 = items.iter().map(|p| p.quantity).sum();
    println!(
        "\n[LBF multistart] {} unique parts, {} total copies, bin {}x{}, rotation=true",
        items.len(),
        total_copies,
        bin.width,
        bin.height
    );

    // Sweep seeds at the best-performing n_samples (5000 rotation=true was
    // 31-32/37 in the prior bench). Multistart picks best-placed.
    let n_samples = 5000;
    let seeds: Vec<u64> = (0..20).collect();
    let mut best_placed = 0usize;
    let mut best_seed = 0u64;
    let mut best_density = 0.0f32;
    let total_start = Instant::now();

    for seed in &seeds {
        let (placed, density, elapsed) = run_lbf(&bin, &items, n_samples, 0.2, *seed);
        print!(
            "seed={:>2}: placed={}/{}, density={:.2}%, elapsed={:?}",
            seed,
            placed,
            total_copies,
            density * 100.0,
            elapsed
        );
        if placed > best_placed || (placed == best_placed && density > best_density) {
            best_placed = placed;
            best_seed = *seed;
            best_density = density;
            println!(" â† new best");
        } else {
            println!();
        }
    }

    let total_elapsed = total_start.elapsed();
    println!(
        "\nMultistart result: {} seeds tested, BEST = {}/{} at seed={}, density={:.2}%, total_elapsed={:?}",
        seeds.len(),
        best_placed,
        total_copies,
        best_seed,
        best_density * 100.0,
        total_elapsed
    );
}

#[test]
#[ignore]
fn lbf_vs_bssf_on_production_fixture_with_rotation() {
    let bin = production_bin();
    let items = production_items(true);
    let total_copies: u32 = items.iter().map(|p| p.quantity).sum();
    println!(
        "\n[LBF bench] {} unique parts, {} total copies, bin {}x{}, rotation=true (continuous)",
        items.len(),
        total_copies,
        bin.width,
        bin.height
    );

    // Note: BSSF doesn't support rotation, so we don't rerun it here â€” its
    // rotation=false number (13/37) is the reference baseline.
    for &n_samples in &[5000usize, 25000, 50000] {
        for &seed in &[42u64, 7] {
            let (placed, density, elapsed) = run_lbf(&bin, &items, n_samples, 0.2, seed);
            println!(
                "LBF n_samples={:<5} seed={}: placed={}/{}, density={:.2}%, elapsed={:?}",
                n_samples,
                seed,
                placed,
                total_copies,
                density * 100.0,
                elapsed
            );
        }
    }
}
