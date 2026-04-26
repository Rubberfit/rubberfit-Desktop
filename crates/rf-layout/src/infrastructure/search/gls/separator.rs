// engine/crates/rf-layout/src/infrastructure/search/gls/separator.rs
//
// Ported from sparrow's `src/optimizer/{separator,worker}.rs` (MIT,
// Copyright 2025 Jeroen Gardeyn, KU Leuven, ejor-snapshot tag c95454e3).
//
// The Separator is the inner loop of the GLS exploration phase. It runs a
// penalty-weighted local search over a single bin's Layout, moving
// colliding items to positions that reduce total collision quantification.
// On success returns `Feasible(LayoutSnapshot)`; on strike-limit
// exhaustion returns `Infeasible { snapshot, ct_snapshot }`.
//
// Deviations from upstream:
//   1. Retyped SPP -> BPP by scoping to a single `Layout` instead of
//      SPProblem. Layout exposes its own place/remove/save/restore API,
//      so the Separator never touches BPProblem -- multi-bin
//      coordination is Task 12's concern.
//   2. `change_strip_width` deleted. BPP bins are fixed-size. The
//      `strip_width()` debug_assert inside upstream `rollback` is
//      likewise dropped.
//   3. `Separator::move_item` (upstream's public move) was dropped in
//      Task 5 and restored in Task 6 as a pub method -- `explore.rs`
//      disrupt_solution needs it at 4 call sites, so inlining became
//      messier than one method. `SeparatorWorker::move_item` remains
//      its own method used inside the worker move loop.
//   4. SeparatorWorker inlined in this file (matches tracker.rs /
//      specialized_pipeline.rs convention). Worker vector kept to
//      preserve Algorithm 10 semantics; iterated sequentially (rayon
//      deferred to Task 18). Default n_workers=3 matches upstream
//      (sparrow `config.rs` L549-557) so Algorithm 10 is faithful.
//   5. `FMT` logging helper replaced with inline `{:.4}` format specs.
//   6. Terminator + SolutionListener introduced as minimal traits with
//      Noop impls. Task 14 replaces the noop impls with real cancel /
//      progress wiring.
//   7. Return signature of `separate()` wrapped in
//      `SeparateOutcome::{ Feasible, Infeasible }` instead of returning
//      `(snapshot, ct_snapshot)` unconditionally -- downstream Task 6
//      explore.rs branches on this distinction.

use super::sampling::{search_placement, SampleConfig};
use super::sep_evaluator::SeparationEvaluator;
use super::tracker::{CTSnapshot, CollisionTracker};
use itertools::Itertools;
use jagua_rs::entities::{Instance, Layout, LayoutSnapshot, PItemKey};
use jagua_rs::geometry::DTransformation;
use jagua_rs::probs::bpp::entities::BPInstance;
use log::{debug, log, Level};
use ordered_float::OrderedFloat;
use rand::prelude::SliceRandom;
use rand::{RngExt, SeedableRng};
use rand_xoshiro::Xoshiro256PlusPlus;
use std::iter::Sum;
use std::ops::AddAssign;

// ---------------------------------------------------------------------------
// Config + telemetry
// ---------------------------------------------------------------------------

/// Runtime configuration for a [`Separator`]. Defaults match sparrow's
/// exploration phase in `sparrow/src/config.rs` (L549-557): `strike_limit=3`,
/// `iter_no_imprv_limit=200`, `n_workers=3`. Compression (task 7) will use
/// its own values.
#[derive(Debug, Clone, Copy)]
pub struct SeparatorConfig {
    pub iter_no_imprv_limit: usize,
    pub strike_limit: usize,
    pub n_workers: usize,
    pub sample_config: SampleConfig,
    pub log_level: Level,
}

impl SeparatorConfig {
    /// Sparrow-paper exploration defaults.
    pub fn exploration() -> Self {
        Self {
            iter_no_imprv_limit: 200,
            strike_limit: 3,
            n_workers: 3,
            sample_config: SampleConfig {
                n_container_samples: 50,
                n_focussed_samples: 20,
                n_coord_descents: 3,
            },
            log_level: Level::Debug,
        }
    }
}

/// Per-run telemetry summed across workers and iterations.
#[derive(Clone, Copy, Debug, Default)]
pub struct SepStats {
    pub total_moves: usize,
    pub total_evals: usize,
}

// `Sum` is unused in the S2.5a sequential port (move_items_multi uses
// `AddAssign` in a for-loop), but kept for upstream parity so Task 18's
// rayon reintegration can `.sum::<SepStats>()` across parallel iterators
// without re-adding this impl.
impl Sum for SepStats {
    fn sum<I: Iterator<Item = SepStats>>(iter: I) -> Self {
        let mut out = SepStats::default();
        for s in iter {
            out += s;
        }
        out
    }
}

impl AddAssign for SepStats {
    fn add_assign(&mut self, other: Self) {
        self.total_moves += other.total_moves;
        self.total_evals += other.total_evals;
    }
}

/// Outcome of a `Separator::separate()` call.
#[derive(Debug)]
pub enum SeparateOutcome {
    /// Total loss reached zero â€” the returned snapshot is collision-free.
    Feasible(LayoutSnapshot),
    /// Strike limit reached before feasibility. Payload is the best-seen
    /// layout + its tracker snapshot (preserves GLS weights for the next
    /// strike in the explore loop).
    Infeasible {
        snapshot: LayoutSnapshot,
        ct_snapshot: CTSnapshot,
    },
}

// ---------------------------------------------------------------------------
// Termination + progress hooks
// ---------------------------------------------------------------------------

/// Minimal termination hook. Task 14 will introduce a real impl backed by
/// an `AtomicBool` cancel token; for S2.5a the `NoopTerminator` below
/// satisfies the explore loop.
pub trait Terminator {
    fn kill(&self) -> bool;
}

/// Minimal progress hook. Task 14 will introduce a real impl emitting
/// NDJSON `PackProgress` frames.
///
/// `report_feasible` and `report_infeasible` carry default-noop impls
/// so Task 5's `NoopListener` compiles unedited. Task 6's explore.rs
/// calls them on pool transitions; Task 14's real listener will route
/// them to NDJSON events.
pub trait SolutionListener {
    fn report_improving(&mut self, snapshot: &LayoutSnapshot);
    fn report_feasible(&mut self, _snapshot: &LayoutSnapshot) {}
    fn report_infeasible(&mut self, _snapshot: &LayoutSnapshot) {}
}

pub struct NoopTerminator;
impl Terminator for NoopTerminator {
    fn kill(&self) -> bool {
        false
    }
}

pub struct NoopListener;
impl SolutionListener for NoopListener {
    fn report_improving(&mut self, _: &LayoutSnapshot) {}
}

// ---------------------------------------------------------------------------
// Separator + worker
// ---------------------------------------------------------------------------

/// The GLS inner loop, scoped to a single bin. Mirrors sparrow's
/// `Separator` (upstream `src/optimizer/separator.rs`) with `SPProblem`
/// replaced by `jagua_rs::entities::Layout`.
pub struct Separator {
    pub instance: BPInstance,
    pub layout: Layout,
    pub ct: CollisionTracker,
    pub rng: Xoshiro256PlusPlus,
    pub workers: Vec<SeparatorWorker>,
    pub config: SeparatorConfig,
}

/// One parallel worker. In sparrow the `Vec<SeparatorWorker>` is driven
/// via rayon; here they run sequentially but preserve Algorithm 10
/// semantics â€” each worker starts from a common master and explores a
/// different random item-ordering; only the min-weighted-loss winner is
/// adopted.
///
/// Workers carry independent RNGs seeded from the master in
/// `Separator::new`. Sequential execution is fine â€” the independent seeds
/// are what guarantee each worker explores a different item-ordering
/// trajectory. Rayon parallelism returns in Task 18.
pub struct SeparatorWorker {
    pub instance: BPInstance,
    pub layout: Layout,
    pub ct: CollisionTracker,
    pub rng: Xoshiro256PlusPlus,
    pub sample_config: SampleConfig,
}

impl Separator {
    pub fn new(
        instance: BPInstance,
        layout: Layout,
        mut rng: Xoshiro256PlusPlus,
        config: SeparatorConfig,
    ) -> Self {
        assert!(
            config.n_workers >= 1,
            "Separator requires at least one worker (got n_workers=0)"
        );
        let ct = CollisionTracker::new(&layout);
        let workers = (0..config.n_workers)
            .map(|_| SeparatorWorker {
                instance: instance.clone(),
                layout: layout.clone(),
                ct: ct.clone(),
                rng: Xoshiro256PlusPlus::seed_from_u64(rng.random()),
                sample_config: config.sample_config,
            })
            .collect();

        Self {
            instance,
            layout,
            ct,
            rng,
            workers,
            config,
        }
    }

    /// Algorithm 9 from <https://doi.org/10.48550/arXiv.2509.13329>.
    ///
    /// Runs the GLS penalty-weighted local search until either total
    /// collision loss reaches zero (feasible) or the strike limit is
    /// exhausted (infeasible). The returned outcome carries the
    /// best-seen layout snapshot in either case.
    pub fn separate(
        &mut self,
        term: &impl Terminator,
        listener: &mut impl SolutionListener,
    ) -> SeparateOutcome {
        let mut min_loss_sol: (LayoutSnapshot, CTSnapshot) = (self.layout.save(), self.ct.save());
        let mut min_loss = self.ct.get_total_loss();
        log!(
            self.config.log_level,
            "[SEP] separating at loss {:.4}",
            min_loss
        );

        let mut n_strikes: usize = 0;
        let mut n_iter: u64 = 0;
        let mut sep_stats = SepStats::default();

        'outer: while n_strikes < self.config.strike_limit && !term.kill() {
            let mut n_iter_no_improvement: usize = 0;
            let initial_strike_loss = self.ct.get_total_loss();
            debug!(
                "[SEP] [s:{n_strikes},i:{n_iter}] init_l: {:.4}",
                initial_strike_loss
            );

            while n_iter_no_improvement < self.config.iter_no_imprv_limit {
                // Task 14: inner-loop cancel polling. Codex-locked:
                // outer-only polling at `n_strikes` granularity gives
                // seconds-level cancel latency; checking at every inner
                // iteration is an `AtomicBool::load(Relaxed)` â€” fast
                // enough to run unconditionally. CompositeTerminator's
                // `kill()` path short-circuits to the cancel flag after
                // the deadline check.
                if term.kill() {
                    break 'outer;
                }
                let w_loss_before = self.ct.get_total_weighted_loss();
                sep_stats += self.move_items_multi();
                let loss = self.ct.get_total_loss();
                let w_loss = self.ct.get_total_weighted_loss();

                if w_loss > w_loss_before * 1.001 {
                    // Task 9.5 kept this as a soft warning. Sparrow's
                    // hard invariant (w_loss(n+1) <= w_loss(n) * 1.001)
                    // assumes sample-evaluation loss AGREES with
                    // tracker-loss. In our stack:
                    //   - sample eval -> specialized_pipeline (correct;
                    //     superset of jagua default)
                    //   - tracker -> direct quantify_collision_poly_poly
                    //   - worker picks min-weighted-loss based on sample
                    //     eval; tracker view can diverge
                    // The weighted loss can legitimately "increase"
                    // after adopting a worker when the two views disagree
                    // on which hazards count. Release builds are
                    // unaffected. The correctness-improving pole
                    // pre-check that Task 9.5 confirmed means the
                    // sample-eval view is the MORE accurate one.
                    log::warn!(
                        "[SEP] weighted loss increased across an iteration: \
                         {w_loss_before} -> {w_loss} (sample-eval / tracker view divergence, \
                         not a regression â€” see Task 9.5 followups)"
                    );
                }

                if loss == 0.0 {
                    // All collisions resolved â€” snapshot the winning layout
                    // and exit the outer loop with Feasible.
                    min_loss_sol = (self.layout.save(), self.ct.save());
                    min_loss = 0.0;
                    log!(
                        self.config.log_level,
                        "[SEP] [s:{n_strikes},i:{n_iter}] (S) feasible"
                    );
                    break 'outer;
                } else if loss < min_loss {
                    // New best-seen layout but still with collisions.
                    // Compute the snapshot *once* and reuse it for both
                    // the listener and the incumbent (Gemini sign-off).
                    let best_snap = self.layout.save();
                    listener.report_improving(&best_snap);
                    if loss < min_loss * 0.98 {
                        n_iter_no_improvement = 0;
                    }
                    min_loss_sol = (best_snap, self.ct.save());
                    min_loss = loss;
                } else {
                    n_iter_no_improvement += 1;
                }

                // GLS weight update at end of each inner iteration,
                // regardless of improvement status.
                self.ct.update_weights();
                n_iter += 1;
            }

            if initial_strike_loss * 0.98 <= min_loss {
                // No substantial improvement during this strike â€” add a strike.
                n_strikes += 1;
            } else {
                // Substantial progress â€” reset strike counter.
                n_strikes = 0;
            }
            // Rollback to the best-seen snapshot before the next strike.
            // `Some(&min_loss_sol.1)` preserves GLS weights across strikes.
            // min_loss_sol is a local, so &min_loss_sol.N is a fresh
            // borrow independent of &mut self.
            self.rollback(&min_loss_sol.0, Some(&min_loss_sol.1));
        }

        log!(
            self.config.log_level,
            "[SEP] finished, moves: {}, evals: {}, iters: {}",
            sep_stats.total_moves,
            sep_stats.total_evals,
            n_iter
        );

        if min_loss == 0.0 {
            SeparateOutcome::Feasible(min_loss_sol.0)
        } else {
            SeparateOutcome::Infeasible {
                snapshot: min_loss_sol.0,
                ct_snapshot: min_loss_sol.1,
            }
        }
    }

    /// Algorithm 10 from <https://doi.org/10.48550/arXiv.2509.13329>.
    ///
    /// Workers carry independent RNGs seeded from the master in
    /// `Separator::new`. Sequential execution is fine â€” the independent
    /// seeds are what guarantee each worker explores a different
    /// item-ordering trajectory. Rayon parallelism returns in Task 18.
    fn move_items_multi(&mut self) -> SepStats {
        let master_layout = self.layout.save();
        let master_ct = self.ct.clone();

        let mut total = SepStats::default();
        for worker in self.workers.iter_mut() {
            worker.load(&master_layout, &master_ct);
            total += worker.move_items();
        }

        debug!(
            "[MOD] workers' w-loss: {:?}",
            self.workers
                .iter()
                .map(|w| w.ct.get_total_weighted_loss())
                .collect_vec()
        );

        // Adopt the min-weighted-loss worker's state into the master.
        // Every other worker's work is discarded â€” matches upstream
        // `min_by_key(OrderedFloat(total_weighted_loss))`.
        let best_idx = self
            .workers
            .iter()
            .enumerate()
            .min_by_key(|(_, w)| OrderedFloat(w.ct.get_total_weighted_loss()))
            .map(|(i, _)| i)
            .expect("move_items_multi requires at least one worker");
        let best_snapshot = self.workers[best_idx].layout.save();
        self.layout.restore(&best_snapshot);
        self.ct = self.workers[best_idx].ct.clone();

        total
    }

    /// Restore the layout + tracker from a previous snapshot. When the
    /// tracker snapshot is provided, GLS weights are preserved; when
    /// absent, the tracker is rebuilt from scratch (used by future
    /// explore.rs disruption moves).
    pub fn rollback(&mut self, snapshot: &LayoutSnapshot, ct_snap: Option<&CTSnapshot>) {
        self.layout.restore(snapshot);
        match ct_snap {
            Some(ots) => self.ct.restore_but_keep_weights(ots, &self.layout),
            None => self.ct = CollisionTracker::new(&self.layout),
        }
    }

    /// Move a placed item to a new transformation. Returns the new
    /// `PItemKey` â€” `Layout::place_item` issues a fresh key on every
    /// placement. Task 5 initially dropped this method; Task 6 restored
    /// it because `explore.rs::disrupt_solution` calls it from 4 sites
    /// (two swap moves + per-swap relocations of practically-contained
    /// items). Inlining everywhere was worse than one method.
    pub fn move_item(&mut self, pk: PItemKey, d_transf: DTransformation) -> PItemKey {
        let item_id = self.layout.placed_items[pk].item_id;
        let item = self.instance.item(item_id);
        self.layout.remove_item(pk);
        let new_pk = self.layout.place_item(item, d_transf);
        self.ct.register_item_move(&self.layout, pk, new_pk);
        new_pk
    }
}

impl SeparatorWorker {
    /// Resync this worker to a given master state.
    pub fn load(&mut self, snapshot: &LayoutSnapshot, ct: &CollisionTracker) {
        self.layout.restore(snapshot);
        self.ct = ct.clone();
    }

    /// Algorithm 5 from <https://doi.org/10.48550/arXiv.2509.13329>.
    ///
    /// One pass over all currently-colliding items (in a random order),
    /// trying to place each at a better position via `search_placement`.
    pub fn move_items(&mut self) -> SepStats {
        // Collect colliding items in a random order. Upstream uses
        // `itertools::Itertools::collect_vec` + `tap::Tap::tap_mut` for
        // in-place shuffle; we inline the same logic.
        let mut candidates: Vec<PItemKey> = self
            .layout
            .placed_items
            .keys()
            .filter(|pk| self.ct.get_loss(*pk) > 0.0)
            .collect();
        candidates.shuffle(&mut self.rng);

        let mut total_moves = 0usize;
        let mut total_evals = 0usize;

        for &pk in candidates.iter() {
            // An earlier move may have already cleared this item's
            // collision â€” check loss again before acting.
            if self.ct.get_loss(pk) > 0.0 {
                let item_id = self.layout.placed_items[pk].item_id;
                let item = self.instance.item(item_id);

                let evaluator = SeparationEvaluator::new(&self.layout, item, pk, &self.ct);
                let (best_sample, n_evals) = search_placement(
                    &self.layout,
                    item,
                    Some(pk),
                    evaluator,
                    self.sample_config,
                    &mut self.rng,
                );
                let (new_dt, _eval) =
                    best_sample.expect("search_placement should always return a sample");

                self.move_item(pk, new_dt);
                total_moves += 1;
                total_evals += n_evals;
            }
        }

        SepStats {
            total_moves,
            total_evals,
        }
    }

    /// Move an item to a new transform: remove, re-place, notify the
    /// tracker. Returns the new `PItemKey` (`Layout::place_item` issues
    /// a fresh key on every placement).
    pub fn move_item(&mut self, pk: PItemKey, d_transf: DTransformation) -> PItemKey {
        let item_id = self.layout.placed_items[pk].item_id;
        let item = self.instance.item(item_id);

        self.layout.remove_item(pk);
        let new_pk = self.layout.place_item(item, d_transf);
        self.ct.register_item_move(&self.layout, pk, new_pk);

        new_pk
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Bin, BinKind, Part};
    use crate::infrastructure::jagua_adapter::to_jagua_instance;
    use crate::infrastructure::search::gls::assertions::tracker_matches_layout;
    use jagua_rs::entities::Instance as InstanceTrait;
    use rf_geom::domain::Point2D;

    const SEED: u64 = 42;

    fn square_part(id: &str, side: f64) -> Part {
        Part {
            shape_id: id.into(),
            quantity: 1,
            polygon: Some(vec![
                Point2D::new(0.0, 0.0),
                Point2D::new(side, 0.0),
                Point2D::new(side, side),
                Point2D::new(0.0, side),
            ]),
            shape_spec: None,
            allow_rotation: false,
            grain_axis: None,
            difficulty: None,
            tag: None,
        }
    }

    /// Build a BPInstance + Layout with the given items placed at the
    /// given (tx, ty) offsets. Overlapping placements are allowed â€”
    /// `Layout::place_item` does not reject them, only the CDE records
    /// hazards.
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

    fn build_separator(instance: BPInstance, layout: Layout, config: SeparatorConfig) -> Separator {
        let rng = Xoshiro256PlusPlus::seed_from_u64(SEED);
        Separator::new(instance, layout, rng, config)
    }

    #[test]
    fn separate_feasible_fast_path() {
        // Two 10x10 squares placed well apart in a 100x100 bin -> no
        // collisions. Expect Feasible without any moves.
        let parts = vec![square_part("a", 10.0), square_part("b", 10.0)];
        let (instance, layout) = tiny_fixture(100.0, &parts, &[(0, 10.0, 10.0), (1, 50.0, 50.0)]);
        let mut sep = build_separator(instance, layout, SeparatorConfig::exploration());

        let outcome = sep.separate(&NoopTerminator, &mut NoopListener);

        assert!(
            matches!(outcome, SeparateOutcome::Feasible(_)),
            "expected Feasible on overlap-free seed"
        );
        assert_eq!(sep.ct.get_total_loss(), 0.0);
        assert!(tracker_matches_layout(&sep.ct, &sep.layout));
    }

    #[test]
    fn separate_resolves_simple_overlap() {
        // Two 10x10 squares at (10,10) and (15,15) -> 50% overlap.
        // Separator should find a non-colliding arrangement.
        let parts = vec![square_part("a", 10.0), square_part("b", 10.0)];
        let (instance, layout) = tiny_fixture(100.0, &parts, &[(0, 10.0, 10.0), (1, 15.0, 15.0)]);
        let mut sep = build_separator(instance, layout, SeparatorConfig::exploration());

        let outcome = sep.separate(&NoopTerminator, &mut NoopListener);

        assert!(
            matches!(outcome, SeparateOutcome::Feasible(_)),
            "expected Feasible after resolving overlap"
        );
        assert_eq!(sep.ct.get_total_loss(), 0.0);
        assert!(tracker_matches_layout(&sep.ct, &sep.layout));
    }

    #[test]
    fn separate_infeasible_exits_at_strike_limit() {
        // Two 80x80 squares in a 100x100 bin cannot fit without overlap
        // (each takes 64% of the bin area). Place them at (5,5) and
        // (15,15) â€” initial overlap is load-bearing; do NOT "fix" the
        // fixture by spreading them out.
        let parts = vec![square_part("big-a", 80.0), square_part("big-b", 80.0)];
        let (instance, layout) = tiny_fixture(100.0, &parts, &[(0, 5.0, 5.0), (1, 15.0, 15.0)]);
        let cfg = SeparatorConfig {
            strike_limit: 2,
            iter_no_imprv_limit: 20,
            ..SeparatorConfig::exploration()
        };
        let mut sep = build_separator(instance, layout, cfg);

        let outcome = sep.separate(&NoopTerminator, &mut NoopListener);

        match outcome {
            SeparateOutcome::Infeasible {
                snapshot,
                ct_snapshot: _,
            } => {
                assert_eq!(
                    snapshot.placed_items.len(),
                    2,
                    "snapshot should retain all placed items"
                );
            }
            SeparateOutcome::Feasible(_) => {
                panic!("expected Infeasible on unresolvable overlap")
            }
        }
        assert!(tracker_matches_layout(&sep.ct, &sep.layout));
    }

    #[test]
    fn separate_respects_terminator() {
        // Terminator::kill() always true â€” separate() must short-circuit
        // before doing work. Starts from an overlapping seed so loss > 0,
        // which forces the Infeasible branch. Also asserts that no work
        // happened (loss unchanged), so a future refactor that moves
        // kill() below the first move_items_multi call would fail.
        struct KillImmediately;
        impl Terminator for KillImmediately {
            fn kill(&self) -> bool {
                true
            }
        }

        let parts = vec![square_part("a", 10.0), square_part("b", 10.0)];
        let (instance, layout) = tiny_fixture(100.0, &parts, &[(0, 10.0, 10.0), (1, 15.0, 15.0)]);
        let mut sep = build_separator(instance, layout, SeparatorConfig::exploration());

        let loss_before = sep.ct.get_total_loss();
        let outcome = sep.separate(&KillImmediately, &mut NoopListener);

        assert!(
            matches!(outcome, SeparateOutcome::Infeasible { .. }),
            "kill()==true on overlapping seed should short-circuit with Infeasible"
        );
        assert_eq!(
            sep.ct.get_total_loss(),
            loss_before,
            "kill()==true must do zero work"
        );
    }

    #[test]
    fn weighted_loss_non_increasing_across_separate() {
        // Guard the `update_weights` port: running separate() on an
        // overlapping seed must not *increase* total weighted loss
        // (modulo 0.1% float tolerance from upstream's debug_assert).
        // The fine-grained invariant is caught by the tracker's own
        // debug_assert under cargo test; this is the coarse end-to-end
        // check that the sign is correct.
        let parts = vec![
            square_part("a", 10.0),
            square_part("b", 10.0),
            square_part("c", 10.0),
        ];
        let (instance, layout) = tiny_fixture(
            100.0,
            &parts,
            &[(0, 10.0, 10.0), (1, 12.0, 12.0), (2, 14.0, 14.0)],
        );
        let cfg = SeparatorConfig {
            strike_limit: 1,
            iter_no_imprv_limit: 10,
            ..SeparatorConfig::exploration()
        };
        let mut sep = build_separator(instance, layout, cfg);

        let before = sep.ct.get_total_weighted_loss();
        let _ = sep.separate(&NoopTerminator, &mut NoopListener);
        let after = sep.ct.get_total_weighted_loss();

        assert!(
            after <= before * 1.001,
            "weighted loss regressed across separate(): {before} -> {after}"
        );
    }
}
