// Polygon-aware free-space computation using Clipper boolean operations
//
// After NFP packing places convex hulls on a stock sheet, this module computes
// the actual free regions via Clipper difference (stock - union(shapes)),
// then iteratively extracts the largest axis-aligned inscribed rectangles
// from each free polygon. Each rectangle is classified as reusable offcut or scrap.
//
// Clipper is already a project dependency (used by nesting/nfp-greedy-placer.ts
// and nesting/vendor/fit/ for Minkowski sums and NFP computation).

import ClipperLib from "clipper-lib"
import type { Point2D } from "./types"
import { polygonArea } from "./convex-hull"

/** A rectangular free region on the stock sheet */
export interface FreeRegion {
  /** Axis-aligned bounding box */
  x: number
  y: number
  width: number
  height: number
  /** Region area in square inches */
  area: number
}

const CLIPPER_SCALE = 1e7
const CLIPPER_CLEAN_THRESHOLD = 0.0001 * CLIPPER_SCALE
/** Ignore regions smaller than 0.25 sq in — same threshold used in offcut band builders */
const MIN_REGION_AREA = 0.25
/** Standard reusable offcut minimums (from nesting-visualizer-types.ts) */
const MIN_REUSABLE_OFFCUT_W = 11.5
const MIN_REUSABLE_OFFCUT_H = 12
const MIN_REUSABLE_STRIP_W = 6
const MIN_REUSABLE_STRIP_H = 24

type ClipperPoint = { X: number; Y: number }
type ClipperPath = ClipperPoint[]

function toClipperPath(points: ReadonlyArray<Point2D>): ClipperPath {
  return points.map((p) => ({
    X: Math.round(p.x * CLIPPER_SCALE),
    Y: Math.round(p.y * CLIPPER_SCALE),
  }))
}

function fromClipperPath(path: ReadonlyArray<ClipperPoint>): Point2D[] {
  return path.map((p) => ({ x: p.X / CLIPPER_SCALE, y: p.Y / CLIPPER_SCALE }))
}

/** Result of Clipper difference: outer contours + hole contours */
interface ClipperDiffResult {
  /** Outer contours of free space (positive Clipper area) */
  outers: Point2D[][]
  /** Hole contours representing placed shapes (negative Clipper area) */
  holes: Point2D[][]
}

/** Compute free-space polygons via Clipper difference: stock - union(shapes) */
function clipperDifference(
  stockW: number,
  stockH: number,
  placedPolygons: ReadonlyArray<ReadonlyArray<Point2D>>
): ClipperDiffResult {
  const stockPath = toClipperPath([
    { x: 0, y: 0 },
    { x: stockW, y: 0 },
    { x: stockW, y: stockH },
    { x: 0, y: stockH },
  ])

  const clipper = new ClipperLib.Clipper()
  clipper.AddPath(stockPath, ClipperLib.PolyType.ptSubject, true)

  for (const poly of placedPolygons) {
    if (poly.length < 3) continue
    const path = toClipperPath(poly)
    const cleaned = ClipperLib.Clipper.CleanPolygon(path, CLIPPER_CLEAN_THRESHOLD)
    if (cleaned.length >= 3) {
      clipper.AddPath(cleaned, ClipperLib.PolyType.ptClip, true)
    }
  }

  const result = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctDifference,
    result,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  )

  const outers: Point2D[][] = []
  const holes: Point2D[][] = []
  for (const path of result) {
    const area = ClipperLib.Clipper.Area(path)
    if (area > 0) {
      outers.push(fromClipperPath(path))
    } else if (area < 0) {
      holes.push(fromClipperPath(path))
    }
  }

  return { outers, holes }
}

/** Ray-casting point-in-polygon test (real coordinates) */
function pointInPolygon(px: number, py: number, polygon: ReadonlyArray<Point2D>): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x
    const yi = polygon[i].y
    const xj = polygon[j].x
    const yj = polygon[j].y
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/**
 * Check if a point is inside the free space: inside the outer contour
 * and outside all hole contours (placed shapes).
 */
function pointInFreeSpace(
  px: number,
  py: number,
  outer: ReadonlyArray<Point2D>,
  holes: ReadonlyArray<ReadonlyArray<Point2D>>
): boolean {
  if (!pointInPolygon(px, py, outer)) return false
  for (const hole of holes) {
    if (pointInPolygon(px, py, hole)) return false
  }
  return true
}

/** Collect unique sorted values, deduplicating values within tolerance */
function uniqueSorted(values: number[], tolerance = 0.01): number[] {
  const sorted = [...new Set(values)].sort((a, b) => a - b)
  if (sorted.length === 0) return []
  const result: number[] = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - result[result.length - 1] > tolerance) {
      result.push(sorted[i])
    }
  }
  return result
}

/**
 * Find the largest all-free rectangle in the grid using O(RC) histogram
 * with a monotonic stack. Tracks actual physical dimensions (inches)
 * for non-uniform cell sizes.
 */
function findLargestFreeRectHistogram(
  grid: boolean[][],
  xs: number[],
  ys: number[]
): { r1: number; c1: number; r2: number; c2: number; area: number } | null {
  const rows = grid.length
  const cols = grid[0]?.length ?? 0
  if (rows === 0 || cols === 0) return null

  // heights[c] = cumulative actual height (inches) of consecutive free cells going up
  const heights = new Array<number>(cols).fill(0)
  // topRow[c] = the row index where the current run of free cells started
  const topRow = new Array<number>(cols).fill(0)

  let best: { r1: number; c1: number; r2: number; c2: number; area: number } | null = null

  for (let r = 0; r < rows; r++) {
    const rowH = ys[r + 1] - ys[r]
    for (let c = 0; c < cols; c++) {
      if (grid[r][c]) {
        heights[c] += rowH
      } else {
        heights[c] = 0
        topRow[c] = r + 1
      }
    }

    // Monotonic stack to find largest rect in this row's histogram
    const stack: number[] = []
    for (let c = 0; c <= cols; c++) {
      const h = c < cols ? heights[c] : 0
      while (stack.length > 0 && heights[stack[stack.length - 1]] > h) {
        const idx = stack[stack.length - 1]
        stack.pop()
        const height = heights[idx]
        const left = stack.length > 0 ? stack[stack.length - 1] + 1 : 0
        const width = xs[c] - xs[left]
        const area = width * height
        if (area > (best?.area ?? 0)) {
          best = { r1: topRow[idx], c1: left, r2: r, c2: c - 1, area }
        }
      }
      stack.push(c)
    }
  }

  return best
}

/**
 * Enrich grid coordinates with edge-grid intersection points.
 * For each polygon edge, compute where it crosses every existing grid line
 * and add those intersection coordinates. This refines the grid at sloped
 * edges so inscribed rectangles align precisely with the polygon boundary.
 */
function enrichGridWithEdgeIntersections(
  polygons: ReadonlyArray<ReadonlyArray<Point2D>>,
  xValues: number[],
  yValues: number[],
  minX: number,
  maxX: number,
  minY: number,
  maxY: number
): void {
  const ySnap = [...yValues]
  const xSnap = [...xValues]

  for (const polygon of polygons) {
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]
      const b = polygon[(i + 1) % polygon.length]
      const dx = b.x - a.x
      const dy = b.y - a.y

      // Where this edge crosses each unique Y line → add the X intersection
      if (Math.abs(dy) > 1e-9) {
        for (const yVal of ySnap) {
          if ((yVal - a.y) * (yVal - b.y) < 0) {
            const t = (yVal - a.y) / dy
            const ix = a.x + t * dx
            if (ix > minX && ix < maxX) xValues.push(ix)
          }
        }
      }

      // Where this edge crosses each unique X line → add the Y intersection
      if (Math.abs(dx) > 1e-9) {
        for (const xVal of xSnap) {
          if ((xVal - a.x) * (xVal - b.x) < 0) {
            const t = (xVal - a.x) / dx
            const iy = a.y + t * dy
            if (iy > minY && iy < maxY) yValues.push(iy)
          }
        }
      }
    }
  }
}

/** Max spacing between grid lines (inches). Ensures triangular/trapezoidal
 *  free-space regions get enough intermediate rows/columns for the histogram
 *  algorithm to find inscribed rectangles. Without this, simple shapes with
 *  few vertices (e.g. the triangle between two trapezoids) produce a grid
 *  with only 1-2 cells that span the full polygon height, failing the
 *  4-corner PIP test because sloped edges cross through the cell interior. */
const GRID_MAX_STEP = 2

/** Build the grid coordinate arrays from outer contour + hole vertices */
function buildGridCoordinates(
  outer: ReadonlyArray<Point2D>,
  holes: ReadonlyArray<ReadonlyArray<Point2D>>,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number
): { xs: number[]; ys: number[] } {
  const xValues: number[] = [minX, maxX]
  const yValues: number[] = [minY, maxY]

  // Seed regular intermediate grid lines so the histogram algorithm has
  // sufficient resolution for shapes with few vertices (triangles, quads)
  const spanX = maxX - minX
  const spanY = maxY - minY
  if (spanX > GRID_MAX_STEP) {
    const stepsX = Math.ceil(spanX / GRID_MAX_STEP)
    const dx = spanX / stepsX
    for (let i = 1; i < stepsX; i++) {
      xValues.push(minX + i * dx)
    }
  }
  if (spanY > GRID_MAX_STEP) {
    const stepsY = Math.ceil(spanY / GRID_MAX_STEP)
    const dy = spanY / stepsY
    for (let i = 1; i < stepsY; i++) {
      yValues.push(minY + i * dy)
    }
  }

  // Add outer polygon vertices
  for (const pt of outer) {
    xValues.push(Math.max(minX, Math.min(maxX, pt.x)))
    yValues.push(Math.max(minY, Math.min(maxY, pt.y)))
  }

  // Add hole polygon vertices — only interior points (strict inequality
  // excludes boundary-coincident vertices that duplicate min/max seeds)
  for (const hole of holes) {
    for (const pt of hole) {
      const cx = Math.max(minX, Math.min(maxX, pt.x))
      const cy = Math.max(minY, Math.min(maxY, pt.y))
      if (cx > minX && cx < maxX) xValues.push(cx)
      if (cy > minY && cy < maxY) yValues.push(cy)
    }
  }

  // Enrich grid with edge-grid intersections from both outer and holes
  enrichGridWithEdgeIntersections([outer, ...holes], xValues, yValues, minX, maxX, minY, maxY)

  return { xs: uniqueSorted(xValues), ys: uniqueSorted(yValues) }
}

/** Classify each grid cell as free or occupied using hole-aware PIP testing */
function buildFreeSpaceGrid(
  xs: number[],
  ys: number[],
  outer: ReadonlyArray<Point2D>,
  holes: ReadonlyArray<ReadonlyArray<Point2D>>
): boolean[][] {
  const PIP_INSET = 0.001
  const rows = ys.length - 1
  const cols = xs.length - 1
  const grid: boolean[][] = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false))
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = xs[c] + PIP_INSET
      const x1 = xs[c + 1] - PIP_INSET
      const y0 = ys[r] + PIP_INSET
      const y1 = ys[r + 1] - PIP_INSET
      if (x1 <= x0 || y1 <= y0) continue
      grid[r][c] =
        pointInFreeSpace(x0, y0, outer, holes) &&
        pointInFreeSpace(x1, y0, outer, holes) &&
        pointInFreeSpace(x0, y1, outer, holes) &&
        pointInFreeSpace(x1, y1, outer, holes)
    }
  }
  return grid
}

/**
 * Find the largest axis-aligned inscribed rectangle in a free-space polygon.
 * Hole-aware: cells inside any hole (placed shape) are excluded.
 */
function findInscribedRect(
  outer: ReadonlyArray<Point2D>,
  holes: ReadonlyArray<ReadonlyArray<Point2D>>
): FreeRegion | null {
  if (outer.length < 3) return null

  // Compute bounding box from outer contour
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const pt of outer) {
    if (pt.x < minX) minX = pt.x
    if (pt.y < minY) minY = pt.y
    if (pt.x > maxX) maxX = pt.x
    if (pt.y > maxY) maxY = pt.y
  }

  const { xs, ys } = buildGridCoordinates(outer, holes, minX, maxX, minY, maxY)
  const rows = ys.length - 1
  const cols = xs.length - 1
  if (rows <= 0 || cols <= 0) return null

  const grid = buildFreeSpaceGrid(xs, ys, outer, holes)

  // Find largest inscribed rectangle via O(RC) histogram
  const rect = findLargestFreeRectHistogram(grid, xs, ys)
  if (!rect || rect.area < MIN_REGION_AREA) return null

  const x = xs[rect.c1]
  const y = ys[rect.r1]
  const width = xs[rect.c2 + 1] - x
  const height = ys[rect.r2 + 1] - y

  return { x, y, width, height, area: rect.area }
}

/** Subtract an axis-aligned rectangle from a polygon via Clipper difference */
function clipperSubtractRect(polygonPoints: ReadonlyArray<Point2D>, rect: FreeRegion): Point2D[][] {
  const polyPath = toClipperPath(polygonPoints)
  const rectPath = toClipperPath([
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ])

  const clipper = new ClipperLib.Clipper()
  clipper.AddPath(polyPath, ClipperLib.PolyType.ptSubject, true)
  clipper.AddPath(rectPath, ClipperLib.PolyType.ptClip, true)

  const result = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctDifference,
    result,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  )

  // Keep only outer contours (positive area in Clipper's coordinate system)
  return result
    .filter((p: ClipperPath) => ClipperLib.Clipper.Area(p) > 0)
    .map((p: ClipperPath) => fromClipperPath(p))
}

/**
 * Extract the largest axis-aligned free rectangles from the stock sheet
 * after subtracting placed polygons.
 *
 * Algorithm:
 * 1. Clipper difference: stock - union(shapes) → outer contours + holes
 * 2. Separate outer contours (positive area) from holes (negative area = shapes)
 * 3. Per outer: build local grid with hole vertices, find largest inscribed rect
 *    via O(RC) histogram, excluding cells that overlap any hole
 * 4. Subtract accepted rect from its outer contour, requeue the remainder
 * 5. Stop when no rectangle meets area thresholds or maxRects reached
 */
export type FreeRectMode = "maximal" | "contour-aabb"

function contourAabbRegions(
  outers: ReadonlyArray<ReadonlyArray<Point2D>>,
  maxRects: number
): FreeRegion[] {
  const rects: FreeRegion[] = []
  for (const poly of outers) {
    if (polygonArea(poly) < MIN_REGION_AREA) continue
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const pt of poly) {
      if (pt.x < minX) minX = pt.x
      if (pt.x > maxX) maxX = pt.x
      if (pt.y < minY) minY = pt.y
      if (pt.y > maxY) maxY = pt.y
    }
    const width = maxX - minX
    const height = maxY - minY
    const area = width * height
    if (area < MIN_REGION_AREA) continue
    rects.push({ x: minX, y: minY, width, height, area })
    if (rects.length >= maxRects) break
  }
  // Bigger regions first so the legend lists the most useful offcut at the top.
  rects.sort((a, b) => b.area - a.area)
  return rects
}

export function extractMaximalFreeRects(
  stockW: number,
  stockH: number,
  placedPolygons: ReadonlyArray<ReadonlyArray<Point2D>>,
  maxRects = 10,
  mode: FreeRectMode = "maximal"
): FreeRegion[] {
  if (placedPolygons.length === 0 || stockW <= 0 || stockH <= 0) {
    return []
  }

  // 1. Clipper difference: stock - union(shapes) → outers + holes
  const { outers, holes } = clipperDifference(stockW, stockH, placedPolygons)

  // Fast path for concave inputs (cones/trapezoids): use each outer contour's
  // AABB directly instead of iteratively carving maximal inscribed rectangles via
  // Clipper. The iterative path fragments the free polygon on each subtraction,
  // and Clipper cost grows with fragmentation — cone sectors blow this up at N≥4.
  if (mode === "contour-aabb") {
    return contourAabbRegions(outers, maxRects)
  }

  // 2. Start with outer contours as the free polygon candidates
  let freePolygons = outers.filter((p) => polygonArea(p) >= MIN_REGION_AREA)

  // 3. Iterative extraction (holes persist — they represent placed shapes)
  const results: FreeRegion[] = []
  while (results.length < maxRects && freePolygons.length > 0) {
    // Find the polygon with the largest inscribed rect
    let bestRect: FreeRegion | null = null
    let bestPolyIdx = -1
    for (let i = 0; i < freePolygons.length; i++) {
      const rect = findInscribedRect(freePolygons[i], holes)
      if (rect && (!bestRect || rect.area > bestRect.area)) {
        bestRect = rect
        bestPolyIdx = i
      }
    }
    if (!bestRect || bestRect.area < MIN_REGION_AREA) break

    results.push(bestRect)

    // Subtract the accepted rect from its polygon via Clipper
    const remaining = clipperSubtractRect(freePolygons[bestPolyIdx], bestRect)
    freePolygons.splice(bestPolyIdx, 1, ...remaining)
    // Filter out tiny remainders
    freePolygons = freePolygons.filter((p) => polygonArea(p) >= MIN_REGION_AREA)
  }

  return results
}

/**
 * Classify a free region as reusable offcut or scrap.
 *
 * Sheet-based classification: checks if the leftover material is large enough
 * to be useful for any future cut, regardless of the current piece shape.
 * - Can fit a standard offcut (11.5" x 12")
 * - Can fit a reusable strip (6" x 24")
 */
export function classifyFreeRegion(region: FreeRegion): "reusable" | "scrap" {
  const { width, height } = region

  const fits = (w: number, h: number) => (width >= w && height >= h) || (width >= h && height >= w)

  if (fits(MIN_REUSABLE_OFFCUT_W, MIN_REUSABLE_OFFCUT_H)) return "reusable"

  if (fits(MIN_REUSABLE_STRIP_W, MIN_REUSABLE_STRIP_H)) return "reusable"

  return "scrap"
}
