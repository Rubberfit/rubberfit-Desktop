// engine/crates/rf-layout/src/infrastructure/search/gls/mod.rs
//
// Guided Local Search machinery ported from sparrow (MIT, Jeroen Gardeyn,
// KU Leuven 2025, `ejor-snapshot` tag c95454e3).
//
// See <https://github.com/JeroenGar/sparrow/blob/ejor-snapshot/LICENSE> for
// the MIT license text reproduced in every ported file header below.
//
// Port scope:
//   Task 3: consts, overlap_proxy, pair_matrix, quantify, tracker.
//   Task 4: bit_reversal_iterator, assertions (replacing the task-3
//     matches_layout stub), sample_eval, specialized_pipeline,
//     sep_evaluator, best_samples, uniform_sampler, coord_descent,
//     sampling.
//   Task 5: separator (the inner loop workhorse).
//   Task 6: explore (penalty-weight phase).
//   Task 7 (this commit): compress — BPP adaptation is identity
//     pass-through; sparrow's strip-shrink has no fixed-bin analogue.
//
// Flattened directory layout: everything sparrow-derived lives under
// `search/gls/` regardless of whether upstream organised it under
// `src/util/`, `src/quantify/`, `src/eval/`, or `src/sample/`. This keeps
// MIT attribution headers in one place and makes cross-module refactors
// (expected during tasks 5-8) contained.

pub mod assertions;
pub mod best_samples;
pub mod bit_reversal_iterator;
pub mod compress;
pub mod consts;
pub mod coord_descent;
pub mod explore;
pub mod overlap_proxy;
pub mod pair_matrix;
pub mod quantify;
pub mod sample_eval;
pub mod sampling;
pub mod sep_evaluator;
pub mod separator;
pub mod specialized_pipeline;
pub mod tracker;
pub mod uniform_sampler;
