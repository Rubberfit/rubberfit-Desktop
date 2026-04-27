// Adapter: Rust `pack_job` PackResult → LayoutModel[] (one per bin).
//
// Replaces the entire TypeScript NFP preview pipeline that used to
// feed NestingVisualizer's Konva renderer. The Rust side now returns
// placements + freeRegions + classified offcuts in a single
// `invoke("pack_job")` round-trip; this module flattens that wire
// shape into the `LayoutModel` contract that the renderer + PDF
// exporter already consume.
//
// Issue #12 — Phase B3 of the AutoNest TS→Rust migration.

import type { LayoutModel, LayoutRegion, PlacedPart, RenderShape } from "./layout-model"
import type { PartTemplate } from "./preset-template-data"
import type {
  BinResult,
  ClassifiedOffcut,
  PackRequest,
  PackResult,
  Placement,
} from "@/lib/packing/types"

// PartTemplate.partType ("rectangle" / "circle" / "cylinder" / "cone"
// / "trapezoid") doesn't map 1:1 to `RenderShape`. Cones unfold to
// flat sectors; cylinders pack as their unrolled rectangle. Anything
// not in the union falls through to "rect" — a defensive default
// that makes the renderer paint a bounding-box rectangle rather than
// crash, which is preferable when an unknown shape arrives.
const PART_TYPE_TO_RENDER_SHAPE: Record<string, RenderShape> = {
  rectangle: "rect",
  rect: "rect",
  cylinder: "rect",
  circle: "circle",
  cone: "sector",
  trapezoid: "trapezoid",
}

interface AdapterOptions {
  /**
   * Tag map keyed by `shapeId` — populated by AutoNest from
   * `tagByTemplateId`. The Rust side ALSO echoes the tag onto
   * each `Placement.tag`; we prefer the Placement's tag when
   * present and fall back to the map when not.
   */
  tagByShapeId?: Map<string, string>
}

/**
 * Convert one bin's slice of a `PackResult` into a `LayoutModel`. The
 * caller iterates `result.perBin` and combines results into the
 * multi-sheet array. Internal — exposed for testability.
 */
export function packResultToLayoutModel(
  result: PackResult,
  request: PackRequest,
  templates: PartTemplate[],
  options: AdapterOptions = {}
): LayoutModel[] {
  const templatesByShapeId = new Map(templates.map((t) => [t.id, t]))
  // Each bin in the request corresponds to one stock sheet that the
  // visualizer paints. Walk the request bins (which preserves
  // request-order — `result.perBin` already mirrors that order, but
  // taking the request as authoritative makes us robust to any
  // future pipeline that returns BinResult in a different sequence).
  return request.bins.map((bin) => {
    const binResult = findBinResult(result.perBin, bin.binId)
    const placements = result.placements.filter((p) => p.binId === bin.binId)

    const parts: PlacedPart[] = placements.map((p, i) =>
      placementToPlacedPart(p, i, templatesByShapeId, options.tagByShapeId)
    )

    const offcuts: LayoutRegion[] =
      binResult?.offcuts.filter((o) => o.kind === "reusable").map(offcutToRegion) ?? []

    // Scrap = bin-wide free-region polygons (`stock − parts` from the
    // Rust boolean diff). The visualizer paints these red with placed
    // parts AND reusable amber rects punched out via SVG evenodd, so
    // the painted red coverage matches the displayed `scrapAreaSqFt`
    // total — every chord-vs-arc gap, sub-cell quantization residual,
    // and post-iteration leftover that the inscribed-rect classifier
    // couldn't carve into a Scrap-classified rect now renders as red
    // instead of falling back to the stock pattern.
    //
    // The earlier rect-only path was introduced to avoid a sub-grid
    // red rim around reusable amber rects (caused by the rect's
    // 0.25"-quantized edge sitting inside the polygon's exact edge,
    // leaving a sliver of the polygon visible around every amber
    // rect). Punching the amber rects out via evenodd makes the
    // scrap polygon truly absent inside each rect — there's nothing
    // left to leak around the edges.
    const scrap: LayoutRegion[] = binResult?.freeRegions.map(polygonPointsToRegion) ?? []
    // Inscribed scrap rects retained as a SEPARATE field for the
    // "Show inscribed rects" debug toggle. These are the rectangles
    // `extract_offcuts_with_obstacles` classified below the reusable
    // threshold; the dashed dark-red outline on top of the red fill
    // shows what the histogram + monotonic-stack extractor saw.
    const debugScrapRects: LayoutRegion[] =
      binResult?.offcuts.filter((o) => o.kind === "scrap").map(offcutToRegion) ?? []

    const usedSqFt = (binResult?.usedArea ?? 0) / 144
    // Reusable area = sum of reusable offcut bboxes, capped at the
    // bin's actual waste_area. The Rust inscribed-rect extractor in
    // free_space.rs uses 0.25" grid sampling, so border cells whose
    // centre sits just inside a polygon contribute their full cell
    // area to the rect — bounded over-reporting that compounds across
    // multiple iteratively-extracted rects. Without the cap a
    // fragmented free space can produce reusable% > 100, which is
    // visually nonsense (offcuts can't exceed the bin's free area).
    const wasteAreaSqIn = binResult?.wasteArea ?? 0
    const rawReusableSqIn = offcuts.reduce((s, r) => s + r.width * r.height, 0)
    const reusableAreaSqIn = Math.min(rawReusableSqIn, wasteAreaSqIn)
    const scrapAreaSqIn = Math.max(0, wasteAreaSqIn - reusableAreaSqIn)
    // efficiency in 0..1 → score-card style 0..1 scaled mirror.
    const fabScore = binResult?.efficiency ?? 0

    return {
      sheetWidth: bin.width,
      sheetLength: bin.height,
      parts,
      offcuts,
      scrap,
      debugScrapRects,
      placedCount: placements.length,
      overflowCount: 0,
      usedAreaSqFt: usedSqFt,
      reusableAreaSqFt: reusableAreaSqIn / 144,
      scrapAreaSqFt: scrapAreaSqIn / 144,
      fabScore,
      source: "rust-rf-layout",
    }
  })
}

function findBinResult(perBin: BinResult[], binId: string): BinResult | undefined {
  return perBin.find((b) => b.binId === binId)
}

function placementToPlacedPart(
  p: Placement,
  index: number,
  templatesByShapeId: Map<string, PartTemplate>,
  tagByShapeId?: Map<string, string>
): PlacedPart {
  const template = templatesByShapeId.get(p.shapeId)
  const renderShape: RenderShape = template?.renderShape
    ? template.renderShape
    : (PART_TYPE_TO_RENDER_SHAPE[template?.partType ?? "rect"] ?? "rect")

  // Prefer the Placement's echoed tag (Rust round-trip), fall back
  // to the AutoNest tag map keyed by shapeId, then to a generated
  // letter from the index. Tag is a UI-only concern; never thrown.
  const tag = p.tag ?? tagByShapeId?.get(p.shapeId) ?? defaultLabelForIndex(index)

  return {
    id: `placement:${p.shapeId}:${p.instanceIndex}`,
    shapeId: p.shapeId,
    partNumber: template?.partNumber,
    label: tag,
    renderShape,
    specIndex: index,
    x: p.x,
    y: p.y,
    rotationRad: p.rotationRad,
    width: p.width,
    height: p.height,
    diameter: template?.diameter,
    topWidth: template?.topWidth,
    bottomWidth: template?.bottomWidth,
    innerRadius: template?.innerRadius,
    outerRadius: template?.outerRadius,
    arcDegrees: template?.arcDegrees,
    polygon: p.polygon,
    packPolygon: p.packPolygon,
  }
}

function offcutToRegion(o: ClassifiedOffcut): LayoutRegion {
  return { x: o.x, y: o.y, width: o.width, height: o.height }
}

/**
 * Wraps a `BinResult.freeRegions` polygon (raw Point2D[]) in a
 * `LayoutRegion`. The bbox fields (`x/y/width/height`) are kept
 * populated so existing consumers that read those (e.g.
 * `OffcutLabel`, the PDF exporter) don't break; the polygon points
 * are stored on `region.polygon` so `RegionShape` paints the exact
 * `stock − parts` boundary, not its bbox.
 */
function polygonPointsToRegion(points: Array<{ x: number; y: number }>): LayoutRegion {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
    polygon: points,
  }
}

// Generates A, B, C, …, Z, AA, AB, … from a 0-indexed counter — same
// algorithm AutoNest already uses inline at AutoNest.tsx:84-90. Keep
// it here as a fallback in case neither Rust nor the tag map has one.
function defaultLabelForIndex(index: number): string {
  let n = index
  let label = ""
  do {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return label
}
