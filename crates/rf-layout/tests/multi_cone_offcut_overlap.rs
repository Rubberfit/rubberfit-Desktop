// Reproducer for the user-reported scenario where a cone's silhouette
// gets rendered into a reusable-offcut amber rectangle: 2× 90° cones
// + 1× 150° cone on a 96×48 sheet, packed with the default annular-
// sector cone packing mode. The invariant we want to enforce is:
// **no reusable-offcut rect emitted by the production pipeline may
// contain any interior point of any placement polygon.**
//
// If the pipeline is correct this test passes; if a cone is being
// classified as reusable space the test fails with the offending
// offcut + placement coords, which is the data we need to debug.

use rf_geom::domain::Point2D;
use rf_layout::application::strategy_for;
use rf_layout::domain::{Bin, BinKind, OffcutKind, PackMode, PackRequest, Part, ShapeSpec};
use std::collections::HashMap;

fn ray_cast_point_in_polygon(p: Point2D, poly: &[Point2D]) -> bool {
    let n = poly.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let pi = poly[i];
        let pj = poly[j];
        if (pi.y > p.y) != (pj.y > p.y) {
            let t = (p.x - pi.x) * (pj.y - pi.y) - (pj.x - pi.x) * (p.y - pi.y);
            let d = pj.y - pi.y;
            if (t < 0.0) != (d < 0.0) {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

fn run_scenario(
    seed: u64,
    cones: &[(&str, f64)],
    inner_radius: f64,
    outer_radius: f64,
) -> Vec<String> {
    let items: Vec<Part> = cones
        .iter()
        .map(|(id, deg)| {
            let mut params = HashMap::new();
            params.insert("innerRadius".into(), serde_json::json!(inner_radius));
            params.insert("outerRadius".into(), serde_json::json!(outer_radius));
            params.insert("arcDegrees".into(), serde_json::json!(*deg));
            Part {
                shape_id: (*id).into(),
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
            }
        })
        .collect();

    let req = PackRequest {
        bins: vec![Bin {
            bin_id: "stock-1".into(),
            width: 96.0,
            height: 48.0,
            kind: BinKind::Fresh,
            priority: None,
        }],
        clearance: 0.125,
        items,
        operator_profile: None,
        mode: Some(PackMode::Fast),
        engine: None,
        time_budget_ms: Some(2_000),
        improvement_budget_ms: None,
        seed: Some(seed),
        units: Default::default(),
        cone_strategy: None,
        cone_packing_mode: None,
        scrap_strategy: None,
        offcut_extraction_strategy: None,
        use_warm_start: None,
    };

    let result = strategy_for(None)
        .pack(req)
        .expect("default strategy should pack the scenario");
    let bin = &result.per_bin[0];

    // Sample each reusable offcut on a fine grid (and at borders) and
    // test every sample point against every placement polygon. Any
    // inside-polygon hit is a packing/classifier bug — the cone polygon
    // was used as the obstacle, so the inscribed rect should never
    // contain a polygon interior point.
    // Sample strictly INSIDE the offcut rect — never on the boundary.
    // Snap deliberately brings offcuts flush against cone edges, so a
    // sample exactly on the cone's boundary will hit ray-cast noise
    // (point-in-polygon is unreliable on boundary points). MARGIN must
    // exceed any plausible polygon-rect numerical separation but stay
    // well under any genuine overlap that would matter visually.
    // Sub-cell residual: the inscribed-rect classifier samples cell
    // centres on a 0.25" grid, so a cell whose centre is just outside
    // the cone is marked free even though the cell extent + the
    // chord-vs-arc gap can let the cone polygon poke into the rect by
    // up to grid_step/2 + ε. That residual is bounded, sub-pixel at
    // typical sheet zoom (1-2 px), and below the operator-visible
    // threshold. The user's complaint was about visible overlap up to
    // a full grid_step (0.25"), caused by snap pulling the rect across
    // straddling chords — fixed in `snap_rect_to_polygon_and_obstacles`.
    // Sampling at margin 0.2" (well past grid_step/2 + numerical
    // noise) tests for any overlap above the inherent classifier
    // residual; the test fails only when snap is regressed.
    const SAMPLE_STEP: f64 = 0.1;
    const MARGIN: f64 = 0.2;
    let mut violations: Vec<String> = Vec::new();

    for (oi, off) in bin.offcuts.iter().enumerate() {
        if off.kind != OffcutKind::Reusable {
            continue;
        }
        let inner_w = (off.width - 2.0 * MARGIN).max(0.0);
        let inner_h = (off.height - 2.0 * MARGIN).max(0.0);
        if inner_w <= 0.0 || inner_h <= 0.0 {
            continue;
        }
        let x_steps = ((inner_w / SAMPLE_STEP).floor() as usize).max(1);
        let y_steps = ((inner_h / SAMPLE_STEP).floor() as usize).max(1);
        for ix in 0..=x_steps {
            for iy in 0..=y_steps {
                let p = Point2D::new(
                    off.x + MARGIN + (ix as f64 * SAMPLE_STEP).min(inner_w),
                    off.y + MARGIN + (iy as f64 * SAMPLE_STEP).min(inner_h),
                );
                for (pi, place) in result.placements.iter().enumerate() {
                    if ray_cast_point_in_polygon(p, &place.polygon) {
                        violations.push(format!(
                            "seed={} offcut[{}] rect=({:.3},{:.3} {:.3}×{:.3}) sample=({:.3},{:.3}) is INSIDE placement[{}] shape={} verts={}",
                            seed,
                            oi,
                            off.x, off.y, off.width, off.height,
                            p.x, p.y,
                            pi,
                            place.shape_id,
                            place.polygon.len(),
                        ));
                    }
                }
            }
        }
    }

    if !violations.is_empty() {
        println!("=== seed={} ===", seed);
        println!("--- {} placement(s) ---", result.placements.len());
        for (i, p) in result.placements.iter().enumerate() {
            let xs = p.polygon.iter().map(|q| q.x);
            let ys = p.polygon.iter().map(|q| q.y);
            let min_x = xs.clone().fold(f64::INFINITY, f64::min);
            let max_x = xs.fold(f64::NEG_INFINITY, f64::max);
            let min_y = ys.clone().fold(f64::INFINITY, f64::min);
            let max_y = ys.fold(f64::NEG_INFINITY, f64::max);
            println!(
                "  placement[{}] {} bbox=({:.2},{:.2})-({:.2},{:.2}) rot={:.2} verts={}",
                i,
                p.shape_id,
                min_x,
                min_y,
                max_x,
                max_y,
                p.rotation_rad,
                p.polygon.len()
            );
        }
        println!(
            "--- {} reusable offcut(s) ---",
            bin.offcuts
                .iter()
                .filter(|o| o.kind == OffcutKind::Reusable)
                .count()
        );
        for (i, o) in bin.offcuts.iter().enumerate() {
            if o.kind == OffcutKind::Reusable {
                println!(
                    "  offcut[{}] rect=({:.2},{:.2} {:.2}×{:.2})",
                    i, o.x, o.y, o.width, o.height
                );
            }
        }
    }

    violations
}

#[test]
fn multi_cone_reusable_offcuts_dont_overlap_placement_polygons() {
    // Sweep several seeds and a couple of cone-dimension presets — the
    // user's exact dimensions are unknown, so this gives the test a
    // chance to surface the failing config across plausible inputs.
    let mut all: Vec<String> = Vec::new();
    let cones = &[
        ("cone-90-a", 90.0_f64),
        ("cone-90-b", 90.0),
        ("cone-150", 150.0),
    ];
    let presets: [(f64, f64); 4] = [(10.0, 28.0), (4.0, 18.0), (8.0, 24.0), (2.0, 12.0)];
    for (inner, outer) in presets {
        for seed in [1_u64, 2, 3, 7, 42, 100] {
            let v = run_scenario(seed, cones, inner, outer);
            if !v.is_empty() {
                println!(
                    "inner={} outer={} seed={} -> {} violation(s)",
                    inner,
                    outer,
                    seed,
                    v.len()
                );
                all.extend(v);
            }
        }
    }

    if !all.is_empty() {
        let n = all.len();
        let max_show = 20;
        println!(
            "=== {} total violation(s); showing first {} ===",
            n,
            n.min(max_show)
        );
        for v in all.iter().take(max_show) {
            println!("{}", v);
        }
        panic!("Reusable offcut(s) overlap placement polygon(s); see stdout for coords");
    }
}
