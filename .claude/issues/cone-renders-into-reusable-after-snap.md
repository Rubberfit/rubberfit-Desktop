# Cone polygon physically renders into reusable offcut after snap-to-edge

## What the user observes

When packing cones (e.g. a 90° + a 160° annular sector on a 96×48 sheet) in AutoNest, the rendered cone polygon visibly extends past the boundary of the red waste region and into an adjacent amber Reusable offcut.

The user confirmed this is **not a stroke artifact** — reducing the cone polygon's `strokeWidth` from 1.5 to 0.5 (and leaving `vector-effect: non-scaling-stroke`) did not eliminate the overlap. The polygon body itself, not just the painted outline, crosses the boundary.

The user reports the bug **only started occurring after snap-to-polygon-edge was wired in** (commit `d63d583`).

## Toggling that helps repro

Enable both:
- "Show inscribed rects" (debug overlay for inscribed-rect Scrap classifications)
- "Show scrap AABB" (debug overlay for the bbox of each `freeRegions` polygon)

The user notes that with the AABB toggle on, the cone fits perfectly inside the AABB outline, but the AABB itself does not align with the visible boundary of the red waste region — and that mismatch is where the cone polygon ends up rendering past the waste into the amber.

## What's verified

A diagnostic test on the same 90°+160° fixture found **zero polygon-level overlaps** between any cone polygon vertex and any emitted Reusable rect, and zero Reusable-rect-corner inside any cone polygon. Numerically the cone polygon's max-x coordinate matched the adjacent Reusable rect's left edge exactly.

So the snap is producing geometry that passes vertex/corner overlap checks but still shows visual overlap on the canvas. Not yet known whether the cause is:
- Snap target choice (uses segment endpoint `x_hi` for diagonal arc segments, not the segment's x at the rect's y range)
- Clipper rounding making the scrap polygon's cone-shaped hole drift from the part polygon's vertices
- jagua-side coordinate roundtripping
- Something else

## Files to look at first

- `crates/rf-geom/src/application/inscribed.rs` — `snap_rect_to_polygon_and_obstacles` and the diagonal-edge branch in particular.
- `crates/rf-layout/src/application/free_space.rs` — `extract_offcuts_with_obstacles` (call site for snap; subtraction step).
- `crates/rf-layout/src/application/pack_lbf_lns.rs:704–723` — in `AnnularSector` mode, `Placement.pack_polygon` is `None` and the concave annular sector polygon itself is the obstacle.
- `src/components/cutting-engine/pack-result-to-layout-model.ts` — `scrap` derived from `binResult.freeRegions`.

## Suggested first step

Write a failing test that places the 90°+160° fixture, dumps the placed cone polygon vertices and the corresponding `freeRegions` hole-reversed polygon vertices, and asserts they match vertex-for-vertex. If they don't match, the bug is downstream of snap — somewhere in the Clipper subtract path. If they do match, the bug is in how snap picks the target on diagonal edges and the rect ends up overlapping the polygon body at sub-pixel scale on the canvas.

## Status

Continuing tomorrow.

---

Reference commit: d63d583 — *Snap reusable offcut rects to actual polygon/obstacle edges so axis-aligned scenarios stop reporting phantom waste from grid quantization.*
