// engine/crates/rf-layout/src/application/shape_builder.rs
//
// Single source of truth for spec-based polygon construction Rust-side.
//
// Today supports kinds: "rect", "circle", "trapezoid", "ngon", "sector".
// The TS `buildPart.buildPolygonFromSpec` (`src/lib/packing/buildPart.ts`)
// used to build the first four kinds client-side and ship the polygon
// over the wire; that path is gone — TS now ships `shape_spec` only,
// and Rust materialises the polygon up front via
// `materialise_request_polygons`. DXF / raw-geometry callers still ship
// `Part.polygon` directly; that escape hatch is preserved by
// `materialise_polygon`.
//
// Cones (`kind: "sector"`) route to the `cone_strategy` module, which
// keeps the pack-vs-render mode strategy (ConvexHull / AnnularSector).
//
// New kinds: add a match arm to `build_polygon_from_spec` and a
// `build_<kind>` helper. If a kind grows multiple swappable strategies
// (like sector did), promote it to its own strategy module and call
// out from this dispatch — not from inside the kind-builder.

use rf_geom::domain::Point2D;
use std::collections::HashMap;

use crate::application::cone_strategy::{
    build_sector_polygon_from_spec, normalize_polygon, ConePackingMode,
};
use crate::domain::{PackError, PackRequest, Part, ShapeSpec};

/// Resolve a part's polygon. Returns the literal `Part.polygon` when
/// present (DXF / raw-geometry escape hatch), otherwise dispatches
/// from `Part.shape_spec`. Cones use the default cone packing mode;
/// for non-default modes use `materialise_request_polygons`, which
/// reads `PackRequest.cone_packing_mode`.
pub fn materialise_polygon(part: &Part) -> Result<Vec<Point2D>, PackError> {
    if let Some(p) = &part.polygon {
        return Ok(p.clone());
    }
    let spec = part.shape_spec.as_ref().ok_or_else(|| {
        PackError::EngineFailed(format!(
            "part '{}' has neither polygon nor shape_spec",
            part.shape_id
        ))
    })?;
    build_polygon_from_spec(spec, ConePackingMode::default())
}

/// Walk every part in the request and fill in any missing polygon from
/// its shape spec. Pack pipelines call this once on entry so downstream
/// search/jagua code can assume `Part.polygon` is `Some`.
///
/// For `kind: "sector"`, the polygon is ALWAYS rebuilt from the spec
/// (even when `Part.polygon` is already `Some`) so the request-level
/// `cone_packing_mode` overrides any legacy polygon the TS layer might
/// have shipped from a pre-Rust era.
pub fn materialise_request_polygons(request: &mut PackRequest) -> Result<(), PackError> {
    let cone_mode = request.cone_packing_mode.unwrap_or_default();
    for part in &mut request.items {
        if part.shape_spec.as_ref().is_some_and(|s| s.kind == "sector") {
            // Safe: the predicate guarantees shape_spec.is_some().
            let spec = part.shape_spec.as_ref().expect("checked above");
            part.polygon = Some(build_polygon_from_spec(spec, cone_mode)?);
            continue;
        }
        if part.polygon.is_some() {
            continue;
        }
        part.polygon = Some(materialise_polygon(part)?);
    }
    Ok(())
}

/// Kind-keyed dispatch. Each shape kind has exactly one canonical
/// builder; `kind` is the discriminator on the input, not a config
/// knob, so this stays a `match` rather than a Strategy trait. Cones
/// route to the cone-strategy module which DOES have multiple
/// swappable strategies (Convex / Annular).
pub fn build_polygon_from_spec(
    spec: &ShapeSpec,
    cone_mode: ConePackingMode,
) -> Result<Vec<Point2D>, PackError> {
    match spec.kind.as_str() {
        "rect" => build_rect(spec),
        "circle" => build_circle(spec),
        "trapezoid" => build_trapezoid(spec),
        "ngon" => build_ngon(spec),
        "sector" => build_sector_polygon_from_spec(spec, cone_mode),
        other => Err(PackError::EngineFailed(format!(
            "shape_spec.kind '{}' is not recognised (expected one of: rect, circle, trapezoid, ngon, sector)",
            other
        ))),
    }
}

// ── Per-kind builders ────────────────────────────────────────────────
//
// Each builder mirrors `src/lib/packing/buildPart.ts` exactly so
// vertex-by-vertex parity is preserved across the wire-format flip.

/// Rectangle anchored at (0,0). 4 verts CCW (already normalised by
/// construction). Mirrors `buildRect` in buildPart.ts.
fn build_rect(spec: &ShapeSpec) -> Result<Vec<Point2D>, PackError> {
    let width = read_f64(&spec.params, "width")?;
    let height = read_f64(&spec.params, "height")?;
    if width <= 0.0 || width.is_nan() {
        return Err(PackError::EngineFailed(
            "rect: width must be positive".into(),
        ));
    }
    if height <= 0.0 || height.is_nan() {
        return Err(PackError::EngineFailed(
            "rect: height must be positive".into(),
        ));
    }
    Ok(vec![
        Point2D::new(0.0, 0.0),
        Point2D::new(width, 0.0),
        Point2D::new(width, height),
        Point2D::new(0.0, height),
    ])
}

/// N-gon approximation of a circle. `segments` defaults to 24 to match
/// the TS-side default. Anchored at (0,0) after normalisation.
/// Mirrors `buildCircle` in buildPart.ts.
fn build_circle(spec: &ShapeSpec) -> Result<Vec<Point2D>, PackError> {
    let diameter = read_f64(&spec.params, "diameter")?;
    let segments = read_optional_usize(&spec.params, "segments")?.unwrap_or(24);
    if diameter <= 0.0 || diameter.is_nan() {
        return Err(PackError::EngineFailed(
            "circle: diameter must be positive".into(),
        ));
    }
    if segments < 8 {
        return Err(PackError::EngineFailed(
            "circle: segments must be at least 8".into(),
        ));
    }
    let r = diameter / 2.0;
    let mut pts = Vec::with_capacity(segments);
    for i in 0..segments {
        let theta = 2.0 * std::f64::consts::PI * (i as f64) / (segments as f64);
        pts.push(Point2D::new(r + r * theta.cos(), r + r * theta.sin()));
    }
    Ok(normalize_polygon(pts))
}

/// Tapered trapezoid. Inset edges so `topWidth` and `bottomWidth`
/// align by their centres. Mirrors `buildTrapezoid` in buildPart.ts.
fn build_trapezoid(spec: &ShapeSpec) -> Result<Vec<Point2D>, PackError> {
    let top_w = read_f64(&spec.params, "topWidth")?;
    let bot_w = read_f64(&spec.params, "bottomWidth")?;
    let height = read_f64(&spec.params, "height")?;
    if top_w <= 0.0 || top_w.is_nan() {
        return Err(PackError::EngineFailed(
            "trapezoid: topWidth must be positive".into(),
        ));
    }
    if bot_w <= 0.0 || bot_w.is_nan() {
        return Err(PackError::EngineFailed(
            "trapezoid: bottomWidth must be positive".into(),
        ));
    }
    if height <= 0.0 || height.is_nan() {
        return Err(PackError::EngineFailed(
            "trapezoid: height must be positive".into(),
        ));
    }
    let max_w = top_w.max(bot_w);
    let top_offset = (max_w - top_w) / 2.0;
    let bot_offset = (max_w - bot_w) / 2.0;
    Ok(normalize_polygon(vec![
        Point2D::new(bot_offset, 0.0),
        Point2D::new(bot_offset + bot_w, 0.0),
        Point2D::new(top_offset + top_w, height),
        Point2D::new(top_offset, height),
    ]))
}

/// Regular polygon with `sides` vertices on a circle of `radius`.
/// First vertex at angle −π/2 (top of bbox after normalisation).
/// Mirrors `buildNGon` in buildPart.ts (sides ≥ 3, no upper bound).
fn build_ngon(spec: &ShapeSpec) -> Result<Vec<Point2D>, PackError> {
    let sides = read_usize(&spec.params, "sides")?;
    let radius = read_f64(&spec.params, "radius")?;
    if sides < 3 {
        return Err(PackError::EngineFailed(format!(
            "ngon: sides must be at least 3, got {}",
            sides
        )));
    }
    if radius <= 0.0 || radius.is_nan() {
        return Err(PackError::EngineFailed(
            "ngon: radius must be positive".into(),
        ));
    }
    let mut pts = Vec::with_capacity(sides);
    for i in 0..sides {
        let a =
            2.0 * std::f64::consts::PI * (i as f64) / (sides as f64) - std::f64::consts::FRAC_PI_2;
        pts.push(Point2D::new(radius * a.cos(), radius * a.sin()));
    }
    Ok(normalize_polygon(pts))
}

// ── Helpers ──────────────────────────────────────────────────────────

fn read_f64(params: &HashMap<String, serde_json::Value>, key: &str) -> Result<f64, PackError> {
    params.get(key).and_then(|v| v.as_f64()).ok_or_else(|| {
        PackError::EngineFailed(format!("shape_spec missing or non-numeric param '{}'", key))
    })
}

fn read_usize(params: &HashMap<String, serde_json::Value>, key: &str) -> Result<usize, PackError> {
    let n = read_f64(params, key)?;
    if n < 0.0 || n.is_nan() {
        return Err(PackError::EngineFailed(format!(
            "shape_spec param '{}' must be non-negative",
            key
        )));
    }
    Ok(n as usize)
}

fn read_optional_usize(
    params: &HashMap<String, serde_json::Value>,
    key: &str,
) -> Result<Option<usize>, PackError> {
    let Some(v) = params.get(key) else {
        return Ok(None);
    };
    let Some(n) = v.as_f64() else {
        return Err(PackError::EngineFailed(format!(
            "shape_spec param '{}' must be numeric",
            key
        )));
    };
    if n < 0.0 || n.is_nan() {
        return Err(PackError::EngineFailed(format!(
            "shape_spec param '{}' must be non-negative",
            key
        )));
    }
    Ok(Some(n as usize))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ShapeSpec;
    use serde_json::json;
    use std::collections::HashMap;

    fn spec(kind: &str, params: serde_json::Value) -> ShapeSpec {
        let mut map = HashMap::new();
        if let serde_json::Value::Object(obj) = params {
            for (k, v) in obj {
                map.insert(k, v);
            }
        }
        ShapeSpec {
            kind: kind.to_string(),
            params: map,
        }
    }

    fn part_with_spec(s: ShapeSpec) -> Part {
        Part {
            shape_id: "test".to_string(),
            quantity: 1,
            polygon: None,
            shape_spec: Some(s),
            allow_rotation: true,
            grain_axis: None,
            difficulty: None,
            tag: None,
        }
    }

    // ── build_rect ──
    #[test]
    fn build_rect_produces_four_corner_quad() {
        let s = spec("rect", json!({"width": 5.0, "height": 3.0}));
        let pts = build_rect(&s).unwrap();
        assert_eq!(pts.len(), 4);
        // CCW from origin: (0,0), (5,0), (5,3), (0,3).
        assert!((pts[0].x - 0.0).abs() < 1e-9 && (pts[0].y - 0.0).abs() < 1e-9);
        assert!((pts[1].x - 5.0).abs() < 1e-9 && (pts[1].y - 0.0).abs() < 1e-9);
        assert!((pts[2].x - 5.0).abs() < 1e-9 && (pts[2].y - 3.0).abs() < 1e-9);
        assert!((pts[3].x - 0.0).abs() < 1e-9 && (pts[3].y - 3.0).abs() < 1e-9);
    }

    #[test]
    fn build_rect_rejects_non_positive_dimensions() {
        let bad_w = spec("rect", json!({"width": 0.0, "height": 1.0}));
        assert!(build_rect(&bad_w).is_err());
        let bad_h = spec("rect", json!({"width": 1.0, "height": -2.0}));
        assert!(build_rect(&bad_h).is_err());
    }

    #[test]
    fn build_rect_rejects_missing_dimensions() {
        let s = spec("rect", json!({"width": 5.0})); // height missing
        assert!(build_rect(&s).is_err());
    }

    // ── build_circle ──
    #[test]
    fn build_circle_produces_n_vertices_centred_at_radius() {
        let s = spec("circle", json!({"diameter": 10.0, "segments": 24}));
        let pts = build_circle(&s).unwrap();
        assert_eq!(pts.len(), 24);
        // Every vertex sits at distance r from the centre (r, r) (after
        // normalisation min=0 the centre stays at (r, r) since the raw
        // points already have minX=0, minY=0 thanks to the +r offset).
        let r = 5.0;
        for p in &pts {
            let d = ((p.x - r).powi(2) + (p.y - r).powi(2)).sqrt();
            assert!(
                (d - r).abs() < 1e-6,
                "vertex {:?} sits at distance {} from ({}, {}) — expected {}",
                p,
                d,
                r,
                r,
                r
            );
        }
    }

    #[test]
    fn build_circle_default_segments_is_24() {
        let s = spec("circle", json!({"diameter": 10.0}));
        let pts = build_circle(&s).unwrap();
        assert_eq!(pts.len(), 24);
    }

    #[test]
    fn build_circle_rejects_too_few_segments() {
        let s = spec("circle", json!({"diameter": 10.0, "segments": 4}));
        assert!(build_circle(&s).is_err());
    }

    #[test]
    fn build_circle_rejects_non_positive_diameter() {
        let s = spec("circle", json!({"diameter": 0.0}));
        assert!(build_circle(&s).is_err());
    }

    // ── build_trapezoid ──
    #[test]
    fn build_trapezoid_centred_via_max_width() {
        // top=4, bottom=8, height=6: bottom anchored at x∈[0,8] on y=0;
        // top inset by 2 each side at y=6 (i.e. x∈[2,6]).
        let s = spec(
            "trapezoid",
            json!({"topWidth": 4.0, "bottomWidth": 8.0, "height": 6.0}),
        );
        let pts = build_trapezoid(&s).unwrap();
        assert_eq!(pts.len(), 4);
        // Find the bottom-left and top-left points (by y = 0 / y = 6).
        // Order is normalisation-dependent; we just check the polygon
        // contains the expected corners regardless of winding.
        let mut found_bl = false;
        let mut found_br = false;
        let mut found_tl = false;
        let mut found_tr = false;
        for p in &pts {
            if (p.y - 0.0).abs() < 1e-9 {
                if (p.x - 0.0).abs() < 1e-9 {
                    found_bl = true;
                }
                if (p.x - 8.0).abs() < 1e-9 {
                    found_br = true;
                }
            }
            if (p.y - 6.0).abs() < 1e-9 {
                if (p.x - 2.0).abs() < 1e-9 {
                    found_tl = true;
                }
                if (p.x - 6.0).abs() < 1e-9 {
                    found_tr = true;
                }
            }
        }
        assert!(
            found_bl && found_br && found_tl && found_tr,
            "trapezoid corners missing: bl={} br={} tl={} tr={}",
            found_bl,
            found_br,
            found_tl,
            found_tr
        );
    }

    #[test]
    fn build_trapezoid_rejects_non_positive_inputs() {
        let bad = spec(
            "trapezoid",
            json!({"topWidth": -1.0, "bottomWidth": 5.0, "height": 3.0}),
        );
        assert!(build_trapezoid(&bad).is_err());
    }

    // ── build_ngon ──
    #[test]
    fn build_ngon_produces_n_vertices_at_radius() {
        let s = spec("ngon", json!({"sides": 6.0, "radius": 3.0}));
        let pts = build_ngon(&s).unwrap();
        assert_eq!(pts.len(), 6);
        // All vertices should sit on a circle of radius 3 around the
        // bbox centre. Bbox after normalisation is 2r × 2r-ish (with
        // some asymmetry for odd sides — a hexagon's bbox is exactly
        // 2r wide and r√3 tall, so the centre is (r, r√3/2)).
        // Easier: check that *every* vertex lies on a circle of radius
        // r around the centroid of the polygon (the regular polygon
        // centroid coincides with its circumscribing circle centre).
        let cx = pts.iter().map(|p| p.x).sum::<f64>() / pts.len() as f64;
        let cy = pts.iter().map(|p| p.y).sum::<f64>() / pts.len() as f64;
        for p in &pts {
            let d = ((p.x - cx).powi(2) + (p.y - cy).powi(2)).sqrt();
            assert!((d - 3.0).abs() < 1e-6, "vertex {:?} not on r=3 circle", p);
        }
    }

    #[test]
    fn build_ngon_rejects_too_few_sides() {
        let s = spec("ngon", json!({"sides": 2.0, "radius": 1.0}));
        assert!(build_ngon(&s).is_err());
    }

    #[test]
    fn build_ngon_accepts_large_sides_count() {
        // Mirrors buildPart.ts: no upper bound on sides. (TS-side
        // shape-to-polygon clamps to 32, but buildPart does not, and
        // the autonest Rust pipeline follows buildPart.)
        let s = spec("ngon", json!({"sides": 64.0, "radius": 5.0}));
        let pts = build_ngon(&s).unwrap();
        assert_eq!(pts.len(), 64);
    }

    #[test]
    fn build_ngon_rejects_non_positive_radius() {
        let s = spec("ngon", json!({"sides": 6.0, "radius": 0.0}));
        assert!(build_ngon(&s).is_err());
    }

    // ── build_polygon_from_spec dispatch ──
    #[test]
    fn build_polygon_from_spec_dispatches_to_sector_for_sector_kind() {
        let s = spec(
            "sector",
            json!({"innerRadius": 3.0, "outerRadius": 6.0, "arcDegrees": 120.0, "segments": 24}),
        );
        let from_dispatch = build_polygon_from_spec(&s, ConePackingMode::default()).unwrap();
        let from_direct = build_sector_polygon_from_spec(&s, ConePackingMode::default()).unwrap();
        assert_eq!(from_dispatch.len(), from_direct.len());
        for (a, b) in from_dispatch.iter().zip(from_direct.iter()) {
            assert!((a.x - b.x).abs() < 1e-12);
            assert!((a.y - b.y).abs() < 1e-12);
        }
    }

    #[test]
    fn build_polygon_from_spec_errors_on_unknown_kind() {
        let s = spec("banana", json!({}));
        let err = build_polygon_from_spec(&s, ConePackingMode::default()).unwrap_err();
        let msg = format!("{:?}", err);
        assert!(
            msg.contains("banana"),
            "error should mention the kind: {}",
            msg
        );
    }

    // ── materialise_polygon ──
    #[test]
    fn materialise_polygon_passes_through_literal() {
        let pts = vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(1.0, 0.0),
            Point2D::new(1.0, 1.0),
            Point2D::new(0.0, 1.0),
        ];
        let part = Part {
            shape_id: "lit".into(),
            quantity: 1,
            polygon: Some(pts.clone()),
            shape_spec: None,
            allow_rotation: false,
            grain_axis: None,
            difficulty: None,
            tag: None,
        };
        let got = materialise_polygon(&part).unwrap();
        assert_eq!(got, pts);
    }

    #[test]
    fn materialise_polygon_builds_from_spec_for_each_kind() {
        for (kind, params) in &[
            ("rect", json!({"width": 4.0, "height": 2.0})),
            ("circle", json!({"diameter": 6.0})),
            (
                "trapezoid",
                json!({"topWidth": 3.0, "bottomWidth": 5.0, "height": 2.0}),
            ),
            ("ngon", json!({"sides": 5.0, "radius": 2.0})),
            (
                "sector",
                json!({"innerRadius": 1.0, "outerRadius": 4.0, "arcDegrees": 90.0, "segments": 24}),
            ),
        ] {
            let part = part_with_spec(spec(kind, params.clone()));
            let pts = materialise_polygon(&part)
                .unwrap_or_else(|e| panic!("kind {} failed: {:?}", kind, e));
            assert!(pts.len() >= 3, "kind {}: only {} verts", kind, pts.len());
        }
    }

    #[test]
    fn materialise_polygon_errors_when_no_polygon_and_no_spec() {
        let part = Part {
            shape_id: "naked".into(),
            quantity: 1,
            polygon: None,
            shape_spec: None,
            allow_rotation: false,
            grain_axis: None,
            difficulty: None,
            tag: None,
        };
        assert!(materialise_polygon(&part).is_err());
    }

    // ── materialise_request_polygons ──
    #[test]
    fn materialise_request_polygons_handles_mixed_kind_request() {
        // Build the request via JSON to avoid coupling this test to the
        // exact field set of PackRequest (which has grown over time).
        let parts = vec![
            ("rect", json!({"width": 4.0, "height": 2.0})),
            ("circle", json!({"diameter": 6.0})),
            (
                "trapezoid",
                json!({"topWidth": 3.0, "bottomWidth": 5.0, "height": 2.0}),
            ),
            ("ngon", json!({"sides": 6.0, "radius": 2.0})),
            (
                "sector",
                json!({"innerRadius": 1.0, "outerRadius": 4.0, "arcDegrees": 90.0, "segments": 24}),
            ),
        ];
        let items_json: Vec<serde_json::Value> = parts
            .iter()
            .enumerate()
            .map(|(i, (kind, params))| {
                json!({
                    "shapeId": format!("p{}", i),
                    "quantity": 1,
                    "shapeSpec": { "kind": kind, "params": params },
                    "allowRotation": true,
                })
            })
            .collect();
        let request_json = json!({
            "bins": [{ "binId": "b0", "width": 96.0, "height": 48.0, "kind": "fresh" }],
            "clearance": 0.0,
            "items": items_json,
        });
        let mut request: PackRequest =
            serde_json::from_value(request_json).expect("PackRequest json parses");

        materialise_request_polygons(&mut request).unwrap();
        for (i, p) in request.items.iter().enumerate() {
            assert!(p.polygon.is_some(), "item {} polygon was not populated", i);
            let n = p.polygon.as_ref().unwrap().len();
            assert!(n >= 3, "item {} only got {} verts", i, n);
        }
    }
}
