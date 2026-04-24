// engine/crates/rf-layout/src/infrastructure/search/gls/explore.rs
//
// Ported from sparrow's `src/optimizer/explore.rs` (MIT, Copyright 2025
// Jeroen Gardeyn, KU Leuven, ejor-snapshot tag c95454e3).
//
// The exploration phase is the outer GLS loop. It repeatedly calls
// Separator::separate, collects feasible layouts, and on infeasibility
// disrupts the layout (swap-two-large) to escape local minima.
//
// Deviations from upstream:
//   1. SPP -> BPP: change_strip_width + the whole shrink-and-retry
//      driver removed. BPP bins are fixed-size. Loop driver is
//      "separate, on Feasible return immediately (density is fixed),
//      on Infeasible disrupt + restart until terminator or
//      max_conseq_failed_attempts".
//   2. Return type: ExplorationOutcome::{ Feasible(LayoutSnapshot),
//      Infeasible { snapshot, total_loss } } instead of
//      Vec<SPSolution>. BPSolution assembly is Task 8/12.
//   3. SPInstance/SPSolution/SPProblem -> BPInstance/LayoutSnapshot/
//      Layout. sep.prob.* -> sep.layout / sep.instance per Task 5.
//   4. sol_listener.report(ReportType::*, ...) replaced with
//      SolutionListener trait methods report_feasible /
//      report_infeasible (default noops added in Task 6 to the trait
//      in separator.rs).
//   5. Budget: Terminator passed in pre-armed. Task 8 allocates 100%
//      of time_budget_ms to exploration; compression is identity in
//      BPP (Task 7) so the sparrow 80/20 split doesn't apply.
//   6. Pool tuple: Vec<(LayoutSnapshot, f32)> matching upstream's
//      semantic: pool restart uses rollback(snap, None) -> fresh
//      tracker. Carrying CTSnapshot would be a semantic deviation
//      from the paper's GLS escape behaviour (Codex sign-off).
//   7. Large-item cutoff (disrupt_solution) computed from
//      sep.layout.placed_items, NOT sep.instance.items. Upstream
//      conflates the two because SPP is single-layout; for BPP the
//      instance carries items destined for other bins too.
//   8. disrupt_solution's sep.move_item calls use the Task 6-restored
//      public method on Separator.
//   9. practically_contained_items ported verbatim as a private fn
//      at bottom of this file — Layout-generic, no retyping.
//   10. FMT logging helper replaced with inline `{:.4}` format specs.

use super::separator::{SeparateOutcome, Separator};
use super::separator::{SeparatorConfig, SolutionListener, Terminator};
use super::uniform_sampler::convert_sample_to_closest_feasible;
use float_cmp::approx_eq;
use itertools::Itertools;
use jagua_rs::collision_detection::hazards::HazardEntity;
use jagua_rs::entities::{Instance, Layout, LayoutSnapshot, PItemKey};
use jagua_rs::geometry::geo_traits::CollidesWith;
use jagua_rs::geometry::DTransformation;
use log::{debug, info, warn};
use ordered_float::OrderedFloat;
use rand::prelude::IteratorRandom;
use rand::seq::IndexedRandom;
use rand_distr::{Distribution, Normal};
use slotmap::SecondaryMap;
use std::cmp::Reverse;

// ---------------------------------------------------------------------------
// Config + outcome
// ---------------------------------------------------------------------------

/// Runtime configuration for `exploration_phase`. Defaults mirror
/// sparrow's `ExplorationConfig::paper_defaults` (upstream `config.rs`
/// L55-74). `shrink_step` and `time_limit` intentionally omitted —
/// the first is SPP-only, the second belongs on the Terminator.
#[derive(Debug, Clone, Copy)]
pub struct ExplorationConfig {
    pub max_conseq_failed_attempts: Option<usize>,
    pub solution_pool_distribution_stddev: f32,
    pub large_item_ch_area_cutoff_percentile: f32,
    pub separator_config: SeparatorConfig,
}

impl ExplorationConfig {
    /// Sparrow-paper defaults.
    pub fn paper_defaults() -> Self {
        Self {
            max_conseq_failed_attempts: None,
            solution_pool_distribution_stddev: 0.25,
            large_item_ch_area_cutoff_percentile: 0.75,
            separator_config: SeparatorConfig::exploration(),
        }
    }
}

/// Outcome of `exploration_phase`.
#[derive(Debug)]
pub enum ExplorationOutcome {
    /// First feasibility reached — return the collision-free layout
    /// immediately. Per-bin density is fixed once feasible in BPP.
    Feasible(LayoutSnapshot),
    /// Ran out of budget or exhausted `max_conseq_failed_attempts`
    /// before feasibility. Payload is the lowest-total-loss snapshot
    /// seen in the infeasible pool (or the starting layout if the pool
    /// never grew).
    Infeasible {
        snapshot: LayoutSnapshot,
        total_loss: f32,
    },
}

// ---------------------------------------------------------------------------
// Exploration phase driver
// ---------------------------------------------------------------------------

/// Algorithm 12 from <https://doi.org/10.48550/arXiv.2509.13329>,
/// BPP-adapted (single-bin).
///
/// Loop: call `sep.separate`. On `Feasible` return immediately (density
/// is fixed by the item set). On `Infeasible` insert into a loss-sorted
/// pool, biased-sample a restart via normal distribution, rollback with
/// fresh tracker (upstream semantic — escape behavior), and disrupt
/// via swap-two-large.
pub fn exploration_phase(
    sep: &mut Separator,
    term: &impl Terminator,
    listener: &mut impl SolutionListener,
    config: &ExplorationConfig,
) -> ExplorationOutcome {
    // Codex sign-off R6: validate stddev at the entry seam so Normal::new
    // failures panic at the top of the call, not deep inside sampling.
    assert!(
        config.solution_pool_distribution_stddev > 0.0,
        "solution_pool_distribution_stddev must be > 0.0 (got {})",
        config.solution_pool_distribution_stddev,
    );

    info!(
        "[EXPL] starting, density: {:.4}%, items: {}",
        sep.layout.density(&sep.instance) * 100.0,
        sep.layout.placed_items.len()
    );

    // Pool is sorted by loss ascending; best (smallest loss) at index 0.
    let mut pool: Vec<(LayoutSnapshot, f32)> = Vec::new();

    // Explicit counter, independent of pool.len(). Under early-exit
    // they happen to coincide today; naming parity with upstream
    // `config.max_conseq_failed_attempts` demands the real invariant
    // (Gemini sign-off R1).
    let mut conseq_failed: usize = 0;

    while !term.kill() {
        match sep.separate(term, listener) {
            SeparateOutcome::Feasible(snap) => {
                info!(
                    "[EXPL] feasible! density: {:.4}%",
                    sep.layout.density(&sep.instance) * 100.0
                );
                listener.report_feasible(&snap);
                return ExplorationOutcome::Feasible(snap);
            }
            SeparateOutcome::Infeasible {
                snapshot,
                ct_snapshot: _,
            } => {
                let loss = sep.ct.get_total_loss();
                debug_assert!(
                    loss.is_finite(),
                    "infeasible pool must not receive NaN/inf loss (got {loss})"
                );
                info!("[EXPL] infeasible, loss: {:.4}", loss);
                listener.report_infeasible(&snapshot);
                insert_sorted_by_loss(&mut pool, snapshot, loss);
                conseq_failed += 1;
                if conseq_failed >= config.max_conseq_failed_attempts.unwrap_or(usize::MAX) {
                    info!(
                        "[EXPL] max consecutive failed attempts ({}), terminating",
                        conseq_failed
                    );
                    break;
                }

                // Biased sample from the pool (better solutions at
                // lower indices get more weight).
                let selected_snap = sample_pool_biased(
                    &pool,
                    &mut sep.rng,
                    config.solution_pool_distribution_stddev,
                );

                // Fresh tracker (upstream L79 uses None) — discards
                // GLS weights as part of the paper's escape behaviour.
                sep.rollback(selected_snap, None);
                disrupt_solution(sep, config);
            }
        }
    }

    // Fell out of the outer loop (terminator or attempts cap). Return
    // the pool's best, or the current state if the pool is empty.
    match pool.into_iter().next() {
        Some((snap, loss)) => ExplorationOutcome::Infeasible {
            snapshot: snap,
            total_loss: loss,
        },
        None => ExplorationOutcome::Infeasible {
            snapshot: sep.layout.save(),
            total_loss: sep.ct.get_total_loss(),
        },
    }
}

/// Insert `snap`/`loss` into `pool` while keeping it sorted by loss asc.
fn insert_sorted_by_loss(pool: &mut Vec<(LayoutSnapshot, f32)>, snap: LayoutSnapshot, loss: f32) {
    match pool.binary_search_by(|(_, o)| {
        o.partial_cmp(&loss)
            .expect("loss must be total-orderable (debug_assert guards NaN upstream)")
    }) {
        Ok(idx) | Err(idx) => pool.insert(idx, (snap, loss)),
    }
}

/// Sample an index from a half-normal distribution clamped to
/// `[0, pool.len())`. Lower indices (better solutions) get higher
/// weight. Panics if `pool` is empty.
fn sample_pool_biased<'a>(
    pool: &'a [(LayoutSnapshot, f32)],
    rng: &mut impl rand::Rng,
    stddev: f32,
) -> &'a LayoutSnapshot {
    debug_assert!(!pool.is_empty(), "cannot sample from an empty pool");
    let dist = Normal::new(0.0_f32, stddev).expect("Normal::new accepts positive stddev");
    let sample = dist.sample(rng).abs().min(0.999);
    let idx = (sample * pool.len() as f32) as usize;
    &pool[idx].0
}

// ---------------------------------------------------------------------------
// Disrupt: swap two large items + relocate contained
// ---------------------------------------------------------------------------

fn disrupt_solution(sep: &mut Separator, config: &ExplorationConfig) {
    if sep.layout.placed_items.len() < 2 {
        warn!("[DSRP] cannot disrupt layout with fewer than 2 items");
        return;
    }

    // BPP scope: compute large-item cutoff from items CURRENTLY PLACED
    // in this layout, not from instance demand totals. For SPP the two
    // are identical (single strip holds everything); for BPP the
    // instance carries items destined for other bins too.
    let total_ch_area: f32 = sep
        .layout
        .placed_items
        .values()
        .map(|pi| {
            sep.instance
                .item(pi.item_id)
                .shape_cd
                .surrogate()
                .convex_hull_area
        })
        .sum();
    let cutoff_threshold_area = total_ch_area * config.large_item_ch_area_cutoff_percentile;

    // Sort placed items by ch area desc. Walk the list accumulating
    // areas until the cumulative sum exceeds the threshold; the item
    // that tipped the sum defines the cutoff.
    let by_area: Vec<(PItemKey, f32)> = sep
        .layout
        .placed_items
        .iter()
        .map(|(pk, pi)| {
            (
                pk,
                sep.instance
                    .item(pi.item_id)
                    .shape_cd
                    .surrogate()
                    .convex_hull_area,
            )
        })
        .sorted_by_key(|(_, a)| Reverse(OrderedFloat(*a)))
        .collect();

    let mut cumulative = 0.0;
    let mut ch_area_cutoff = 0.0;
    for &(_, a) in &by_area {
        cumulative += a;
        if cumulative > cutoff_threshold_area {
            ch_area_cutoff = a;
            debug!("[DSRP] cutoff ch area: {:.4}", ch_area_cutoff);
            break;
        }
    }
    debug_assert!(
        ch_area_cutoff > 0.0,
        "large-item cutoff should be positive; placed_items={}",
        sep.layout.placed_items.len()
    );

    // Gather large items.
    let large: Vec<PItemKey> = sep
        .layout
        .placed_items
        .iter()
        .filter(|(_, pi)| pi.shape.surrogate().convex_hull_area >= ch_area_cutoff)
        .map(|(pk, _)| pk)
        .collect();
    let &pk1 = large
        .choose(&mut sep.rng)
        .expect("[DSRP] failed to choose first large item");
    let pi1_area = sep.layout.placed_items[pk1].shape.area;
    let pi1_diam = sep.layout.placed_items[pk1].shape.diameter;

    // Second item: differ from the first in BOTH area AND diameter
    // (upstream explore.rs L147-152 uses && — a sufficiently different
    // second item guarantees the swap perturbs the layout). Fall back
    // to any other placed item if that filter finds nothing.
    let pk2 = large
        .iter()
        .copied()
        .filter(|&pk| pk != pk1)
        .filter(|&pk| {
            let pi = &sep.layout.placed_items[pk];
            !approx_eq!(f32, pi.shape.area, pi1_area, epsilon = pi1_area * 0.01)
                && !approx_eq!(f32, pi.shape.diameter, pi1_diam, epsilon = pi1_diam * 0.01)
        })
        .choose(&mut sep.rng)
        .or_else(|| {
            sep.layout
                .placed_items
                .keys()
                .filter(|&pk| pk != pk1)
                .choose(&mut sep.rng)
        })
        .expect("[DSRP] failed to choose second item for disruption");

    let dt1_old = sep.layout.placed_items[pk1].d_transf;
    let dt2_old = sep.layout.placed_items[pk2].d_transf;

    // Rotation-feasible adjustment — items with fixed rotations must
    // snap to allowed angles. Helper was already ported in Task 4
    // (uniform_sampler.rs L135).
    let item1_id = sep.layout.placed_items[pk1].item_id;
    let item2_id = sep.layout.placed_items[pk2].item_id;
    let dt1_new = convert_sample_to_closest_feasible(dt2_old, sep.instance.item(item1_id));
    let dt2_new = convert_sample_to_closest_feasible(dt1_old, sep.instance.item(item2_id));

    info!(
        "[DSRP] swapping large items (ids {} <-> {})",
        item1_id, item2_id
    );

    let pk1 = sep.move_item(pk1, dt1_new);
    let pk2 = sep.move_item(pk2, dt2_new);

    // Relocate items practically contained by the NEW shape of pk1
    // (typically the post-swap larger item's footprint swallows
    // former neighbours of the smaller one); same for pk2.
    relocate_contained(sep, pk1, dt1_old, dt1_new, pk2);
    relocate_contained(sep, pk2, dt2_old, dt2_new, pk1);
}

/// Move items practically contained by `anchor`'s new shape out of the
/// way via the transformation that carried `anchor` from `dt_old` to
/// `dt_new`. Upstream explore.rs L180-215.
fn relocate_contained(
    sep: &mut Separator,
    anchor: PItemKey,
    dt_old: DTransformation,
    dt_new: DTransformation,
    skip: PItemKey,
) {
    let converting = dt_new.compose().inverse().transform(&dt_old.compose());

    let contained: Vec<PItemKey> = practically_contained_items(&sep.layout, anchor)
        .into_iter()
        .filter(|&pk| pk != skip)
        .collect();

    for pk in contained {
        let c_pi = &sep.layout.placed_items[pk];
        let c_item_id = c_pi.item_id;
        let new_dt = c_pi.d_transf.compose().transform(&converting).decompose();
        let feasible_dt = convert_sample_to_closest_feasible(new_dt, sep.instance.item(c_item_id));
        sep.move_item(pk, feasible_dt);
    }
}

/// Collect items whose point-of-inaccessibility (POI) center is
/// contained by `anchor`'s shape. Upstream explore.rs L219-240.
fn practically_contained_items(layout: &Layout, anchor: PItemKey) -> Vec<PItemKey> {
    let anchor_pi = &layout.placed_items[anchor];

    // Detect all items whose shapes collide with anchor's shape.
    // `SecondaryMap` impls `HazardCollector`; use it as the collector
    // so the result is compact.
    let mut collector: SecondaryMap<_, HazardEntity> = SecondaryMap::new();
    layout
        .cde()
        .collect_poly_collisions(&anchor_pi.shape, &mut collector);

    collector
        .iter()
        .filter_map(|(_, he)| match he {
            HazardEntity::PlacedItem { pk, .. } => Some(*pk),
            _ => None,
        })
        .filter(|&pk| pk != anchor)
        .filter(|&pk| {
            let poi = layout.placed_items[pk].shape.poi;
            anchor_pi.shape.collides_with(&poi.center)
        })
        .collect_vec()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Bin, BinKind, Part};
    use crate::infrastructure::jagua_adapter::to_jagua_instance;
    use crate::infrastructure::search::gls::separator::{NoopListener, NoopTerminator};
    use jagua_rs::entities::Instance as InstanceTrait;
    use jagua_rs::probs::bpp::entities::BPInstance;
    use rand::SeedableRng;
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

    fn tiny_fixture(
        bin_side: f64,
        items: &[Part],
        placements: &[(usize, f32, f32)],
    ) -> (BPInstance, Layout) {
        let bin = Bin {
            bin_id: "test-bin".into(),
            width: bin_side,
            height: bin_side,
            kind: BinKind::Fresh,
            priority: None,
        };
        let instance = to_jagua_instance(&[bin], items, 0.0).expect("build instance");
        let container = instance.container(0).clone();
        let mut layout = Layout::new(container);
        for &(item_id, tx, ty) in placements {
            let item = instance.item(item_id);
            layout.place_item(item, DTransformation::new(0.0, (tx, ty)));
        }
        (instance, layout)
    }

    fn build_separator(instance: BPInstance, layout: Layout) -> Separator {
        let rng = Xoshiro256PlusPlus::seed_from_u64(SEED);
        Separator::new(
            instance,
            layout,
            rng,
            ExplorationConfig::paper_defaults().separator_config,
        )
    }

    #[test]
    fn explore_feasible_fast_path() {
        // Two 10x10 squares placed well apart in a 100x100 bin — first
        // separate() returns Feasible; explore exits with Feasible.
        let parts = vec![square_part("a", 10.0), square_part("b", 10.0)];
        let (instance, layout) = tiny_fixture(100.0, &parts, &[(0, 10.0, 10.0), (1, 50.0, 50.0)]);
        let mut sep = build_separator(instance, layout);

        let outcome = exploration_phase(
            &mut sep,
            &NoopTerminator,
            &mut NoopListener,
            &ExplorationConfig::paper_defaults(),
        );

        assert!(
            matches!(outcome, ExplorationOutcome::Feasible(ref snap) if snap.placed_items.len() == 2),
            "expected Feasible with 2 placed items, got {outcome:?}"
        );
    }

    #[test]
    fn explore_resolves_overlap() {
        // Two 10x10 squares at (10,10)/(15,15) — 50% overlap. Expect the
        // inner Separator to resolve.
        let parts = vec![square_part("a", 10.0), square_part("b", 10.0)];
        let (instance, layout) = tiny_fixture(100.0, &parts, &[(0, 10.0, 10.0), (1, 15.0, 15.0)]);
        let mut sep = build_separator(instance, layout);

        let outcome = exploration_phase(
            &mut sep,
            &NoopTerminator,
            &mut NoopListener,
            &ExplorationConfig::paper_defaults(),
        );

        assert!(
            matches!(outcome, ExplorationOutcome::Feasible(_)),
            "expected Feasible after resolving overlap, got {outcome:?}"
        );
    }

    #[test]
    fn explore_max_attempts_cap() {
        // Two 80x80 squares in a 100x100 bin cannot fit without overlap.
        // Cap at 3 conseq failed attempts -> Infeasible with positive
        // total_loss.
        let parts = vec![square_part("big-a", 80.0), square_part("big-b", 80.0)];
        let (instance, layout) = tiny_fixture(100.0, &parts, &[(0, 5.0, 5.0), (1, 15.0, 15.0)]);

        let mut cfg = ExplorationConfig::paper_defaults();
        cfg.max_conseq_failed_attempts = Some(3);
        cfg.separator_config.strike_limit = 1;
        cfg.separator_config.iter_no_imprv_limit = 5;

        let rng = Xoshiro256PlusPlus::seed_from_u64(SEED);
        let mut sep = Separator::new(instance, layout, rng, cfg.separator_config);

        let outcome = exploration_phase(&mut sep, &NoopTerminator, &mut NoopListener, &cfg);

        // Gemini sign-off R2: assert the real infeasibility signal
        // (total_loss > 0); the placed_items count is tautological under
        // disrupt_solution (which only moves, never removes, items).
        assert!(
            matches!(outcome, ExplorationOutcome::Infeasible { .. }),
            "expected Infeasible under unresolvable fixture, got {outcome:?}"
        );
        if let ExplorationOutcome::Infeasible {
            snapshot: _,
            total_loss,
        } = outcome
        {
            assert!(
                total_loss > 0.0,
                "infeasible outcome must carry positive loss"
            );
        }
    }

    #[test]
    fn explore_respects_terminator() {
        // KillImmediately -> fall-through path returns Infeasible from
        // the current (still-overlapping) layout without running any
        // separate iteration. Must also return the EXACT pre-call
        // layout snapshot — not just unchanged loss — so a future
        // refactor that runs `sep.layout.save()` partway through the
        // kill path would fail this test (Codex impl-review fix).
        struct KillImmediately;
        impl Terminator for KillImmediately {
            fn kill(&self) -> bool {
                true
            }
        }

        let parts = vec![square_part("a", 10.0), square_part("b", 10.0)];
        let (instance, layout) = tiny_fixture(100.0, &parts, &[(0, 10.0, 10.0), (1, 15.0, 15.0)]);
        let mut sep = build_separator(instance, layout);
        let loss_before = sep.ct.get_total_loss();
        // Capture the pre-call item set: (item_id, d_transf) tuples.
        // PItemKey is not stable across remove+place, so we compare by
        // the stable (item_id, d_transf) pair.
        let pre_call: Vec<(usize, DTransformation)> = sep
            .layout
            .placed_items
            .values()
            .map(|pi| (pi.item_id, pi.d_transf))
            .sorted_by_key(|(id, _)| *id)
            .collect();

        let outcome = exploration_phase(
            &mut sep,
            &KillImmediately,
            &mut NoopListener,
            &ExplorationConfig::paper_defaults(),
        );

        assert!(
            matches!(outcome, ExplorationOutcome::Infeasible { .. }),
            "kill()==true must short-circuit with Infeasible"
        );
        if let ExplorationOutcome::Infeasible {
            snapshot,
            total_loss,
        } = outcome
        {
            assert_eq!(
                total_loss, loss_before,
                "kill()==true must do zero work (loss unchanged)"
            );
            let returned: Vec<(usize, DTransformation)> = snapshot
                .placed_items
                .values()
                .map(|pi| (pi.item_id, pi.d_transf))
                .sorted_by_key(|(id, _)| *id)
                .collect();
            assert_eq!(
                returned, pre_call,
                "kill()==true must return the exact pre-call layout (no partial save)"
            );
        }
    }

    #[test]
    fn explore_determinism_under_fixed_seed() {
        // Two runs from the same seed must produce the same placed-item
        // transformations in the feasible outcome.
        fn run() -> Vec<(usize, DTransformation)> {
            let parts = vec![square_part("a", 10.0), square_part("b", 10.0)];
            let (instance, layout) =
                tiny_fixture(100.0, &parts, &[(0, 10.0, 10.0), (1, 15.0, 15.0)]);
            let mut sep = build_separator(instance, layout);
            let outcome = exploration_phase(
                &mut sep,
                &NoopTerminator,
                &mut NoopListener,
                &ExplorationConfig::paper_defaults(),
            );
            match outcome {
                ExplorationOutcome::Feasible(snap) => snap
                    .placed_items
                    .values()
                    .map(|pi| (pi.item_id, pi.d_transf))
                    .sorted_by_key(|(id, _)| *id)
                    .collect(),
                _ => panic!("expected feasible from seed 42"),
            }
        }

        assert_eq!(run(), run());
    }
}
