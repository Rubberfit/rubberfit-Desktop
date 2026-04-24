// Convex hull via Andrew's monotone chain algorithm (1979)
// Standard computational geometry algorithm — no external repo needed
// Reference: A.M. Andrew, "Another Efficient Algorithm for Convex Hulls in Two Dimensions", 1979
//
// SAT (Separating Axis Theorem) for convex polygon overlap detection
// Standard computational geometry algorithm — no external repo needed

import type { Point2D } from "./types"

const SAT_EPSILON = 0.001

function cross(o: Point2D, a: Point2D, b: Point2D): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

/**
 * Compute the convex hull of a set of 2D points using Andrew's monotone chain.
 * Returns vertices in CCW order. O(n log n).
 */
export function convexHull(points: ReadonlyArray<Point2D>): Point2D[] {
  const sorted = [...points].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y))
  const n = sorted.length
  if (n <= 2) return sorted.slice()

  // Lower hull
  const lower: Point2D[] = []
  for (let i = 0; i < n; i++) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], sorted[i]) <= 0
    ) {
      lower.pop()
    }
    lower.push(sorted[i])
  }

  // Upper hull
  const upper: Point2D[] = []
  for (let i = n - 1; i >= 0; i--) {
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], sorted[i]) <= 0
    ) {
      upper.pop()
    }
    upper.push(sorted[i])
  }

  // Remove last point of each half (duplicate of the other half's first point)
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/**
 * Compute the area of a simple polygon using the shoelace formula.
 * Returns the absolute area (positive regardless of winding).
 */
export function polygonArea(points: ReadonlyArray<Point2D>): number {
  if (points.length < 3) return 0
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const current = points[i]
    const next = points[(i + 1) % points.length]
    area += current.x * next.y - next.x * current.y
  }
  return Math.abs(area) / 2
}

/**
 * Project all points of a polygon onto an axis and return the min/max scalar values.
 */
function projectPolygon(
  polygon: ReadonlyArray<Point2D>,
  axisX: number,
  axisY: number
): { min: number; max: number } {
  if (polygon.length === 0) {
    return { min: 0, max: 0 }
  }
  let min = polygon[0].x * axisX + polygon[0].y * axisY
  let max = min
  for (let i = 1; i < polygon.length; i++) {
    const dot = polygon[i].x * axisX + polygon[i].y * axisY
    if (dot < min) min = dot
    if (dot > max) max = dot
  }
  return { min, max }
}

/**
 * Check if two convex polygons overlap using the Separating Axis Theorem.
 * Returns true if they overlap. O(n+m) where n,m are vertex counts.
 */
export function convexPolygonsOverlap(
  a: ReadonlyArray<Point2D>,
  b: ReadonlyArray<Point2D>
): boolean {
  const polygons = [a, b]

  for (const polygon of polygons) {
    for (let i = 0; i < polygon.length; i++) {
      const next = (i + 1) % polygon.length
      // Edge normal (perpendicular to edge)
      const axisX = polygon[next].y - polygon[i].y
      const axisY = polygon[i].x - polygon[next].x

      const projA = projectPolygon(a, axisX, axisY)
      const projB = projectPolygon(b, axisX, axisY)

      // If projections don't overlap on this axis, polygons are separated
      if (projA.max < projB.min + SAT_EPSILON || projB.max < projA.min + SAT_EPSILON) {
        return false
      }
    }
  }

  return true
}
