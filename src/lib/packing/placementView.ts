// Ported from rema-portal src/application/packing/placementView.ts.
// Pure type module — kept alongside the other pack types so UI code
// in src/components/cutting-engine/ can build a denormalized view
// from a PackResult without reaching into rema's old @/src/ tree.

import type { Point2D, ShapeSpec } from "./types"

export type RenderShape = "rect" | "circle" | "trapezoid" | "sector" | "ngon" | "polygon"

export interface PlacementViewItem {
  shapeId: string
  instanceIndex: number
  binId: string
  x: number
  y: number
  rotationRad: number
  width: number
  height: number
  polygon: Point2D[]
  shapeSpec?: ShapeSpec
  renderShape: RenderShape
  difficulty?: number
}

export interface PlacementViewBin {
  binId: string
  width: number
  height: number
  items: PlacementViewItem[]
  usedArea: number
  wasteArea: number
  occupiedWidth: number
  occupiedHeight: number
  efficiency: number
}

export interface PlacementView {
  items: PlacementViewItem[]
  bins: Record<string, PlacementViewBin>
  placedCount: number
  overflowCount: number
  totalUsedArea: number
  totalWasteArea: number
}
