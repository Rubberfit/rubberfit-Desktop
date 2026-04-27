# rf-geom

2D geometry primitives for the RF nesting engine.

## Layout

- `src/domain/` — pure types (Point2D, Polygon, Rect) + invariants
- `src/application/` — operations (normalize, convex hull, SAT, inscribed rects)
- `src/infrastructure/` — vendor wrappers (clipper2)

## Public API (v0.1)

```rust
use rf_geom::domain::{Point2D, Polygon, Rect};
use rf_geom::application::{normalize_polygon, convex_hull, sat_overlap, maximal_inscribed_rects};
use rf_geom::infrastructure::clipper;
```

Polygons are CCW with min-corner at (0, 0). All linear dimensions are unitless — callers supply consistent units (RF uses inches).

## Domain types

- `Point2D` — `{x, y}` pair of `f64`, serializes as a plain JSON object.
- `Polygon` — validated ring of at least 3 `Point2D`; exposes `signed_area`, `area`, and `bbox`.
- `Rect` — axis-aligned `{x, y, width, height}` of `f64`; exposes `area`, `min_corner`, `max_corner`, and `contains`.
