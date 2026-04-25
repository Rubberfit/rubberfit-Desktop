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

import type {
  LayoutModel,
  LayoutRegion,
  PlacedPart,
  RenderShape,
} from "./layout-model"
import type { PartTemplate } from "./preset-template-data"
import type {
  BinResult,
  ClassifiedOffcut,
  PackRequest,
  PackResult,
  Placement,
  Point2D,
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
      binResult?.offcuts
        .filter((o) => o.kind === "reusable")
        .map(offcutToRegion) ?? []

    // Scrap is everything else in the waste: classified scrap rects
    // from the inscribed-rect pass + the raw `freeRegions` polygons
    // (which preserve irregular waste shape for cone/trapezoid mixes
    // where rectangular inscribed rects would lose fidelity). Both
    // overlap geometrically — that's fine because reusable amber
    // rects paint on top, masking the scrap underneath where they
    // overlap.
    const scrapRects: LayoutRegion[] =
      binResult?.offcuts
        .filter((o) => o.kind === "scrap")
        .map(offcutToRegion) ?? []
    const scrapPolygons: LayoutRegion[] =
      binResult?.freeRegions.map((poly) => polygonToRegion(poly)) ?? []
    const scrap = [...scrapPolygons, ...scrapRects]

    const usedSqFt = (binResult?.usedArea ?? 0) / 144
    // reusable area = sum of reusable offcut bboxes, in sq ft
    const reusableAreaSqIn = offcuts.reduce((s, r) => s + r.width * r.height, 0)
    const scrapAreaSqIn = (binResult?.wasteArea ?? 0) - reusableAreaSqIn
    // efficiency in 0..1 → score-card style 0..1 scaled mirror.
    const fabScore = binResult?.efficiency ?? 0

    return {
      sheetWidth: bin.width,
      sheetLength: bin.height,
      parts,
      offcuts,
      scrap,
      placedCount: placements.length,
      overflowCount: 0,
      usedAreaSqFt: usedSqFt,
      reusableAreaSqFt: reusableAreaSqIn / 144,
      scrapAreaSqFt: Math.max(0, scrapAreaSqIn / 144),
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
    : PART_TYPE_TO_RENDER_SHAPE[template?.partType ?? "rect"] ?? "rect"

  // Prefer the Placement's echoed tag (Rust round-trip), fall back
  // to the AutoNest tag map keyed by shapeId, then to a generated
  // letter from the index. Tag is a UI-only concern; never thrown.
  const tag =
    p.tag ?? tagByShapeId?.get(p.shapeId) ?? defaultLabelForIndex(index)

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
  }
}

function offcutToRegion(o: ClassifiedOffcut): LayoutRegion {
  return { x: o.x, y: o.y, width: o.width, height: o.height }
}

function polygonToRegion(poly: Point2D[]): LayoutRegion {
  // bbox of the polygon — the renderer uses width/height as a fallback
  // when polygon-aware drawing isn't available.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const pt of poly) {
    if (pt.x < minX) minX = pt.x
    if (pt.y < minY) minY = pt.y
    if (pt.x > maxX) maxX = pt.x
    if (pt.y > maxY) maxY = pt.y
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    polygon: poly,
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
