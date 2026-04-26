// engine/crates/rf-layout/src/application/cone_strategy.rs
//
// Cone (sector) polygon strategy.
//
// Cones placed by jagua-rs were physically overlapping each other on
// screen because the TS-built annular-sector polygon is concave, and
// jagua's surrogate (2 inscribed-circle poles + 0 piers, see
// `jagua_adapter.rs:62-70`) cannot represent the inner-radius notch
// — two cones whose bodies fit into each other's notches pass
// surrogate collision and get placed overlapping in fact.
//
// Fix is two-fold:
//
//   1. **Pack against the convex hull.** Both strategies feed jagua a
//      convex hull of the annular sector. Jagua's surrogate is exact
//      for convex shapes, so collision detection is correct.
//
//   2. **Strategy pattern for the render polygon.** What the
//      visualizer paints is decoupled from what jagua collides:
//
//      * `ConvexWedge` — pack and render are the same convex hull.
//        Cones display as solid wedges. Density loss vs concave
//        packing that would have nested them.
//      * `AnnularSector` — pack is the convex hull; render is the
//        real annular crescent the operator will cut. Higher fidelity.
//
// Strategy choice is wire-driven via `PackRequest.cone_strategy`
// (URL-param-resolved on the TS side). Mirrors the existing
// `NestingStrategy` pattern in `application/strategy.rs` — explicit
// trait + factory, not a bare match (memory
// `feedback_strategy_pattern_swappable_engines`).

use rf_geom::domain::Point2D;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::domain::{PackError, PackRequest, Part, ShapeSpec};

/// Default subdivision count for the outer/inner arcs when the caller
/// omits `segments` from the shape spec. Matches the TS-side default
/// in `src/lib/packing/buildPart.ts`.
pub const DEFAULT_CONE_SEGMENTS: usize = 24;

/// Geometric parameters parsed out of a `kind: "sector"` shape spec.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ConeDimensions {
    pub inner_radius: f64,
    pub outer_radius: f64,
    pub arc_degrees: f64,
    pub segments: usize,
}

/// Wire-format identifier for the active cone strategy. Serialised on
/// `PackRequest.cone_strategy`; absent means `AnnularSector`
/// (high-fidelity render is the production default).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ConeStrategyKind {
    ConvexWedge,
    #[default]
    AnnularSector,
}

/// One cone polygon strategy. `pack_polygon` is what jagua-rs uses
/// for collision detection; `render_polygon_local` is what the
/// visualizer should paint (in part-local coords — the pack
/// pipeline applies the placement transform via the same
/// `apply_dtransformation_to_point` used for the pack polygon, so
/// pack and render polygons go through bit-identical transform
/// math and cannot drift apart at runtime).
///
/// Splitting pack vs render lets us collide on a convex hull
/// (jagua's surrogate is exact) while still rendering the real
/// annular crescent the operator will cut.
pub trait ConePolygonStrategy: Send + Sync + 'static {
    /// Stable identifier for logs and parity-test assertions.
    fn name(&self) -> &'static str;

    /// Convex polygon used by jagua for collision detection.
    /// Normalized so minX = minY = 0, CCW-wound.
    fn pack_polygon(&self, d: ConeDimensions) -> Result<Vec<Point2D>, PackError>;

    /// Render polygon in part-local coords (normalized to
    /// minX = minY = 0, same frame as `pack_polygon`). The pack
    /// pipeline applies the placement transform after this call.
    /// `None` means "use the (already-transformed) pack polygon
    /// as-is" — the convex-wedge strategy returns that.
    fn render_polygon_local(&self, d: ConeDimensions) -> Option<Vec<Point2D>>;
}

/// Cones display as solid convex wedges. Pack and render are the same
/// polygon — cheaper to draw, slight density loss vs the annular
/// strategy when many cones could nest into each other's notches.
pub struct ConvexWedgeStrategy;

/// Cones display as the real annular crescent. Pack is still the
/// convex hull (so jagua's surrogate is exact), but render is the
/// concave annular polygon the operator actually cuts.
pub struct AnnularSectorStrategy;

impl ConePolygonStrategy for ConvexWedgeStrategy {
    fn name(&self) -> &'static str {
        "convex_wedge"
    }

    fn pack_polygon(&self, d: ConeDimensions) -> Result<Vec<Point2D>, PackError> {
        build_cone_convex_hull(d)
    }

    fn render_polygon_local(&self, _d: ConeDimensions) -> Option<Vec<Point2D>> {
        None // pack polygon == render polygon for wedge strategy
    }
}

impl ConePolygonStrategy for AnnularSectorStrategy {
    fn name(&self) -> &'static str {
        "annular_sector"
    }

    fn pack_polygon(&self, d: ConeDimensions) -> Result<Vec<Point2D>, PackError> {
        build_cone_convex_hull(d)
    }

    fn render_polygon_local(&self, d: ConeDimensions) -> Option<Vec<Point2D>> {
        Some(
            build_annular_sector_normalized(d)
                .expect("annular sector geometry validated when ConeDimensions was parsed"),
        )
    }
}

/// Map a `ConeStrategyKind` to a concrete strategy. New strategy =
/// new struct + impl + one extra match arm here, nothing else.
pub fn cone_strategy_for(kind: ConeStrategyKind) -> Box<dyn ConePolygonStrategy> {
    match kind {
        ConeStrategyKind::ConvexWedge => Box::new(ConvexWedgeStrategy),
        ConeStrategyKind::AnnularSector => Box::new(AnnularSectorStrategy),
    }
}

/// Read cone dimensions out of a `sector` shape spec. `segments`
/// defaults to 24 (matching the TS-side default) when absent.
pub fn parse_cone_dimensions(spec: &ShapeSpec) -> Result<ConeDimensions, PackError> {
    if spec.kind != "sector" {
        return Err(PackError::EngineFailed(format!(
            "parse_cone_dimensions: expected kind 'sector', got '{}'",
            spec.kind
        )));
    }
    let inner_radius = read_f64(&spec.params, "innerRadius")?;
    let outer_radius = read_f64(&spec.params, "outerRadius")?;
    let arc_degrees = read_f64(&spec.params, "arcDegrees")?;
    let segments = spec
        .params
        .get("segments")
        .and_then(|v| v.as_f64())
        .map(|f| f as usize)
        .unwrap_or(DEFAULT_CONE_SEGMENTS);

    if !(outer_radius > inner_radius) {
        return Err(PackError::EngineFailed(format!(
            "cone: outerRadius ({}) must exceed innerRadius ({})",
            outer_radius, inner_radius
        )));
    }
    if inner_radius < 0.0 {
        return Err(PackError::EngineFailed(format!(
            "cone: innerRadius must be non-negative, got {}",
            inner_radius
        )));
    }
    if !(arc_degrees > 0.0 && arc_degrees < 360.0) {
        return Err(PackError::EngineFailed(format!(
            "cone: arcDegrees must be in (0, 360), got {}",
            arc_degrees
        )));
    }
    if segments < 2 {
        return Err(PackError::EngineFailed(format!(
            "cone: segments must be at least 2, got {}",
            segments
        )));
    }

    Ok(ConeDimensions {
        inner_radius,
        outer_radius,
        arc_degrees,
        segments,
    })
}

/// Returns `Some(dims)` when the part is a cone (sector shape spec),
/// `None` otherwise. Errors during parsing surface as `None` here —
/// the pack pipeline materialises the polygon up front via
/// `materialise_polygon`, which propagates parse errors there.
pub fn cone_dims_from_part(part: &Part) -> Option<ConeDimensions> {
    let spec = part.shape_spec.as_ref()?;
    if spec.kind != "sector" {
        return None;
    }
    parse_cone_dimensions(spec).ok()
}

/// Walk every part in the request and fill in any missing polygon
/// from its shape spec. Pack pipelines call this once on entry so
/// downstream search/jagua code can assume `Part.polygon` is `Some`.
pub fn materialise_request_polygons(request: &mut PackRequest) -> Result<(), PackError> {
    for part in &mut request.items {
        if part
            .shape_spec
            .as_ref()
            .is_some_and(|spec| spec.kind == "sector")
        {
            part.polygon = Some(materialise_sector_polygon_from_spec(part)?);
            continue;
        }
        if part.polygon.is_some() {
            continue;
        }
        part.polygon = Some(materialise_polygon(part)?);
    }
    Ok(())
}

/// Resolve a part's pack polygon. Returns the literal polygon when
/// present, otherwise materialises one from the shape spec.
///
/// Currently only `kind: "sector"` (cones) are spec-only — every
/// other shape still ships its polygon from TS. Adding a new
/// spec-only shape: extend the `match` here.
pub fn materialise_polygon(part: &Part) -> Result<Vec<Point2D>, PackError> {
    if let Some(p) = &part.polygon {
        return Ok(p.clone());
    }
    materialise_sector_polygon_from_spec(part)
}

fn materialise_sector_polygon_from_spec(part: &Part) -> Result<Vec<Point2D>, PackError> {
    let spec = part.shape_spec.as_ref().ok_or_else(|| {
        PackError::EngineFailed(format!(
            "part '{}' has neither polygon nor shape_spec",
            part.shape_id
        ))
    })?;
    match spec.kind.as_str() {
        "sector" => {
            let d = parse_cone_dimensions(spec)?;
            build_cone_convex_hull(d)
        }
        other => Err(PackError::EngineFailed(format!(
            "part '{}' has shape_spec.kind '{}' but no polygon; only 'sector' is constructed Rust-side today",
            part.shape_id, other,
        ))),
    }
}

// ── Private builders ──────────────────────────────────────────────

fn read_f64(params: &HashMap<String, serde_json::Value>, key: &str) -> Result<f64, PackError> {
    params.get(key).and_then(|v| v.as_f64()).ok_or_else(|| {
        PackError::EngineFailed(format!(
            "cone shape_spec missing or non-numeric param '{}'",
            key
        ))
    })
}

/// Raw annular-sector vertices, origin-centered with the lower-radius
/// edge along the +x axis. NOT normalized — caller decides whether to
/// translate to minX = minY = 0 here or after a placement transform.
///
/// Order: outer arc from angle 0 to `arcRad` (segments+1 vertices),
/// then inner arc from `arcRad` back to 0 (segments+1 vertices) — so
/// the polygon is CCW in math coords and concave wherever
/// `innerRadius > 0`.
fn build_annular_sector_raw(d: ConeDimensions) -> Result<Vec<Point2D>, PackError> {
    let arc_rad = d.arc_degrees.to_radians();
    let step = arc_rad / d.segments as f64;
    let mut points = Vec::with_capacity(2 * (d.segments + 1));
    for i in 0..=d.segments {
        let a = i as f64 * step;
        points.push(Point2D::new(
            d.outer_radius * a.cos(),
            d.outer_radius * a.sin(),
        ));
    }
    for i in (0..=d.segments).rev() {
        let a = i as f64 * step;
        points.push(Point2D::new(
            d.inner_radius * a.cos(),
            d.inner_radius * a.sin(),
        ));
    }
    Ok(points)
}

/// Annular-sector polygon translated so minX = minY = 0, CCW-wound.
/// This is what the AnnularSector strategy renders (after applying
/// the placement transform).
fn build_annular_sector_normalized(d: ConeDimensions) -> Result<Vec<Point2D>, PackError> {
    let raw = build_annular_sector_raw(d)?;
    Ok(normalize_polygon(raw))
}

/// Convex hull of the annular sector, normalized to minX = minY = 0,
/// CCW-wound. This is what jagua collides on.
fn build_cone_convex_hull(d: ConeDimensions) -> Result<Vec<Point2D>, PackError> {
    let raw = build_annular_sector_raw(d)?;
    let hull = convex_hull(&raw);
    Ok(normalize_polygon(hull))
}

/// Translate so minX = minY = 0, then ensure CCW winding. Mirrors
/// `normalizePolygon` + `ensureCCW` in `src/lib/packing/buildPart.ts`.
fn normalize_polygon(points: Vec<Point2D>) -> Vec<Point2D> {
    if points.is_empty() {
        return points;
    }
    let min_x = points.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
    let min_y = points.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
    let translated: Vec<Point2D> = points
        .into_iter()
        .map(|p| Point2D::new(p.x - min_x, p.y - min_y))
        .collect();
    ensure_ccw(translated)
}

fn ensure_ccw(points: Vec<Point2D>) -> Vec<Point2D> {
    let n = points.len();
    if n < 3 {
        return points;
    }
    // Trapezoid signed-area: positive == CW in screen (y-down) coords.
    // Reverse to get CCW so jagua/rf-geom consumers see the standard
    // math-coord winding the rest of the codebase produces.
    let mut signed = 0.0;
    for i in 0..n {
        let a = points[i];
        let b = points[(i + 1) % n];
        signed += (b.x - a.x) * (b.y + a.y);
    }
    if signed > 0.0 {
        let mut rev = points;
        rev.reverse();
        rev
    } else {
        points
    }
}

/// Andrew's monotone chain. Returns the convex hull in CCW order
/// (math coords). Strictly inside-collinear points are dropped via
/// the `cross <= 0.0` test, so the hull is minimal.
fn convex_hull(points: &[Point2D]) -> Vec<Point2D> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut sorted: Vec<Point2D> = points.to_vec();
    sorted.sort_by(|a, b| {
        a.x.partial_cmp(&b.x)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal))
    });
    sorted.dedup_by(|a, b| (a.x - b.x).abs() < 1e-12 && (a.y - b.y).abs() < 1e-12);
    let n = sorted.len();
    if n < 3 {
        return sorted;
    }

    let mut hull: Vec<Point2D> = Vec::with_capacity(2 * n);
    // Lower hull.
    for &p in &sorted {
        while hull.len() >= 2 && cross(hull[hull.len() - 2], hull[hull.len() - 1], p) <= 0.0 {
            hull.pop();
        }
        hull.push(p);
    }
    // Upper hull.
    let lower_len = hull.len() + 1;
    for &p in sorted.iter().rev().skip(1) {
        while hull.len() >= lower_len && cross(hull[hull.len() - 2], hull[hull.len() - 1], p) <= 0.0
        {
            hull.pop();
        }
        hull.push(p);
    }
    hull.pop(); // last point equals the first
    hull
}

fn cross(o: Point2D, a: Point2D, b: Point2D) -> f64 {
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dims(inner: f64, outer: f64, deg: f64, segs: usize) -> ConeDimensions {
        ConeDimensions {
            inner_radius: inner,
            outer_radius: outer,
            arc_degrees: deg,
            segments: segs,
        }
    }

    fn approx_eq(a: f64, b: f64, eps: f64) -> bool {
        (a - b).abs() < eps
    }

    #[test]
    fn convex_wedge_strategy_name() {
        assert_eq!(ConvexWedgeStrategy.name(), "convex_wedge");
    }

    #[test]
    fn annular_sector_strategy_name() {
        assert_eq!(AnnularSectorStrategy.name(), "annular_sector");
    }

    #[test]
    fn factory_dispatches_to_named_impl() {
        assert_eq!(
            cone_strategy_for(ConeStrategyKind::ConvexWedge).name(),
            "convex_wedge"
        );
        assert_eq!(
            cone_strategy_for(ConeStrategyKind::AnnularSector).name(),
            "annular_sector"
        );
    }

    #[test]
    fn default_strategy_kind_is_annular_sector() {
        assert_eq!(ConeStrategyKind::default(), ConeStrategyKind::AnnularSector);
    }

    #[test]
    fn pack_polygon_has_segments_plus_three_vertices_for_120_deg() {
        // 24 outer-arc vertices + 1 outer endpoint + 2 inner endpoints
        // = 27. The full annular polygon has 50; the convex hull drops
        // the 23 interior inner-arc points.
        let d = dims(3.0, 6.0, 120.0, 24);
        let hull = ConvexWedgeStrategy.pack_polygon(d).unwrap();
        assert_eq!(
            hull.len(),
            27,
            "hull should be 27 vertices for arc=120°, segs=24"
        );
    }

    #[test]
    fn render_polygon_local_for_annular_has_50_vertices() {
        let d = dims(3.0, 6.0, 120.0, 24);
        let render = AnnularSectorStrategy
            .render_polygon_local(d)
            .expect("annular strategy returns Some");
        assert_eq!(render.len(), 50, "annular polygon = 2 * (segs+1) = 50");
    }

    #[test]
    fn convex_wedge_render_local_returns_none() {
        let d = dims(3.0, 6.0, 120.0, 24);
        let render = ConvexWedgeStrategy.render_polygon_local(d);
        assert!(
            render.is_none(),
            "wedge strategy reuses pack polygon — local render = None"
        );
    }

    #[test]
    fn parse_cone_dimensions_round_trip() {
        let mut params = HashMap::new();
        params.insert("innerRadius".into(), serde_json::json!(3.0));
        params.insert("outerRadius".into(), serde_json::json!(6.0));
        params.insert("arcDegrees".into(), serde_json::json!(120.0));
        params.insert("segments".into(), serde_json::json!(24));
        let spec = ShapeSpec {
            kind: "sector".into(),
            params,
        };
        let d = parse_cone_dimensions(&spec).unwrap();
        assert_eq!(d.inner_radius, 3.0);
        assert_eq!(d.outer_radius, 6.0);
        assert_eq!(d.arc_degrees, 120.0);
        assert_eq!(d.segments, 24);
    }

    #[test]
    fn parse_cone_dimensions_defaults_segments_to_24() {
        let mut params = HashMap::new();
        params.insert("innerRadius".into(), serde_json::json!(3.0));
        params.insert("outerRadius".into(), serde_json::json!(6.0));
        params.insert("arcDegrees".into(), serde_json::json!(120.0));
        // segments intentionally omitted — matches AutoNest.tsx wire format.
        let spec = ShapeSpec {
            kind: "sector".into(),
            params,
        };
        let d = parse_cone_dimensions(&spec).unwrap();
        assert_eq!(d.segments, DEFAULT_CONE_SEGMENTS);
    }

    #[test]
    fn parse_cone_dimensions_rejects_outer_le_inner() {
        let mut params = HashMap::new();
        params.insert("innerRadius".into(), serde_json::json!(6.0));
        params.insert("outerRadius".into(), serde_json::json!(3.0));
        params.insert("arcDegrees".into(), serde_json::json!(120.0));
        let spec = ShapeSpec {
            kind: "sector".into(),
            params,
        };
        assert!(parse_cone_dimensions(&spec).is_err());
    }

    #[test]
    fn parse_cone_dimensions_rejects_arc_at_or_above_360() {
        let mut params = HashMap::new();
        params.insert("innerRadius".into(), serde_json::json!(3.0));
        params.insert("outerRadius".into(), serde_json::json!(6.0));
        params.insert("arcDegrees".into(), serde_json::json!(360.0));
        let spec = ShapeSpec {
            kind: "sector".into(),
            params,
        };
        assert!(parse_cone_dimensions(&spec).is_err());
    }

    #[test]
    fn parse_cone_dimensions_rejects_wrong_kind() {
        let spec = ShapeSpec {
            kind: "rect".into(),
            params: HashMap::new(),
        };
        assert!(parse_cone_dimensions(&spec).is_err());
    }

    #[test]
    fn pack_polygon_is_normalized_to_origin() {
        let d = dims(3.0, 6.0, 120.0, 24);
        let hull = ConvexWedgeStrategy.pack_polygon(d).unwrap();
        let min_x = hull.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
        let min_y = hull.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
        assert!(
            approx_eq(min_x, 0.0, 1e-12),
            "minX should be 0, got {}",
            min_x
        );
        assert!(
            approx_eq(min_y, 0.0, 1e-12),
            "minY should be 0, got {}",
            min_y
        );
    }

    #[test]
    fn render_polygon_local_normalized_to_origin() {
        let d = dims(3.0, 6.0, 120.0, 24);
        let render = AnnularSectorStrategy
            .render_polygon_local(d)
            .expect("annular returns Some");
        let min_x = render.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
        let min_y = render.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
        assert!(
            approx_eq(min_x, 0.0, 1e-12),
            "minX should be 0, got {}",
            min_x
        );
        assert!(
            approx_eq(min_y, 0.0, 1e-12),
            "minY should be 0, got {}",
            min_y
        );
    }

    #[test]
    fn pack_and_render_share_same_bbox() {
        // Hull and annular share the same bbox in part-local coords —
        // they include the same outer-arc extreme points. This is the
        // load-bearing invariant that lets the pack pipeline apply a
        // single transform to both polygons and have them stay aligned.
        let d = dims(3.0, 6.0, 120.0, 24);
        let hull = AnnularSectorStrategy.pack_polygon(d).unwrap();
        let render = AnnularSectorStrategy
            .render_polygon_local(d)
            .expect("annular returns Some");

        let bbox = |poly: &[Point2D]| {
            let min_x = poly.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
            let min_y = poly.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
            let max_x = poly.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
            let max_y = poly.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
            (min_x, min_y, max_x, max_y)
        };
        let (hx0, hy0, hx1, hy1) = bbox(&hull);
        let (rx0, ry0, rx1, ry1) = bbox(&render);
        assert!(approx_eq(hx0, rx0, 1e-9));
        assert!(approx_eq(hy0, ry0, 1e-9));
        assert!(approx_eq(hx1, rx1, 1e-9));
        assert!(approx_eq(hy1, ry1, 1e-9));
    }

    #[test]
    fn every_annular_vertex_is_inside_hull_in_local_coords() {
        // The bug we shipped this overlay to diagnose: render polygon
        // (annular crescent) was rendering OUTSIDE the pack polygon
        // (convex hull). Mathematically the annular MUST be a subset
        // of the hull because the hull is the convex closure of the
        // annular's vertex set. This test asserts that invariant in
        // part-local coords; the visualizer aligns the two via the
        // SAME `apply_dtransformation_to_point` call in the pack
        // pipeline, so if this passes, the rendered polygons stay
        // aligned in bin-local coords too.
        let d = dims(3.0, 6.0, 120.0, 24);
        let hull = AnnularSectorStrategy.pack_polygon(d).unwrap();
        let render = AnnularSectorStrategy
            .render_polygon_local(d)
            .expect("annular returns Some");

        for v in &render {
            assert!(
                point_in_polygon(*v, &hull),
                "annular vertex {:?} should lie inside hull",
                v
            );
        }
    }

    fn point_in_polygon(p: Point2D, polygon: &[Point2D]) -> bool {
        // Standard winding-number test with a small epsilon for
        // boundary-coincident vertices (every annular vertex on the
        // outer arc is also a hull vertex).
        let n = polygon.len();
        let mut inside = false;
        let mut j = n - 1;
        for i in 0..n {
            let pi = polygon[i];
            let pj = polygon[j];
            let on_boundary = (pi.x - p.x).abs() < 1e-9 && (pi.y - p.y).abs() < 1e-9;
            if on_boundary {
                return true;
            }
            if (pi.y > p.y) != (pj.y > p.y) {
                let slope = (p.y - pi.y) / (pj.y - pi.y);
                let xi = pi.x + slope * (pj.x - pi.x);
                if p.x < xi {
                    inside = !inside;
                }
            }
            j = i;
        }
        inside
    }

    #[test]
    fn cone_dims_from_part_returns_some_for_sector() {
        let mut params = HashMap::new();
        params.insert("innerRadius".into(), serde_json::json!(3.0));
        params.insert("outerRadius".into(), serde_json::json!(6.0));
        params.insert("arcDegrees".into(), serde_json::json!(120.0));
        let part = Part {
            shape_id: "cone-1".into(),
            quantity: 1,
            polygon: None,
            shape_spec: Some(ShapeSpec {
                kind: "sector".into(),
                params,
            }),
            allow_rotation: true,
            grain_axis: None,
            difficulty: None,
            tag: None,
        };
        let d = cone_dims_from_part(&part).expect("sector spec should parse");
        assert_eq!(d.outer_radius, 6.0);
    }

    #[test]
    fn cone_dims_from_part_returns_none_for_non_sector() {
        let part = Part {
            shape_id: "rect-1".into(),
            quantity: 1,
            polygon: Some(vec![
                Point2D::new(0.0, 0.0),
                Point2D::new(1.0, 0.0),
                Point2D::new(1.0, 1.0),
            ]),
            shape_spec: None,
            allow_rotation: true,
            grain_axis: None,
            difficulty: None,
            tag: None,
        };
        assert!(cone_dims_from_part(&part).is_none());
    }

    #[test]
    fn materialise_polygon_passes_through_literal() {
        let raw = vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(2.0, 0.0),
            Point2D::new(2.0, 1.0),
            Point2D::new(0.0, 1.0),
        ];
        let part = Part {
            shape_id: "rect-1".into(),
            quantity: 1,
            polygon: Some(raw.clone()),
            shape_spec: None,
            allow_rotation: true,
            grain_axis: None,
            difficulty: None,
            tag: None,
        };
        let got = materialise_polygon(&part).unwrap();
        assert_eq!(got, raw);
    }

    #[test]
    fn materialise_polygon_builds_hull_from_sector_spec() {
        let mut params = HashMap::new();
        params.insert("innerRadius".into(), serde_json::json!(3.0));
        params.insert("outerRadius".into(), serde_json::json!(6.0));
        params.insert("arcDegrees".into(), serde_json::json!(120.0));
        let part = Part {
            shape_id: "cone-1".into(),
            quantity: 1,
            polygon: None,
            shape_spec: Some(ShapeSpec {
                kind: "sector".into(),
                params,
            }),
            allow_rotation: true,
            grain_axis: None,
            difficulty: None,
            tag: None,
        };
        let got = materialise_polygon(&part).unwrap();
        assert_eq!(got.len(), 27);
    }

    #[test]
    fn materialise_request_polygons_replaces_legacy_sector_polygon_with_hull() {
        let mut params = HashMap::new();
        params.insert("innerRadius".into(), serde_json::json!(3.0));
        params.insert("outerRadius".into(), serde_json::json!(6.0));
        params.insert("arcDegrees".into(), serde_json::json!(120.0));
        let legacy_annular = build_annular_sector_normalized(dims(3.0, 6.0, 120.0, 24)).unwrap();
        let mut request = PackRequest {
            bins: Vec::new(),
            clearance: 0.0,
            items: vec![Part {
                shape_id: "cone-legacy".into(),
                quantity: 1,
                polygon: Some(legacy_annular),
                shape_spec: Some(ShapeSpec {
                    kind: "sector".into(),
                    params,
                }),
                allow_rotation: true,
                grain_axis: None,
                difficulty: None,
                tag: None,
            }],
            operator_profile: None,
            mode: None,
            engine: None,
            time_budget_ms: None,
            improvement_budget_ms: None,
            seed: None,
            units: Default::default(),
            cone_strategy: None,
        };

        materialise_request_polygons(&mut request).unwrap();

        assert_eq!(
            request.items[0].polygon.as_ref().map(Vec::len),
            Some(27),
            "sector pack polygon should be convex hull even when a legacy annular polygon was supplied"
        );
    }

    #[test]
    fn materialise_polygon_errors_when_no_polygon_and_no_spec() {
        let part = Part {
            shape_id: "broken".into(),
            quantity: 1,
            polygon: None,
            shape_spec: None,
            allow_rotation: true,
            grain_axis: None,
            difficulty: None,
            tag: None,
        };
        assert!(materialise_polygon(&part).is_err());
    }

    #[test]
    fn cone_strategy_kind_serialises_camel_case() {
        let s = serde_json::to_string(&ConeStrategyKind::AnnularSector).unwrap();
        assert_eq!(s, "\"annularSector\"");
        let s = serde_json::to_string(&ConeStrategyKind::ConvexWedge).unwrap();
        assert_eq!(s, "\"convexWedge\"");
        let k: ConeStrategyKind = serde_json::from_str("\"annularSector\"").unwrap();
        assert_eq!(k, ConeStrategyKind::AnnularSector);
    }
}
