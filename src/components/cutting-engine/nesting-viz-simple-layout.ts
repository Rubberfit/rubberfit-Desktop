// Layout computation for NestingVizSimpleMode
// Extracted to reduce function complexity below ESLint threshold

import type { SimplePartPreview, PreviewItem } from "./nesting-visualizer-types"
import type { NestingResult } from "@/nesting/types"
import { formatInches, getPlacementBounds } from "./nesting-layout-utils"
import {
  computeFabricationScore,
  compareStockLayoutPreviews,
  buildOptimizedStockPreview,
} from "./nesting-preview-builders"

interface SimpleModeLayoutInput {
  preview: SimplePartPreview
  previewRollW: number
  previewRollL: number
  wasRotated: boolean
  patternSeed: string
  viewMode: "stock" | "profile"
  optimizedResult: NestingResult | null
  optimizedItems: PreviewItem[] | null
}

export interface SimpleModeLayout {
  displayPreview: SimplePartPreview
  isOptimizedResult: boolean
  fabScore: {
    score: number
    breakdown: {
      wasteScore: number
      reusableScore: number
      seamScore: number
      nestingScore: number
    }
  }
  stockSqFt: number
  usedSqFt: number
  reusableOffcutSqFt: number
  scrapSqFt: number
  reusableOffcutPct: number
  scrapPct: number
  layoutNote: string
  displayItems: PreviewItem[]
  shapeFirstView: boolean
  viewWidth: number
  viewHeight: number
  scale: number
  surfaceX: number
  surfaceY: number
  surfacePxW: number
  surfacePxH: number
  unitOriginX: number
  unitOriginY: number
  canvasUnitsW: number
  canvasUnitsH: number
  stockPatternId: string
  offcutPatternId: string
  wastePatternId: string
  usablePatternId: string
  markerId: string
  rowLabelY: number
  colLabelX: number
  requestedCutPieceCount: number
  isSplitStockPreview: boolean
  missingCutPieceCount: number
  pieceCountLabel: string
  reusableMetricLabel: string
  scrapMetricLabel: string
  pieceCountValue: string
  previewTitle: string
  localBlankX: number
  localBlankY: number
  localBlankW: number
  localBlankH: number
  showOffcutLabel: boolean
  offcutLabelBands: SimplePartPreview["offcutBands"]
  showCutPlan: boolean
  metricsAreEstimatedFromStock: boolean
  previewRollW: number
  previewRollL: number
  wasRotated: boolean
  preview: SimplePartPreview
}

// eslint-disable-next-line complexity -- layout computation with many derived values
export function computeSimpleModeLayout(input: SimpleModeLayoutInput): SimpleModeLayout {
  const {
    preview,
    previewRollW,
    previewRollL,
    wasRotated,
    patternSeed,
    viewMode,
    optimizedResult,
    optimizedItems,
  } = input
  const shapeFirstView = viewMode === "profile"
  const hasOptimizedStockLayout =
    viewMode === "stock" &&
    optimizedResult !== null &&
    optimizedItems !== null &&
    optimizedItems.length > 0
  let displayPreview: SimplePartPreview = preview
  let optimizedStockPreview: SimplePartPreview | null = null
  if (hasOptimizedStockLayout && optimizedResult && optimizedItems) {
    optimizedStockPreview = buildOptimizedStockPreview(
      preview,
      optimizedResult,
      optimizedItems,
      previewRollW,
      previewRollL
    )
    if (compareStockLayoutPreviews(optimizedStockPreview, preview) < 0) {
      displayPreview = optimizedStockPreview
    }
  }
  const isOptimizedResult =
    optimizedStockPreview !== null && displayPreview === optimizedStockPreview
  const fabScore = computeFabricationScore(displayPreview, previewRollW, previewRollL)
  const stockSqFt = (previewRollW * previewRollL) / 144
  const usedSqFt = displayPreview.usedArea / 144
  const reusableOffcutSqFt = displayPreview.reusableArea / 144
  const scrapSqFt = displayPreview.scrapArea / 144
  const reusableOffcutPct = stockSqFt > 0 ? (reusableOffcutSqFt / stockSqFt) * 100 : 0
  const scrapPct = stockSqFt > 0 ? (scrapSqFt / stockSqFt) * 100 : 0
  const layoutNote = isOptimizedResult
    ? `${displayPreview.strategyNote} Optimized placements and metrics are shown in stock layout.`
    : displayPreview.strategyNote
  const displayItems = displayPreview.items
  const previewBounds = getPlacementBounds(displayItems)

  // SVG layout
  const viewWidth = 980
  const viewHeight = 560
  const padLeft = 74
  const padRight = 112
  const padTop = 82
  const padBottom = 80
  const drawWidth = viewWidth - padLeft - padRight
  const drawHeight = viewHeight - padTop - padBottom
  const heroPadX = shapeFirstView ? Math.max(previewBounds.occupiedWidth * 0.12, 1.5) : 0
  const heroPadY = shapeFirstView ? Math.max(previewBounds.occupiedHeight * 0.12, 1.5) : 0
  const canvasUnitsW = shapeFirstView
    ? Math.max(previewBounds.occupiedWidth + heroPadX * 2, 1)
    : previewRollW
  const canvasUnitsH = shapeFirstView
    ? Math.max(previewBounds.occupiedHeight + heroPadY * 2, 1)
    : previewRollL
  const unitOriginX = shapeFirstView ? previewBounds.minX - heroPadX : 0
  const unitOriginY = shapeFirstView ? previewBounds.minY - heroPadY : 0
  const scale = Math.min(drawWidth / canvasUnitsW, drawHeight / canvasUnitsH)
  const surfacePxW = canvasUnitsW * scale
  const surfacePxH = canvasUnitsH * scale
  const surfaceX = padLeft + (drawWidth - surfacePxW) / 2
  const surfaceY = padTop + (drawHeight - surfacePxH) / 2

  // Pattern IDs
  const stockPatternId = `stock-${patternSeed}`
  const offcutPatternId = `offcut-${patternSeed}`
  const wastePatternId = `waste-${patternSeed}`
  const usablePatternId = `usable-${patternSeed}`
  const markerId = `arrow-${patternSeed}`

  // Label positions
  const rowLabelY = surfaceY + surfacePxH + 50
  const colLabelX = surfaceX + surfacePxW + 50

  // Metrics
  const metricsAreEstimatedFromStock = false
  const requestedCutPieceCount =
    displayPreview.requestedUnits * Math.max(displayPreview.piecesPerUnit, 1)
  const isSplitStockPreview =
    displayPreview.renderShape !== "rect" && displayPreview.piecesPerUnit > 1
  const missingCutPieceCount = Math.max(0, requestedCutPieceCount - displayPreview.piecesShown)
  const pieceCountLabel =
    displayPreview.renderShape === "rect" || displayPreview.piecesPerUnit > 1
      ? isSplitStockPreview
        ? "Cut pieces placed"
        : "Cut pieces"
      : "Profiles placed"
  const reusableMetricLabel = "Reusable offcut"
  const scrapMetricLabel = "Waste"
  const pieceCountValue = isSplitStockPreview
    ? `${displayPreview.piecesShown}/${requestedCutPieceCount}`
    : `${displayPreview.piecesShown}`
  const previewTitle = isSplitStockPreview
    ? `${displayPreview.strategyName} - ${displayPreview.requestedUnits} finished profile${displayPreview.requestedUnits === 1 ? "" : "s"} / ${requestedCutPieceCount} cut section${requestedCutPieceCount === 1 ? "" : "s"}`
    : `${displayPreview.strategyName} - ${displayPreview.requestedUnits} part${displayPreview.requestedUnits === 1 ? "" : "s"} requested`

  // Blank and offcut labels
  const localBlankX = surfaceX + (previewBounds.minX - unitOriginX) * scale
  const localBlankY = surfaceY + (previewBounds.minY - unitOriginY) * scale
  const localBlankW = previewBounds.occupiedWidth * scale
  const localBlankH = previewBounds.occupiedHeight * scale
  const showOffcutLabel =
    !shapeFirstView && displayPreview.wasteMode === "bands" && displayPreview.offcutBands.length > 0
  const offcutLabelBands = showOffcutLabel
    ? [...displayPreview.offcutBands]
        .sort((a, b) => b.width * b.height - a.width * a.height)
        .filter((band) => band.width * scale > 42 && band.height * scale > 14)
    : []
  const showCutPlan = displayPreview.renderShape !== "rect"

  return {
    displayPreview,
    isOptimizedResult,
    fabScore,
    stockSqFt,
    usedSqFt,
    reusableOffcutSqFt,
    scrapSqFt,
    reusableOffcutPct,
    scrapPct,
    layoutNote,
    displayItems,
    shapeFirstView,
    viewWidth,
    viewHeight,
    scale,
    surfaceX,
    surfaceY,
    surfacePxW,
    surfacePxH,
    unitOriginX,
    unitOriginY,
    canvasUnitsW,
    canvasUnitsH,
    stockPatternId,
    offcutPatternId,
    wastePatternId,
    usablePatternId,
    markerId,
    rowLabelY,
    colLabelX,
    requestedCutPieceCount,
    isSplitStockPreview,
    missingCutPieceCount,
    pieceCountLabel,
    reusableMetricLabel,
    scrapMetricLabel,
    pieceCountValue,
    previewTitle,
    localBlankX,
    localBlankY,
    localBlankW,
    localBlankH,
    showOffcutLabel,
    offcutLabelBands,
    showCutPlan,
    metricsAreEstimatedFromStock,
    previewRollW,
    previewRollL,
    wasRotated,
    preview,
  }
}

export { formatInches }
