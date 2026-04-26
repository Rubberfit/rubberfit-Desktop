// engine/crates/rf-layout/tests/cross_bin_swap_integration.rs
//
// Task 11 integration tests for cross-bin swap operators. These run
// against the real assignment pipeline (FFD â†’ operator â†’ materialize)
// and verify invariants end-to-end.

use rf_geom::domain::Point2D;
use rf_layout::domain::{Bin, BinKind, Part};
use rf_layout::infrastructure::search::assignment::{
    cross_bin_swap::{migrate, swap_two, unload_lightest_bin},
    ffd::{ffd_assign, FfdAssignment},
};

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

fn total_items(a: &FfdAssignment) -> u32 {
    a.per_bin
        .iter()
        .map(|b| b.placements.len() as u32)
        .sum::<u32>()
        + a.overflow.iter().map(|(_, n)| *n).sum::<u32>()
}

/// End-to-end: run FFD, then swap_two on the result. Invariants hold
/// regardless of whether the swap committed.
#[test]
fn end_to_end_ffd_then_swap() {
    let bins_spec = vec![bin("A", 30.0, 30.0), bin("B", 30.0, 30.0)];
    let items = vec![
        rect_part("a", 2, 10.0, 10.0),
        rect_part("b", 1, 15.0, 10.0),
        rect_part("c", 1, 8.0, 8.0),
    ];
    let asn = ffd_assign(&bins_spec, &items, 0.0).unwrap();
    let before = total_items(&asn);

    let result = swap_two(&asn, 0, 1, &bins_spec, &items, 0.0).unwrap();
    let final_asn = result.unwrap_or_else(|| asn.clone());
    let after = total_items(&final_asn);

    assert_eq!(before, after, "swap_two leaked or duplicated items");
    // Every placement must be within its bin.
    for (i, bin_seed) in final_asn.per_bin.iter().enumerate() {
        for p in &bin_seed.placements {
            assert_eq!(
                p.bin_id, bins_spec[i].bin_id,
                "placement bin_id mismatches owning bin"
            );
        }
    }
}

/// Compose all three operators on the same starting assignment. Each
/// step's output must be a valid FfdAssignment (per-shape conservation).
#[test]
fn operators_compose_preserving_invariants() {
    let bins_spec = vec![
        bin("A", 50.0, 50.0),
        bin("B", 30.0, 30.0),
        bin("C", 20.0, 20.0),
    ];
    let items = vec![
        rect_part("a", 1, 40.0, 40.0),
        rect_part("b", 2, 10.0, 10.0),
        rect_part("c", 1, 8.0, 8.0),
    ];
    let total_requested: u32 = items.iter().map(|p| p.quantity).sum();

    let asn = ffd_assign(&bins_spec, &items, 0.0).unwrap();
    assert_eq!(total_items(&asn), total_requested);

    // Apply each operator in sequence; fall through to prior assignment
    // if a given operator didn't find an improving move.
    let step1 = unload_lightest_bin(&asn, &bins_spec, &items, 0.0)
        .unwrap()
        .unwrap_or_else(|| asn.clone());
    assert_eq!(total_items(&step1), total_requested);

    let step2 = swap_two(&step1, 0, 1, &bins_spec, &items, 0.0)
        .unwrap()
        .unwrap_or_else(|| step1.clone());
    assert_eq!(total_items(&step2), total_requested);

    let step3 = migrate(&step2, 0, 1, None, &bins_spec, &items, 0.0)
        .unwrap()
        .unwrap_or_else(|| step2.clone());
    assert_eq!(total_items(&step3), total_requested);
}

/// Determinism: running FFD + each operator twice gives bit-identical
/// bin_id + x + y placements.
#[test]
fn determinism_under_repeated_runs() {
    let bins_spec = vec![bin("A", 40.0, 40.0), bin("B", 40.0, 40.0)];
    let items = vec![rect_part("a", 2, 15.0, 15.0), rect_part("b", 1, 10.0, 10.0)];

    let run = || {
        let asn = ffd_assign(&bins_spec, &items, 0.0).unwrap();
        let s = swap_two(&asn, 0, 1, &bins_spec, &items, 0.0)
            .unwrap()
            .unwrap_or(asn.clone());
        let m = migrate(&s, 0, 1, None, &bins_spec, &items, 0.0)
            .unwrap()
            .unwrap_or(s.clone());
        let u = unload_lightest_bin(&m, &bins_spec, &items, 0.0)
            .unwrap()
            .unwrap_or(m.clone());
        u.per_bin
            .iter()
            .map(|b| {
                b.placements
                    .iter()
                    .map(|p| {
                        (
                            p.shape_id.clone(),
                            p.bin_id.clone(),
                            p.x.to_bits(),
                            p.y.to_bits(),
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>()
    };

    assert_eq!(
        run(),
        run(),
        "bit-identical outputs expected under fixed inputs"
    );
}
