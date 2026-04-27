// engine/crates/rf-layout/src/infrastructure/jagua_adapter.rs
use crate::domain::{Bin, PackError, Part};
use crate::infrastructure::warm_start::SeedPlacement;

use jagua_rs::collision_detection::CDEConfig;
use jagua_rs::geometry::fail_fast::SPSurrogateConfig;
use jagua_rs::geometry::DTransformation;
use jagua_rs::io::ext_repr::{ExtContainer, ExtItem as BaseExtItem, ExtSPolygon, ExtShape};
use jagua_rs::io::import::Importer;
use jagua_rs::probs::bpp::entities::{BPInstance, BPLayoutType, BPPlacement};
use jagua_rs::probs::bpp::io::ext_repr::{ExtBPInstance, ExtBin, ExtItem as BpExtItem};
use jagua_rs::probs::bpp::io::import_instance;

/// Translate a jagua `DTransformation` by `(dx, dy)` in the world frame.
///
/// Used by every placement-construction site to undo the bin-expansion
/// shift introduced in `build_ext_bin`. The expansion grows each bin by
/// `clearance` on every side so jagua's `min_item_separation` keeps items
/// `clearance` away from the EXPANDED walls, which puts them flush against
/// the original walls once we shift placements back by `-clearance`. A
/// single helper guarantees every translation site applies the same shift
/// and stays in sync if the expansion factor changes.
pub fn shift_dtransformation(t: &DTransformation, dx: f32, dy: f32) -> DTransformation {
    DTransformation::new(
        t.rotation.into_inner(),
        (
            t.translation.0.into_inner() + dx,
            t.translation.1.into_inner() + dy,
        ),
    )
}

/// Convert a greedy `SeedPlacement` (world bbox-min coords, post-greedy
/// wall-margin offset) into a jagua `BPPlacement` whose `d_transf`
/// translation places the polygon centroid in jagua's expanded-bin
/// coordinate frame.
///
/// The math relies on two offsets cancelling exactly:
///   - greedy_rectangle_pack returns `seed.x = bbox_min_x + clearance`
///     because it adds a wall-margin to bin-packing's inner-area coords
///     (warm_start.rs:338-339).
///   - jagua's `build_ext_bin` expands the bin by `clearance` on every
///     side, so jagua coords are `world + clearance`.
///
/// Net: `jagua_translation = (seed.bbox_min - clearance) + dims/2 +
/// clearance = seed.bbox_min + dims/2`. The two clearance terms cancel,
/// so a flush-corner placement just needs `seed.x + width/2`.
///
/// Used by Option C's greedy warm-start in `pack_lbf` to pre-load
/// rectangle placements into jagua's BPProblem before LBF::solve() runs.
pub fn seed_to_bp_placement(
    seed: &SeedPlacement,
    item_id: usize,
    layout_id: BPLayoutType,
) -> BPPlacement {
    let tx = (seed.x + seed.width / 2.0) as f32;
    let ty = (seed.y + seed.height / 2.0) as f32;
    BPPlacement {
        layout_id,
        item_id,
        d_transf: DTransformation::new(seed.rotation_rad as f32, (tx, ty)),
    }
}

/// Guard an f64 -> f32 narrowing conversion against NaN, infinity, and values
/// outside f32's representable range. jagua-rs operates in f32, so we reject
/// upstream rather than silently producing NaN/inf geometry.
fn finite_f32(x: f64, context: &str) -> Result<f32, PackError> {
    if !x.is_finite() {
        return Err(PackError::EngineFailed(format!(
            "non-finite coordinate in {}: {}",
            context, x
        )));
    }
    if x.abs() > f32::MAX as f64 {
        return Err(PackError::EngineFailed(format!(
            "coordinate out of f32 range in {}: {}",
            context, x
        )));
    }
    Ok(x as f32)
}

/// Convert a rema domain Part + Bin into a jagua-rs [`BPInstance`].
///
/// This is the seam between domain and vendor; no jagua types leak past this
/// module except through this function's return type, which is consumed only
/// by the packing orchestrator inside the same crate.
///
/// `clearance` is passed to jagua as `min_item_separation`, i.e. the minimum
/// distance to maintain between every pair of hazards (items and container
/// edges). Our unit is domain-native (inches for REMA), matching the polygon
/// coordinates.
pub fn to_jagua_instance(
    bins: &[Bin],
    items: &[Part],
    clearance: f64,
) -> Result<BPInstance, PackError> {
    if bins.is_empty() {
        return Err(PackError::NoBins);
    }
    if items.is_empty() {
        return Err(PackError::NoItems);
    }
    if clearance < 0.0 {
        return Err(PackError::EngineFailed(format!(
            "negative clearance: {}",
            clearance
        )));
    }

    // Sensible defaults taken from lbf (the reference binary in jagua-rs 0.7.1).
    // These govern the Collision Detection Engine's quadtree resolution and the
    // item surrogate polygon approximation. Tuning can happen downstream.
    let cde_config = CDEConfig {
        quadtree_depth: 5,
        cd_threshold: 16,
        item_surrogate_config: SPSurrogateConfig {
            n_pole_limits: [(100, 0.0), (20, 0.75), (10, 0.90)],
            // 2 poles + 0 piers matches jagua-rs's `lbf` reference
            // binary defaults. We tried bumping this to 4/2 and 8/4
            // to address an apparent collision-overlap report from
            // the AutoNest UI, but: (a) 8/4 caused ~17x slowdown
            // that blew per-pack budgets, (b) 4/2 broke the cancel
            // latency SLA (~500ms cap turned into 7.5s under the
            // heavier surrogate). The collision symptom is being
            // diagnosed via a visualizer overlay (`Placement.pack_polygon`)
            // before tuning the surrogate further.
            n_ff_poles: 2,
            n_ff_piers: 0,
        },
    };

    let min_item_separation = if clearance > 0.0 {
        Some(finite_f32(clearance, "clearance")?)
    } else {
        None
    };

    let importer = Importer::new(
        cde_config,
        None,                // poly_simpl_tolerance: leave shapes exact
        min_item_separation, // min_item_separation = our clearance
        None,                // narrow_concavity_cutoff: off
    );

    // Build external representation (jagua's public input shape). IDs must be
    // consecutive and start from 0 for both items and bins; we assign by index.
    let ext_items: Vec<BpExtItem> = items
        .iter()
        .enumerate()
        .map(|(idx, p)| build_ext_item(idx as u64, p))
        .collect::<Result<_, _>>()?;

    let ext_bins: Vec<ExtBin> = bins
        .iter()
        .enumerate()
        .map(|(idx, b)| build_ext_bin(idx as u64, b, clearance))
        .collect::<Result<_, _>>()?;

    let ext_instance = ExtBPInstance {
        name: "rema-pack".to_string(),
        items: ext_items,
        bins: ext_bins,
    };

    import_instance(&importer, &ext_instance)
        .map_err(|e| PackError::EngineFailed(format!("jagua import failed: {e}")))
}

fn build_ext_item(id: u64, part: &Part) -> Result<BpExtItem, PackError> {
    let polygon = part.polygon_slice();
    if polygon.len() < 3 {
        return Err(PackError::EngineFailed(format!(
            "part '{}' polygon has fewer than 3 vertices",
            part.shape_id
        )));
    }
    if part.quantity == 0 {
        return Err(PackError::EngineFailed(format!(
            "part '{}' has zero quantity",
            part.shape_id
        )));
    }

    let points: Vec<(f32, f32)> = polygon
        .iter()
        .map(|p| Ok((finite_f32(p.x, "polygon.x")?, finite_f32(p.y, "polygon.y")?)))
        .collect::<Result<_, PackError>>()?;

    // Rotation policy:
    //   `allow_rotation = false` -> fixed at 0 degrees.
    //   `allow_rotation = true`  -> per-kind allowed set:
    //     - "rect" (covers user rectangles AND unrolled cylinders, which
    //        the TS layer ships as kind "rect" with width = π·d): only
    //        0 and 90° — a rectangle is 180°-symmetric, so the other two
    //        cardinals are equivalence-class duplicates that would just
    //        feed jagua redundant solver iterations.
    //     - "trapezoid": all four cardinals — no rotational symmetry.
    //     - everything else (sector / circle / ngon / raw polygon with
    //        no shape_spec): continuous rotation, the prior behaviour.
    //
    // IMPORTANT: jagua-rs `allowed_orientations` is interpreted as
    // DEGREES on import (see jagua-rs `io/import.rs`: it pipes each
    // value through `f32::to_radians()` when building the internal
    // `RotationRange::Discrete`). Pass degrees here.
    let allowed_orientations = if part.allow_rotation {
        match part.shape_spec.as_ref().map(|s| s.kind.as_str()) {
            Some("rect") => Some(vec![0.0, 90.0]),
            Some("trapezoid") => Some(vec![0.0, 90.0, 180.0, 270.0]),
            _ => None,
        }
    } else {
        Some(vec![0.0])
    };

    Ok(BpExtItem {
        base: BaseExtItem {
            id,
            allowed_orientations,
            shape: ExtShape::SimplePolygon(ExtSPolygon(points)),
            min_quality: None,
        },
        demand: part.quantity as u64,
    })
}

fn build_ext_bin(id: u64, bin: &Bin, clearance: f64) -> Result<ExtBin, PackError> {
    // Expand the bin by `clearance` on every side. jagua's
    // `min_item_separation` enforcement keeps items at least `clearance`
    // away from the EXPANDED walls, which puts them flush against the
    // original walls after `snapshot_to_placements` shifts coordinates
    // back. Inter-item kerf separation is preserved (jagua keeps that
    // between items independently). Operators don't trim sheet edges,
    // so wall-flush placement matches physical reality.
    let expanded_width = finite_f32(bin.width + 2.0 * clearance, "bin.width + 2*clearance")?;
    let expanded_height = finite_f32(bin.height + 2.0 * clearance, "bin.height + 2*clearance")?;
    Ok(ExtBin {
        base: ExtContainer {
            id,
            shape: ExtShape::Rectangle {
                x_min: 0.0,
                y_min: 0.0,
                width: expanded_width,
                height: expanded_height,
            },
            zones: vec![],
        },
        // REMA's domain doesn't model multi-stock bins; one copy per declared bin.
        stock: 1,
        // Uniform cost: BPP cost affects bin-selection heuristics only.
        cost: 1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::BinKind;

    fn test_bin() -> Bin {
        Bin {
            bin_id: "b1".into(),
            width: 48.0,
            height: 96.0,
            kind: BinKind::Fresh,
            priority: None,
        }
    }

    fn test_rect_part() -> Part {
        Part {
            shape_id: "rect-a".into(),
            quantity: 1,
            polygon: Some(vec![
                rf_geom::domain::Point2D::new(0.0, 0.0),
                rf_geom::domain::Point2D::new(24.0, 0.0),
                rf_geom::domain::Point2D::new(24.0, 12.0),
                rf_geom::domain::Point2D::new(0.0, 12.0),
            ]),
            shape_spec: None,
            allow_rotation: true,
            grain_axis: None,
            difficulty: None,
            tag: None,
        }
    }

    #[test]
    fn converts_simple_rect_instance() {
        let bins = vec![test_bin()];
        let items = vec![test_rect_part()];
        let r = to_jagua_instance(&bins, &items, 0.125);
        assert!(
            r.is_ok(),
            "conversion should succeed for a valid simple rect"
        );
    }

    #[test]
    fn rejects_empty_bins() {
        let items = vec![test_rect_part()];
        let r = to_jagua_instance(&[], &items, 0.125);
        assert!(matches!(r, Err(PackError::NoBins)));
    }

    #[test]
    fn rejects_empty_items() {
        let bins = vec![test_bin()];
        let r = to_jagua_instance(&bins, &[], 0.125);
        assert!(matches!(r, Err(PackError::NoItems)));
    }

    #[test]
    fn rejects_zero_quantity_part() {
        let bins = vec![test_bin()];
        let mut part = test_rect_part();
        part.quantity = 0;
        let r = to_jagua_instance(&bins, &[part], 0.125);
        assert!(r.is_err(), "zero quantity should be rejected");
    }

    #[test]
    fn rejects_degenerate_polygon() {
        let bins = vec![test_bin()];
        let mut part = test_rect_part();
        part.polygon = Some(vec![
            rf_geom::domain::Point2D::new(0.0, 0.0),
            rf_geom::domain::Point2D::new(1.0, 0.0),
        ]); // only 2 vertices
        let r = to_jagua_instance(&bins, &[part], 0.125);
        assert!(r.is_err(), "polygon with <3 vertices should be rejected");
    }

    #[test]
    fn rejects_negative_clearance() {
        let bins = vec![test_bin()];
        let items = vec![test_rect_part()];
        let r = to_jagua_instance(&bins, &items, -0.5);
        assert!(r.is_err(), "negative clearance should be rejected");
    }

    #[test]
    fn rejects_nan_coordinate() {
        let bins = vec![test_bin()];
        let mut part = test_rect_part();
        part.polygon.as_mut().expect("test fixture has polygon")[0].x = f64::NAN;
        let r = to_jagua_instance(&bins, &[part], 0.125);
        assert!(r.is_err(), "NaN coordinate should be rejected");
    }

    #[test]
    fn fixed_rotation_path_converts_successfully() {
        let bins = vec![test_bin()];
        let mut part = test_rect_part();
        part.allow_rotation = false;
        let r = to_jagua_instance(&bins, &[part], 0.125);
        assert!(
            r.is_ok(),
            "allow_rotation=false should convert cleanly (single fixed angle)"
        );
    }

    // ── Per-kind rotation policy ─────────────────────────────────────
    //
    // These tests pin the contract `build_ext_item` exposes to jagua:
    // rect (and unrolled cylinders) → 2 cardinals; trapezoid → 4
    // cardinals; everything else (circle, sector, ngon, raw polygon
    // with no shape_spec) → continuous. Regressing any of these silently
    // would reintroduce the oblique-angle nesting the user reported.

    fn part_with_kind(kind: &str) -> Part {
        let mut p = test_rect_part();
        p.shape_spec = Some(crate::domain::ShapeSpec {
            kind: kind.into(),
            params: std::collections::HashMap::new(),
        });
        p
    }

    #[test]
    fn rect_kind_emits_two_cardinal_orientations_in_degrees() {
        // jagua-rs treats allowed_orientations as degrees and converts
        // to radians on import — the values here MUST be in degrees.
        let item = build_ext_item(0, &part_with_kind("rect")).expect("build_ext_item ok");
        assert_eq!(item.base.allowed_orientations, Some(vec![0.0, 90.0]));
    }

    #[test]
    fn trapezoid_kind_emits_four_cardinal_orientations_in_degrees() {
        let item = build_ext_item(0, &part_with_kind("trapezoid")).expect("build_ext_item ok");
        assert_eq!(
            item.base.allowed_orientations,
            Some(vec![0.0, 90.0, 180.0, 270.0]),
        );
    }

    #[test]
    fn circle_kind_keeps_continuous_rotation() {
        let item = build_ext_item(0, &part_with_kind("circle")).expect("build_ext_item ok");
        assert_eq!(item.base.allowed_orientations, None);
    }

    #[test]
    fn sector_kind_keeps_continuous_rotation() {
        let item = build_ext_item(0, &part_with_kind("sector")).expect("build_ext_item ok");
        assert_eq!(item.base.allowed_orientations, None);
    }

    #[test]
    fn polygon_only_part_keeps_continuous_rotation() {
        // No shape_spec — caller shipped a raw polygon (DXF / free-roam
        // custom shape). Stays continuous.
        let item = build_ext_item(0, &test_rect_part()).expect("build_ext_item ok");
        assert_eq!(item.base.allowed_orientations, None);
    }

    #[test]
    fn rect_with_allow_rotation_false_locks_to_zero() {
        let mut part = part_with_kind("rect");
        part.allow_rotation = false;
        let item = build_ext_item(0, &part).expect("build_ext_item ok");
        assert_eq!(item.base.allowed_orientations, Some(vec![0.0]));
    }
}
