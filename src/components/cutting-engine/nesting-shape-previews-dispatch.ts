// Preview dispatch functions — multi-part layout and single-part routing
// Split from nesting-shape-previews-advanced.ts to keep files under 500 lines

import type {
  OffcutBand,
  SimplePartPreview,
  SimplePartSpec,
  NestingVisualizerProps,
  MultiSheetResult,
  SheetPreview,
} from "./nesting-visualizer-types"
import {
  bandFitsAnyPreviewItem,
  computeIntraBlankWaste,
  getPlacementBounds,
  buildShelfGapBands,
} from "./nesting-layout-utils"
import {
  packPreviewItemsOnShelves,
  packRectItemsWithGuillotine,
  packIntoFreeRects,
  recomputePlacedPolygon,
} from "./nesting-packing-utils"
import { buildPartPreviewItem, getPartTypeLabel } from "./nesting-preview-builders"
import { generateRectanglePreview, generateCirclePreview } from "./nesting-shape-previews-basic"
import { computeFabricationScore } from "./nesting-preview-builders"
import {
  generateCylinderPreview,
  generateConePreview,
  generateConePreviewAsync,
  generateTrapezoidPreview,
  generateTrapezoidPreviewAsync,
} from "./nesting-shape-previews-advanced"
import type { PreviewItem } from "./nesting-visualizer-types"
import {
  packMixedNfp,
  packMixedNfpAsync,
  type MixedPackResult,
  type MixedSpec,
} from "@/nesting/mixed-nfp-placer"
import { sectorToPolygon, trapezoidToPolygon } from "@/nesting/shape-to-polygon"
import type { Point2D } from "@/nesting/types"

export { globalMultiSheetPack } from "./nesting-global-packer-entry"

interface PackingCandidate {
  sortBy: string
  packed: { items: PreviewItem[]; usedArea: number; freeRects?: OffcutBand[] }
  bounds: ReturnType<typeof getPlacementBounds>
  offcutBands: OffcutBand[]
  scrapBands: OffcutBand[]
  reusableArea: number
  scrapArea: number
  trimDensity: number
}

function evaluatePackingCandidate(
  requestedItems: (PreviewItem & { usedArea: number })[],
  rollW: number,
  rollL: number,
  sortBy: "area" | "height" | "width" | "max-edge",
  allRectangles: boolean
): PackingCandidate {
  const packed = allRectangles
    ? packRectItemsWithGuillotine(requestedItems, rollW, rollL, sortBy)
    : packPreviewItemsOnShelves(requestedItems, rollW, rollL, sortBy)
  const bounds = getPlacementBounds(packed.items)
  const allBands = allRectangles
    ? (packed.freeRects ?? [])
    : buildShelfGapBands(packed.items, rollW, rollL)
  const offcutBands: OffcutBand[] = []
  const scrapBands: OffcutBand[] = []
  let reusableArea = 0
  let scrapArea = 0

  allBands.forEach((band) => {
    const area = band.width * band.height
    if (bandFitsAnyPreviewItem(band, packed.items)) {
      offcutBands.push(band)
      reusableArea += area
    } else {
      scrapBands.push(band)
      scrapArea += area
    }
  })

  const intraBlankWaste = packed.items.reduce((sum, item) => sum + computeIntraBlankWaste(item), 0)
  scrapArea += intraBlankWaste
  const trimDensity =
    bounds.occupiedWidth * bounds.occupiedHeight > 0
      ? scrapArea / (bounds.occupiedWidth * bounds.occupiedHeight)
      : 1

  return { sortBy, packed, bounds, offcutBands, scrapBands, reusableArea, scrapArea, trimDensity }
}

const MIN_TRAPEZOID_STEP = 2

/**
 * Build the unrotated base polygon for a cone or trapezoid spec.
 * Returns null for any spec type that mixed-NFP doesn't handle.
 */
function basePolygonForSpec(
  spec: SimplePartSpec,
  fallbackWidth: number,
  fallbackHeight: number
): Point2D[] | null {
  if (spec.partType === "cone") {
    const innerRadius = spec.innerRadius ?? Math.max(1, fallbackWidth / 2)
    const outerRadius = spec.outerRadius ?? Math.max(innerRadius + 1, fallbackHeight)
    const arcDegrees = spec.arcDegrees ?? 120
    return sectorToPolygon(innerRadius, outerRadius, arcDegrees, 48)
  }
  if (spec.partType === "trapezoid") {
    const topWidth = spec.topWidth ?? fallbackWidth
    const bottomWidth = spec.bottomWidth ?? fallbackWidth
    const height = spec.height ?? fallbackHeight
    return trapezoidToPolygon(topWidth, bottomWidth, height)
  }
  return null
}

type MixedSpecMeta = PreviewItem & { usedArea: number }

/**
 * Build the per-spec inputs for mixed-NFP. Returns null if any spec is
 * unsupported (e.g. rect/circle), so the caller can fall back to shelf packing.
 */
function buildMixedNfpInputs(
  simpleParts: SimplePartSpec[],
  fallbackWidth: number,
  fallbackHeight: number,
  // Original index of each spec in the parent simpleParts array. Needed when
  // the caller has split simpleParts (e.g. trapezoid hybrid) so per-item
  // specIndex tags still match the parent's tag map.
  originalIndices?: number[]
): MixedSpec<MixedSpecMeta>[] | null {
  const inputs: MixedSpec<MixedSpecMeta>[] = []
  for (let i = 0; i < simpleParts.length; i++) {
    const spec = simpleParts[i]
    const basePolygon = basePolygonForSpec(spec, fallbackWidth, fallbackHeight)
    if (!basePolygon) return null
    const template = buildPartPreviewItem(spec, fallbackWidth, fallbackHeight)
    template.specIndex = originalIndices?.[i] ?? i
    template.partNumber = spec.partNumber
    inputs.push({
      meta: template,
      basePolygon,
      quantity: Math.max(1, spec.quantity || 1),
    })
  }
  return inputs
}

/**
 * Convert a MixedPackResult into a PackingCandidate consumable by
 * generateMultiPartPreview's waste pipeline. Shared by sync/async paths.
 */
function mixedResultToCandidate(
  result: MixedPackResult<MixedSpecMeta>,
  rollW: number,
  rollL: number
): PackingCandidate {
  const placedItems: PreviewItem[] = result.placements.map((p) => ({
    ...p.meta,
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    rotation: p.rotation,
    placedPolygon: p.placedPolygon,
  }))

  const bounds = getPlacementBounds(placedItems)
  const allBands = buildShelfGapBands(placedItems, rollW, rollL)
  const offcutBands: OffcutBand[] = []
  const scrapBands: OffcutBand[] = []
  let reusableArea = 0
  let scrapArea = 0
  allBands.forEach((band) => {
    const area = band.width * band.height
    if (bandFitsAnyPreviewItem(band, placedItems)) {
      offcutBands.push(band)
      reusableArea += area
    } else {
      scrapBands.push(band)
      scrapArea += area
    }
  })
  const intraBlankWaste = placedItems.reduce((sum, item) => sum + computeIntraBlankWaste(item), 0)
  scrapArea += intraBlankWaste
  const trimDensity =
    bounds.occupiedWidth * bounds.occupiedHeight > 0
      ? scrapArea / (bounds.occupiedWidth * bounds.occupiedHeight)
      : 1

  return {
    sortBy: "mixed-nfp",
    packed: { items: placedItems, usedArea: result.usedArea },
    bounds,
    offcutBands,
    scrapBands,
    reusableArea,
    scrapArea,
    trimDensity,
  }
}

/**
 * Pack multiple cone/trapezoid specs using per-spec NFP rotation + global
 * collision-checked placement. Returns a PackingCandidate that slots into the
 * existing waste-calculation pipeline. Returns null if any spec is unsupported.
 */
function tryMixedNfpCandidate(
  simpleParts: SimplePartSpec[],
  rollW: number,
  rollL: number,
  fallbackWidth: number,
  fallbackHeight: number
): PackingCandidate | null {
  const inputs = buildMixedNfpInputs(simpleParts, fallbackWidth, fallbackHeight)
  if (!inputs) return null
  const result = packMixedNfp(inputs, rollW, rollL)
  return mixedResultToCandidate(result, rollW, rollL)
}

/** Async variant — runs per-spec NFP angle search on the worker pool. */
async function tryMixedNfpCandidateAsync(
  simpleParts: SimplePartSpec[],
  rollW: number,
  rollL: number,
  fallbackWidth: number,
  fallbackHeight: number
): Promise<PackingCandidate | null> {
  const inputs = buildMixedNfpInputs(simpleParts, fallbackWidth, fallbackHeight)
  if (!inputs) return null
  const result = await packMixedNfpAsync(inputs, rollW, rollL)
  return mixedResultToCandidate(result, rollW, rollL)
}

/**
 * Offset a list of placed items downward by `dy`. Translates `placedPolygon`
 * vertex y-values too so the polygon outline stays aligned with the AABB.
 */
function translateItemsY(items: PreviewItem[], dy: number): PreviewItem[] {
  if (dy === 0) return items
  return items.map((item) => ({
    ...item,
    y: item.y + dy,
    placedPolygon: item.placedPolygon
      ? item.placedPolygon.map((pt) => ({ x: pt.x, y: pt.y + dy }))
      : item.placedPolygon,
  }))
}

/**
 * Build the lower-strip "other items" preview given a list of non-trapezoid
 * specs and a virtual sub-stock dimension. Uses mixed-NFP when any cone is
 * present (so cones still get per-spec rotation), otherwise shelf packing.
 */
function packOtherSpecsForHybrid(
  otherSpecs: SimplePartSpec[],
  rollW: number,
  remainingHeight: number,
  fallbackWidth: number,
  fallbackHeight: number,
  // Original index of each otherSpec in the parent simpleParts array, so
  // tag-map keys (specIndex) survive the trapezoid/other split.
  originalIndices?: number[]
): { items: PreviewItem[]; usedArea: number } {
  if (otherSpecs.length === 0 || remainingHeight <= 0) {
    return { items: [], usedArea: 0 }
  }
  const otherRequestedItems = otherSpecs.flatMap((spec, i) =>
    Array.from({ length: Math.max(1, spec.quantity || 1) }, () => {
      const item = buildPartPreviewItem(spec, fallbackWidth, fallbackHeight)
      item.specIndex = originalIndices?.[i] ?? i
      item.partNumber = spec.partNumber
      return item
    })
  )
  const hasCone = otherSpecs.some((s) => s.partType === "cone")
  if (hasCone) {
    const inputs = buildMixedNfpInputs(otherSpecs, fallbackWidth, fallbackHeight, originalIndices)
    if (inputs) {
      const result = packMixedNfp(inputs, rollW, remainingHeight)
      const items: PreviewItem[] = result.placements.map((p) => ({
        ...p.meta,
        x: p.x,
        y: p.y,
        width: p.width,
        height: p.height,
        rotation: p.rotation,
        placedPolygon: p.placedPolygon,
      }))
      return { items, usedArea: result.usedArea }
    }
  }
  const shelf = packPreviewItemsOnShelves(otherRequestedItems, rollW, remainingHeight, "area")
  return { items: shelf.items, usedArea: shelf.usedArea }
}

/** Async sibling — uses packMixedNfpAsync (worker pool) for the cone subset. */
async function packOtherSpecsForHybridAsync(
  otherSpecs: SimplePartSpec[],
  rollW: number,
  remainingHeight: number,
  fallbackWidth: number,
  fallbackHeight: number,
  // Original index of each otherSpec in the parent simpleParts array, so
  // tag-map keys (specIndex) survive the trapezoid/other split.
  originalIndices?: number[]
): Promise<{ items: PreviewItem[]; usedArea: number }> {
  if (otherSpecs.length === 0 || remainingHeight <= 0) {
    return { items: [], usedArea: 0 }
  }
  const otherRequestedItems = otherSpecs.flatMap((spec, i) =>
    Array.from({ length: Math.max(1, spec.quantity || 1) }, () => {
      const item = buildPartPreviewItem(spec, fallbackWidth, fallbackHeight)
      item.specIndex = originalIndices?.[i] ?? i
      item.partNumber = spec.partNumber
      return item
    })
  )
  const hasCone = otherSpecs.some((s) => s.partType === "cone")
  if (hasCone) {
    const inputs = buildMixedNfpInputs(otherSpecs, fallbackWidth, fallbackHeight, originalIndices)
    if (inputs) {
      const result = await packMixedNfpAsync(inputs, rollW, remainingHeight)
      const items: PreviewItem[] = result.placements.map((p) => ({
        ...p.meta,
        x: p.x,
        y: p.y,
        width: p.width,
        height: p.height,
        rotation: p.rotation,
        placedPolygon: p.placedPolygon,
      }))
      return { items, usedArea: result.usedArea }
    }
  }
  const shelf = packPreviewItemsOnShelves(otherRequestedItems, rollW, remainingHeight, "area")
  return { items: shelf.items, usedArea: shelf.usedArea }
}

/**
 * Build a PackingCandidate from a fully-placed item list (all bands, waste,
 * intra-blank). Mirrors evaluatePackingCandidate's classification but skips
 * the upstream packing step. Used by the trapezoid hybrid path.
 */
function buildHybridCandidate(
  combinedItems: PreviewItem[],
  totalUsedArea: number,
  rollW: number,
  rollL: number
): PackingCandidate {
  const bounds = getPlacementBounds(combinedItems)
  const allBands = buildShelfGapBands(combinedItems, rollW, rollL)
  const offcutBands: OffcutBand[] = []
  const scrapBands: OffcutBand[] = []
  let reusableArea = 0
  let scrapArea = 0
  allBands.forEach((band) => {
    const area = band.width * band.height
    if (bandFitsAnyPreviewItem(band, combinedItems)) {
      offcutBands.push(band)
      reusableArea += area
    } else {
      scrapBands.push(band)
      scrapArea += area
    }
  })
  const intraBlankWaste = combinedItems.reduce((sum, item) => sum + computeIntraBlankWaste(item), 0)
  scrapArea += intraBlankWaste
  const trimDensity =
    bounds.occupiedWidth * bounds.occupiedHeight > 0
      ? scrapArea / (bounds.occupiedWidth * bounds.occupiedHeight)
      : 1

  return {
    sortBy: "trapezoid-hybrid",
    packed: { items: combinedItems, usedArea: totalUsedArea },
    bounds,
    offcutBands,
    scrapBands,
    reusableArea,
    scrapArea,
    trimDensity,
  }
}

/**
 * Hybrid packer for layouts containing trapezoids alongside other shape
 * types. Trapezoids interlock at the top via packInterleavedTrapezoids; the
 * other shapes get the remaining vertical strip below, packed with mixed-NFP
 * (when any cone is present) or shelf packing.
 *
 * Returns null when not applicable (no trapezoid specs, no other specs, or
 * trapezoid packing fails) so the caller falls through to existing routes.
 */
function tryTrapezoidHybridCandidate(
  simpleParts: SimplePartSpec[],
  rollW: number,
  rollL: number,
  fallbackWidth: number,
  fallbackHeight: number
): PackingCandidate | null {
  // Track each spec's original index so the trapezoid/other split doesn't
  // collide tag-map keys (specIndex) downstream.
  const trapWithIdx = simpleParts
    .map((spec, idx) => ({ spec, idx }))
    .filter(({ spec }) => spec.partType === "trapezoid")
  const otherWithIdx = simpleParts
    .map((spec, idx) => ({ spec, idx }))
    .filter(({ spec }) => spec.partType !== "trapezoid")
  if (trapWithIdx.length === 0 || otherWithIdx.length === 0) return null

  const trapItems = trapWithIdx.flatMap(({ spec, idx }) =>
    Array.from({ length: Math.max(1, spec.quantity || 1) }, () => {
      const item = buildPartPreviewItem(spec, fallbackWidth, fallbackHeight)
      item.specIndex = idx
      item.partNumber = spec.partNumber
      return item
    })
  )
  const trapPacked = packInterleavedTrapezoids(trapItems, rollW, rollL)
  if (!trapPacked) return null

  const trapMaxY = trapPacked.packed.items.reduce((m, item) => Math.max(m, item.y + item.height), 0)
  const remainingHeight = Math.max(0, rollL - trapMaxY)

  const otherPacked = packOtherSpecsForHybrid(
    otherWithIdx.map(({ spec }) => spec),
    rollW,
    remainingHeight,
    fallbackWidth,
    fallbackHeight,
    otherWithIdx.map(({ idx }) => idx)
  )
  const translatedOthers = translateItemsY(otherPacked.items, trapMaxY)

  return buildHybridCandidate(
    [...trapPacked.packed.items, ...translatedOthers],
    trapPacked.packed.usedArea + otherPacked.usedArea,
    rollW,
    rollL
  )
}

/** Async variant — runs the cone subset (if any) through the worker pool. */
async function tryTrapezoidHybridCandidateAsync(
  simpleParts: SimplePartSpec[],
  rollW: number,
  rollL: number,
  fallbackWidth: number,
  fallbackHeight: number
): Promise<PackingCandidate | null> {
  // Track each spec's original index so the trapezoid/other split doesn't
  // collide tag-map keys (specIndex) downstream.
  const trapWithIdx = simpleParts
    .map((spec, idx) => ({ spec, idx }))
    .filter(({ spec }) => spec.partType === "trapezoid")
  const otherWithIdx = simpleParts
    .map((spec, idx) => ({ spec, idx }))
    .filter(({ spec }) => spec.partType !== "trapezoid")
  if (trapWithIdx.length === 0 || otherWithIdx.length === 0) return null

  const trapItems = trapWithIdx.flatMap(({ spec, idx }) =>
    Array.from({ length: Math.max(1, spec.quantity || 1) }, () => {
      const item = buildPartPreviewItem(spec, fallbackWidth, fallbackHeight)
      item.specIndex = idx
      item.partNumber = spec.partNumber
      return item
    })
  )
  const trapPacked = packInterleavedTrapezoids(trapItems, rollW, rollL)
  if (!trapPacked) return null

  const trapMaxY = trapPacked.packed.items.reduce((m, item) => Math.max(m, item.y + item.height), 0)
  const remainingHeight = Math.max(0, rollL - trapMaxY)

  const otherPacked = await packOtherSpecsForHybridAsync(
    otherWithIdx.map(({ spec }) => spec),
    rollW,
    remainingHeight,
    fallbackWidth,
    fallbackHeight,
    otherWithIdx.map(({ idx }) => idx)
  )
  const translatedOthers = translateItemsY(otherPacked.items, trapMaxY)

  return buildHybridCandidate(
    [...trapPacked.packed.items, ...translatedOthers],
    trapPacked.packed.usedArea + otherPacked.usedArea,
    rollW,
    rollL
  )
}

function comparePackingCandidates(a: PackingCandidate, b: PackingCandidate): number {
  if (a.packed.items.length !== b.packed.items.length)
    return b.packed.items.length - a.packed.items.length
  if (Math.abs(a.scrapArea - b.scrapArea) > 0.001) return a.scrapArea - b.scrapArea
  if (Math.abs(a.trimDensity - b.trimDensity) > 0.0001) return a.trimDensity - b.trimDensity
  if (Math.abs(a.reusableArea - b.reusableArea) > 0.001) return b.reusableArea - a.reusableArea
  if (Math.abs(a.bounds.occupiedHeight - b.bounds.occupiedHeight) > 0.001)
    return a.bounds.occupiedHeight - b.bounds.occupiedHeight
  return 0
}

function packInterleavedTrapezoids(
  items: (PreviewItem & { usedArea: number })[],
  rollW: number,
  rollL: number
): PackingCandidate | null {
  const sorted = [...items].sort((a, b) => {
    if (Math.abs(b.height - a.height) > 0.001) return b.height - a.height
    return b.width - a.width
  })

  const placedItems: PreviewItem[] = []
  let totalUsedArea = 0
  let currentY = 0
  let currentX = 0
  let rowHeight = 0
  let placedInRow = 0

  const skipped: typeof sorted = []

  for (let idx = 0; idx < sorted.length; idx++) {
    const item = sorted[idx]
    const topW = item.topWidth ?? item.width
    const botW = item.bottomWidth ?? item.width
    const boxW = Math.max(topW, botW)

    if (currentX + boxW > rollW + 0.001) {
      currentY += rowHeight
      currentX = 0
      rowHeight = 0
      placedInRow = 0
    }
    if (currentY + item.height > rollL + 0.001) {
      skipped.push(item)
      continue
    }

    const flipped = placedInRow % 2 === 1
    placedItems.push({
      ...item,
      x: currentX,
      y: currentY,
      flipped,
      placedPolygon: recomputePlacedPolygon(item, false, flipped, currentX, currentY),
    })
    totalUsedArea += item.usedArea
    rowHeight = Math.max(rowHeight, item.height)
    placedInRow++

    const next = sorted[idx + 1]
    let step = (topW + botW) / 2
    if (next) {
      const nTopW = next.topWidth ?? next.width
      const nBotW = next.bottomWidth ?? next.width
      const nBoxW = Math.max(nTopW, nBotW)
      step = Math.max((boxW + botW - nBoxW + nTopW) / 2, (boxW + topW - nBoxW + nBotW) / 2)
    }
    currentX += Math.max(step, MIN_TRAPEZOID_STEP)
  }

  // Retry skipped items — they may fit after row advancement
  for (const item of skipped) {
    const topW = item.topWidth ?? item.width
    const botW = item.bottomWidth ?? item.width
    const boxW = Math.max(topW, botW)

    if (currentX + boxW > rollW + 0.001) {
      currentY += rowHeight
      currentX = 0
      rowHeight = 0
      placedInRow = 0
    }
    if (currentY + item.height > rollL + 0.001) continue

    const retryFlipped = placedInRow % 2 === 1
    placedItems.push({
      ...item,
      x: currentX,
      y: currentY,
      flipped: retryFlipped,
      placedPolygon: recomputePlacedPolygon(item, false, retryFlipped, currentX, currentY),
    })
    totalUsedArea += item.usedArea
    rowHeight = Math.max(rowHeight, item.height)
    placedInRow++

    currentX += Math.max((topW + botW) / 2, MIN_TRAPEZOID_STEP)
  }

  if (placedItems.length === 0) return null

  const bounds = getPlacementBounds(placedItems)
  const allBands = buildShelfGapBands(placedItems, rollW, rollL)
  const offcutBands: OffcutBand[] = []
  const scrapBands: OffcutBand[] = []
  let reusableArea = 0
  let scrapArea = 0

  allBands.forEach((band) => {
    const area = band.width * band.height
    if (bandFitsAnyPreviewItem(band, placedItems)) {
      offcutBands.push(band)
      reusableArea += area
    } else {
      scrapBands.push(band)
      scrapArea += area
    }
  })

  const intraBlankWaste = placedItems.reduce((sum, item) => sum + computeIntraBlankWaste(item), 0)
  scrapArea += intraBlankWaste
  const trimDensity =
    bounds.occupiedWidth * bounds.occupiedHeight > 0
      ? scrapArea / (bounds.occupiedWidth * bounds.occupiedHeight)
      : 1

  return {
    sortBy: "interleaved",
    packed: { items: placedItems, usedArea: totalUsedArea },
    bounds,
    offcutBands,
    scrapBands,
    reusableArea,
    scrapArea,
    trimDensity,
  }
}

/**
 * Pick the best non-mixed-NFP candidate. Used by both sync and async
 * generateMultiPartPreview as the fallback / first-paint layout.
 */
function pickFallbackCandidate(
  requestedItems: (PreviewItem & { usedArea: number })[],
  simpleParts: SimplePartSpec[],
  rollW: number,
  rollL: number
): PackingCandidate {
  const allRectangles = requestedItems.every((item) => item.renderShape === "rect")
  const allTrapezoids = requestedItems.every((item) => item.renderShape === "trapezoid")

  if (allTrapezoids && requestedItems.length >= 2) {
    const trapInterleaved = packInterleavedTrapezoids(requestedItems, rollW, rollL)
    if (trapInterleaved) return trapInterleaved
  }

  // Suppress unused-var warning when the helper above already returned.
  void simpleParts

  const candidates = (["area", "height", "width", "max-edge"] as const).map((sortBy) =>
    evaluatePackingCandidate(requestedItems, rollW, rollL, sortBy, allRectangles)
  )
  candidates.sort(comparePackingCandidates)
  return candidates[0]
}

export function generateMultiPartPreview(
  rollW: number,
  rollL: number,
  simpleParts: SimplePartSpec[],
  fallbackWidth: number,
  fallbackHeight: number,
  // Skip the expensive sync mixed-NFP path for first-paint; the async
  // refinement (generateMultiPartPreviewAsync) replaces the preview shortly.
  // Overflow regenerate calls pass `false` so subsequent sheets match the
  // first sheet's NFP-rotated layout.
  skipNfpPacking = true
): SimplePartPreview {
  const requestedItems = simpleParts.flatMap((spec, specIdx) =>
    Array.from({ length: Math.max(1, spec.quantity || 1) }, () => {
      const item = buildPartPreviewItem(spec, fallbackWidth, fallbackHeight)
      item.specIndex = specIdx
      item.partNumber = spec.partNumber
      return item
    })
  )
  // Mixed-NFP applies when every spec is cone/trapezoid AND at least one is a
  // cone. Pure trapezoid keeps using packInterleavedTrapezoids (its specialized
  // interlocking is denser than generic NFP). Pure cone or cone+trapezoid mixes
  // get NFP rotation per spec and global collision-checked placement.
  const allConeOrTrapezoid = simpleParts.every(
    (s) => s.partType === "cone" || s.partType === "trapezoid"
  )
  const hasCone = simpleParts.some((s) => s.partType === "cone")
  const hasTrapezoid = simpleParts.some((s) => s.partType === "trapezoid")
  const hasNonTrapezoid = simpleParts.some((s) => s.partType !== "trapezoid")
  // Trapezoid hybrid takes precedence when trapezoids are mixed with any
  // other shape — pure NFP placement loses the interlocked flip pattern.
  const useTrapezoidHybrid =
    !skipNfpPacking && simpleParts.length > 1 && hasTrapezoid && hasNonTrapezoid
  const useMixedNfp = !skipNfpPacking && simpleParts.length > 1 && allConeOrTrapezoid && hasCone

  // When both hybrid and mixed-NFP are eligible (cone+trapezoid), compute
  // both and pick whichever places more items so a partial hybrid (e.g. cone
  // doesn't fit under the trapezoid row) doesn't lose to a complete mixed-NFP
  // result. Tie-break to hybrid since interleaved trapezoids beat generic NFP.
  const hybrid = useTrapezoidHybrid
    ? tryTrapezoidHybridCandidate(simpleParts, rollW, rollL, fallbackWidth, fallbackHeight)
    : null
  const mixed = useMixedNfp
    ? tryMixedNfpCandidate(simpleParts, rollW, rollL, fallbackWidth, fallbackHeight)
    : null

  let best: PackingCandidate | undefined
  if (hybrid && mixed) {
    best = mixed.packed.items.length > hybrid.packed.items.length ? mixed : hybrid
  } else {
    best = hybrid ?? mixed ?? undefined
  }

  if (!best) {
    best = pickFallbackCandidate(requestedItems, simpleParts, rollW, rollL)
  }

  return buildMultiPartPreviewFromCandidate(best, simpleParts, requestedItems.length, rollW, rollL)
}

/**
 * Async variant — runs mixed-NFP via the worker pool when applicable, then
 * builds the preview. Falls back to the same shelf/interleave packing as the
 * sync first-paint path when the spec mix isn't NFP-eligible.
 */
export async function generateMultiPartPreviewAsync(
  rollW: number,
  rollL: number,
  simpleParts: SimplePartSpec[],
  fallbackWidth: number,
  fallbackHeight: number
): Promise<SimplePartPreview> {
  const requestedItems = simpleParts.flatMap((spec, specIdx) =>
    Array.from({ length: Math.max(1, spec.quantity || 1) }, () => {
      const item = buildPartPreviewItem(spec, fallbackWidth, fallbackHeight)
      item.specIndex = specIdx
      item.partNumber = spec.partNumber
      return item
    })
  )
  const allConeOrTrapezoid = simpleParts.every(
    (s) => s.partType === "cone" || s.partType === "trapezoid"
  )
  const hasCone = simpleParts.some((s) => s.partType === "cone")
  const hasTrapezoid = simpleParts.some((s) => s.partType === "trapezoid")
  const hasNonTrapezoid = simpleParts.some((s) => s.partType !== "trapezoid")
  const useTrapezoidHybrid = simpleParts.length > 1 && hasTrapezoid && hasNonTrapezoid
  const useMixedNfp = simpleParts.length > 1 && allConeOrTrapezoid && hasCone

  // When both hybrid and mixed-NFP are eligible (cone+trapezoid), compute
  // both in parallel and pick whichever places more items. Tie-break to
  // hybrid since interleaved trapezoids beat generic NFP placement.
  const [hybrid, mixed] = await Promise.all([
    useTrapezoidHybrid
      ? tryTrapezoidHybridCandidateAsync(simpleParts, rollW, rollL, fallbackWidth, fallbackHeight)
      : Promise.resolve(null),
    useMixedNfp
      ? tryMixedNfpCandidateAsync(simpleParts, rollW, rollL, fallbackWidth, fallbackHeight)
      : Promise.resolve(null),
  ])

  let best: PackingCandidate | undefined
  if (hybrid && mixed) {
    best = mixed.packed.items.length > hybrid.packed.items.length ? mixed : hybrid
  } else {
    best = hybrid ?? mixed ?? undefined
  }

  if (!best) {
    best = pickFallbackCandidate(requestedItems, simpleParts, rollW, rollL)
  }
  return buildMultiPartPreviewFromCandidate(best, simpleParts, requestedItems.length, rollW, rollL)
}

function buildMultiPartPreviewFromCandidate(
  best: PackingCandidate,
  simpleParts: SimplePartSpec[],
  requestedCount: number,
  rollW: number,
  rollL: number
): SimplePartPreview {
  const allRectangles = best.packed.items.every((item) => item.renderShape === "rect")
  const placedItems = best.packed.items
  const usedArea = best.packed.usedArea
  const bounds = best.bounds
  const offcutBands = best.offcutBands
  const scrapBands = best.scrapBands

  // Raw band areas may overlap (maximal rectangles share area) and
  // interlocked trapezoid bounding boxes double-count intra-blank waste.
  // Proportionally correct so totals equal actual free area.
  const stockArea = rollW * rollL
  const actualFreeArea = Math.max(0, stockArea - usedArea)
  const rawReusable = best?.reusableArea ?? 0
  const rawScrap = best?.scrapArea ?? 0
  const rawTotal = rawReusable + rawScrap
  let reusableArea: number
  let scrapArea: number
  if (rawTotal > 0) {
    reusableArea = actualFreeArea * (rawReusable / rawTotal)
    scrapArea = actualFreeArea - reusableArea
  } else {
    reusableArea = 0
    scrapArea = actualFreeArea
  }
  const wasteArea = reusableArea + scrapArea
  const partType = simpleParts[0]?.partType ?? "rectangle"
  const partLabel = getPartTypeLabel(partType)

  return {
    renderShape: placedItems[0]?.renderShape ?? "rect",
    strategyName: `${partLabel} mixed-size layout`,
    strategyNote: best
      ? `Selected standard sizes are packed together on the chosen stock using a ${allRectangles ? "guillotine-fit" : `${best.sortBy}-first shelf`} layout scored for lower trim scrap.`
      : "Selected standard sizes are packed together on the chosen stock preview.",
    placementMode: "origin",
    wasteMode: "bands",
    cutPlanTitle: `${partLabel} cut sequence`,
    cutSteps: [
      {
        title: "Rough-cut the selected blanks in placement order",
        detail:
          "The preview stacks every selected size on the same stock so the operator can work from one layout.",
      },
      {
        title: "Finish each profile from its placed blank",
        detail:
          "Non-rectangular parts show their blank scrap directly so the cutter can see where the finished profile comes out of each placement.",
      },
    ],
    requestedUnits: requestedCount,
    unitsCompleted: placedItems.length,
    overflowUnits: Math.max(0, requestedCount - placedItems.length),
    piecesShown: placedItems.length,
    piecesPerUnit: 1,
    usedArea,
    wasteArea,
    wastePct: rollW * rollL > 0 ? (wasteArea / (rollW * rollL)) * 100 : 100,
    reusableArea,
    scrapArea,
    occupiedWidth: bounds.occupiedWidth,
    occupiedHeight: bounds.occupiedHeight,
    items: placedItems,
    offcutBands,
    scrapBands,
    placements: placedItems,
    label: placedItems[0]?.label ?? "",
  } as SimplePartPreview
}

// Single-spec previews come back from the per-shape generators without
// specIndex/partNumber set (those generators don't know about the spec list).
// Stamp them so buildTagMap (in NestingVisualizer) returns a non-empty map
// even when only one spec is selected.
function tagSingleSpecPreview(
  preview: SimplePartPreview,
  simplePart: SimplePartSpec
): SimplePartPreview {
  preview.items.forEach((item) => {
    item.specIndex = 0
    if (simplePart.partNumber !== undefined) item.partNumber = simplePart.partNumber
  })
  return preview
}

export function generateSimplePartPreview(
  rollW: number,
  rollL: number,
  simplePart: NonNullable<NestingVisualizerProps["simplePart"]>,
  fallbackWidth: number,
  fallbackHeight: number,
  fallbackQty: number,
  // Skip the expensive sync NFP packing for cone/trapezoid first-paint;
  // the async worker result replaces the directGrid output shortly.
  // Overflow-sheet regeneration must pass `false` so subsequent sheets
  // match the first sheet's NFP-optimized layout.
  skipNfpPacking = true
): SimplePartPreview {
  const qty = Math.max(1, simplePart.quantity || fallbackQty)

  const preview = ((): SimplePartPreview => {
    switch (simplePart.partType) {
      case "circle":
        return generateCirclePreview(rollW, rollL, simplePart.diameter ?? fallbackWidth, qty)
      case "cylinder":
        return generateCylinderPreview(
          rollW,
          rollL,
          simplePart.diameter ?? fallbackWidth,
          simplePart.height ?? fallbackHeight,
          qty,
          simplePart.cutDirection,
          simplePart.cutRatios
        )
      case "cone":
        return generateConePreview(
          rollW,
          rollL,
          simplePart.innerRadius ?? Math.max(1, fallbackWidth / 2),
          simplePart.outerRadius ?? Math.max(2, fallbackHeight),
          simplePart.arcDegrees ?? 120,
          qty,
          simplePart.cutDirection,
          simplePart.cutRatios,
          undefined,
          skipNfpPacking
        )
      case "trapezoid":
        return generateTrapezoidPreview(
          rollW,
          rollL,
          simplePart.topWidth ?? fallbackWidth,
          simplePart.bottomWidth ?? fallbackWidth,
          simplePart.height ?? fallbackHeight,
          qty,
          simplePart.cutDirection,
          simplePart.cutRatios,
          undefined,
          skipNfpPacking
        )
      case "rectangle":
      default:
        return generateRectanglePreview(
          rollW,
          rollL,
          simplePart.width ?? fallbackWidth,
          simplePart.length ?? fallbackHeight,
          qty
        )
    }
  })()

  return tagSingleSpecPreview(preview, simplePart)
}

/**
 * Async variant of generateSimplePartPreview. Routes cone/trapezoid through
 * the worker-backed NFP path (parallel coarse-angle sweep); everything else
 * falls through to the sync generators.
 */
export async function generateSimplePartPreviewAsync(
  rollW: number,
  rollL: number,
  simplePart: NonNullable<NestingVisualizerProps["simplePart"]>,
  fallbackWidth: number,
  fallbackHeight: number,
  fallbackQty: number
): Promise<SimplePartPreview> {
  const qty = Math.max(1, simplePart.quantity || fallbackQty)
  const preview = await (async (): Promise<SimplePartPreview> => {
    switch (simplePart.partType) {
      case "cone":
        return generateConePreviewAsync(
          rollW,
          rollL,
          simplePart.innerRadius ?? Math.max(1, fallbackWidth / 2),
          simplePart.outerRadius ?? Math.max(2, fallbackHeight),
          simplePart.arcDegrees ?? 120,
          qty,
          simplePart.cutDirection,
          simplePart.cutRatios
        )
      case "trapezoid":
        return generateTrapezoidPreviewAsync(
          rollW,
          rollL,
          simplePart.topWidth ?? fallbackWidth,
          simplePart.bottomWidth ?? fallbackWidth,
          simplePart.height ?? fallbackHeight,
          qty,
          simplePart.cutDirection,
          simplePart.cutRatios
        )
      default:
        // generateSimplePartPreview already tags items via tagSingleSpecPreview,
        // so calling it here is sufficient on its own — no extra tagging needed
        // for the rectangle/cylinder/circle path.
        return generateSimplePartPreview(
          rollW,
          rollL,
          simplePart,
          fallbackWidth,
          fallbackHeight,
          fallbackQty
        )
    }
  })()
  return tagSingleSpecPreview(preview, simplePart)
}

// Matches placed items back to specs by formatted dimension label. This couples
// to the label format in buildPartPreviewItem — keep them in sync.
function reduceSpecsByPlacedItems(specs: SimplePartSpec[], items: PreviewItem[]): SimplePartSpec[] {
  const labels = new Map<string, number>()
  items.forEach((item) => {
    labels.set(item.label, (labels.get(item.label) ?? 0) + 1)
  })
  return specs
    .map((spec) => {
      // Use buildPartPreviewItem to derive the label so all part types
      // (trapezoid, cone, cylinder, etc.) match the placed-item format.
      const label = buildPartPreviewItem(spec, 0, 0).label
      const count = labels.get(label) ?? 0
      if (count <= 0) return spec
      const left = Math.max(0, (spec.quantity || 1) - count)
      labels.set(label, count - Math.min(count, spec.quantity || 1))
      return left > 0 ? { ...spec, quantity: left } : null
    })
    .filter((s): s is SimplePartSpec => s !== null)
}

function tryGapFillSheet(
  sheetPreview: SimplePartPreview,
  remainingSpecs: SimplePartSpec[],
  rollW: number,
  rollL: number,
  stockArea: number
): { preview: SimplePartPreview; remainingSpecs: SimplePartSpec[] } {
  const allFreeRects = [
    ...(sheetPreview.offcutBands ?? []),
    ...(sheetPreview.scrapBands ?? []),
    // 1" minimum is intentional: gap-fill only considers rects large enough to fit
    // another part, unlike MIN_GAP_BAND_SIZE (0.25") which controls band rendering.
    // Skip bands with polygon geometry — only use verified axis-aligned rectangles.
  ].filter((r) => r.width > 1 && r.height > 1 && !r.polygon)

  if (remainingSpecs.length === 0 || allFreeRects.length === 0) {
    return { preview: sheetPreview, remainingSpecs }
  }

  // Build label → specIndex/partNumber lookup from already-placed items on this sheet
  const labelToSpecIndex = new Map<string, number>()
  const labelToPartNumber = new Map<string, string>()
  for (const item of sheetPreview.items) {
    if (item.specIndex != null && !labelToSpecIndex.has(item.label)) {
      labelToSpecIndex.set(item.label, item.specIndex)
      if (item.partNumber) labelToPartNumber.set(item.label, item.partNumber)
    }
  }

  const overflowItems = remainingSpecs.flatMap((spec) =>
    Array.from({ length: Math.max(1, spec.quantity || 1) }, () => {
      const item = buildPartPreviewItem(spec, rollW, rollL)
      item.specIndex = labelToSpecIndex.get(item.label)
      item.partNumber = spec.partNumber ?? labelToPartNumber.get(item.label)
      return item
    })
  )
  const gapFill = packIntoFreeRects(overflowItems, allFreeRects)
  if (gapFill.placed.length === 0) {
    return { preview: sheetPreview, remainingSpecs }
  }

  const mergedItems = [...sheetPreview.items, ...gapFill.placed]
  const mergedUsedArea = sheetPreview.usedArea + gapFill.usedArea
  const bounds = getPlacementBounds(mergedItems)
  const newOffcutBands: OffcutBand[] = []
  const newScrapBands: OffcutBand[] = []
  let newReusableArea = 0
  let newScrapArea = 0
  gapFill.remainingFreeRects.forEach((band) => {
    const area = band.width * band.height
    if (bandFitsAnyPreviewItem(band, mergedItems)) {
      newOffcutBands.push(band)
      newReusableArea += area
    } else {
      newScrapBands.push(band)
      newScrapArea += area
    }
  })
  newScrapArea += mergedItems.reduce((sum, item) => sum + computeIntraBlankWaste(item), 0)

  // Proportionally correct waste areas to equal actual free area
  // (raw band areas from MaxRects may overlap as maximal rectangles share space)
  const actualFreeArea = Math.max(0, stockArea - mergedUsedArea)
  const rawWasteTotal = newReusableArea + newScrapArea
  let correctedReusable: number
  let correctedScrap: number
  if (rawWasteTotal > 0) {
    correctedReusable = actualFreeArea * (newReusableArea / rawWasteTotal)
    correctedScrap = actualFreeArea - correctedReusable
  } else {
    correctedReusable = 0
    correctedScrap = actualFreeArea
  }

  const updatedPreview = {
    ...sheetPreview,
    items: mergedItems,
    placements: mergedItems,
    unitsCompleted: mergedItems.length,
    piecesShown: mergedItems.length,
    requestedUnits: sheetPreview.requestedUnits,
    usedArea: mergedUsedArea,
    offcutBands: newOffcutBands,
    scrapBands: newScrapBands,
    reusableArea: correctedReusable,
    scrapArea: correctedScrap,
    wasteArea: correctedReusable + correctedScrap,
    wastePct: stockArea > 0 ? ((correctedReusable + correctedScrap) / stockArea) * 100 : 100,
    occupiedWidth: bounds.occupiedWidth,
    occupiedHeight: bounds.occupiedHeight,
    overflowUnits: Math.max(0, sheetPreview.overflowUnits - gapFill.placed.length),
  } as SimplePartPreview

  return {
    preview: updatedPreview,
    remainingSpecs: reduceSpecsByPlacedItems(remainingSpecs, gapFill.placed),
  }
}

export function computeMultiSheetPreviews(
  preview: SimplePartPreview,
  rollW: number,
  rollL: number,
  maxSheets: number = 4,
  regenerate?: (qty: number, remainingSpecs?: SimplePartSpec[]) => SimplePartPreview,
  allSpecs?: SimplePartSpec[]
): MultiSheetResult {
  const capacityPerSheet = preview.unitsCompleted
  const totalNeeded = preview.unitsCompleted + preview.overflowUnits
  const stockArea = rollW * rollL

  if (preview.overflowUnits <= 0 || capacityPerSheet <= 0) {
    const fab = computeFabricationScore(preview, rollW, rollL)
    return {
      sheets: [{ sheetIndex: 0, preview, isPartial: false }],
      totalUnitsCompleted: preview.unitsCompleted,
      totalUsedArea: preview.usedArea,
      totalReusableArea: preview.reusableArea,
      totalScrapArea: preview.scrapArea,
      totalStockArea: stockArea,
      remainingOverflow: capacityPerSheet <= 0 ? totalNeeded : 0,
      avgFabScore: fab.score,
    }
  }

  const isMultiPart = allSpecs && allSpecs.length > 1

  const sheets: SheetPreview[] = []
  let placed = 0
  let overflowSpecs = allSpecs ? [...allSpecs] : undefined

  while (placed < totalNeeded && sheets.length < maxSheets) {
    const remaining = totalNeeded - placed
    const unitsOnSheet = Math.min(capacityPerSheet, remaining)

    let sheetPreview: SimplePartPreview
    if (sheets.length === 0) {
      sheetPreview = preview
    } else if (regenerate) {
      sheetPreview = regenerate(unitsOnSheet, overflowSpecs)
      // If the remaining spec(s) don't fit on a fresh sheet (e.g. async NFP
      // rotation produced an AABB larger than the stock), there's no point
      // adding empty sheets — leftover items end up in remainingOverflow.
      if (sheetPreview.unitsCompleted === 0) break
    } else {
      sheetPreview = preview
    }

    if (isMultiPart && overflowSpecs && overflowSpecs.length > 0) {
      let remainingSpecs = reduceSpecsByPlacedItems(overflowSpecs, sheetPreview.items)
      const gapResult = tryGapFillSheet(sheetPreview, remainingSpecs, rollW, rollL, stockArea)
      sheetPreview = gapResult.preview
      remainingSpecs = gapResult.remainingSpecs
      overflowSpecs = remainingSpecs
    }

    const isPartial = sheetPreview.unitsCompleted < capacityPerSheet
    sheets.push({ sheetIndex: sheets.length, preview: sheetPreview, isPartial })
    placed += sheetPreview.unitsCompleted

    if (isMultiPart && overflowSpecs && overflowSpecs.length === 0) break
  }

  const totalUnitsCompleted = sheets.reduce((s, sh) => s + sh.preview.unitsCompleted, 0)
  const totalUsedArea = sheets.reduce((s, sh) => s + sh.preview.usedArea, 0)
  const totalReusableArea = sheets.reduce((s, sh) => s + sh.preview.reusableArea, 0)
  const totalScrapArea = sheets.reduce((s, sh) => s + sh.preview.scrapArea, 0)
  const remainingOverflow = Math.max(0, totalNeeded - totalUnitsCompleted)
  const fabScores = sheets.map((sh) => computeFabricationScore(sh.preview, rollW, rollL).score)
  const avgFabScore = Math.round(fabScores.reduce((a, b) => a + b, 0) / fabScores.length)

  return {
    sheets,
    totalUnitsCompleted,
    totalUsedArea,
    totalReusableArea,
    totalScrapArea,
    totalStockArea: stockArea * sheets.length,
    remainingOverflow,
    avgFabScore,
  }
}
