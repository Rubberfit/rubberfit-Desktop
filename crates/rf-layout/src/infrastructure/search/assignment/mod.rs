// engine/crates/rf-layout/src/infrastructure/search/assignment/mod.rs
//
// Bin-assignment heuristics. Decides which items go to which bin
// BEFORE the per-bin GLS optimize runs.
//   - Task 10 shipped `ffd` (First-Fit-Decreasing).
//   - Task 11 adds `cross_bin_swap` (swap/migrate/unload operators).
//   - Future variants (BFD, shelf) slot in as siblings.

pub mod cross_bin_swap;
pub mod ffd;
