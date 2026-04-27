// engine/crates/rf-layout/src/infrastructure/search/gls/consts.rs
//
// Ported from sparrow's `src/consts.rs` (MIT, Copyright 2025 Jeroen Gardeyn,
// KU Leuven). Only the GLS / quantify subset is carried over — logging,
// SVG draw options, and sample-config constants are dropped because we
// don't ship an SVG debugger or a preconfigured lbf sampler yet.

/// Maximum per-update multiplier on pair/container weights when a
/// collision is observed (the "bad" end of the range).
pub const GLS_WEIGHT_MAX_INC_RATIO: f32 = 2.0;

/// Minimum per-update multiplier when a collision is observed.
pub const GLS_WEIGHT_MIN_INC_RATIO: f32 = 1.2;

/// Per-update decay applied when no collision is present, pushing the
/// weight back toward 1.0.
pub const GLS_WEIGHT_DECAY: f32 = 0.95;

/// Epsilon factor (as a fraction of the larger of two shapes' diameters)
/// used to avoid zero-overlap degenerate cases in `quantify_collision_poly_poly`.
pub const OVERLAP_PROXY_EPSILON_DIAM_RATIO: f32 = 0.01;

/// Coordinate descent step multiplier on success.
pub const CD_STEP_SUCCESS: f32 = 1.1;

/// Coordinate descent step multiplier on failure.
pub const CD_STEP_FAIL: f32 = 0.5;

/// Ratio of the item's min dimension to be used as initial and limit step
/// size for the first refinement.
pub const PRE_REFINE_CD_TL_RATIOS: (f32, f32) = (0.25, 0.02);

/// Step sizes for rotation in the first refinement.
pub const PRE_REFINE_CD_R_STEPS: (f32, f32) = (f32::to_radians(5.0), f32::to_radians(1.0));

/// Ratio of the item's min dimension to be used as initial and limit step
/// size for the second (final) refinement.
pub const SND_REFINE_CD_TL_RATIOS: (f32, f32) = (0.01, 0.001);

/// Step sizes for rotation in the second (final) refinement.
pub const SND_REFINE_CD_R_STEPS: (f32, f32) = (f32::to_radians(0.5), f32::to_radians(0.05));

/// If two samples are closer than this ratio of the item's min dimension,
/// they are considered duplicates.
pub const UNIQUE_SAMPLE_THRESHOLD: f32 = 0.05;
