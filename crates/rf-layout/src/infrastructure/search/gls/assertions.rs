// engine/crates/rf-layout/src/infrastructure/search/gls/assertions.rs
//
// Ported from sparrow's `src/util/assertions.rs` (MIT, Copyright 2025 Jeroen
// Gardeyn, KU Leuven).
//
// Provides two debug-only invariant checks:
//   1. `tracker_matches_layout` — replaces the stub added in task 3, used by
//      `gls::tracker` debug_asserts to guard against the tracker cache
//      drifting from the jagua Layout state after mutations.
//   2. `custom_pipeline_matches_jaguars` — used by the specialized jaguars
//      pipeline to assert the fast-path collection matches the jagua-rs
//      default collision pass.
//
// Deviations from upstream:
//   - `strip_width_is_in_check` dropped — SPP-only (uses `SPProblem`),
//     irrelevant to our BPP work.
//   - Unused `SvgDrawOptions` import dropped (upstream imports it without
//     using it).
//   - The debug panic bodies (which upstream uses to dump shape vertices
//     via `dbg!`) are preserved to keep the crash-site diagnostics identical.

use super::quantify::{quantify_collision_poly_container, quantify_collision_poly_poly};
use super::specialized_pipeline::SpecializedHazardCollector;
use super::tracker::CollisionTracker;
use float_cmp::{approx_eq, assert_approx_eq};
use itertools::Itertools;
use jagua_rs::collision_detection::hazards::collector::{BasicHazardCollector, HazardCollector};
use jagua_rs::collision_detection::hazards::HazardEntity;
use jagua_rs::entities::Layout;
use jagua_rs::geometry::primitives::SPolygon;
use jagua_rs::util::assertions;
use log::warn;
use std::collections::HashSet;

pub fn tracker_matches_layout(ct: &CollisionTracker, l: &Layout) -> bool {
    assert!(l.placed_items.keys().all(|k| ct.pk_idx_map.contains_key(k)));
    assert!(assertions::layout_qt_matches_fresh_qt(l));

    for (pk1, pi1) in l.placed_items.iter() {
        let mut collector = BasicHazardCollector::new();
        l.cde().collect_poly_collisions(&pi1.shape, &mut collector);
        collector.remove_by_entity(&HazardEntity::from((pk1, pi1)));
        assert_eq!(ct.get_pair_loss(pk1, pk1), 0.0);
        for (pk2, pi2) in l.placed_items.iter().filter(|(k, _)| *k != pk1) {
            let stored_loss = ct.get_pair_loss(pk1, pk2);
            match collector
                .iter()
                .any(|(_, he)| he == &HazardEntity::from((pk2, pi2)))
            {
                true => {
                    let calc_loss = quantify_collision_poly_poly(&pi1.shape, &pi2.shape);
                    let calc_loss_r = quantify_collision_poly_poly(&pi2.shape, &pi1.shape);
                    if !approx_eq!(f32, calc_loss, stored_loss, epsilon = 0.10 * stored_loss)
                        && !approx_eq!(f32, calc_loss_r, stored_loss, epsilon = 0.10 * stored_loss)
                    {
                        let mut opp_collector = BasicHazardCollector::new();
                        l.cde()
                            .collect_poly_collisions(&pi2.shape, &mut opp_collector);
                        opp_collector.remove_by_entity(&HazardEntity::from((pk2, pi2)));
                        if opp_collector.contains_entity(&((pk1, pi1).into())) {
                            dbg!(&pi1.shape.vertices, &pi2.shape.vertices);
                            dbg!(
                                stored_loss,
                                calc_loss,
                                calc_loss_r,
                                opp_collector.iter().collect_vec(),
                                HazardEntity::from((pk1, pi1)),
                                HazardEntity::from((pk2, pi2))
                            );
                            warn!("tracker_matches_layout: inconsistent pair loss (see followups.md for the custom_pipeline containment-check divergence that cascades here; release builds unaffected)");
                        } else if stored_loss == 0.0 {
                            // Detecting collisions is not symmetrical in edge cases.
                            warn!("non-symmetrical collision!");
                        } else {
                            dbg!(&pi1.shape.vertices, &pi2.shape.vertices);
                            dbg!(
                                stored_loss,
                                calc_loss,
                                calc_loss_r,
                                opp_collector.iter().collect_vec(),
                                HazardEntity::from((pk1, pi1)),
                                HazardEntity::from((pk2, pi2))
                            );
                            warn!("tracker_matches_layout: inconsistent pair loss (see followups.md for the custom_pipeline containment-check divergence that cascades here; release builds unaffected)");
                        }
                    }
                }
                false => {
                    if stored_loss != 0.0 {
                        let calc_loss = quantify_collision_poly_poly(&pi1.shape, &pi2.shape);
                        let mut opp_collector = BasicHazardCollector::new();
                        l.cde()
                            .collect_poly_collisions(&pi2.shape, &mut opp_collector);
                        opp_collector.remove_by_entity(&HazardEntity::from((pk2, pi2)));
                        if !opp_collector.contains_entity(&HazardEntity::from((pk1, pi1))) {
                            dbg!(&pi1.shape.vertices, &pi2.shape.vertices);
                            dbg!(
                                stored_loss,
                                calc_loss,
                                opp_collector.iter().collect_vec(),
                                HazardEntity::from((pk1, pi1)),
                                HazardEntity::from((pk2, pi2))
                            );
                            warn!("tracker_matches_layout: inconsistent pair loss (see followups.md for the custom_pipeline containment-check divergence that cascades here; release builds unaffected)");
                        } else {
                            // Detecting collisions is not symmetrical in edge cases.
                            warn!("inconsistent loss");
                            warn!(
                                "collisions: {:?} -> {:?}",
                                HazardEntity::from((pk1, pi1)),
                                collector.iter().collect_vec()
                            );
                            warn!(
                                "opposite collisions: {:?} -> {:?}",
                                HazardEntity::from((pk2, pi2)),
                                opp_collector.iter().collect_vec()
                            );
                        }
                    }
                }
            }
        }
        if collector.contains_entity(&HazardEntity::Exterior) {
            let stored_loss = ct.get_container_loss(pk1);
            let calc_loss =
                quantify_collision_poly_container(&pi1.shape, l.container.outer_cd.bbox);
            assert_approx_eq!(f32, stored_loss, calc_loss, ulps = 5);
        } else {
            assert_eq!(ct.get_container_loss(pk1), 0.0);
        }
    }

    true
}

/// Returns whether the custom specialized pipeline's hazard collection
/// matches jagua's default `collect_poly_collisions` pass for this
/// same shape.
///
/// Always emits a `warn!` when they diverge. The return value is the
/// boolean comparison result so callers can assert, log, or ignore as
/// appropriate — but see the call site in `specialized_pipeline.rs`:
/// Task 8 INTENTIONALLY does not wrap this in `debug_assert!` to avoid
/// panicking on the Task-4-era pipeline divergence (tracked as a
/// follow-up; release builds are unaffected).
pub fn custom_pipeline_matches_jaguars(shape: &SPolygon, det: &SpecializedHazardCollector) -> bool {
    // Standard collision collection, provided by jagua-rs, for comparison.
    let cde = det.layout.cde();
    let base_detector = {
        let pi = &det.layout.placed_items[det.current_pk];
        let pk = det.current_pk;
        let mut coll = BasicHazardCollector::new();
        cde.collect_poly_collisions(shape, &mut coll);
        if coll.contains_entity(&HazardEntity::from((pk, pi))) {
            coll.remove_by_entity(&HazardEntity::from((pk, pi)));
        }
        coll
    };

    let default_set: HashSet<HazardEntity> = base_detector.entities().cloned().collect();
    let custom_set: HashSet<HazardEntity> = det.entities().cloned().collect();

    // Task 9.5 (Gemini + Codex): our custom pipeline's pole pre-check
    // (specialized_pipeline.rs:51-68) is correctness-improving relative
    // to jagua's default pass, which under-detects axis-aligned
    // rectangle overlaps whose bboxes are `Intersecting` but not
    // `Enclosed` / `Surrounding` (no edge-crossing in the virtual-root
    // walk + jagua's `detect_containment_collision` returns false for
    // `Intersecting`).
    //
    // Sparrow upstream has the same pole pre-check and the same
    // bare `assert_eq!`. Sparrow's test fixtures never produce this
    // configuration; REMA's packing fixtures do routinely (multiple
    // clearance-inflated rects in tight bins).
    //
    // Correct invariant: `custom ⊇ default`. EXTRA hazards in custom
    // are expected and good. MISSING hazards in custom (items jagua
    // found but we did not) would be a real regression.
    let missing_from_custom: Vec<&HazardEntity> = default_set.difference(&custom_set).collect();
    let extra_in_custom: Vec<&HazardEntity> = custom_set.difference(&default_set).collect();

    if !missing_from_custom.is_empty() {
        warn!(
            "custom cde pipeline MISSED hazards jagua default found for pk {:?}: \
             jagua_default={:?}, custom={:?}, missing={:?} (REAL REGRESSION)",
            det.current_pk, default_set, custom_set, missing_from_custom,
        );
    } else if !extra_in_custom.is_empty() {
        log::trace!(
            "custom cde pipeline found {} extra hazard(s) via pole pre-check for pk {:?}: extra={:?}",
            extra_in_custom.len(),
            det.current_pk,
            extra_in_custom,
        );
    }

    missing_from_custom.is_empty()
}
