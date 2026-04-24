// engine/crates/rf-layout/src/infrastructure/search/objective.rs
//
// Objective function for the GLS search. Defines what "better" means —
// used by accept/reject decisions inside explore and compress.
//
// Task 1: the scaffold + a BPP lexicographic default. Task 6 onwards:
// the GLS loop consults this when deciding whether to keep a candidate
// solution.

use super::state::SearchState;

/// A totally ordered objective on `SearchState`. Lower score = better.
pub trait Objective {
    fn score(&self, state: &SearchState) -> f64;

    /// Default comparator: `a` is better than `b` iff its score is
    /// strictly lower (ties treated as "not better").
    fn is_better(&self, a: &SearchState, b: &SearchState) -> bool {
        self.score(a) < self.score(b)
    }
}

/// Bin-packing objective: minimize (overflow, then waste).
///
/// Lexicographic encoding via scalar: overflow contributes the high bits
/// (weighted by a large multiplier), placed-count contributes the low bits.
/// The encoding is lexicographically faithful while `overflow_weight >
/// max_placed_count * |placed_weight|` — with default weights that is
/// `1e9 > placed * 1`, safe for any realistic fixture (cut-planner jobs
/// rarely exceed 10^4 placements).
///
/// At S2.5b, extend to favor filled bins over fragmented layouts via a
/// tertiary "active bin count" term.
#[derive(Clone, Debug)]
pub struct BppObjective {
    /// Large multiplier on overflow so any overflow improvement dominates
    /// any waste improvement. Defaults to 1e9.
    pub overflow_weight: f64,
    /// Tie-breaker weight on aggregate placed-item count. Negative so
    /// more placements lowers the score.
    pub placed_weight: f64,
}

impl Default for BppObjective {
    fn default() -> Self {
        BppObjective {
            overflow_weight: 1e9,
            placed_weight: -1.0,
        }
    }
}

impl Objective for BppObjective {
    fn score(&self, state: &SearchState) -> f64 {
        let overflow = state.total_overflow() as f64 * self.overflow_weight;
        let placed = state.total_placed() as f64 * self.placed_weight;
        overflow + placed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::warm_start::{SeedPlacement, SeedResult};

    fn seed_with(placed: usize, overflow: u32) -> SeedResult {
        SeedResult {
            placements: (0..placed)
                .map(|i| SeedPlacement {
                    shape_id: format!("s{i}"),
                    instance_index: 0,
                    bin_id: "b".into(),
                    x: 0.0,
                    y: 0.0,
                    rotation_rad: 0.0,
                    polygon: vec![],
                    width: 1.0,
                    height: 1.0,
                })
                .collect(),
            overflow,
        }
    }

    fn state(placed: usize, overflow: u32) -> SearchState {
        SearchState::from_single_bin(seed_with(placed, overflow))
    }

    #[test]
    fn fewer_overflow_is_always_better_than_more_placements() {
        let obj = BppObjective::default();
        let less_overflow = state(0, 0);
        let more_placed_but_overflow = state(1_000_000, 1);
        assert!(obj.is_better(&less_overflow, &more_placed_but_overflow));
    }

    #[test]
    fn with_equal_overflow_more_placed_wins() {
        let obj = BppObjective::default();
        let better = state(10, 2);
        let worse = state(9, 2);
        assert!(obj.is_better(&better, &worse));
    }

    #[test]
    fn identical_states_are_not_strictly_better() {
        let obj = BppObjective::default();
        let a = state(5, 1);
        let b = state(5, 1);
        assert!(!obj.is_better(&a, &b));
        assert!(!obj.is_better(&b, &a));
    }
}
