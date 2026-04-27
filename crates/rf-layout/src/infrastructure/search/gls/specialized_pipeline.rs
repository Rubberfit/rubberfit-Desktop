// engine/crates/rf-layout/src/infrastructure/search/gls/specialized_pipeline.rs
//
// Ported from sparrow's `src/eval/specialized_jaguars_pipeline.rs` (MIT,
// Copyright 2025 Jeroen Gardeyn, KU Leuven).
//
// Fast custom collision-collection path with early termination + hazard-
// map-backed weighted-loss cache. Replaces the default
// `CDEngine::collect_poly_collisions` pass when the Separator knows a
// `loss_bound` above which the candidate will be rejected, so checking
// additional edges is wasted work.
//
// Deviations from upstream:
//   - SIMD feature (`#[cfg(feature = "simd")]` branches + `CirclesSoA`
//     + `quantify_collision_poly_poly_simd`) dropped. rf-layout ships a
//     single non-SIMD build; porting the SIMD variant buys no quality
//     and adds a nightly/portable_simd dependency.
//   - `crate::util::assertions` rewritten to `super::assertions`.

use super::assertions;
use super::bit_reversal_iterator::BitReversalIterator;
use super::quantify::{quantify_collision_poly_container, quantify_collision_poly_poly};
use super::tracker::CollisionTracker;
use float_cmp::approx_eq;
use jagua_rs::collision_detection::hazards::collector::HazardCollector;
use jagua_rs::collision_detection::hazards::{HazKey, HazardEntity};
use jagua_rs::collision_detection::quadtree::QTHazPresence;
use jagua_rs::collision_detection::CDEngine;
use jagua_rs::entities::Layout;
use jagua_rs::entities::PItemKey;
use jagua_rs::geometry::geo_traits::TransformableFrom;
use jagua_rs::geometry::primitives::SPolygon;
use jagua_rs::geometry::DTransformation;
use slotmap::SecondaryMap;
use std::f32::consts::PI;

/// Functionally identical to `CDEngine::collect_poly_collisions`, but with
/// early return. Collision collection stops as soon as the accumulated loss
/// exceeds the detector's `loss_bound` — saving ~90% of the CPU time spent
/// in this function during long GLS runs.
pub fn collect_poly_collisions_in_detector_custom(
    cde: &CDEngine,
    dt: &DTransformation,
    shape_buffer: &mut SPolygon,
    reference_shape: &SPolygon,
    collector: &mut SpecializedHazardCollector,
) {
    let t = dt.compose();
    // Transform the shape buffer to the new position.
    let shape = shape_buffer.transform_from(reference_shape, &t);

    {
        // Check a few poles first to detect obvious collisions quickly and
        // raise the loss. Potentially allows fail-fast (early terminate)
        // without checking all edges. Stop when the pole area checked
        // exceeds 50% of the shape area.
        let area_threshold = shape.area * 0.5 / PI;
        let mut area_sum = 0.0;
        for pole in shape.surrogate().poles.iter() {
            cde.quadtree.collect_collisions(pole, collector);
            if collector.early_terminate(shape) {
                return;
            }
            area_sum += pole.radius * pole.radius;
            if area_sum > area_threshold {
                break;
            }
        }
    }

    // Find the virtual root of the quadtree for the shape's bounding box so
    // we don't have to start from the root every time.
    let v_quadtree = cde.get_virtual_root(shape.bbox);

    // Collect collisions for each edge of the polygon.
    // Iterate over them in a bit-reversed order to maximize detecting new
    // hazards early.
    let custom_edge_iter = BitReversalIterator::new(shape.n_vertices()).map(|i| shape.edge(i));
    for edge in custom_edge_iter {
        v_quadtree.collect_collisions(&edge, collector);
        if collector.early_terminate(shape) {
            return;
        }
    }

    // Check for any other collisions due to containment.
    for qt_haz in v_quadtree.hazards.iter() {
        match &qt_haz.presence {
            // No need to check these — guaranteed to be detected by edge intersection.
            QTHazPresence::None | QTHazPresence::Entire => {}
            QTHazPresence::Partial(_) => {
                if !collector.contains_key(qt_haz.hkey) {
                    let h_shape = &cde.hazards_map[qt_haz.hkey].shape;
                    if cde.detect_containment_collision(shape, h_shape, qt_haz.entity) {
                        collector.insert(qt_haz.hkey, qt_haz.entity);
                        if collector.early_terminate(shape) {
                            return;
                        }
                    }
                }
            }
        }
    }

    // Invariant: everything jagua's default collection finds must ALSO
    // be present in the custom collector (`custom ⊇ default`). EXTRA
    // hazards in `custom` are expected — the pole pre-check at line
    // 51-68 catches axis-aligned rectangle overlaps with `Intersecting`
    // bboxes that jagua's edge+containment path under-detects.
    //
    // Task 9.5 restored this hard invariant after Gemini + Codex
    // root-cause investigation: the Task-8-era "divergence" was
    // correctness-improving, not buggy. The helper now returns `true`
    // iff `missing_from_custom.is_empty()`, not strict set equality.
    debug_assert!(
        assertions::custom_pipeline_matches_jaguars(shape, collector),
        "Custom pipeline is MISSING a hazard that jagua's default found \
         (real regression; see `assertions::custom_pipeline_matches_jaguars` \
         warning message for the diverged sets)"
    );
}

/// Specialized version of `HazardCollector` that computes the loss
/// incrementally on the fly and caches the result. Allows early termination
/// if the loss exceeds a configured upper bound.
pub struct SpecializedHazardCollector<'a> {
    pub layout: &'a Layout,
    pub ct: &'a CollisionTracker,
    pub current_pk: PItemKey,
    pub current_haz_key: HazKey,
    pub detected: SecondaryMap<HazKey, (HazardEntity, usize)>,
    pub idx_counter: usize,
    pub loss_cache: (usize, f32),
    pub loss_bound: f32,
}

impl<'a> SpecializedHazardCollector<'a> {
    pub fn new(layout: &'a Layout, ct: &'a CollisionTracker, current_pk: PItemKey) -> Self {
        let current_haz_key = layout
            .cde()
            .haz_key_from_pi_key(current_pk)
            .expect("placed item should be registered in the CDE");
        Self {
            layout,
            ct,
            current_pk,
            current_haz_key,
            detected: SecondaryMap::with_capacity(layout.placed_items.len() + 1),
            idx_counter: 0,
            loss_cache: (0, 0.0),
            loss_bound: f32::INFINITY,
        }
    }

    pub fn reload(&mut self, loss_bound: f32) {
        self.detected.clear();
        self.idx_counter = 0;
        self.loss_cache = (0, 0.0);
        self.loss_bound = loss_bound;
    }

    pub fn iter_with_index(&self) -> impl Iterator<Item = &(HazardEntity, usize)> {
        self.detected.values()
    }

    pub fn early_terminate(&mut self, shape: &SPolygon) -> bool {
        self.loss(shape) > self.loss_bound
    }

    pub fn loss(&mut self, shape: &SPolygon) -> f32 {
        let (cache_idx, cached_loss) = self.loss_cache;
        if cache_idx < self.idx_counter {
            // Additional hazards were detected, update the cache.
            let extra_loss: f32 = self
                .iter_with_index()
                .filter(|(_, idx)| *idx >= cache_idx)
                .map(|(h, _)| self.calc_weighted_loss(h, shape))
                .sum();
            self.loss_cache = (self.idx_counter, cached_loss + extra_loss);
        }
        debug_assert!(approx_eq!(
            f32,
            self.loss_cache.1,
            self.iter()
                .map(|(_, he)| self.calc_weighted_loss(he, shape))
                .sum()
        ));
        self.loss_cache.1
    }

    fn calc_weighted_loss(&self, haz: &HazardEntity, shape: &SPolygon) -> f32 {
        match haz {
            HazardEntity::PlacedItem { pk: other_pk, .. } => {
                let other_shape = &self.layout.placed_items[*other_pk].shape;

                let loss = quantify_collision_poly_poly(other_shape, shape);

                let weight = self.ct.get_pair_weight(self.current_pk, *other_pk);
                loss * weight
            }
            HazardEntity::Exterior => {
                let loss =
                    quantify_collision_poly_container(shape, self.layout.container.outer_cd.bbox);
                let weight = self.ct.get_container_weight(self.current_pk);
                loss * weight
            }
            _ => unimplemented!("unsupported hazard entity"),
        }
    }
}

impl<'a> HazardCollector for SpecializedHazardCollector<'a> {
    fn contains_key(&self, hkey: HazKey) -> bool {
        self.detected.contains_key(hkey) || hkey == self.current_haz_key
    }

    fn insert(&mut self, hkey: HazKey, entity: HazardEntity) {
        debug_assert!(!self.contains_key(hkey));
        self.detected.insert(hkey, (entity, self.idx_counter));
        self.idx_counter += 1;
    }

    fn remove_by_key(&mut self, hkey: HazKey) {
        let (_, idx) = self
            .detected
            .remove(hkey)
            .expect("key should be present in the collector");
        if idx < self.loss_cache.0 {
            // Wipe the cache if a hazard was removed that was in it.
            self.loss_cache = (0, 0.0);
        }
    }

    fn is_empty(&self) -> bool {
        self.detected.is_empty()
    }

    fn len(&self) -> usize {
        self.detected.len()
    }

    fn iter(&self) -> impl Iterator<Item = (HazKey, &HazardEntity)> {
        self.detected.iter().map(|(k, (h, _))| (k, h))
    }
}
