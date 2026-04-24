import type { SimplePartPreview, OffcutBand, PreviewItem } from "./nesting-visualizer-types"
import type { SimpleCutDirection } from "./nesting-visualizer-types"

/**
 * Shape-family dispatch for the Konva renderer + PDF renderer.
 *
 * - Primitives that map to a Konva native shape: `rect`, `circle`,
 *   `ellipse`, `ring`.
 * - Primitives that Konva doesn't ship but we compose from a vertex
 *   array: `trapezoid`, `sector`, `triangle`, `ngon`, `star`, and the
 *   generic escape-hatch `polygon`. All of these require
 *   `PlacedPart.polygon` to be populated at template-create time.
 *
 * Renderer dispatch lives in `KonvaSheetRenderer.PartShape`. Any
 * shape in this union that does NOT have a first-class Konva
 * primitive falls through to the polygon `<Line closed points>`
 * path, then to `<Rect>` as a last-resort fallback.
 */
export type RenderShape =
  | "rect"
  | "circle"
  | "ellipse"
  | "ring"
  | "trapezoid"
  | "sector"
  | "triangle"
  | "ngon"
  | "star"
  | "polygon"

export interface PlacedPart {
  id: string
  shapeId: string
  partNumber?: string
  label: string
  renderShape: RenderShape
  specIndex: number

  /** Inches, sheet-space (post-rotation so Konva/PDF coords are final). */
  x: number
  y: number
  rotationRad: number

  width: number
  height: number

  diameter?: number
  topWidth?: number
  bottomWidth?: number
  innerRadius?: number
  outerRadius?: number
  arcDegrees?: number

  /** Actual placed polygon vertices (inches, post-rotation). Present for non-rect shapes. */
  polygon?: Array<{ x: number; y: number }>
  cutDirection?: SimpleCutDirection
  flipped?: boolean
  rotated90?: boolean
}

export interface LayoutRegion {
  x: number
  y: number
  width: number
  height: number
  polygon?: Array<{ x: number; y: number }>
}

export interface LayoutModel {
  /** Display width in inches (post-rotation — what the user sees on screen). */
  sheetWidth: number
  /** Display length in inches (post-rotation). */
  sheetLength: number

  parts: PlacedPart[]
  offcuts: LayoutRegion[]
  scrap: LayoutRegion[]

  placedCount: number
  overflowCount: number
  usedAreaSqFt: number
  reusableAreaSqFt: number
  scrapAreaSqFt: number
  fabScore: number

  source: "ts-nfp"
}

// ── Normaliser ───────────────────────────────────────────────────────────────

function bandToRegion(b: OffcutBand): LayoutRegion {
  return { x: b.x, y: b.y, width: b.width, height: b.height, polygon: b.polygon }
}

// Map the PreviewItem.renderShape strings (from the Auto-nest
// NestingVisualizer pipeline) onto our RenderShape union. Keep this
// narrow — new shapes added for Free-roam's shape library don't
// need to round-trip through the Auto-nest preview path; they come
// in via `PartTemplate` → manual placements instead.
const RENDER_SHAPE_MAP: Record<string, RenderShape> = {
  rect: "rect",
  circle: "circle",
  trapezoid: "trapezoid",
  sector: "sector",
}

function itemToPlacedPart(
  item: PreviewItem,
  index: number,
  tagMap: Map<string, string>
): PlacedPart {
  const tagKey = item.specIndex != null ? String(item.specIndex) : String(index)
  const label = tagMap.get(tagKey) ?? tagKey
  const renderShape: RenderShape = RENDER_SHAPE_MAP[item.renderShape] ?? "rect"

  return {
    id: `item:${index}`,
    shapeId: item.partNumber ?? `spec-${item.specIndex ?? index}`,
    partNumber: item.partNumber,
    label,
    renderShape,
    specIndex: item.specIndex ?? 0,
    x: item.x,
    y: item.y,
    rotationRad: item.rotation ?? 0,
    width: item.width,
    height: item.height,
    diameter: item.diameter,
    topWidth: item.topWidth,
    bottomWidth: item.bottomWidth,
    innerRadius: item.innerRadius,
    outerRadius: item.outerRadius,
    arcDegrees: item.arcDegrees,
    polygon: item.placedPolygon,
    cutDirection: item.cutDirection,
    flipped: item.flipped,
    rotated90: item.rotated90,
  }
}

/**
 * Convert a NestingVisualizer preview (already post-rotation) into a LayoutModel.
 * `sheetW` / `sheetL` are the display dimensions in inches (post-rotation).
 * `tagMap` is keyed by specIndex string → tag letter or part number.
 */
export function fromPreviewToLayoutModel(
  preview: SimplePartPreview,
  sheetW: number,
  sheetL: number,
  tagMap: Map<string, string>
): LayoutModel {
  return {
    sheetWidth: sheetW,
    sheetLength: sheetL,
    parts: preview.items.map((item, i) => itemToPlacedPart(item, i, tagMap)),
    offcuts: preview.offcutBands.map(bandToRegion),
    scrap: preview.scrapBands.map(bandToRegion),
    placedCount: preview.unitsCompleted,
    overflowCount: preview.overflowUnits,
    usedAreaSqFt: preview.usedArea / 144,
    reusableAreaSqFt: preview.reusableArea / 144,
    scrapAreaSqFt: preview.scrapArea / 144,
    fabScore: (preview.fabricationScore ?? 0) / 100,
    source: "ts-nfp",
  }
}
