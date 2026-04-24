// Types and interfaces for NestingVisualizer

export type ShapeType = "rect" | "circle" | "cone"
export type GrainDir = "none" | "width" | "length"
export type DiagDir = "ltr" | "rtl"
export type StratMethod = "rect" | "diag"
export type SimplePartType = "rectangle" | "circle" | "cylinder" | "cone" | "trapezoid"
export type SimpleCutDirection =
  | "vertical_split"
  | "horizontal_split"
  | "radial_split"
  | "arc_bands"
  | "wrap_panels"
  | "wrap_bands"

export interface SimplePartSpec {
  partType: SimplePartType
  quantity: number
  cutDirection?: SimpleCutDirection
  cutRatios?: number[]
  width?: number
  length?: number
  diameter?: number
  height?: number
  topWidth?: number
  bottomWidth?: number
  innerRadius?: number
  outerRadius?: number
  arcDegrees?: number
  partNumber?: string
}

export interface Strategy {
  id: string
  name: string
  sub: string
  method: StratMethod
  cutW: number
  cutH: number
  primaryDir: "horizontal" | "vertical"
  diagType?: "corner" | "custom"
  diagAngle?: number
  ddir?: DiagDir
  steps: string[]
  icon: string
}

export interface ScoredStrategy extends Strategy {
  cols: number
  rows: number
  rects: number
  pieces: number
  waste: number
  vCuts: number
  hCuts: number
  score: number
  reasons: { p: "p" | "w" | "f"; t: string }[]
}

/**
 * One reusable offcut rectangle extracted from the sheet. Emitted
 * alongside the aggregate metrics so downstream consumers (e.g.
 * the cut-recording route) can spawn one inventory row per piece
 * instead of one aggregate strip. Dims in inches.
 */
export interface OffcutPieceMetric {
  widthIn: number
  lengthIn: number
  /** Convenience square-footage so consumers don't redo /144. */
  areaSqft: number
}

export interface SimpleCutMetrics {
  partsCompleted: number
  cutPieces: number
  materialUsedSqFt: number
  reusableOffsetSqFt: number
  scrapSqFt: number
  fabScore: number
  /**
   * Per-piece offcut geometry. Empty when the layout has no
   * reusable offcut. Across multi-sheet layouts this is the
   * union of every sheet's reusable bands.
   */
  offcutPieces: OffcutPieceMetric[]
}

export interface NestingVisualizerProps {
  defaultRollWidth?: number
  defaultRollLength?: number
  defaultCutWidth?: number
  defaultCutHeight?: number
  defaultQty?: number
  simplePart?: SimplePartSpec
  simpleParts?: SimplePartSpec[]
  onMetricsChange?: (metrics: SimpleCutMetrics) => void
  onTagMapChange?: (tagMap: Map<string, string>) => void
}

export interface SimpleRectLayout {
  orientation: "default" | "rotated"
  pieceW: number
  pieceH: number
  cols: number
  rows: number
  rowCounts: number[]
  capacity: number
  placed: number
  overflow: number
  usedArea: number
  wasteArea: number
  wastePct: number
  reusableArea: number
  scrapArea: number
  reusablePieces: number
}

export interface SimpleCircleLayout {
  positions: ShapePlacement[]
  blankSize: number
  capacity: number
  placed: number
  overflow: number
  usedArea: number
  wasteArea: number
  wastePct: number
}

export type SimplePreviewShape = "rect" | "circle" | "trapezoid" | "sector"

export interface ShapePlacement {
  x: number
  y: number
  width: number
  height: number
  flipped?: boolean
  rotated90?: boolean
}

export interface OffcutBand {
  x: number
  y: number
  width: number
  height: number
  /** For NFP layouts: actual polygon outline of the free region */
  polygon?: Array<{ x: number; y: number }>
}

export interface PackedShapeLayout {
  positions: ShapePlacement[]
  capacity: number
  placed: number
  overflow: number
  occupiedWidth: number
  occupiedHeight: number
}

export interface PackedPreviewItemsResult {
  items: PreviewItem[]
  usedArea: number
  occupiedWidth: number
  occupiedHeight: number
  freeRects?: OffcutBand[]
}

export interface CutPlanStep {
  title: string
  detail: string
}

export interface PreviewItem extends ShapePlacement {
  renderShape: SimplePreviewShape
  label: string
  /** Index of the originating spec in the simpleParts array (used for unique tag assignment) */
  specIndex?: number
  /** Part number from uploaded cut list (e.g. "G2"); used as tag when available */
  partNumber?: string
  cutDirection?: SimpleCutDirection
  diameter?: number
  topWidth?: number
  bottomWidth?: number
  innerRadius?: number
  outerRadius?: number
  arcDegrees?: number
  /** NFP solver rotation in radians (0 for heuristic placements) */
  rotation?: number
  /** Pre-computed polygon vertices (rotated + translated) from NFP solver */
  placedPolygon?: Array<{ x: number; y: number }>
}

export interface PreviewSection {
  start: number
  end: number
  label: string
  item: PreviewItem & { usedArea: number }
}

export interface SimplePreviewBase {
  renderShape: SimplePreviewShape
  strategyName: string
  strategyNote: string
  cutDirection?: SimpleCutDirection
  cutRatios?: number[]
  cutBreakpoints?: number[]
  cutLabels?: string[]
  profileItem?: PreviewItem
  sections?: PreviewSection[]
  placementMode: "origin" | "center"
  wasteMode: "bands" | "summary"
  cutPlanTitle: string
  cutSteps: CutPlanStep[]
  requestedUnits: number
  unitsCompleted: number
  overflowUnits: number
  piecesShown: number
  piecesPerUnit: number
  usedArea: number
  wasteArea: number
  wastePct: number
  reusableArea: number
  scrapArea: number
  occupiedWidth: number
  occupiedHeight: number
  items: PreviewItem[]
  offcutBands: OffcutBand[]
  scrapBands: OffcutBand[]
  fabricationScore?: number
  fabricationBreakdown?: {
    wasteScore: number
    reusableScore: number
    seamScore: number
    nestingScore: number
  }
}

export interface RectLikePreview extends SimplePreviewBase {
  renderShape: "rect" | "trapezoid" | "sector"
  placements: ShapePlacement[]
  label: string
  topWidth?: number
  bottomWidth?: number
  height?: number
  innerRadius?: number
  outerRadius?: number
  arcDegrees?: number
}

export interface CirclePreview extends SimplePreviewBase {
  renderShape: "circle"
  layout: SimpleCircleLayout
  diameter: number
}

export type SimplePartPreview = RectLikePreview | CirclePreview

export interface SheetPreview {
  sheetIndex: number
  preview: SimplePartPreview
  isPartial: boolean
}

export interface MultiSheetResult {
  sheets: SheetPreview[]
  totalUnitsCompleted: number
  totalUsedArea: number
  totalReusableArea: number
  totalScrapArea: number
  totalStockArea: number
  remainingOverflow: number
  avgFabScore: number
}

export type PreviewPackSort = "area" | "height" | "width" | "max-edge"

export const MIN_REUSABLE_OFFCUT_WIDTH = 11.5
export const MIN_REUSABLE_OFFCUT_HEIGHT = 12
export const MIN_REUSABLE_STRIP_WIDTH = 6
export const MIN_REUSABLE_STRIP_LENGTH = 24
