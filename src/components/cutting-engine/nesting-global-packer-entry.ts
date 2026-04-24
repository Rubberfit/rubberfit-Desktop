// Global multi-sheet packing entry point + sheet builder
// Split from nesting-global-packer.ts to stay under max-lines limit

import type {
  OffcutBand,
  PreviewItem,
  RectLikePreview,
  SimplePartSpec,
  MultiSheetResult,
  SheetPreview,
} from "./nesting-visualizer-types"
import {
  bandFitsAnyPreviewItem,
  computeIntraBlankWaste,
  getPlacementBounds,
} from "./nesting-offcut-utils"
import { globalWidthPairPack } from "./nesting-width-pair-packer"
import { buildPartPreviewItem, computeFabricationScore } from "./nesting-preview-builders"
import {
  MaxRectBin,
  batchFillBin,
  type HeuristicType,
  type PackableItem,
  type Placement,
} from "./nesting-global-packer"

// ---------------------------------------------------------------------------
// Exhaustive rotation search — minimize occupied height on last sheet
// ---------------------------------------------------------------------------

function exhaustiveRotationSearch(
  items: PackableItem[],
  binW: number,
  binH: number,
  heuristic: HeuristicType
): { placements: Placement[]; occupiedHeight: number } | null {
  const n = items.length
  if (n === 0) return null

  // Only non-square, non-oriented items contribute to rotation search.
  // Trapezoids and sectors have semantic geometry fields (topWidth/bottomWidth,
  // innerRadius/outerRadius) that are perpendicular to height — rotating them
  // 90° produces inconsistent PreviewItem state and broken rendering.
  const rotatableIndices: number[] = []
  for (let i = 0; i < n; i++) {
    const rs = items[i].item.renderShape
    const isOriented = rs === "trapezoid" || rs === "sector"
    if (!isOriented && Math.abs(items[i].w - items[i].h) > 0.001) rotatableIndices.push(i)
  }
  const effectiveN = rotatableIndices.length
  const maxExhaustive = 14
  const totalCombos = effectiveN <= maxExhaustive ? 1 << effectiveN : 0

  let bestPlacements: Placement[] = []
  let bestHeight = Infinity

  const tryPacking = (
    orientedItems: PackableItem[]
  ): { placements: Placement[]; height: number } => {
    const bin = new MaxRectBin(0, binW, binH)
    const result: Placement[] = []
    let maxY = 0

    for (const item of orientedItems) {
      // Rotation disabled — the mask already controls orientation
      const fit = bin.scoreRect(item.w, item.h, heuristic, false)
      if (!fit) continue

      bin.place(fit.x, fit.y, fit.w, fit.h)
      result.push({
        binIndex: 0,
        x: fit.x,
        y: fit.y,
        w: fit.w,
        h: fit.h,
        // Compare placed width vs original spec width to detect rotation
        rotated: Math.abs(fit.w - item.item.width) > 0.001,
        itemIndex: item.index,
      })
      maxY = Math.max(maxY, fit.y + fit.h)
    }
    return { placements: result, height: maxY }
  }

  // Exhaustive search over rotation masks
  if (totalCombos > 0) {
    for (let mask = 0; mask < totalCombos; mask++) {
      const oriented = items.map((item) => ({ ...item }))
      for (let bit = 0; bit < effectiveN; bit++) {
        if ((mask >> bit) & 1) {
          const idx = rotatableIndices[bit]
          const orig = oriented[idx]
          oriented[idx] = { ...orig, w: orig.h, h: orig.w }
        }
      }
      oriented.sort((a, b) => b.h - a.h || b.w - a.w)
      const result = tryPacking(oriented)
      if (result.placements.length === n && result.height < bestHeight) {
        bestHeight = result.height
        bestPlacements = result.placements
      }
    }
  }

  // Also try greedy with 4 sort orders as fallback
  const sortFns: Array<(a: PackableItem, b: PackableItem) => number> = [
    (a, b) => b.w * b.h - a.w * a.h,
    (a, b) => b.h - a.h || b.w - a.w,
    (a, b) => b.w - a.w || b.h - a.h,
    (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h),
  ]
  for (const sortFn of sortFns) {
    const sorted = [...items].sort(sortFn)
    const result = tryPacking(sorted)
    if (result.placements.length === n && result.height < bestHeight) {
      bestHeight = result.height
      bestPlacements = result.placements
    }
  }

  if (bestPlacements.length === 0) return null
  return { placements: bestPlacements, occupiedHeight: bestHeight }
}

// ---------------------------------------------------------------------------
// Build SheetPreview from placements
// ---------------------------------------------------------------------------

function buildSheetFromPlacements(
  placements: Placement[],
  sortedItems: (PreviewItem & { usedArea: number })[],
  rollW: number,
  rollL: number,
  sheetIndex: number,
  isPartial: boolean
): SheetPreview {
  // Clamp placement sizes to stock bounds (shrink only, never move position).
  // Moving x/y can push items into space occupied by other placements.
  const clampedPlacements = placements
    .map((p) => ({
      ...p,
      w: Math.min(p.w, Math.max(0, rollW - p.x)),
      h: Math.min(p.h, Math.max(0, rollL - p.y)),
    }))
    .filter((p) => p.w > 0.001 && p.h > 0.001)

  // Filter out overlapping items — the MaxRects packer shouldn't produce
  // overlaps, but floating-point edge cases in dense layouts can cause them.
  // Accept items greedily in placement order; reject any that overlap an
  // already-accepted item (AABB overlap with 0.5 tolerance).
  const accepted: Placement[] = []
  for (const p of clampedPlacements) {
    const overlaps = accepted.some(
      (a) =>
        p.x < a.x + a.w - 0.5 &&
        p.x + p.w > a.x + 0.5 &&
        p.y < a.y + a.h - 0.5 &&
        p.y + p.h > a.y + 0.5
    )
    if (!overlaps) accepted.push(p)
  }

  const placedItems: PreviewItem[] = accepted.map((p) => {
    const original = sortedItems[p.itemIndex]
    const item: PreviewItem = {
      ...original,
      x: p.x,
      y: p.y,
      width: p.w,
      height: p.h,
      rotated90: p.rotated ? !(original.rotated90 ?? false) : (original.rotated90 ?? false),
      flipped: p.rotated ? !(original.flipped ?? false) : (original.flipped ?? false),
    }

    // Trapezoids must render in their original upright orientation regardless of
    // how the MaxRects solver rotated them for packing.  Restore the original
    // dimensions so TrapezoidShape draws the correct top/bottom edge widths.
    if (original.renderShape === "trapezoid" && original.topWidth != null) {
      item.width = Math.max(original.topWidth, original.bottomWidth ?? original.topWidth)
      item.height = original.height
      item.rotated90 = false
      item.rotation = 0
      item.flipped = false
      item.placedPolygon = undefined
    }

    return item
  })

  const usedArea = accepted.reduce((sum, p) => sum + sortedItems[p.itemIndex].usedArea, 0)
  const bounds = getPlacementBounds(placedItems)

  // Reconstruct free rects by replaying placements on a fresh bin
  const bin = new MaxRectBin(0, rollW, rollL)
  for (const p of accepted) {
    bin.place(p.x, p.y, p.w, p.h)
  }

  // Classify free rects as reusable offcuts vs scrap.
  // For mixed-shape layouts, check ALL placed items' dimensions — not just
  // the first — so a band that fits any of the placed shapes is reusable.
  const offcutBands: OffcutBand[] = []
  const scrapBands: OffcutBand[] = []
  let reusableArea = 0
  let scrapArea = 0

  for (const fr of bin.freeRects) {
    const band: OffcutBand = { x: fr.x, y: fr.y, width: fr.w, height: fr.h }
    const bandArea = fr.w * fr.h
    if (bandFitsAnyPreviewItem(band, placedItems)) {
      offcutBands.push(band)
      reusableArea += bandArea
    } else {
      scrapBands.push(band)
      scrapArea += bandArea
    }
  }

  const intraWaste = placedItems.reduce((sum, item) => sum + computeIntraBlankWaste(item), 0)

  // MaxRects free rects overlap (maximal rectangles share area), so raw sums
  // inflate reusable + scrap totals.  Compute the true free area from the
  // stock area minus the used area, then split proportionally.
  const stockArea = rollW * rollL
  const actualFreeArea = Math.max(0, stockArea - usedArea)
  const rawTotal = reusableArea + scrapArea
  let correctedReusable: number
  let correctedScrap: number
  if (rawTotal > 0) {
    correctedReusable = actualFreeArea * (reusableArea / rawTotal)
    correctedScrap = actualFreeArea - correctedReusable + intraWaste
  } else {
    correctedReusable = 0
    correctedScrap = actualFreeArea + intraWaste
  }
  const wasteArea = correctedReusable + correctedScrap

  const preview: RectLikePreview = {
    // Circles are packed as bounding rectangles in global layout, so map to "rect"
    renderShape:
      placedItems[0]?.renderShape === "circle" ? "rect" : (placedItems[0]?.renderShape ?? "rect"),
    strategyName: "Global-optimized layout",
    strategyNote:
      "Items globally assigned across sheets using MaxRects with all 5 heuristics (BSSF/BLSF/BAF/BL/CP) and batch insertion for minimal waste.",
    placementMode: "origin",
    wasteMode: "bands",
    cutPlanTitle: "Cut sequence",
    cutSteps: [
      {
        title: "Rough-cut the selected blanks in placement order",
        detail:
          "The preview globally optimizes item placement across all sheets for minimal waste.",
      },
      {
        title: "Finish each profile from its placed blank",
        detail:
          "Non-rectangular parts show their blank scrap directly so the cutter can see where the finished profile comes out of each placement.",
      },
    ],
    requestedUnits: placedItems.length,
    unitsCompleted: placedItems.length,
    overflowUnits: 0,
    piecesShown: placedItems.length,
    piecesPerUnit: 1,
    usedArea,
    wasteArea,
    wastePct: stockArea > 0 ? (wasteArea / stockArea) * 100 : 100,
    reusableArea: correctedReusable,
    scrapArea: correctedScrap,
    occupiedWidth: bounds.occupiedWidth,
    occupiedHeight: bounds.occupiedHeight,
    items: placedItems,
    offcutBands,
    scrapBands,
    placements: placedItems,
    label: placedItems[0]?.label ?? "",
  }

  return { sheetIndex, preview, isPartial }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function globalMultiSheetPack(
  specs: SimplePartSpec[],
  rollW: number,
  rollL: number,
  maxSheets: number,
  fallbackWidth: number,
  fallbackHeight: number
): MultiSheetResult {
  const stockArea = rollW * rollL

  // Build all items from specs (expand quantities)
  const allItems = specs.flatMap((spec, specIdx) =>
    Array.from({ length: Math.max(1, spec.quantity || 1) }, () => {
      const item = buildPartPreviewItem(spec, fallbackWidth, fallbackHeight)
      item.specIndex = specIdx
      item.partNumber = spec.partNumber
      return item
    })
  )

  if (allItems.length === 0) {
    return {
      sheets: [],
      totalUnitsCompleted: 0,
      totalUsedArea: 0,
      totalReusableArea: 0,
      totalScrapArea: 0,
      totalStockArea: 0,
      remainingOverflow: 0,
      avgFabScore: 0,
    }
  }

  const basePackItems: PackableItem[] = allItems.map((item, i) => ({
    index: i,
    w: item.width,
    h: item.height,
    item,
  }))

  // All 5 heuristics from Jylänki's paper
  const heuristics: HeuristicType[] = ["bssf", "blsf", "baf", "bl", "cp"]

  // Sort strategies from rectpack (for greedy mode)
  const sortFns: Array<{
    fn: (a: PackableItem, b: PackableItem) => number
  }> = [
    { fn: (a, b) => b.w * b.h - a.w * a.h },
    { fn: (a, b) => b.h - a.h || b.w * b.h - a.w * a.h },
    { fn: (a, b) => b.w - a.w || b.w * b.h - a.w * a.h },
    {
      fn: (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h,
    },
    { fn: (a, b) => b.w + b.h - (a.w + a.h) || b.w * b.h - a.w * a.h },
    {
      fn: (a, b) => {
        const bandA = Math.round(a.w / 5) * 5
        const bandB = Math.round(b.w / 5) * 5
        if (bandA !== bandB) return bandB - bandA
        return b.h - a.h || b.w * b.h - a.w * a.h
      },
    },
  ]

  // Both bin orientations
  const binOrientations: Array<{
    bw: number
    bh: number
    swapped: boolean
  }> = [{ bw: rollW, bh: rollL, swapped: false }]
  if (Math.abs(rollW - rollL) > 1) {
    binOrientations.push({ bw: rollL, bh: rollW, swapped: true })
  }

  let bestResult: MultiSheetResult | null = null
  let bestPlaced = 0
  let bestSheetCount = Infinity
  let bestOccupiedHeight = Infinity

  const evaluateCandidate = (
    placements: Placement[],
    _bins: MaxRectBin[],
    binW: number,
    binH: number,
    swapped: boolean,
    heuristic: HeuristicType
  ) => {
    // Group placements by bin
    const binGroups = new Map<number, Placement[]>()
    for (const p of placements) {
      const group = binGroups.get(p.binIndex) ?? []
      group.push(p)
      binGroups.set(p.binIndex, group)
    }

    const binIds = [...binGroups.keys()].sort((a, b) => a - b)
    if (binIds.length === 0) return

    // Exhaustive rotation search on the last bin
    const lastBinId = binIds[binIds.length - 1]
    const lastBinPlacements = binGroups.get(lastBinId)
    if (!lastBinPlacements) return
    const lastBinItems = lastBinPlacements.map((p) => basePackItems[p.itemIndex])

    // maxExhaustive=14 inside exhaustiveRotationSearch; items beyond that
    // count fall back to greedy sort orders only (still beneficial)
    if (lastBinItems.length > 0) {
      const optimized = exhaustiveRotationSearch(lastBinItems, binW, binH, heuristic)
      if (optimized && optimized.placements.length === lastBinItems.length) {
        binGroups.set(lastBinId, optimized.placements)
      }
    }

    // Transform swapped coordinates back to original
    if (swapped) {
      for (const binId of binIds) {
        const group = binGroups.get(binId) ?? []
        binGroups.set(
          binId,
          group.map((p) => ({
            ...p,
            x: p.y,
            y: p.x,
            w: p.h,
            h: p.w,
            rotated: !p.rotated,
          }))
        )
      }
    }

    // Build sheets
    const sheets: SheetPreview[] = []
    for (let si = 0; si < binIds.length; si++) {
      const binId = binIds[si]
      const binPlacements = binGroups.get(binId) ?? []
      const isLast = si === binIds.length - 1
      sheets.push(buildSheetFromPlacements(binPlacements, allItems, rollW, rollL, si, isLast))
    }

    const totalUnitsCompleted = sheets.reduce((s, sh) => s + sh.preview.unitsCompleted, 0)
    const totalUsedArea = sheets.reduce((s, sh) => s + sh.preview.usedArea, 0)
    const totalReusableArea = sheets.reduce((s, sh) => s + sh.preview.reusableArea, 0)
    const totalScrapArea = sheets.reduce((s, sh) => s + sh.preview.scrapArea, 0)
    const remainingOverflow = Math.max(0, allItems.length - totalUnitsCompleted)
    const fabScores = sheets.map((sh) => computeFabricationScore(sh.preview, rollW, rollL).score)
    const avgFabScore =
      fabScores.length > 0 ? Math.round(fabScores.reduce((a, b) => a + b, 0) / fabScores.length) : 0

    const result: MultiSheetResult = {
      sheets,
      totalUnitsCompleted,
      totalUsedArea,
      totalReusableArea,
      totalScrapArea,
      totalStockArea: stockArea * sheets.length,
      remainingOverflow,
      avgFabScore,
    }

    // Compare: most items placed → fewest sheets → tightest packing.
    // Use total occupied height as tiebreaker — classification-independent.
    const totalOccupied = sheets.reduce((s, sh) => s + sh.preview.occupiedHeight, 0)
    const betterPlaced = totalUnitsCompleted > bestPlaced
    const samePlaced = totalUnitsCompleted === bestPlaced
    const fewerSheets = sheets.length < bestSheetCount
    const sameSheets = sheets.length === bestSheetCount
    const tighterPacking = totalOccupied < bestOccupiedHeight

    if (
      betterPlaced ||
      (samePlaced && fewerSheets) ||
      (samePlaced && sameSheets && tighterPacking)
    ) {
      bestResult = result
      bestPlaced = totalUnitsCompleted
      bestSheetCount = sheets.length
      bestOccupiedHeight = totalOccupied
    }
  }

  // =========================================================================
  // Mode 1: Batch insertion (Jylänki Insert + rectpack Global)
  // 5 heuristics × 2 orientations = 10 candidates
  // =========================================================================
  for (const { bw, bh, swapped } of binOrientations) {
    for (const heuristic of heuristics) {
      const { placements, bins } = globalBatchPack(basePackItems, bw, bh, maxSheets, heuristic)
      evaluateCandidate(placements, bins, bw, bh, swapped, heuristic)
    }
  }

  // =========================================================================
  // Mode 2: Sort-based greedy with BBF bin selection
  // 5 heuristics × 6 sorts × 2 orientations = 60 candidates
  // =========================================================================
  for (const { bw, bh, swapped } of binOrientations) {
    for (const { fn } of sortFns) {
      for (const heuristic of heuristics) {
        const sorted = [...basePackItems].sort(fn)
        const { placements, bins } = globalGreedyPack(sorted, bw, bh, maxSheets, heuristic)
        evaluateCandidate(placements, bins, bw, bh, swapped, heuristic)
      }
    }
  }

  // =========================================================================
  // Mode 3: Width-pair packing
  // 5 heuristics × 2 orientations = 10 candidates
  // =========================================================================
  for (const { bw, bh, swapped } of binOrientations) {
    for (const heuristic of heuristics) {
      const { placements, bins } = globalWidthPairPack(basePackItems, bw, bh, maxSheets, heuristic)
      if (placements.length > 0) {
        evaluateCandidate(placements, bins, bw, bh, swapped, heuristic)
      }
    }
  }

  return (
    bestResult ?? {
      sheets: [],
      totalUnitsCompleted: 0,
      totalUsedArea: 0,
      totalReusableArea: 0,
      totalScrapArea: 0,
      totalStockArea: 0,
      remainingOverflow: allItems.length,
      avgFabScore: 0,
    }
  )
}

// Re-export internal packing functions needed by globalMultiSheetPack
function globalBatchPack(
  items: PackableItem[],
  binW: number,
  binH: number,
  maxBins: number,
  heuristic: HeuristicType
) {
  const bins: MaxRectBin[] = []
  const allPlacements: Placement[] = []
  const remaining = new Set(items.map((_, i) => i))

  while (remaining.size > 0 && bins.length < maxBins) {
    const bin = new MaxRectBin(bins.length, binW, binH)
    const placed = batchFillBin(bin, items, remaining, heuristic)
    if (placed.length === 0) break
    bins.push(bin)
    allPlacements.push(...placed)
  }

  return { placements: allPlacements, bins }
}

function globalGreedyPack(
  sorted: PackableItem[],
  binW: number,
  binH: number,
  maxBins: number,
  heuristic: HeuristicType
): { placements: Placement[]; bins: MaxRectBin[] } {
  const bins: MaxRectBin[] = []
  const placements: Placement[] = []

  for (const item of sorted) {
    let bestBin: MaxRectBin | null = null
    let bestResult: ReturnType<MaxRectBin["scoreRect"]> = null
    let bestS1 = Infinity
    let bestS2 = Infinity
    const rs = item.item.renderShape
    const allowRot = rs !== "trapezoid" && rs !== "sector"

    // BBF: try all bins, pick best fit
    for (const bin of bins) {
      const result = bin.scoreRect(item.w, item.h, heuristic, allowRot)
      if (
        result &&
        (result.score1 < bestS1 - 0.001 ||
          (Math.abs(result.score1 - bestS1) < 0.001 && result.score2 < bestS2 - 0.001))
      ) {
        bestS1 = result.score1
        bestS2 = result.score2
        bestBin = bin
        bestResult = result
      }
    }

    if (bestBin && bestResult) {
      bestBin.place(bestResult.x, bestResult.y, bestResult.w, bestResult.h)
      placements.push({
        binIndex: bestBin.id,
        x: bestResult.x,
        y: bestResult.y,
        w: bestResult.w,
        h: bestResult.h,
        rotated: bestResult.rotated,
        itemIndex: item.index,
      })
    } else if (bins.length < maxBins) {
      const bin = new MaxRectBin(bins.length, binW, binH)
      const result = bin.scoreRect(item.w, item.h, heuristic, allowRot)
      if (result) {
        bin.place(result.x, result.y, result.w, result.h)
        bins.push(bin)
        placements.push({
          binIndex: bin.id,
          x: result.x,
          y: result.y,
          w: result.w,
          h: result.h,
          rotated: result.rotated,
          itemIndex: item.index,
        })
      }
    }
  }

  return { placements, bins }
}
