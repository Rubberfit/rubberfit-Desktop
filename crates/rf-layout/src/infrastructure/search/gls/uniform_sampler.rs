// engine/crates/rf-layout/src/infrastructure/search/gls/uniform_sampler.rs
//
// Ported from sparrow's `src/sample/uniform_sampler.rs` (MIT, Copyright
// 2025 Jeroen Gardeyn, KU Leuven).
//
// Deviations from upstream:
//   - `ndarray::Array::linspace` replaced by a manual linspace to avoid
//     pulling the `ndarray` crate into the workspace for a single call
//     that only ever produces 16 points.
//   - `rand_xoshiro::rand_core::Rng` import dropped; `rand::Rng` alone
//     is sufficient in rand 0.10.

use itertools::Itertools;
use jagua_rs::entities::Item;
use jagua_rs::geometry::geo_enums::RotationRange;
use jagua_rs::geometry::geo_traits::TransformableFrom;
use jagua_rs::geometry::primitives::Rect;
use jagua_rs::geometry::{normalize_rotation, DTransformation, Transformation};
use ordered_float::OrderedFloat;
use rand::prelude::IndexedRandom;
use rand::{Rng, RngExt};
use std::f32::consts::PI;
use std::ops::Range;

const ROT_N_SAMPLES: usize = 16; // number of rotations to sample for continuous rotation

/// A sampler that creates uniform samples for an item within a bounding box.
#[derive(Clone, Debug)]
pub struct UniformBBoxSampler {
    /// The list of possible rotations and their corresponding x and y ranges.
    rot_entries: Vec<RotEntry>,
}

#[derive(Clone, Debug)]
struct RotEntry {
    pub r: f32,
    pub x_range: Range<f32>,
    pub y_range: Range<f32>,
}

impl UniformBBoxSampler {
    pub fn new(sample_bbox: Rect, item: &Item, container_bbox: Rect) -> Option<Self> {
        let continuous_rot: Vec<f32>;
        let rotations: &Vec<f32> = match &item.allowed_rotation {
            RotationRange::None => &vec![0.0],
            RotationRange::Discrete(r) => r,
            RotationRange::Continuous => {
                // For continuous rotation, sample a set of rotations spaced
                // evenly over [0, 2pi). Upstream uses ndarray::Array::linspace;
                // we compute the same sequence inline.
                continuous_rot = linspace(0.0, 2.0 * PI, ROT_N_SAMPLES);
                &continuous_rot
            }
        };

        let mut shape_buffer = item.shape_cd.as_ref().clone();

        let sample_x_range = sample_bbox.x_min..sample_bbox.x_max;
        let sample_y_range = sample_bbox.y_min..sample_bbox.y_max;

        // For each possible rotation, calculate the sample ranges (x and y)
        // where the item resides fully inside the container and is within
        // the sample bounding box.
        let rot_entries = rotations
            .iter()
            .filter_map(|&r| {
                let r_shape_bbox = shape_buffer
                    .transform_from(item.shape_cd.as_ref(), &Transformation::from_rotation(r))
                    .bbox;

                // Narrow the container range to account for the rotated shape.
                let cont_x_range = (container_bbox.x_min - r_shape_bbox.x_min)
                    ..(container_bbox.x_max - r_shape_bbox.x_max);
                let cont_y_range = (container_bbox.y_min - r_shape_bbox.y_min)
                    ..(container_bbox.y_max - r_shape_bbox.y_max);

                // Intersect with the sample bbox.
                let x_range = intersect_range(&cont_x_range, &sample_x_range);
                let y_range = intersect_range(&cont_y_range, &sample_y_range);

                // Make sure the ranges are not empty.
                if x_range.is_empty() || y_range.is_empty() {
                    None
                } else {
                    Some(RotEntry {
                        r,
                        x_range,
                        y_range,
                    })
                }
            })
            .collect_vec();

        match rot_entries.is_empty() {
            true => None,
            false => Some(Self { rot_entries }),
        }
    }

    pub fn sample(&self, rng: &mut impl Rng) -> DTransformation {
        // Randomly select a rotation.
        let r_entry = self.rot_entries.choose(rng).unwrap();

        // Sample a random x and y value within the valid range.
        let r = r_entry.r;
        let x_sample = rng.random_range(r_entry.x_range.clone());
        let y_sample = rng.random_range(r_entry.y_range.clone());

        DTransformation::new(r, (x_sample, y_sample))
    }
}

fn intersect_range(a: &Range<f32>, b: &Range<f32>) -> Range<f32> {
    let min = f32::max(a.start, b.start);
    let max = f32::min(a.end, b.end);
    min..max
}

/// Matches `ndarray::Array::linspace(start, end, n)`: `n` evenly spaced
/// values from `start` to `end` inclusive. For `n == 0` returns empty;
/// for `n == 1` returns `[start]`.
fn linspace(start: f32, end: f32, n: usize) -> Vec<f32> {
    match n {
        0 => vec![],
        1 => vec![start],
        _ => {
            let step = (end - start) / (n as f32 - 1.0);
            (0..n).map(|i| start + step * i as f32).collect()
        }
    }
}

/// Converts a sample transformation to the closest feasible transformation
/// (for now just mapping rotation to the closest allowed one).
pub fn convert_sample_to_closest_feasible(dt: DTransformation, item: &Item) -> DTransformation {
    let feasible_rotation = match &item.allowed_rotation {
        RotationRange::None => 0.0,
        RotationRange::Discrete(v) => {
            // Find the closest rotation in the discrete set.
            v.iter()
                .min_by_key(|&&r| {
                    // Normalize the delta to the range [-PI, PI].
                    let norm_delta = normalize_rotation(dt.rotation() - r);
                    OrderedFloat(norm_delta.abs())
                })
                .cloned()
                .unwrap()
        }
        RotationRange::Continuous => {
            // For continuous rotation, we can just use the sample rotation.
            dt.rotation()
        }
    };
    DTransformation::new(feasible_rotation, dt.translation())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linspace_n_zero() {
        assert_eq!(linspace(0.0, 1.0, 0), Vec::<f32>::new());
    }

    #[test]
    fn linspace_n_one() {
        assert_eq!(linspace(5.0, 10.0, 1), vec![5.0]);
    }

    #[test]
    fn linspace_endpoints_match() {
        let v = linspace(0.0, 10.0, 5);
        assert_eq!(v.len(), 5);
        assert_eq!(v[0], 0.0);
        assert!((v[v.len() - 1] - 10.0).abs() < 1e-6);
    }

    #[test]
    fn linspace_even_spacing() {
        let v = linspace(0.0, 1.0, 5);
        let step = v[1] - v[0];
        for i in 2..v.len() {
            assert!((v[i] - v[i - 1] - step).abs() < 1e-6);
        }
    }
}
