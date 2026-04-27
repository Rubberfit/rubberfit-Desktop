// engine/crates/rf-layout/src/infrastructure/search/multi.rs
//
// Task 12: multi-bin orchestrator (`optimize_multi`).
//
// Weaves Task 10's FFD assignment, Task 11's cross-bin swap operators,
// and Task 5-8's per-bin GLS into a unified multi-bin search loop.
// `pack.rs` becomes a thin result aggregator after this lands.
//
// Scope choice â€” "batch mode" (Codex-flagged trade-off): sparrow's
// `Separator::separate` owns its strike/iteration state as locals
// and is NOT resumable mid-loop. Rather than refactor Separator to
// expose a resumable `step()` (which would be a 2-3 task scope),
// Task 12 runs each round as:
//   1. Optimize every non-empty bin to strike-limit via a fresh
//      `search::optimize` call.
//   2. Apply operator ladder (unload â†’ migrate â†’ swap).
//   3. Repeat until operators exhaust or budget runs out.
//
// This trades fine-grained iteration interleaving for implementation
// simplicity. Task 13+ can upgrade to iteration-level sessions if
// benchmarks demand it.
//
// Codex-locked invariants (from .claude/research/task12/codex-signoff.md):
//   - Single-bin fast path bypasses the whole orchestrator â†’ Task 9 parity preserved.
//   - Positional RNG consumption: one `next_u64()` per bin index per round, even
//     for empty bins, to keep the RNG stream bit-identical regardless of which
//     bins are populated.
//   - Lifetime per-bin quota accumulation (no quota re-grant per round).
//   - Exp back-off on no-op operator ticks; terminate on consecutive no-op ticks.
//   - Unload runs once per operator tick, outside the pair loop.
//   - Request-order items preserved across rebuilds (via `items_for_seed`).
//
// See plan: docs/superpowers/plans/2026-04-18-s2.5-task12-orchestrator.md.

use super::assignment::cross_bin_swap::{
    consolidate_tail_bin, migrate, swap_two, unload_lightest_bin,
};
use super::assignment::ffd::FfdAssignment;
use super::cancel::{is_cancelled, CancelToken};
use super::progress::ProgressEmitter;
use crate::domain::{PackError, PackRequest, Part};
use crate::infrastructure::search::optimize as optimize_single;
use crate::infrastructure::search::OptimizerConfig;
use crate::infrastructure::warm_start::SeedResult;
use rand::{RngExt, SeedableRng};
use rand_xoshiro::Xoshiro256PlusPlus;
use std::collections::HashMap;
use std::time::Instant;

// Task 18 tuning findings (see
// `docs/superpowers/benchmarks/2026-04-18-s2.5-results.md`):
//
// Raising MAX_ROUNDS to 60 / MAX_OPERATOR_GAP to 16 /
// TERMINATION_NOOP_TICKS to 8 produced ZERO density lift on all 9
// RF parity fixtures Ã— 3 modes Ã— 2 seeds. The operators
// (swap_two, migrate, unload_lightest_bin) return Ok(None) on the
// first tick â€” FFD's initial assignment is already Pareto-optimal
// under the lex score `(closed_bins, concentration)` for this
// fixture family, so no amount of extra rounds changes the outcome.
//
// Kept at conservative defaults to minimize worst-case wall-clock
// on fixtures where operators genuinely iterate (future work /
// larger fixtures that aren't in the RF parity set).
const MAX_ROUNDS: usize = 20;
const MAX_OPERATOR_GAP: usize = 8;
const TERMINATION_NOOP_TICKS: usize = 3;

/// Output of `optimize_multi_with_hooks`.
///
/// `was_cancelled = true` means the caller's cancel token flipped
/// before search completed. `assignment` carries best-so-far state
/// regardless. Callers (pack.rs) propagate `was_cancelled` into the
/// public `PackResult`.
pub struct OptimizeMultiOutcome {
    pub assignment: FfdAssignment,
    pub was_cancelled: bool,
}

/// Multi-bin search orchestrator (no-hooks entry point).
///
/// Takes an initial assignment (typically from `ffd_assign`) and
/// refines it in-place. Returns the final `FfdAssignment` ready for
/// `pack.rs` to aggregate into a `PackResult`.
pub fn optimize_multi(
    assignment: FfdAssignment,
    request: &PackRequest,
) -> Result<FfdAssignment, PackError> {
    let outcome = optimize_multi_with_hooks(assignment, request, None, None)?;
    Ok(outcome.assignment)
}

/// Multi-bin search orchestrator with progress + cancel hooks
/// (Task 14). Called from `pack_with_options`.
///
/// Cancel token is polled at round boundaries + between bins + before
/// the operator ladder + inside Separator's inner loop via
/// `CompositeTerminator`. Latency is bounded by the slowest of those
/// checkpoints.
pub fn optimize_multi_with_hooks(
    assignment: FfdAssignment,
    request: &PackRequest,
    cancel: Option<CancelToken>,
    mut emitter: Option<ProgressEmitter>,
) -> Result<OptimizeMultiOutcome, PackError> {
    let n_bins = request.bins.len();
    let total_budget_ms = request.resolved_time_budget_ms();
    let t0 = Instant::now();
    let global_deadline = t0 + std::time::Duration::from_millis(total_budget_ms);

    // Emit baseline progress frame before any work.
    if let Some(ref mut em) = emitter {
        em.emit_baseline(&assignment, &request.bins, &request.items, "explore");
    }

    // Early-cancel check â€” if token is already set, return immediately
    // with the FFD-only assignment as the best-so-far result.
    if is_cancelled(cancel.as_ref()) {
        return Ok(OptimizeMultiOutcome {
            assignment,
            was_cancelled: true,
        });
    }

    // Single-bin fast path â€” bypass the entire orchestrator. Task 9
    // parity fixtures depend on this delegating to today's `optimize`
    // semantics without instantiating orch RNG, round counters, or
    // operator scheduling.
    if n_bins <= 1 {
        let refined =
            optimize_single_bin_fast_path(assignment, request, total_budget_ms, cancel.as_ref())?;
        // Offer a final progress frame in case single-bin refined.
        if let Some(ref mut em) = emitter {
            em.offer(&refined, &request.bins, &request.items, "explore");
        }
        return Ok(OptimizeMultiOutcome {
            assignment: refined,
            was_cancelled: is_cancelled(cancel.as_ref()),
        });
    }

    let per_bin_quota_ms = total_budget_ms / (n_bins as u64);
    let mut gls_spent_ms: Vec<u64> = vec![0; n_bins];
    let seed = request.seed.unwrap_or(0x5E5A_5EA1_BEEF_CAFE);
    let mut orch_rng = Xoshiro256PlusPlus::seed_from_u64(seed);

    let mut cur = assignment;
    let mut operator_gap: usize = 1;
    let mut rounds_until_next_operator: usize = 0;
    let mut consecutive_noop_operator_ticks: usize = 0;

    for _round in 0..MAX_ROUNDS {
        // Phase A: optimize every bin slot (empty bins still consume
        // their RNG slot for positional determinism).
        cur = optimize_all_bins(
            cur,
            request,
            per_bin_quota_ms,
            &mut gls_spent_ms,
            global_deadline,
            &mut orch_rng,
            cancel.as_ref(),
        )?;

        // Offer a monotonic progress frame after each round's bin pass.
        if let Some(ref mut em) = emitter {
            em.offer(&cur, &request.bins, &request.items, "explore");
        }

        if Instant::now() >= global_deadline {
            return Ok(OptimizeMultiOutcome {
                assignment: cur,
                was_cancelled: is_cancelled(cancel.as_ref()),
            });
        }

        // Cancel check between rounds â€” Codex-locked: short-circuit
        // BEFORE mutating back-off state.
        if is_cancelled(cancel.as_ref()) {
            return Ok(OptimizeMultiOutcome {
                assignment: cur,
                was_cancelled: true,
            });
        }

        // Phase B: operator ladder gated by back-off countdown.
        if rounds_until_next_operator > 0 {
            rounds_until_next_operator -= 1;
            continue;
        }

        match apply_operator_ladder(&cur, request, cancel.as_ref())? {
            Some(next) => {
                cur = next;
                if let Some(ref mut em) = emitter {
                    em.offer(&cur, &request.bins, &request.items, "explore");
                }
                consecutive_noop_operator_ticks = 0;
                operator_gap = 1;
                rounds_until_next_operator = 0;
            }
            None => {
                // Codex sign-off Â§3: if cancel fired during the ladder,
                // it short-circuits `apply_operator_ladder` with
                // `Some(cur)` (unchanged) â€” we detect the flag here
                // and skip the no-op back-off mutation.
                if is_cancelled(cancel.as_ref()) {
                    return Ok(OptimizeMultiOutcome {
                        assignment: cur,
                        was_cancelled: true,
                    });
                }
                consecutive_noop_operator_ticks += 1;
                if consecutive_noop_operator_ticks >= TERMINATION_NOOP_TICKS {
                    return Ok(OptimizeMultiOutcome {
                        assignment: cur,
                        was_cancelled: false,
                    });
                }
                operator_gap = (operator_gap.saturating_mul(2)).min(MAX_OPERATOR_GAP);
                rounds_until_next_operator = operator_gap.saturating_sub(1);
            }
        }
    }

    Ok(OptimizeMultiOutcome {
        assignment: cur,
        was_cancelled: is_cancelled(cancel.as_ref()),
    })
}

fn optimize_single_bin_fast_path(
    mut assignment: FfdAssignment,
    request: &PackRequest,
    total_budget_ms: u64,
    _cancel: Option<&CancelToken>,
) -> Result<FfdAssignment, PackError> {
    if assignment.per_bin.is_empty() {
        return Ok(assignment);
    }
    let bin_idx = 0;
    let seed = &assignment.per_bin[bin_idx];
    if seed.placements.is_empty() {
        return Ok(assignment);
    }
    let items_for_bin = items_for_seed(seed, &request.items);
    let cfg = OptimizerConfig {
        time_budget_ms: total_budget_ms,
        improvement_budget_ms: request.improvement_budget_ms,
        seed: request.seed,
        bin: request.bins[bin_idx].clone(),
        items: items_for_bin,
        clearance: request.clearance,
        cancel_token: _cancel.cloned(),
    };
    let refined = optimize_single(seed.clone(), cfg)?;
    assignment.per_bin[bin_idx] = refined;
    Ok(assignment)
}

fn optimize_all_bins(
    mut assignment: FfdAssignment,
    request: &PackRequest,
    per_bin_quota_ms: u64,
    gls_spent_ms: &mut [u64],
    global_deadline: Instant,
    orch_rng: &mut Xoshiro256PlusPlus,
    cancel: Option<&CancelToken>,
) -> Result<FfdAssignment, PackError> {
    let n_bins = request.bins.len();
    #[allow(clippy::needless_range_loop)]
    for bin_idx in 0..n_bins {
        // Positional RNG draw â€” runs for every bin regardless of
        // whether we actually optimize it. Codex-locked.
        let bin_seed: u64 = orch_rng.random();

        if Instant::now() >= global_deadline {
            continue;
        }
        // Cancel check between bins (Codex plan Â§4).
        if is_cancelled(cancel) {
            continue;
        }
        if assignment.per_bin[bin_idx].placements.is_empty() {
            continue;
        }

        let bin_remaining = per_bin_quota_ms.saturating_sub(gls_spent_ms[bin_idx]);
        if bin_remaining == 0 {
            continue;
        }
        let now = Instant::now();
        if now >= global_deadline {
            continue;
        }
        let global_remaining_ms = (global_deadline - now).as_millis() as u64;
        let slice_ms = bin_remaining.min(global_remaining_ms);
        if slice_ms == 0 {
            continue;
        }

        let items_for_bin = items_for_seed(&assignment.per_bin[bin_idx], &request.items);
        let cfg = OptimizerConfig {
            time_budget_ms: slice_ms,
            improvement_budget_ms: request.improvement_budget_ms,
            seed: Some(bin_seed),
            bin: request.bins[bin_idx].clone(),
            items: items_for_bin,
            clearance: request.clearance,
            cancel_token: cancel.cloned(),
        };

        let call_start = Instant::now();
        let refined = optimize_single(assignment.per_bin[bin_idx].clone(), cfg)?;
        let actual_ms = call_start.elapsed().as_millis() as u64;
        gls_spent_ms[bin_idx] = gls_spent_ms[bin_idx].saturating_add(actual_ms);

        assignment.per_bin[bin_idx] = refined;
    }
    Ok(assignment)
}

fn apply_operator_ladder(
    assignment: &FfdAssignment,
    request: &PackRequest,
    cancel: Option<&CancelToken>,
) -> Result<Option<FfdAssignment>, PackError> {
    let n_bins = request.bins.len();
    let bins = &request.bins;
    let items = &request.items;
    let clearance = request.clearance;

    // Cancel check before unload (Codex plan Â§4: between operator stages).
    if is_cancelled(cancel) {
        return Ok(None);
    }

    // 1. unload â€” one-shot, scans all bins internally.
    if let Some(new) = unload_lightest_bin(assignment, bins, items, clearance)? {
        return Ok(Some(new));
    }
    if is_cancelled(cancel) {
        return Ok(None);
    }

    // 2. consolidate_tail_bin (Tier 6) â€” post-unload repair for 2-bin
    // jobs with collapsed tails. No-op on everything else (gated
    // internally), so parity-safe for the 9 existing fixtures.
    if let Some(new) = consolidate_tail_bin(assignment, bins, items, clearance)? {
        return Ok(Some(new));
    }
    if is_cancelled(cancel) {
        return Ok(None);
    }

    // 3. migrate â€” try both directions per bin pair.
    for a in 0..n_bins {
        for b in (a + 1)..n_bins {
            if is_cancelled(cancel) {
                return Ok(None);
            }
            if let Some(new) = migrate(assignment, a, b, None, bins, items, clearance)? {
                return Ok(Some(new));
            }
            if let Some(new) = migrate(assignment, b, a, None, bins, items, clearance)? {
                return Ok(Some(new));
            }
        }
    }
    if is_cancelled(cancel) {
        return Ok(None);
    }

    // 4. swap_two â€” pair enumeration.
    for a in 0..n_bins {
        for b in (a + 1)..n_bins {
            if is_cancelled(cancel) {
                return Ok(None);
            }
            if let Some(new) = swap_two(assignment, a, b, bins, items, clearance)? {
                return Ok(Some(new));
            }
        }
    }

    Ok(None)
}

/// Reconstruct the `Vec<Part>` subset routed to a single bin from that
/// bin's seed placements. Collapses per-shape counts into one Part
/// each (duplicate shape_id rows break `replay_seed_into_layout`'s
/// precondition at search/mod.rs:144). Part order follows the input
/// `request.items` order for determinism (Codex-locked).
fn items_for_seed(seed: &SeedResult, original: &[Part]) -> Vec<Part> {
    if seed.placements.is_empty() {
        return Vec::new();
    }
    let mut counts: HashMap<&str, u32> = HashMap::new();
    for p in &seed.placements {
        *counts.entry(p.shape_id.as_str()).or_insert(0) += 1;
    }
    original
        .iter()
        .filter_map(|part| {
            counts.get(part.shape_id.as_str()).map(|qty| Part {
                shape_id: part.shape_id.clone(),
                quantity: *qty,
                polygon: part.polygon.clone(),
                shape_spec: part.shape_spec.clone(),
                allow_rotation: part.allow_rotation,
                grain_axis: part.grain_axis,
                difficulty: part.difficulty,
                tag: part.tag.clone(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Bin, BinKind, PackMode};
    use crate::infrastructure::search::assignment::ffd::ffd_assign;
    use rf_geom::domain::Point2D;

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

    fn test_request(bins: Vec<Bin>, items: Vec<Part>) -> PackRequest {
        PackRequest {
            bins,
            clearance: 0.0,
            items,
            operator_profile: None,
            mode: Some(PackMode::Fast),
            engine: None,
            time_budget_ms: Some(200),
            improvement_budget_ms: None,
            seed: Some(42),
            units: Default::default(),
            cone_strategy: None,
            cone_packing_mode: None,
            scrap_strategy: None,
            offcut_extraction_strategy: None,
            use_warm_start: None,
        }
    }

    #[test]
    fn optimize_multi_single_bin_matches_optimize() {
        // n_bins=1 fast path must produce the SAME result as calling
        // `optimize()` directly with the same seed and items.
        let req = test_request(
            vec![bin("A", 48.0, 96.0)],
            vec![rect_part("r", 3, 10.0, 5.0)],
        );
        let asn = ffd_assign(&req.bins, &req.items, 0.0).unwrap();

        // Direct single-bin path.
        let via_multi = optimize_multi(asn.clone(), &req).unwrap();

        // Reference: what today's `optimize` would produce for the same
        // seed/budget/items.
        let items_for_bin = items_for_seed(&asn.per_bin[0], &req.items);
        let cfg = OptimizerConfig {
            time_budget_ms: 200,
            improvement_budget_ms: None,
            seed: Some(42),
            bin: req.bins[0].clone(),
            items: items_for_bin,
            clearance: 0.0,
            cancel_token: None,
        };
        let via_direct = optimize_single(asn.per_bin[0].clone(), cfg).unwrap();

        assert_eq!(
            via_multi.per_bin[0].placements.len(),
            via_direct.placements.len()
        );
        // Per-placement identity: bit-identical bin_id + (x, y) pairs.
        for (a, b) in via_multi.per_bin[0]
            .placements
            .iter()
            .zip(via_direct.placements.iter())
        {
            assert_eq!(a.shape_id, b.shape_id);
            assert_eq!(a.bin_id, b.bin_id);
            assert!((a.x - b.x).abs() < 1e-9);
            assert!((a.y - b.y).abs() < 1e-9);
        }
    }

    #[test]
    fn optimize_multi_terminates_on_budget() {
        let mut req = test_request(
            vec![bin("A", 30.0, 30.0), bin("B", 30.0, 30.0)],
            vec![rect_part("r", 4, 10.0, 10.0)],
        );
        req.time_budget_ms = Some(100);
        let asn = ffd_assign(&req.bins, &req.items, 0.0).unwrap();
        let t0 = Instant::now();
        let _ = optimize_multi(asn, &req).unwrap();
        let elapsed = t0.elapsed().as_millis();
        // Generous ceiling â€” termination is cooperative but should be
        // well under 10Ã— the budget.
        assert!(
            elapsed < 5_000,
            "optimize_multi exceeded 5s with 100ms budget (elapsed: {}ms)",
            elapsed
        );
    }

    #[test]
    fn optimize_multi_determinism_under_fixed_seed() {
        let req = test_request(
            vec![bin("A", 30.0, 30.0), bin("B", 30.0, 30.0)],
            vec![rect_part("r", 4, 10.0, 10.0), rect_part("s", 2, 5.0, 5.0)],
        );
        let asn = ffd_assign(&req.bins, &req.items, 0.0).unwrap();
        let r1 = optimize_multi(asn.clone(), &req).unwrap();
        let r2 = optimize_multi(asn, &req).unwrap();
        let key = |a: &FfdAssignment| {
            a.per_bin
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
        assert_eq!(key(&r1), key(&r2), "bit-identical output under fixed seed");
    }

    #[test]
    fn optimize_multi_preserves_cardinality() {
        let req = test_request(
            vec![bin("A", 40.0, 40.0), bin("B", 40.0, 40.0)],
            vec![rect_part("a", 3, 10.0, 10.0), rect_part("b", 2, 15.0, 10.0)],
        );
        let total_requested: u32 = req.items.iter().map(|p| p.quantity).sum();
        let asn = ffd_assign(&req.bins, &req.items, 0.0).unwrap();
        let refined = optimize_multi(asn, &req).unwrap();
        let placed: u32 = refined
            .per_bin
            .iter()
            .map(|b| b.placements.len() as u32)
            .sum();
        let spilled: u32 = refined.overflow.iter().map(|(_, n)| *n).sum();
        assert_eq!(
            placed + spilled,
            total_requested,
            "cardinality must be preserved"
        );
    }

    #[test]
    fn optimize_multi_exp_backoff_terminates() {
        // Simple fixture where operators have no useful move â€” loop
        // should terminate via back-off, not run to MAX_ROUNDS.
        let mut req = test_request(
            vec![bin("A", 30.0, 30.0), bin("B", 30.0, 30.0)],
            vec![rect_part("r", 2, 10.0, 10.0)],
        );
        req.time_budget_ms = Some(2000);
        let asn = ffd_assign(&req.bins, &req.items, 0.0).unwrap();
        let t0 = Instant::now();
        let _ = optimize_multi(asn, &req).unwrap();
        // Back-off should kick in quickly; exit well under budget.
        assert!(
            t0.elapsed().as_millis() < 1_500,
            "exp back-off should exit early when operators can't improve"
        );
    }

    #[test]
    fn optimize_multi_handles_empty_bins_positionally() {
        // Add an extra bin that FFD won't populate. RNG draws must
        // still be positional; the test here just verifies the run
        // completes successfully with an empty bin in the slot.
        let req = test_request(
            vec![
                bin("A", 30.0, 30.0),
                bin("B", 30.0, 30.0),
                bin("C", 5.0, 5.0), // too small for any item
            ],
            vec![rect_part("r", 2, 10.0, 10.0)],
        );
        let asn = ffd_assign(&req.bins, &req.items, 0.0).unwrap();
        // C should be empty after FFD.
        assert_eq!(asn.per_bin[2].placements.len(), 0);
        let refined = optimize_multi(asn, &req).unwrap();
        assert_eq!(refined.per_bin.len(), 3);
    }
}
