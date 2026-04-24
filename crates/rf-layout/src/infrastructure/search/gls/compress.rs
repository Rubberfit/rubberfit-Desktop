// engine/crates/rf-layout/src/infrastructure/search/gls/compress.rs
//
// Ported from sparrow's `src/optimizer/compress.rs` (MIT, Copyright 2025
// Jeroen Gardeyn, KU Leuven, ejor-snapshot tag c95454e3).
//
// Algorithm 13 is SPP-specific: shrink the strip, re-separate, keep the
// result iff still feasible. BPP bins are fixed-size (see `separator.rs`
// deviation #2 — `change_strip_width` was deleted in Task 5). That
// leaves Algorithm 13 with no analogue in a fixed-container setting:
//
//   1. `Separator::separate()` exits immediately when total loss == 0
//      (separator.rs:274). Running it again on a feasible layout does
//      zero moves because `SeparatorWorker::move_items()` filters
//      candidates to items with loss > 0 (separator.rs:425).
//   2. `BppObjective` scores only overflow + placed count; it cannot
//      detect intra-bin geometry improvements. Adding such a term is
//      out of scope (Task 1 / Task 18 territory — gated on Task 12
//      cross-bin swap telemetry).
//   3. Upstream's 20% budget slice earns its cost because strip width
//      actually improves SPP density. In BPP the slice would be dead
//      weight. Task 8 will allocate 100% to exploration instead.
//
// Conclusion: the faithful BPP port of Algorithm 13 is identity. This
// module exists to:
//   (a) preserve the call-site uniformity Task 8 expects,
//   (b) document the port decision at the right location in the tree,
//   (c) leave a stable seam for a future BPP-specific compression
//       heuristic (geometric compaction, for example) without touching
//       Task 8's orchestrator.
//
// Deviations from upstream:
//   1. `compression_phase()` returns its input unchanged. Upstream's
//      shrink-retry loop is deleted in full.
//   2. No `CompressionConfig` — upstream's fields drove strip-shrink
//      schedule, which does not apply here.
//   3. `attempt_to_compress` helper deleted.
//   4. Logs the decision at `info` level so operators see compress
//      ran and returned identity (not silent).

use super::separator::{Separator, SolutionListener, Terminator};
use jagua_rs::entities::LayoutSnapshot;
use log::info;

/// Algorithm 13 from <https://doi.org/10.48550/arXiv.2509.13329>,
/// BPP-adapted — identity pass-through.
///
/// For fixed-size bins there is no shrink analogue to Algorithm 13's
/// strip-width compression. Running `Separator::separate` on a feasible
/// layout is provably a no-op (the algorithm exits on `loss == 0` and
/// the inner worker filters candidates to items with `loss > 0`). So
/// the faithful BPP port is identity.
///
/// The `&mut Separator` reference is accepted to keep the Task 8
/// orchestrator signature uniform across `explore → compress`, and so
/// that a future real BPP compression can drop in without a call-site
/// change. The function **reads** `sep.layout` and `sep.instance` for
/// the single diagnostic `info!` line below and **does not mutate**
/// any separator state (no writes to `layout`, `ct`, `rng`, `workers`,
/// or `instance`). RNG-stream identity is asserted by the test below.
pub fn compression_phase(
    sep: &mut Separator,
    feasible: LayoutSnapshot,
    _term: &impl Terminator,
    _listener: &mut impl SolutionListener,
) -> LayoutSnapshot {
    info!(
        "[CMPR] identity pass (BPP fixed-container, density unchanged at {:.4}%, items: {})",
        sep.layout.density(&sep.instance) * 100.0,
        sep.layout.placed_items.len()
    );
    feasible
}

// ---------------------------------------------------------------------------
// Tests — identity + RNG-stream invariants (per Codex sign-off §5)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Bin, BinKind, Part};
    use crate::infrastructure::jagua_adapter::to_jagua_instance;
    use crate::infrastructure::search::gls::separator::{
        NoopListener, NoopTerminator, SeparatorConfig,
    };
    use itertools::Itertools;
    use jagua_rs::entities::{Instance as InstanceTrait, Layout};
    use jagua_rs::geometry::DTransformation;
    use jagua_rs::probs::bpp::entities::BPInstance;
    use rand::{Rng, SeedableRng};
    use rand_xoshiro::Xoshiro256PlusPlus;
    use rf_geom::domain::Point2D;

    const SEED: u64 = 42;

    fn square_part(id: &str, side: f64) -> Part {
        Part {
            shape_id: id.into(),
            quantity: 1,
            polygon: vec![
                Point2D::new(0.0, 0.0),
                Point2D::new(side, 0.0),
                Point2D::new(side, side),
                Point2D::new(0.0, side),
            ],
            shape_spec: None,
            allow_rotation: false,
            grain_axis: None,
            difficulty: None,
        }
    }

    /// A deliberately-feasible fixture: two 10x10 squares well apart in
    /// a 100x100 bin. No collisions — directly usable by compression_phase.
    fn feasible_fixture() -> (BPInstance, Layout) {
        let bin = Bin {
            bin_id: "test-bin".into(),
            width: 100.0,
            height: 100.0,
            kind: BinKind::Fresh,
            priority: None,
        };
        let parts = vec![square_part("a", 10.0), square_part("b", 10.0)];
        let instance = to_jagua_instance(&[bin], &parts, 0.0).expect("build instance");
        let container = instance.container(0).clone();
        let mut layout = Layout::new(container);
        for (item_id, tx, ty) in [(0usize, 10.0f32, 10.0f32), (1, 50.0, 50.0)] {
            let item = instance.item(item_id);
            layout.place_item(item, DTransformation::new(0.0, (tx, ty)));
        }
        (instance, layout)
    }

    fn build_separator(instance: BPInstance, layout: Layout) -> Separator {
        let rng = Xoshiro256PlusPlus::seed_from_u64(SEED);
        Separator::new(instance, layout, rng, SeparatorConfig::exploration())
    }

    #[test]
    fn compress_returns_input_unchanged() {
        // Start from a known feasible snapshot; compression_phase must
        // return byte-identical placements.
        // Borrow-order note (Codex sign-off): save the snapshot BEFORE
        // building the separator and BEFORE any `&mut sep` call.
        let (instance, layout) = feasible_fixture();
        let snap_before = layout.save();
        let mut sep = build_separator(instance, layout);

        let snap_after = compression_phase(
            &mut sep,
            snap_before.clone(),
            &NoopTerminator,
            &mut NoopListener,
        );

        let before: Vec<(usize, DTransformation)> = snap_before
            .placed_items
            .values()
            .map(|pi| (pi.item_id, pi.d_transf))
            .sorted_by_key(|(id, _)| *id)
            .collect();
        let after: Vec<(usize, DTransformation)> = snap_after
            .placed_items
            .values()
            .map(|pi| (pi.item_id, pi.d_transf))
            .sorted_by_key(|(id, _)| *id)
            .collect();

        assert_eq!(
            before, after,
            "compression must be identity on feasible input"
        );
    }

    #[test]
    fn compress_does_not_touch_rng() {
        // The RNG stream must be unperturbed by compression_phase so
        // (explore, compress) is indistinguishable from (explore, no-op).
        // This is the real determinism invariant at the explore→compress
        // seam (per Codex §5).
        let (instance, layout) = feasible_fixture();
        let mut sep = build_separator(instance, layout);
        let rng_reference = sep.rng.clone();
        let snap = sep.layout.save();

        let _ = compression_phase(&mut sep, snap, &NoopTerminator, &mut NoopListener);

        // Both RNGs should now emit the same stream. A fresh
        // `clone()` of `sep.rng` gives us a stream-equivalent copy to
        // compare against `rng_reference`.
        let mut rng_after = sep.rng.clone();
        let mut rng_ref = rng_reference;
        for i in 0..8 {
            assert_eq!(
                rng_after.next_u64(),
                rng_ref.next_u64(),
                "compress must not consume the RNG stream (drifted at draw {i})"
            );
        }
    }
}
