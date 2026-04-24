// Stock layout preview builders for optimized and custom packed layouts
// Split from nesting-preview-builders.ts to stay under the max-lines limit

import type {
  OffcutBand,
  PreviewItem,
  RectLikePreview,
  ShapePlacement,
  SimplePartPreview,
  SimpleCutDirection,
  PackedPreviewItemsResult,
} from "./nesting-visualizer-types"
import type { NestingResult } from "@/nesting/types"
import type { GreedyPackResult } from "@/nesting/nfp-greedy-placer"
import { extractMaximalFreeRects, classifyFreeRegion } from "@/nesting/free-space"
import {
  buildOffcutBands,
  bandFitsAnyPreviewItem,
  getPlacementBounds,
  packPreviewItemsOnShelves,
} from "./nesting-layout-utils"

export function buildOptimizedStockPreview(
  preview: SimplePartPreview,
  result: NestingResult,
  items: PreviewItem[],
  rollW: number,
  rollL: number
): SimplePartPreview {
  const rollArea = result.stockArea > 0 ? result.stockArea : rollW * rollL
  const usedArea = Math.max(0, result.usedArea)
  const fallbackBounds = getPlacementBounds(items)
  const occupiedWidth =
    result.occupiedWidth > 0 ? result.occupiedWidth : fallbackBounds.occupiedWidth
  const occupiedHeight =
    result.occupiedHeight > 0 ? result.occupiedHeight : fallbackBounds.occupiedHeight
  // Use polygon-aware free space if items have placed polygon outlines
  const placedPolygons = items
    .map((item) => item.placedPolygon)
    .filter((poly): poly is Array<{ x: number; y: number }> => poly != null && poly.length >= 3)

  const offcutBands: OffcutBand[] = []
  const scrapBands: OffcutBand[] = []
  let reusableArea = 0

  if (placedPolygons.length > 0) {
    const freeRects = extractMaximalFreeRects(rollW, rollL, placedPolygons)
    for (const rect of freeRects) {
      const band: OffcutBand = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      }
      if (classifyFreeRegion(rect) === "reusable") {
        offcutBands.push(band)
        reusableArea += rect.area
      } else {
        scrapBands.push(band)
      }
    }
  } else {
    const allBands = buildOffcutBands(fallbackBounds, rollW, rollL, preview.placementMode)
    allBands.forEach((band) => {
      const area = band.width * band.height
      if (bandFitsAnyPreviewItem(band, items)) {
        offcutBands.push(band)
        reusableArea += area
      } else {
        scrapBands.push(band)
      }
    })
  }

  const wasteArea = Math.max(0, rollArea - usedArea)
  const scrapArea = Math.max(0, wasteArea - reusableArea)
  const unitsCompleted =
    preview.piecesPerUnit > 0 ? Math.floor(result.placed / preview.piecesPerUnit) : result.placed
  const overflowUnits = Math.max(0, preview.requestedUnits - unitsCompleted)

  return {
    ...preview,
    items,
    usedArea,
    wasteArea,
    wastePct: rollArea > 0 ? (wasteArea / rollArea) * 100 : 100,
    reusableArea,
    scrapArea,
    occupiedWidth,
    occupiedHeight,
    unitsCompleted,
    overflowUnits,
    piecesShown: items.length,
    offcutBands,
    scrapBands,
    wasteMode: "bands",
  } as SimplePartPreview
}

export function buildCustomPackedPreview(
  rollW: number,
  rollL: number,
  items: Array<PreviewItem & { usedArea: number }>,
  config: {
    renderShape: "rect" | "trapezoid" | "sector"
    strategyName: string
    strategyNote: string
    cutDirection?: SimpleCutDirection
    requestedUnits: number
    piecesPerUnit: number
    label: string
    topWidth?: number
    bottomWidth?: number
    height?: number
    innerRadius?: number
    outerRadius?: number
    arcDegrees?: number
    cutRatios?: number[]
    cutBreakpoints?: number[]
    cutLabels?: string[]
    flipPattern?: "none" | "checker"
  }
): RectLikePreview {
  const packed = packPreviewItemsOnShelves(items, rollW, rollL, "area", config.flipPattern)
  return buildCustomPackedPreviewFromPackedResult(rollW, rollL, packed, config)
}

export function buildCustomPackedPreviewFromPackedResult(
  rollW: number,
  rollL: number,
  packed: PackedPreviewItemsResult,
  config: {
    renderShape: "rect" | "trapezoid" | "sector"
    strategyName: string
    strategyNote: string
    cutDirection?: SimpleCutDirection
    requestedUnits: number
    piecesPerUnit: number
    label: string
    topWidth?: number
    bottomWidth?: number
    height?: number
    innerRadius?: number
    outerRadius?: number
    arcDegrees?: number
    cutRatios?: number[]
    cutBreakpoints?: number[]
    cutLabels?: string[]
    flipPattern?: "none" | "checker"
  }
): RectLikePreview {
  const bounds = getPlacementBounds(packed.items)
  const reusableBands: OffcutBand[] = []
  const scrapBands: OffcutBand[] = []
  let reusableArea = 0

  // Use polygon-aware free space if items have placed polygon outlines
  const packedPolygons = packed.items
    .map((item) => item.placedPolygon)
    .filter((poly): poly is Array<{ x: number; y: number }> => poly != null && poly.length >= 3)

  if (packedPolygons.length > 0) {
    const freeRects = extractMaximalFreeRects(rollW, rollL, packedPolygons)
    for (const rect of freeRects) {
      const band: OffcutBand = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      }
      if (classifyFreeRegion(rect) === "reusable") {
        reusableBands.push(band)
        reusableArea += rect.area
      } else {
        scrapBands.push(band)
      }
    }
  } else {
    const allBands = packed.freeRects ?? buildOffcutBands(bounds, rollW, rollL, "origin")
    allBands.forEach((band) => {
      const area = band.width * band.height
      if (bandFitsAnyPreviewItem(band, packed.items)) {
        reusableBands.push(band)
        reusableArea += area
      } else {
        scrapBands.push(band)
      }
    })
  }

  const rollArea = rollW * rollL
  const wasteArea = Math.max(0, rollArea - packed.usedArea)
  const scrapArea = Math.max(0, wasteArea - reusableArea)
  const unitsCompleted = Math.floor(packed.items.length / Math.max(config.piecesPerUnit, 1))

  return {
    renderShape: config.renderShape,
    strategyName: config.strategyName,
    strategyNote: config.strategyNote,
    cutDirection: config.cutDirection,
    cutRatios: config.cutRatios,
    cutBreakpoints: config.cutBreakpoints,
    cutLabels: config.cutLabels,
    placementMode: "origin",
    wasteMode: "bands",
    cutPlanTitle: "Cut sequence",
    cutSteps: [],
    requestedUnits: config.requestedUnits,
    unitsCompleted,
    overflowUnits: Math.max(0, config.requestedUnits - unitsCompleted),
    piecesShown: packed.items.length,
    piecesPerUnit: config.piecesPerUnit,
    usedArea: packed.usedArea,
    wasteArea,
    wastePct: rollW * rollL > 0 ? (wasteArea / (rollW * rollL)) * 100 : 100,
    reusableArea,
    scrapArea,
    occupiedWidth: bounds.occupiedWidth,
    occupiedHeight: bounds.occupiedHeight,
    items: packed.items,
    offcutBands: reusableBands,
    scrapBands,
    placements: packed.items,
    label: config.label,
    topWidth: config.topWidth,
    bottomWidth: config.bottomWidth,
    height: config.height,
    innerRadius: config.innerRadius,
    outerRadius: config.outerRadius,
    arcDegrees: config.arcDegrees,
  }
}

export function buildNfpPackedPreview(
  nfpResult: GreedyPackResult,
  _rollW: number,
  _rollL: number,
  config: {
    renderShape: "rect" | "trapezoid" | "sector"
    strategyName: string
    strategyNote: string
    requestedUnits: number
    piecesPerUnit: number
    pieceArea: number
    label: string
    topWidth?: number
    bottomWidth?: number
    height?: number
    innerRadius?: number
    outerRadius?: number
    arcDegrees?: number
  }
): RectLikePreview {
  const unitsCompleted = Math.floor(nfpResult.placed / config.piecesPerUnit)
  const usedArea = nfpResult.placed * config.pieceArea

  const items: PreviewItem[] = nfpResult.placements.map((p) => ({
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    renderShape: config.renderShape,
    label: config.label,
    rotation: p.rotation,
    placedPolygon: p.placedPolygon,
    topWidth: config.topWidth,
    bottomWidth: config.bottomWidth,
    innerRadius: config.innerRadius,
    outerRadius: config.outerRadius,
    arcDegrees: config.arcDegrees,
  }))

  const placements: ShapePlacement[] = nfpResult.placements.map((p) => ({
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
  }))

  return {
    renderShape: config.renderShape,
    strategyName: config.strategyName,
    strategyNote: config.strategyNote,
    placementMode: "origin",
    wasteMode: "bands",
    cutPlanTitle: "Cut sequence",
    cutSteps: [],
    requestedUnits: config.requestedUnits,
    unitsCompleted,
    overflowUnits: Math.max(0, config.requestedUnits - unitsCompleted),
    piecesShown: nfpResult.placed,
    piecesPerUnit: config.piecesPerUnit,
    usedArea,
    wasteArea: 0,
    wastePct: 0,
    reusableArea: 0,
    scrapArea: 0,
    items,
    placements,
    occupiedWidth: nfpResult.occupiedWidth,
    occupiedHeight: nfpResult.occupiedHeight,
    offcutBands: [],
    scrapBands: [],
    label: config.label,
    topWidth: config.topWidth,
    bottomWidth: config.bottomWidth,
    height: config.height,
    innerRadius: config.innerRadius,
    outerRadius: config.outerRadius,
    arcDegrees: config.arcDegrees,
  }
}
