// Shared label-position math for placed parts. Used by both the
// on-screen Konva/SVG renderer and the PDF exporter so a tag that
// reads inside the cone silhouette on screen does the same in the
// printed report. Extracted from layout-visualizer.tsx so the PDF
// path stops using bare bbox centres (which fall outside the
// silhouette for concave parts — most importantly the 150° annular
// sector, whose bbox centre lands in the inner-arc hole).

import type { PlacedPart } from "./layout-model"

export interface PartLabelCenter {
  /** X in sheet-space inches. */
  x: number
  /** Y in sheet-space inches. */
  y: number
  /** Min bbox dimension (inches) — drives font sizing so the tag scales with the visual footprint. */
  minDim: number
}

/**
 * Returns the area-weighted polygon centroid when a polygon is present,
 * falling back to the placement-rect centre otherwise. `minDim` mirrors
 * the bbox min dimension so font sizing stays proportional to the
 * visual footprint, not the centroid's distance to the nearest edge.
 */
export function partLabelCenter(part: PlacedPart): PartLabelCenter {
  if (part.polygon && part.polygon.length >= 3) {
    const aabb = polygonAabb(part.polygon)
    const c = polygonCentroid(part.polygon)
    return { x: c.x, y: c.y, minDim: Math.min(aabb.width, aabb.height) }
  }
  return {
    x: part.x + part.width / 2,
    y: part.y + part.height / 2,
    minDim: Math.min(part.width, part.height),
  }
}

function polygonAabb(points: ReadonlyArray<{ x: number; y: number }>): {
  width: number
  height: number
} {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const pt of points) {
    if (pt.x < minX) minX = pt.x
    if (pt.y < minY) minY = pt.y
    if (pt.x > maxX) maxX = pt.x
    if (pt.y > maxY) maxY = pt.y
  }
  return { width: maxX - minX, height: maxY - minY }
}

/**
 * Area-weighted centroid of a simple polygon. CCW or CW input is fine —
 * the signed-area term cancels with the moment terms. For degenerate
 * polygons (zero signed area: collinear or duplicated vertices) falls
 * back to the vertex average so callers always get a usable point.
 */
export function polygonCentroid(points: ReadonlyArray<{ x: number; y: number }>): {
  x: number
  y: number
} {
  let cx = 0
  let cy = 0
  let area2 = 0
  const n = points.length
  for (let i = 0; i < n; i++) {
    const p0 = points[i]
    const p1 = points[(i + 1) % n]
    const cross = p0.x * p1.y - p1.x * p0.y
    area2 += cross
    cx += (p0.x + p1.x) * cross
    cy += (p0.y + p1.y) * cross
  }
  if (Math.abs(area2) < 1e-9) {
    let ax = 0
    let ay = 0
    for (const p of points) {
      ax += p.x
      ay += p.y
    }
    return { x: ax / n, y: ay / n }
  }
  const factor = 1 / (3 * area2)
  return { x: cx * factor, y: cy * factor }
}
