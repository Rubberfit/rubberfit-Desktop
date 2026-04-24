// engine/crates/rf-geom/src/infrastructure/clipper.rs
//
// Thin wrapper around the clipper2 crate. Exposes boolean / offset operations
// in domain types so the rest of the codebase never sees clipper2.
use clipper2::{
    difference as clipper_difference, inflate, union as clipper_union, EndType, FillRule, JoinType,
    Path, Paths, PointScaler,
};

use crate::domain::{GeomError, Point2D, Polygon};

/// Custom point scaler. Clipper2 uses 64-bit integer coordinates internally;
/// we choose 1e7 as the multiplier, giving a resolution of 100 nm / sub-micron
/// precision (rounds to nearest 1e-7 unit).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Hash)]
struct RemaScale;

impl PointScaler for RemaScale {
    const MULTIPLIER: f64 = 1e7;
}

/// Convert a domain `Polygon` into clipper2 `Paths` at 1e7 scale.
fn to_clipper(p: &Polygon) -> Paths<RemaScale> {
    let pts: Vec<(f64, f64)> = p.points().iter().map(|pt| (pt.x, pt.y)).collect();
    Paths::<RemaScale>::from(pts)
}

/// Convert a clipper2 `Paths` result (at 1e7 scale) back into domain `Polygon`s.
/// Empty paths are dropped; paths with fewer than 3 vertices are dropped.
/// Every returned polygon is normalized to CCW winding so callers never need to
/// know clipper2's outer/hole sign convention.
fn from_clipper(paths: Paths<RemaScale>) -> Vec<Polygon> {
    paths
        .iter()
        .filter_map(|path: &Path<RemaScale>| {
            if path.len() < 3 {
                return None;
            }
            let mut pts: Vec<Point2D> =
                path.iter().map(|pt| Point2D::new(pt.x(), pt.y())).collect();
            let polygon = Polygon::new(pts.clone()).ok()?;
            if polygon.signed_area() >= 0.0 {
                Some(polygon)
            } else {
                pts.reverse();
                Polygon::new(pts).ok()
            }
        })
        .collect()
}

/// Boolean union of two polygons. Returns the resulting polygons (all CCW).
pub fn union(a: &Polygon, b: &Polygon) -> Result<Vec<Polygon>, GeomError> {
    let result = clipper_union::<RemaScale>(to_clipper(a), to_clipper(b), FillRule::NonZero)
        .map_err(|e| GeomError::ClipperFailed(format!("{e}")))?;
    Ok(from_clipper(result))
}

/// Boolean difference: `a` minus every polygon in `b`. Returned polygons are all CCW.
pub fn difference(a: &Polygon, b: &[Polygon]) -> Result<Vec<Polygon>, GeomError> {
    let subject = to_clipper(a);
    let mut clip: Paths<RemaScale> = Paths::default();
    for p in b {
        clip.push(to_clipper(p));
    }
    let result = clipper_difference::<RemaScale>(subject, clip, FillRule::NonZero)
        .map_err(|e| GeomError::ClipperFailed(format!("{e}")))?;
    Ok(from_clipper(result))
}

/// Polygon offset. Positive `delta` grows the polygon outward, negative shrinks it.
/// Clipper2's `inflate` is infallible, so this function does not return a Result.
pub fn offset(p: &Polygon, delta: f64) -> Vec<Polygon> {
    let result = inflate::<RemaScale>(
        to_clipper(p),
        delta,
        // Miter joins preserve sharp corners; the 2.0 miter limit caps spike
        // length at 2x the offset distance before falling back to a bevel.
        JoinType::Miter,
        EndType::Polygon,
        2.0,
    );
    from_clipper(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x: f64, y: f64, side: f64) -> Polygon {
        Polygon::new(vec![
            Point2D::new(x, y),
            Point2D::new(x + side, y),
            Point2D::new(x + side, y + side),
            Point2D::new(x, y + side),
        ])
        .unwrap()
    }

    #[test]
    fn union_of_disjoint_squares_yields_two_polygons() {
        let a = square(0.0, 0.0, 1.0);
        let b = square(5.0, 5.0, 1.0);
        let out = union(&a, &b).unwrap();
        assert_eq!(
            out.len(),
            2,
            "expected 2 disjoint polygons, got {}",
            out.len()
        );
        for p in &out {
            assert!(p.signed_area() > 0.0, "every returned polygon must be CCW");
        }
    }

    #[test]
    fn difference_carves_a_hole_shaped_result() {
        let outer = square(0.0, 0.0, 10.0);
        let inner = square(3.0, 3.0, 4.0);
        let result = difference(&outer, std::slice::from_ref(&inner)).unwrap();
        assert_eq!(
            result.len(),
            2,
            "expected outer ring + former hole as 2 CCW polygons"
        );
        let mut areas: Vec<f64> = result.iter().map(|p| p.area()).collect();
        areas.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert!(
            (areas[0] - 16.0).abs() < 0.5,
            "smaller polygon should be the former hole (~16), got {}",
            areas[0]
        );
        assert!(
            (areas[1] - 100.0).abs() < 0.5,
            "larger polygon should be the outer (~100), got {}",
            areas[1]
        );
        for p in &result {
            assert!(p.signed_area() > 0.0, "every returned polygon must be CCW");
        }
    }

    #[test]
    fn offset_grows_outward() {
        let sq = square(0.0, 0.0, 10.0);
        let out = offset(&sq, 2.0);
        let total_area: f64 = out.iter().map(|p| p.area()).sum();
        assert!(
            total_area > 100.0,
            "expected grown area > 100, got {}",
            total_area
        );
    }
}
