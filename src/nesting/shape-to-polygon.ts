import type { Point2D } from "./types"

/** Rectangle → 4 vertices */
export function rectToPolygon(width: number, height: number): Point2D[] {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ]
}

/** Circle → N-gon approximation */
export function circleToPolygon(diameter: number, segments = 24): Point2D[] {
  const r = diameter / 2
  return Array.from({ length: segments }, (_, i) => {
    const angle = (2 * Math.PI * i) / segments
    return { x: r + r * Math.cos(angle), y: r + r * Math.sin(angle) }
  })
}

/** Trapezoid → 4 vertices with insets for tapered edges */
export function trapezoidToPolygon(
  topWidth: number,
  bottomWidth: number,
  height: number
): Point2D[] {
  const maxW = Math.max(topWidth, bottomWidth)
  const topInset = (maxW - topWidth) / 2
  const botInset = (maxW - bottomWidth) / 2
  return [
    { x: topInset, y: 0 },
    { x: maxW - topInset, y: 0 },
    { x: maxW - botInset, y: height },
    { x: botInset, y: height },
  ]
}

/** Ellipse → N-gon approximation anchored at bbox top-left (0, 0) */
export function ellipseToPolygon(width: number, height: number, segments = 48): Point2D[] {
  const rx = width / 2
  const ry = height / 2
  return Array.from({ length: segments }, (_, i) => {
    const angle = (2 * Math.PI * i) / segments
    return { x: rx + rx * Math.cos(angle), y: ry + ry * Math.sin(angle) }
  })
}

/**
 * Isoceles triangle → 3 vertices with the apex centered on top.
 * Bbox anchored at (0, 0), base runs along the bottom edge.
 */
export function triangleToPolygon(baseWidth: number, height: number): Point2D[] {
  return [
    { x: baseWidth / 2, y: 0 },
    { x: baseWidth, y: height },
    { x: 0, y: height },
  ]
}

/**
 * Right triangle → 3 vertices with the right angle in the bottom-left.
 * Bbox anchored at (0, 0). Useful when the operator wants a specific
 * corner-cut orientation rather than a symmetric isoceles.
 */
export function rightTriangleToPolygon(baseWidth: number, height: number): Point2D[] {
  return [
    { x: 0, y: 0 },
    { x: baseWidth, y: height },
    { x: 0, y: height },
  ]
}

/**
 * Regular N-gon → `sides` vertices distributed on a circle of the
 * given radius. Bbox anchored so all vertices have non-negative
 * coords. First vertex sits at the top (12 o'clock) so even-sided
 * polygons read as "flat-top / flat-bottom" on screen.
 */
export function ngonToPolygon(sides: number, radius: number): Point2D[] {
  const clamped = Math.max(3, Math.min(32, Math.round(sides)))
  const pts: Point2D[] = []
  for (let i = 0; i < clamped; i++) {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / clamped
    pts.push({ x: radius + radius * Math.cos(angle), y: radius + radius * Math.sin(angle) })
  }
  return pts
}

/**
 * N-pointed star → alternating outer / inner vertices. `points` is
 * the number of TIPS (5 = pentagram, 6 = Star of David, etc).
 * Bbox anchored at (0, 0) so a 100-unit outer radius produces a
 * 200×200 bbox with all vertices ≥ 0.
 */
export function starToPolygon(points: number, outerRadius: number, innerRadius: number): Point2D[] {
  const clamped = Math.max(3, Math.min(20, Math.round(points)))
  const verts: Point2D[] = []
  const steps = clamped * 2
  for (let i = 0; i < steps; i++) {
    const r = i % 2 === 0 ? outerRadius : innerRadius
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / steps
    verts.push({
      x: outerRadius + r * Math.cos(angle),
      y: outerRadius + r * Math.sin(angle),
    })
  }
  return verts
}

/**
 * Annulus (ring) → outer + inner circle as a single polygon with
 * a hole. Clipper treats CCW as solid / CW as hole, so the inner
 * circle is walked in reverse. The output is a 2D flat list of
 * verts; consumers that can't handle holes (like Konva's simple
 * `<Line closed>`) get a filled disc of the outer boundary only —
 * use `ringOuterOnlyPolygon` for those.
 *
 * Bbox anchored at (0, 0), so for outer diameter D the bbox is D×D.
 */
export function ringToPolygon(
  outerDiameter: number,
  innerDiameter: number,
  segments = 48
): Point2D[] {
  const ro = outerDiameter / 2
  const ri = innerDiameter / 2
  const pts: Point2D[] = []
  // Outer boundary, CCW
  for (let i = 0; i < segments; i++) {
    const angle = (2 * Math.PI * i) / segments
    pts.push({ x: ro + ro * Math.cos(angle), y: ro + ro * Math.sin(angle) })
  }
  // Bridge back to the inner hole via the first outer vertex —
  // produces a self-intersecting polygon that Clipper normalizes
  // correctly for difference ops. The Konva <Ring> primitive
  // renders the ring geometry natively and doesn't consume this.
  pts.push({ x: ro + ro, y: ro }) // duplicate first outer vert
  // Inner boundary, CW so it registers as a hole
  for (let i = segments; i >= 0; i--) {
    const angle = (2 * Math.PI * i) / segments
    pts.push({ x: ro + ri * Math.cos(angle), y: ro + ri * Math.sin(angle) })
  }
  return pts
}

/** Outer-only boundary of a ring (no hole). For renderers that can't
 *  handle holes; for collision / waste math use {@link ringToPolygon}. */
export function ringOuterOnlyPolygon(outerDiameter: number, segments = 48): Point2D[] {
  return circleToPolygon(outerDiameter, segments)
}

/** Annular sector → outer arc + inner arc (reversed) polygon approximation */
export function sectorToPolygon(
  innerRadius: number,
  outerRadius: number,
  arcDegrees: number,
  segments = 24
): Point2D[] {
  const arcRad = (arcDegrees * Math.PI) / 180
  const points: Point2D[] = []

  // Center the sector vertically: arc spans from -arcRad/2 to +arcRad/2
  // Origin at (outerRadius, outerRadius) so all points are positive
  // Outer arc (forward)
  for (let i = 0; i <= segments; i++) {
    const angle = -arcRad / 2 + (arcRad * i) / segments
    points.push({
      x: outerRadius + outerRadius * Math.sin(angle),
      y: outerRadius - outerRadius * Math.cos(angle),
    })
  }
  // Inner arc (reverse)
  for (let i = segments; i >= 0; i--) {
    const angle = -arcRad / 2 + (arcRad * i) / segments
    points.push({
      x: outerRadius + innerRadius * Math.sin(angle),
      y: outerRadius - innerRadius * Math.cos(angle),
    })
  }
  return points
}
