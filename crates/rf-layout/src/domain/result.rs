// engine/crates/rf-layout/src/domain/result.rs
use rf_geom::domain::{Point2D, Polygon};
use serde::{Deserialize, Serialize};

/// Whether an offcut rectangle meets the reusable-stock thresholds
/// (TypeScript free-space.ts compatibility) or is treated as scrap.
/// The thresholds and classification rules live in
/// `application::offcut_classifier`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OffcutKind {
    /// Large enough (in either orientation) to be re-stocked as a
    /// remnant. Rendered amber in the AutoNest visualizer.
    Reusable,
    /// Below all reusable thresholds. Rendered red as waste.
    Scrap,
}

/// One axis-aligned offcut rectangle extracted from a `BinResult`'s
/// free-space polygons via `largest_inscribed_rect` and classified
/// against reusable-stock thresholds. AutoNest renders these as the
/// amber/red overlays on top of placed cuts.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClassifiedOffcut {
    pub bin_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub kind: OffcutKind,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub shape_id: String,
    pub instance_index: u32,
    pub bin_id: String,
    pub x: f64,
    pub y: f64,
    pub rotation_rad: f64,
    pub polygon: Vec<Point2D>,
    pub width: f64,
    pub height: f64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub difficulty: Option<f64>,
    /// Echo of the source `Part.tag`. The packing pipeline does not
    /// produce this value; it is stamped post-pack from the request
    /// (see `application::strategy::run_with_tag_echo`) so a tag
    /// carries through the boundary without leaking into search,
    /// jagua-rs, or any geometric primitive.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tag: Option<String>,
    /// Transformed pack polygon — the surface jagua actually
    /// collided on. Populated only when it differs from `polygon`
    /// (today: the cone convex-hull overlay in default packing). The
    /// visualizer can paint this as a translucent overlay so operators
    /// can see jagua's "mental model" of the shape. None for every
    /// shape where pack polygon == render polygon, including
    /// annular-sector cone packing.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub pack_polygon: Option<Vec<Point2D>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BinResult {
    pub bin_id: String,
    pub used_area: f64,
    pub waste_area: f64,
    pub occupied_width: f64,
    pub occupied_height: f64,
    /// Ratio of placed item area to bin stock area, 0..1.
    /// Industry alias: `density` (jagua-rs convention).
    #[serde(alias = "density")]
    pub efficiency: f64,
    /// Ratio of waste to total stock, 0..1.
    /// Invariant: `scrap_ratio == 1.0 - efficiency` (within f64 epsilon).
    /// Set by the pack() orchestrator in Task 18; not validated at the type level.
    /// Feeds downstream UI waste reporting (S5).
    #[serde(default)]
    pub scrap_ratio: f64,
    /// Boolean-difference output: bin polygon minus the union of all
    /// placed-part polygons in this bin. CCW-wound, in bin-local
    /// coordinates. AutoNest paints these as scrap polygons for
    /// irregular waste regions (cone/trapezoid mixes). Empty when
    /// the post-pack free-space extractor hasn't run (e.g. older
    /// callers that bypassed `application::strategy`).
    #[serde(default)]
    pub free_regions: Vec<Polygon>,
    /// Axis-aligned reusable/scrap rectangles inscribed inside the
    /// `free_regions`. AutoNest paints reusable in amber and scrap
    /// in red. Empty when the post-pack extractor hasn't run.
    #[serde(default)]
    pub offcuts: Vec<ClassifiedOffcut>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackResult {
    pub placements: Vec<Placement>,
    pub placed_count: u32,
    pub overflow_count: u32,
    pub per_bin: Vec<BinResult>,
    pub total_used_area: f64,
    pub total_waste_area: f64,
    /// Workspace-wide utilization, 0..1.
    /// Invariant: `overall_density == total_used_area / (total_used_area + total_waste_area)` when non-empty;
    /// 0.0 for empty results.
    /// Set by the pack() orchestrator in Task 18; mirrors jagua-rs `BPSolution::density()`.
    #[serde(default)]
    pub overall_density: f64,
    /// Wall-clock time spent packing, in milliseconds.
    /// None until populated by the pack() orchestrator in Task 18.
    /// A `Some(0)` is a valid result for trivial inputs.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub run_time_ms: Option<u64>,
    /// Task 14: `true` if the caller-provided `cancel_token` flipped
    /// before search completed; `false` otherwise. Best-so-far partial
    /// state is still returned as a valid result (cooperative cancel
    /// is non-exceptional).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub was_cancelled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_camel_case_field_names() {
        let br = BinResult {
            bin_id: "b1".into(),
            used_area: 50.0,
            waste_area: 0.0,
            occupied_width: 10.0,
            occupied_height: 5.0,
            efficiency: 1.0,
            scrap_ratio: 0.0,
            free_regions: Vec::new(),
            offcuts: Vec::new(),
        };
        let json = serde_json::to_string(&br).unwrap();
        assert!(json.contains("\"binId\":"));
        assert!(json.contains("\"occupiedWidth\":"));
        assert!(json.contains("\"scrapRatio\":"));
    }

    #[test]
    fn placement_serializes_polygon_array() {
        let p = Placement {
            shape_id: "a".into(),
            instance_index: 0,
            bin_id: "b1".into(),
            x: 0.0,
            y: 0.0,
            rotation_rad: 0.0,
            polygon: vec![
                Point2D::new(0.0, 0.0),
                Point2D::new(1.0, 0.0),
                Point2D::new(1.0, 1.0),
            ],
            width: 1.0,
            height: 1.0,
            difficulty: None,
            tag: None,
            pack_polygon: None,
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"rotationRad\":0.0"));
        assert!(json.contains("\"instanceIndex\":0"));
    }

    #[test]
    fn binresult_accepts_density_alias_on_deserialize() {
        // Input uses "density" (jagua-rs convention); field on the struct is `efficiency`
        let json = r#"{
            "binId":"b1",
            "usedArea":50.0,
            "wasteArea":10.0,
            "occupiedWidth":10,
            "occupiedHeight":6,
            "density":0.833,
            "scrapRatio":0.167
        }"#;
        let br: BinResult = serde_json::from_str(json).unwrap();
        assert!((br.efficiency - 0.833).abs() < 1e-9);
    }

    #[test]
    fn binresult_default_scrap_ratio_is_zero() {
        // Omitting scrapRatio from input still deserializes (default=0)
        let json = r#"{
            "binId":"b1",
            "usedArea":50.0,
            "wasteArea":0.0,
            "occupiedWidth":10,
            "occupiedHeight":5,
            "efficiency":1.0
        }"#;
        let br: BinResult = serde_json::from_str(json).unwrap();
        assert_eq!(br.scrap_ratio, 0.0);
    }

    #[test]
    fn packresult_default_overall_density_is_zero_and_run_time_is_none() {
        let json = r#"{
            "placements":[],
            "placedCount":0,
            "overflowCount":0,
            "perBin":[],
            "totalUsedArea":0,
            "totalWasteArea":0
        }"#;
        let pr: PackResult = serde_json::from_str(json).unwrap();
        assert_eq!(pr.overall_density, 0.0);
        assert_eq!(pr.run_time_ms, None);
    }

    #[test]
    fn packresult_roundtrips_with_new_fields() {
        let pr = PackResult {
            placements: vec![],
            placed_count: 0,
            overflow_count: 0,
            per_bin: vec![],
            total_used_area: 100.0,
            total_waste_area: 25.0,
            overall_density: 0.8,
            run_time_ms: Some(1234),
            was_cancelled: false,
        };
        let json = serde_json::to_string(&pr).unwrap();
        assert!(json.contains("\"overallDensity\":0.8"));
        assert!(json.contains("\"runTimeMs\":1234"));
        let back: PackResult = serde_json::from_str(&json).unwrap();
        assert_eq!(back, pr);
    }
}
