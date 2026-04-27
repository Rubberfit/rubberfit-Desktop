// engine/crates/rf-layout/src/infrastructure/search/state.rs
//
// Multi-bin incumbent state for the GLS search. Scaffolding for S2.5b;
// task 1 lands only the data shape so later tasks can wire against it
// without churning neighbors.

use crate::infrastructure::warm_start::{SeedPlacement, SeedResult};

/// Snapshot of the best layout the search has observed so far across one
/// or more bins. Grows across phases:
///   - Task 1: just a typed wrapper around `SeedResult` per bin.
///   - Task 12: becomes the authoritative incumbent consulted by cross-bin
///     swap operators.
#[derive(Clone, Debug, Default)]
pub struct SearchState {
    /// Per-bin placements + overflow, indexed positionally against the
    /// request's bin order. One entry per bin.
    pub per_bin: Vec<SeedResult>,
    /// Monotonically increasing iteration counter used by progress reports.
    pub iteration: u64,
    /// Wall-clock elapsed since `search::optimize` entered.
    pub elapsed_ms: u64,
}

impl SearchState {
    pub fn from_single_bin(seed: SeedResult) -> Self {
        SearchState {
            per_bin: vec![seed],
            iteration: 0,
            elapsed_ms: 0,
        }
    }

    /// Total placements across every bin in the incumbent.
    pub fn total_placed(&self) -> usize {
        self.per_bin.iter().map(|b| b.placements.len()).sum()
    }

    /// Total overflow across every bin.
    pub fn total_overflow(&self) -> u32 {
        self.per_bin.iter().map(|b| b.overflow).sum()
    }

    /// Flatten per-bin placements preserving bin order.
    pub fn all_placements(&self) -> Vec<SeedPlacement> {
        self.per_bin
            .iter()
            .flat_map(|b| b.placements.iter().cloned())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_seed(n_placed: usize, overflow: u32) -> SeedResult {
        SeedResult {
            placements: (0..n_placed)
                .map(|i| SeedPlacement {
                    shape_id: format!("s{i}"),
                    instance_index: 0,
                    bin_id: "b".into(),
                    x: i as f64,
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

    #[test]
    fn single_bin_wrap_reports_correct_totals() {
        let state = SearchState::from_single_bin(sample_seed(3, 2));
        assert_eq!(state.per_bin.len(), 1);
        assert_eq!(state.total_placed(), 3);
        assert_eq!(state.total_overflow(), 2);
    }

    #[test]
    fn multi_bin_sums_placements_and_overflow() {
        let state = SearchState {
            per_bin: vec![sample_seed(2, 1), sample_seed(3, 4)],
            iteration: 0,
            elapsed_ms: 0,
        };
        assert_eq!(state.total_placed(), 5);
        assert_eq!(state.total_overflow(), 5);
    }

    #[test]
    fn all_placements_preserves_bin_order() {
        let state = SearchState {
            per_bin: vec![sample_seed(2, 0), sample_seed(1, 0)],
            iteration: 0,
            elapsed_ms: 0,
        };
        let flat = state.all_placements();
        assert_eq!(flat.len(), 3);
        assert_eq!(flat[0].shape_id, "s0");
        assert_eq!(flat[1].shape_id, "s1");
        assert_eq!(flat[2].shape_id, "s0");
    }
}
