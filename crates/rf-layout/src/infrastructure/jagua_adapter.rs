// engine/crates/rf-layout/src/infrastructure/jagua_adapter.rs
use crate::domain::{Bin, PackError, Part};

use jagua_rs::collision_detection::CDEConfig;
use jagua_rs::geometry::fail_fast::SPSurrogateConfig;
use jagua_rs::io::ext_repr::{ExtContainer, ExtItem as BaseExtItem, ExtSPolygon, ExtShape};
use jagua_rs::io::import::Importer;
use jagua_rs::probs::bpp::entities::BPInstance;
use jagua_rs::probs::bpp::io::ext_repr::{ExtBPInstance, ExtBin, ExtItem as BpExtItem};
use jagua_rs::probs::bpp::io::import_instance;

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
        .map(|(idx, b)| build_ext_bin(idx as u64, b))
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
    if part.polygon.len() < 3 {
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

    let points: Vec<(f32, f32)> = part
        .polygon
        .iter()
        .map(|p| Ok((finite_f32(p.x, "polygon.x")?, finite_f32(p.y, "polygon.y")?)))
        .collect::<Result<_, PackError>>()?;

    // `allow_rotation = true`  -> continuous rotation (omit allowed_orientations).
    // `allow_rotation = false` -> fixed at 0 degrees (single-angle list).
    let allowed_orientations = if part.allow_rotation {
        None
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

fn build_ext_bin(id: u64, bin: &Bin) -> Result<ExtBin, PackError> {
    Ok(ExtBin {
        base: ExtContainer {
            id,
            shape: ExtShape::Rectangle {
                x_min: 0.0,
                y_min: 0.0,
                width: finite_f32(bin.width, "bin.width")?,
                height: finite_f32(bin.height, "bin.height")?,
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
            polygon: vec![
                rf_geom::domain::Point2D::new(0.0, 0.0),
                rf_geom::domain::Point2D::new(24.0, 0.0),
                rf_geom::domain::Point2D::new(24.0, 12.0),
                rf_geom::domain::Point2D::new(0.0, 12.0),
            ],
            shape_spec: None,
            allow_rotation: true,
            grain_axis: None,
            difficulty: None,
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
        part.polygon = vec![
            rf_geom::domain::Point2D::new(0.0, 0.0),
            rf_geom::domain::Point2D::new(1.0, 0.0),
        ]; // only 2 vertices
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
        part.polygon[0].x = f64::NAN;
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
}
