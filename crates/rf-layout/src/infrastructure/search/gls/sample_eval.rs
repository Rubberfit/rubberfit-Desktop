// engine/crates/rf-layout/src/infrastructure/search/gls/sample_eval.rs
//
// Ported from sparrow's `src/eval/sample_eval.rs` (MIT, Copyright 2025 Jeroen
// Gardeyn, KU Leuven). Verbatim — defines the `SampleEval` enum + total
// ordering used by BestSamples and the Separator to pick the best
// candidate transformation during GLS.

use jagua_rs::geometry::DTransformation;
use jagua_rs::util::FPA;
use std::cmp::Ordering;

use SampleEval::{Clear, Collision, Invalid};

#[derive(Clone, Debug, PartialEq, Copy)]
pub enum SampleEval {
    /// No collisions occur.
    Clear {
        loss: f32,
    },
    Collision {
        loss: f32,
    },
    Invalid,
}

impl PartialOrd for SampleEval {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for SampleEval {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Invalid, Invalid) => Ordering::Equal,
            (Invalid, _) => Ordering::Greater,
            (_, Invalid) => Ordering::Less,
            (Collision { .. }, Clear { .. }) => Ordering::Greater,
            (Clear { .. }, Collision { .. }) => Ordering::Less,
            (Collision { loss: l1 }, Collision { loss: l2 })
            | (Clear { loss: l1 }, Clear { loss: l2 }) => FPA(*l1).partial_cmp(&FPA(*l2)).unwrap(),
        }
    }
}

impl Eq for SampleEval {}

/// Simple trait for types that can evaluate samples.
pub trait SampleEvaluator {
    fn evaluate_sample(
        &mut self,
        dt: DTransformation,
        upper_bound: Option<SampleEval>,
    ) -> SampleEval;

    fn n_evals(&self) -> usize;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordering_invalid_is_worst() {
        assert!(SampleEval::Invalid > SampleEval::Collision { loss: 1e9 });
        assert!(SampleEval::Invalid > SampleEval::Clear { loss: 1e9 });
    }

    #[test]
    fn ordering_clear_beats_collision_regardless_of_loss() {
        assert!(SampleEval::Clear { loss: 9999.0 } < SampleEval::Collision { loss: 0.001 });
    }

    #[test]
    fn ordering_within_same_variant_by_loss() {
        assert!(SampleEval::Clear { loss: 1.0 } < SampleEval::Clear { loss: 2.0 });
        assert!(SampleEval::Collision { loss: 1.0 } < SampleEval::Collision { loss: 2.0 });
    }

    #[test]
    fn equal_evals_compare_equal() {
        assert_eq!(
            SampleEval::Clear { loss: 1.0 }.cmp(&SampleEval::Clear { loss: 1.0 }),
            Ordering::Equal
        );
    }
}
