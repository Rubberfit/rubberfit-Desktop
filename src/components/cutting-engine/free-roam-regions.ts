import ClipperLib from "clipper-lib"
import type { Point2D } from "@/nesting/types"
import { circleToPolygon, rectToPolygon } from "@/nesting/shape-to-polygon"
import { polygonArea } from "@/nesting/convex-hull"
import { extractMaximalFreeRects } from "@/nesting/free-space"
import type { PartTemplate } from "./PresetDimensionSelector"
import type { StockConfig } from "./stock-preview-configurator"
import type { LayoutRegion } from "./layout-model"
import type { ManualPlacement } from "./free-roam-collision"

/**
 * Sheet-space polygon for a single placement. Rectangles expand to 4
 * rotated corners, discs to a 24-vertex approximation. Unknown /
 * missing templates collapse to an empty array so the caller can
 * skip them without a try/catch.
 *
 * The vertices are in SHEET INCH coords (post-rotation), matching the
 * format `extractMaximalFreeRects` expects.
 */
function placementToSheetPolygon(placement: ManualPlacement, template: PartTemplate): Point2D[] {
  const width = template.width ?? template.diameter ?? 12
  const height = template.length ?? template.height ?? template.diameter ?? 12
  const cx = placement.x + width / 2
  const cy = placement.y + height / 2
  const cos = Math.cos(placement.rotationRad)
  const sin = Math.sin(placement.rotationRad)

  const rotateAndTranslate = (local: Point2D[]): Point2D[] =>
    local.map((p) => {
      const dx = p.x - width / 2
      const dy = p.y - height / 2
      return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
    })

  // Shape-registry templates carry a pre-built local polygon —
  // triangle, ellipse, n-gon, star, ring, custom. Use it directly
  // so the waste math hugs the actual shape instead of a rect.
  if (template.polygon && template.polygon.length >= 3) {
    return rotateAndTranslate(template.polygon)
  }

  if (template.partType === "cylinder" && template.diameter) {
    return rotateAndTranslate(circleToPolygon(template.diameter, 24))
  }

  return rotateAndTranslate(rectToPolygon(width, height))
}

/** All placements converted to sheet-space polygons. Missing templates skipped. */
export function placementsToPolygons(
  placements: ManualPlacement[],
  parts: PartTemplate[]
): Point2D[][] {
  const byId = new Map(parts.map((p) => [p.id, p]))
  const polys: Point2D[][] = []
  for (const placement of placements) {
    const template = byId.get(placement.templateId)
    if (!template) continue
    const poly = placementToSheetPolygon(placement, template)
    if (poly.length >= 3) polys.push(poly)
  }
  return polys
}

export interface ComputedRegions {
  offcuts: LayoutRegion[]
  scrap: LayoutRegion[]
}

/**
 * Visual / metric floor for scrap polygons. Anything smaller than
 * this falls back to the ambient amber background and doesn't count
 * as waste — operators can't cut a 1.4"×1.4" sliver, so showing it
 * as red reads as noise rather than information.
 */
const MIN_VISIBLE_SCRAP_SQIN = 2

/**
 * Minimum "usable" dimension for a free-space inscribed rectangle.
 * A rect with its smaller side below this is too thin to cut anything
 * meaningful from — classified as waste regardless of its length.
 *
 * Tuned to 6" to match the existing Auto-nest `MIN_REUSABLE_STRIP_W`
 * threshold: a 6"-wide strip is the narrowest piece treated as
 * reusable anywhere else in the app. Anything thinner is a strip the
 * operator can't practically plan around. The earlier 11.5" threshold
 * (MIN_REUSABLE_OFFCUT_W) was too aggressive — it flagged 10"-wide
 * columns around a disc as waste even though they had plenty of
 * vertical room for other cuts.
 */
const MIN_USABLE_DIM_IN = 6

// ── Clipper helpers for the "unreusable residue" compute ─────────────────

const CLIPPER_SCALE = 1e7

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

function polyBbox(poly: Point2D[]): { x: number; y: number; width: number; height: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of poly) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * Compute per-part "crescent waste" polygons — the material trapped
 * between a part's axis-aligned bounding box and the part's own
 * outline. For rectangles this is empty (bbox === polygon). For
 * discs the result is the four corner crescents of the bbox. For
 * trapezoids / triangles / sectors it's the tapered strips.
 *
 * This is the intuitive notion of waste the operator expects: the
 * material that's geometrically TRAPPED by the part's shape. The
 * earlier "strict reusable threshold" logic classified any free
 * strip narrower than 11.5" or 6" as scrap — technically correct
 * per offcut-catalog rules, but it turned the whole column
 * containing a 10"-wide disc red even though there was plenty of
 * usable sheet above and below.
 *
 * Thin-strip / dead-end waste (e.g., 5" between a part and the
 * sheet edge) is NOT detected here on purpose — operators generally
 * plan those by eye. If we re-introduce strict classification later,
 * it should be behind an explicit toggle.
 */
function computePartCrescentWaste(
  partPolygons: ReadonlyArray<ReadonlyArray<Point2D>>
): Point2D[][] {
  const out: Point2D[][] = []
  for (const poly of partPolygons) {
    if (poly.length < 3) continue
    const bbox = polyBbox(poly as Point2D[])
    // Degenerate or zero-area bbox → nothing to subtract.
    if (bbox.width <= 0 || bbox.height <= 0) continue

    const bboxPath = toClipperPath([
      { x: bbox.x, y: bbox.y },
      { x: bbox.x + bbox.width, y: bbox.y },
      { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
      { x: bbox.x, y: bbox.y + bbox.height },
    ])
    const clip = new ClipperLib.Clipper()
    clip.AddPath(bboxPath, ClipperLib.PolyType.ptSubject, true)
    clip.AddPath(toClipperPath(poly), ClipperLib.PolyType.ptClip, true)
    const paths = new ClipperLib.Paths()
    clip.Execute(
      ClipperLib.ClipType.ctDifference,
      paths,
      ClipperLib.PolyFillType.pftNonZero,
      ClipperLib.PolyFillType.pftNonZero
    )
    for (const path of paths) {
      if (ClipperLib.Clipper.Area(path) > 0) out.push(fromClipperPath(path))
    }
  }
  return out
}

/**
 * Union all waste inputs via Clipper so overlapping signals (crescent
 * + thin-strip) render as a single layer instead of compounding into
 * darker patches where they overlap. Each 28%-alpha rect stacked on
 * another 28%-alpha rect would read as a noticeably darker red; the
 * user reads that as "different shades of scrap" which isn't what
 * the classifier means.
 *
 * Returns the disjoint outer contours of the merged waste polygon
 * set — ready to hand to the renderer as individual `LayoutRegion`s.
 */
function unionWasteRegions(
  crescentPolys: ReadonlyArray<ReadonlyArray<Point2D>>,
  thinRects: ReadonlyArray<{ x: number; y: number; width: number; height: number }>
): Point2D[][] {
  if (crescentPolys.length === 0 && thinRects.length === 0) return []

  const clip = new ClipperLib.Clipper()
  let added = 0
  for (const poly of crescentPolys) {
    if (poly.length < 3) continue
    clip.AddPath(toClipperPath(poly), ClipperLib.PolyType.ptSubject, true)
    added++
  }
  for (const r of thinRects) {
    clip.AddPath(
      toClipperPath([
        { x: r.x, y: r.y },
        { x: r.x + r.width, y: r.y },
        { x: r.x + r.width, y: r.y + r.height },
        { x: r.x, y: r.y + r.height },
      ]),
      ClipperLib.PolyType.ptSubject,
      true
    )
    added++
  }
  if (added === 0) return []

  const out = new ClipperLib.Paths()
  clip.Execute(
    ClipperLib.ClipType.ctUnion,
    out,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  )
  const polys: Point2D[][] = []
  for (const path of out) {
    if (ClipperLib.Clipper.Area(path) <= 0) continue // skip holes
    polys.push(fromClipperPath(path))
  }
  return polys
}

/**
 * Continuously-computed amber/red regions for the Free-roam canvas.
 *
 * Waste comes from two independent signals, ORed together:
 *
 *   1. Per-part crescents: for each placed part, the material trapped
 *      between the part's axis-aligned bbox and its own outline.
 *      Rectangles produce nothing (bbox ≡ polygon); discs produce
 *      four small corner crescents; trapezoids / triangles / sectors
 *      produce their characteristic tapered slivers. This is purely
 *      shape-driven — it doesn't depend on how parts are arranged.
 *
 *   2. Thin-strip detection: inscribed rectangles in the free polygon
 *      (`stock − ⋃parts`) whose smaller dimension is below
 *      `MIN_USABLE_DIM_IN`. This catches dead-end strips between
 *      parts and narrow bands along the sheet edge. The threshold is
 *      6" — matches the app-wide minimum-reusable-strip width — so a
 *      10"-wide column around a disc stays amber while a 4" gap
 *      between two parts gets flagged.
 *
 * Both signals are unioned via Clipper before being emitted, so the
 * renderer paints ONE uniformly-coloured red layer — even where a
 * crescent corner overlaps a thin strip.
 *
 * Cheap enough to run on every rAF tick — the Clipper passes operate
 * on small polygon sets (parts + the inscribed rect carve).
 */
export function computeAdaptiveRegions(
  placements: ManualPlacement[],
  parts: PartTemplate[],
  stock: StockConfig
): ComputedRegions {
  if (placements.length === 0 || stock.width <= 0 || stock.length <= 0) {
    return { offcuts: [], scrap: [] }
  }
  const polygons = placementsToPolygons(placements, parts)
  if (polygons.length === 0) return { offcuts: [], scrap: [] }

  // Signal 1 — per-part crescent waste (raw polygons).
  const crescentPolys = computePartCrescentWaste(polygons)

  // Signal 2 — inscribed rects in free space that are too thin to
  // cut a useful piece from. Usable rects are dropped — the amber
  // background paints them.
  const rects = extractMaximalFreeRects(stock.width, stock.length, polygons, 20, "maximal")
  const thinRects = rects
    .filter((r) => Math.min(r.width, r.height) < MIN_USABLE_DIM_IN)
    .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }))

  // Union the two signals so overlapping waste doesn't render as
  // darker red. Filter sub-threshold polygons so truly micro slivers
  // disappear into the amber background rather than showing as noise.
  const merged = unionWasteRegions(crescentPolys, thinRects)
  const scrap: LayoutRegion[] = []
  for (const poly of merged) {
    if (polygonArea(poly) < MIN_VISIBLE_SCRAP_SQIN) continue
    const bbox = polyBbox(poly)
    scrap.push({ ...bbox, polygon: poly })
  }

  // Offcuts deliberately empty — the amber sheet background already
  // paints the reusable semantic.
  return { offcuts: [], scrap }
}
