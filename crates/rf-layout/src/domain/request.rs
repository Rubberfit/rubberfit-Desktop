// engine/crates/rf-layout/src/domain/request.rs
use rf_geom::domain::Point2D;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BinKind {
    Fresh,
    Remnant,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum UnitSystem {
    #[default]
    #[serde(alias = "in", alias = "inches")]
    Inch,
    #[serde(alias = "millimeter", alias = "millimeters")]
    Mm,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bin {
    pub bin_id: String,
    pub width: f64,
    pub height: f64,
    pub kind: BinKind,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub priority: Option<i32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ShapeSpec {
    pub kind: String,
    pub params: HashMap<String, serde_json::Value>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GrainAxis {
    Width,
    Length,
    None,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub shape_id: String,
    #[serde(alias = "demand")]
    pub quantity: u32,
    pub polygon: Vec<Point2D>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub shape_spec: Option<ShapeSpec>,
    pub allow_rotation: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub grain_axis: Option<GrainAxis>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub difficulty: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperatorProfile {
    pub skills: Vec<String>,
    pub max_difficulty: f64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PackMode {
    Fast,
    Balanced,
    Thorough,
}

/// Which backend engine pack-cli should dispatch to.
///
/// - `Default` → `pack_lbf_lns`: polygon-aware LBF + LNS refinement.
/// - `Lbf`     → constructive LBF only.
/// - `Legacy`  → pre-Phase-3 `pack()` path; benches / debug only.
///
/// Request-level takes priority; when absent, pack-cli reads the
/// `RF_ENGINE` environment variable, then falls back to `Default`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PackEngine {
    Default,
    Lbf,
    Legacy,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackRequest {
    pub bins: Vec<Bin>,
    #[serde(alias = "kerf", alias = "spacing")]
    pub clearance: f64,
    pub items: Vec<Part>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub operator_profile: Option<OperatorProfile>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mode: Option<PackMode>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub engine: Option<PackEngine>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub time_budget_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub improvement_budget_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub seed: Option<u64>,
    #[serde(default)]
    pub units: UnitSystem,
}

pub const FAST_MS: u64 = 2_000;
pub const BALANCED_MS: u64 = 10_000;
pub const THOROUGH_MS: u64 = 30_000;

impl PackRequest {
    pub fn resolved_time_budget_ms(&self) -> u64 {
        if let Some(ms) = self.time_budget_ms {
            return ms;
        }
        match self.mode {
            Some(PackMode::Fast) => FAST_MS,
            Some(PackMode::Thorough) => THOROUGH_MS,
            Some(PackMode::Balanced) | None => BALANCED_MS,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"{
        "bins":[{"binId":"b1","width":48,"height":96,"kind":"fresh"}],
        "clearance":0.125,
        "items":[{"shapeId":"rect-a","quantity":1,"polygon":[{"x":0,"y":0},{"x":24,"y":0},{"x":24,"y":12},{"x":0,"y":12}],"allowRotation":true}],
        "mode":"fast",
        "seed":42
    }"#;

    #[test]
    fn deserializes_s1_fixture() {
        let req: PackRequest = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(req.bins.len(), 1);
        assert_eq!(req.bins[0].bin_id, "b1");
        assert_eq!(req.items.len(), 1);
        assert_eq!(req.items[0].shape_id, "rect-a");
        assert_eq!(req.items[0].polygon.len(), 4);
        assert_eq!(req.mode, Some(PackMode::Fast));
        assert_eq!(req.units, UnitSystem::Inch); // default
    }

    #[test]
    fn fast_mode_resolves_to_fast_budget() {
        let req: PackRequest = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(req.resolved_time_budget_ms(), FAST_MS);
    }

    #[test]
    fn default_mode_falls_back_to_balanced_budget() {
        let json = r#"{
            "bins":[{"binId":"b","width":1,"height":1,"kind":"fresh"}],
            "clearance":0,
            "items":[{"shapeId":"a","quantity":1,"polygon":[{"x":0,"y":0},{"x":1,"y":0},{"x":1,"y":1}],"allowRotation":true}]
        }"#;
        let req: PackRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.mode, None);
        assert_eq!(req.resolved_time_budget_ms(), BALANCED_MS);
    }

    #[test]
    fn explicit_budget_overrides_mode() {
        let mut req: PackRequest = serde_json::from_str(FIXTURE).unwrap();
        req.time_budget_ms = Some(7_500);
        assert_eq!(req.resolved_time_budget_ms(), 7_500);
    }

    #[test]
    fn bin_kind_serializes_as_lowercase() {
        let b = Bin {
            bin_id: "x".into(),
            width: 1.0,
            height: 1.0,
            kind: BinKind::Remnant,
            priority: None,
        };
        let json = serde_json::to_string(&b).unwrap();
        assert!(json.contains("\"kind\":\"remnant\""));
    }

    // Industry alias tests

    #[test]
    fn accepts_demand_alias_for_quantity() {
        let json = r#"{
            "bins":[{"binId":"b1","width":48,"height":96,"kind":"fresh"}],
            "clearance":0.125,
            "items":[{"shapeId":"a","demand":7,"polygon":[{"x":0,"y":0},{"x":1,"y":0},{"x":1,"y":1}],"allowRotation":true}]
        }"#;
        let req: PackRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.items[0].quantity, 7);
    }

    #[test]
    fn accepts_kerf_alias_for_clearance() {
        let json = r#"{
            "bins":[{"binId":"b1","width":48,"height":96,"kind":"fresh"}],
            "kerf":0.25,
            "items":[{"shapeId":"a","quantity":1,"polygon":[{"x":0,"y":0},{"x":1,"y":0},{"x":1,"y":1}],"allowRotation":true}]
        }"#;
        let req: PackRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.clearance, 0.25);
    }

    #[test]
    fn accepts_spacing_alias_for_clearance() {
        let json = r#"{
            "bins":[{"binId":"b1","width":48,"height":96,"kind":"fresh"}],
            "spacing":0.1,
            "items":[{"shapeId":"a","quantity":1,"polygon":[{"x":0,"y":0},{"x":1,"y":0},{"x":1,"y":1}],"allowRotation":true}]
        }"#;
        let req: PackRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.clearance, 0.1);
    }

    #[test]
    fn units_defaults_to_inch_and_accepts_alias() {
        let json_in = r#"{"bins":[{"binId":"b","width":1,"height":1,"kind":"fresh"}],"clearance":0,"items":[{"shapeId":"a","quantity":1,"polygon":[{"x":0,"y":0},{"x":1,"y":0},{"x":1,"y":1}],"allowRotation":true}],"units":"in"}"#;
        let req: PackRequest = serde_json::from_str(json_in).unwrap();
        assert_eq!(req.units, UnitSystem::Inch);

        let json_mm = r#"{"bins":[{"binId":"b","width":1,"height":1,"kind":"fresh"}],"clearance":0,"items":[{"shapeId":"a","quantity":1,"polygon":[{"x":0,"y":0},{"x":1,"y":0},{"x":1,"y":1}],"allowRotation":true}],"units":"mm"}"#;
        let req: PackRequest = serde_json::from_str(json_mm).unwrap();
        assert_eq!(req.units, UnitSystem::Mm);
    }
}
