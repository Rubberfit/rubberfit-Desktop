// Packing algorithms for NestingVisualizer
// Split from nesting-layout-utils.ts — contains packing, shelf, and guillotine algorithms

import type {
  OffcutBand,
  PackedPreviewItemsResult,
  PackedShapeLayout,
  PreviewItem,
  PreviewPackSort,
  ShapePlacement,
} from "./nesting-visualizer-types"
import { getPlacementBounds } from "./nesting-offcut-utils"
import { sectorToPolygon, trapezoidToPolygon } from "@/nesting/shape-to-polygon"

export function sortPreviewItems(
  items: Array<PreviewItem & { usedArea: number }>,
  sortBy: PreviewPackSort
) {
  return [...items].sort((a, b) => {
    switch (sortBy) {
      case "height":
        if (b.height !== a.height) return b.height - a.height
        break
      case "width":
        if (b.width !== a.width) return b.width - a.width
        break
      case "max-edge":
        if (Math.max(b.width, b.height) !== Math.max(a.width, a.height)) {
          return Math.max(b.width, b.height) - Math.max(a.width, a.height)
        }
        break
      case "area":
      default:
        if (b.usedArea !== a.usedArea) return b.usedArea - a.usedArea
        break
    }

    if (b.height !== a.height) return b.height - a.height
    if (b.width !== a.width) return b.width - a.width
    return 0
  })
}

function findBestShelf(
  orientations: Array<{ w: number; h: number; rotated: boolean }>,
  shelves: Array<{ y: number; height: number; x: number }>,
  rollW: number,
  rollL: number
): { shelfIndex: number; shelfHeight: number; rotated: boolean; waste: number } {
  let bestShelfIndex = -1
  let bestShelfWaste = Number.POSITIVE_INFINITY
  let bestShelfHeight = 0
  let bestRotated = false

  for (const orient of orientations) {
    for (let index = 0; index < shelves.length; index += 1) {
      const shelf = shelves[index]
      const nextShelfY = shelves[index + 1]?.y ?? rollL
      const availableHeight = nextShelfY - shelf.y
      const nextHeight = Math.max(shelf.height, orient.h)
      if (nextHeight > availableHeight + 0.001) continue
      if (shelf.x + orient.w > rollW + 0.001) continue
      if (shelf.y + nextHeight > rollL + 0.001) continue

      const remainingWidth = rollW - (shelf.x + orient.w)
      const heightPenalty = nextHeight - shelf.height
      const shelfWaste = remainingWidth + heightPenalty * 0.75

      if (shelfWaste < bestShelfWaste) {
        bestShelfWaste = shelfWaste
        bestShelfIndex = index
        bestShelfHeight = nextHeight
        bestRotated = orient.rotated
      }
    }
  }

  return {
    shelfIndex: bestShelfIndex,
    shelfHeight: bestShelfHeight,
    rotated: bestRotated,
    waste: bestShelfWaste,
  }
}

export function packPreviewItemsOnShelves(
  items: Array<PreviewItem & { usedArea: number }>,
  rollW: number,
  rollL: number,
  sortBy: PreviewPackSort,
  flipPattern?: "none" | "checker"
): PackedPreviewItemsResult {
  const sortedItems = sortPreviewItems(items, sortBy)
  const shelves: Array<{ y: number; height: number; x: number }> = []
  const placedItems: PreviewItem[] = []
  let usedArea = 0
  let placedIndex = 0

  sortedItems.forEach((item) => {
    const canRotate = Math.abs(item.width - item.height) > 0.001
    const orientations = [
      { w: item.width, h: item.height, rotated: false },
      ...(canRotate ? [{ w: item.height, h: item.width, rotated: true }] : []),
    ]

    let {
      shelfIndex: bestShelfIndex,
      shelfHeight: bestShelfHeight,
      rotated: bestRotated,
    } = findBestShelf(orientations, shelves, rollW, rollL)

    if (bestShelfIndex === -1) {
      const nextY =
        shelves.length === 0 ? 0 : Math.max(...shelves.map((shelf) => shelf.y + shelf.height))

      const orient = orientations.find((o) => nextY + o.h <= rollL + 0.001 && o.w <= rollW + 0.001)
      if (!orient) return

      shelves.push({ y: nextY, height: orient.h, x: 0 })
      bestShelfIndex = shelves.length - 1
      bestShelfHeight = orient.h
      bestRotated = orient.rotated
    }

    const shelf = shelves[bestShelfIndex]
    const placedW = bestRotated ? item.height : item.width
    const finalRotated90 = bestRotated ? !(item.rotated90 ?? false) : (item.rotated90 ?? false)
    const finalFlipped = flipPattern === "checker" ? placedIndex % 2 === 1 : (item.flipped ?? false)
    // Set placedPolygon for trapezoid/sector items so the renderer takes the
    // PolygonShape path. Without it, TrapezoidShape/SectorShape draw the shape
    // in its original orientation inside a rotated AABB — visual mismatch.
    const placedPolygon = recomputePlacedPolygon(
      item,
      finalRotated90,
      finalFlipped,
      shelf.x,
      shelf.y
    )
    placedItems.push({
      ...item,
      x: shelf.x,
      y: shelf.y,
      width: bestRotated ? item.height : item.width,
      height: bestRotated ? item.width : item.height,
      rotated90: finalRotated90,
      flipped: finalFlipped,
      ...(placedPolygon ? { placedPolygon } : {}),
    })
    placedIndex += 1
    shelf.x += placedW
    shelf.height = bestShelfHeight
    usedArea += item.usedArea
  })

  const bounds = getPlacementBounds(placedItems)

  return {
    items: placedItems,
    usedArea,
    occupiedWidth: bounds.occupiedWidth,
    occupiedHeight: bounds.occupiedHeight,
  }
}

export function packPreviewItemsInCenteredColumn(
  items: Array<PreviewItem & { usedArea: number }>,
  rollW: number,
  rollL: number,
  gap = 0.75
): PackedPreviewItemsResult {
  const sortedItems = [...items].sort((a, b) => {
    const outerA = a.outerRadius ?? Math.max(a.width, a.height)
    const outerB = b.outerRadius ?? Math.max(b.width, b.height)
    if (outerB !== outerA) return outerB - outerA
    if (b.usedArea !== a.usedArea) return b.usedArea - a.usedArea
    return b.width - a.width
  })

  const maxWidth = sortedItems.reduce((max, item) => Math.max(max, item.width), 0)
  const placedItems: PreviewItem[] = []
  let usedArea = 0
  let cursorY = 0

  for (const item of sortedItems) {
    if (item.width > rollW + 0.001 || cursorY + item.height > rollL + 0.001) {
      break
    }

    const x = Math.max(0, (maxWidth - item.width) / 2)
    placedItems.push({
      ...item,
      x,
      y: cursorY,
    })
    usedArea += item.usedArea
    cursorY += item.height + gap
  }

  const bounds = getPlacementBounds(placedItems)
  return {
    items: placedItems,
    usedArea,
    occupiedWidth: bounds.occupiedWidth,
    occupiedHeight: bounds.occupiedHeight,
  }
}

export function packRectItemsWithGuillotine(
  items: Array<PreviewItem & { usedArea: number }>,
  rollW: number,
  rollL: number,
  sortBy: PreviewPackSort
): PackedPreviewItemsResult {
  type RectPlacementChoice = {
    freeIndex: number
    width: number
    height: number
    rotated: boolean
    shortSide: number
    longSide: number
    areaFit: number
    y: number
    x: number
  }

  const sortedItems = sortPreviewItems(items, sortBy)
  let freeRects: OffcutBand[] = [{ x: 0, y: 0, width: rollW, height: rollL }]
  const placedItems: PreviewItem[] = []
  let usedArea = 0

  const pruneFreeRects = (rects: OffcutBand[]) =>
    rects.filter((rect, index) => {
      if (rect.width <= 0.25 || rect.height <= 0.25) {
        return false
      }
      return !rects.some((other, otherIndex) => {
        if (index === otherIndex) return false
        return (
          rect.x >= other.x &&
          rect.y >= other.y &&
          rect.x + rect.width <= other.x + other.width &&
          rect.y + rect.height <= other.y + other.height
        )
      })
    })

  sortedItems.forEach((item) => {
    let best: RectPlacementChoice | null = null

    const orientations = [
      { width: item.width, height: item.height, rotated: false },
      ...(Math.abs(item.width - item.height) > 0.001
        ? [{ width: item.height, height: item.width, rotated: true }]
        : []),
    ]

    freeRects.forEach((freeRect, freeIndex) => {
      orientations.forEach((orientation) => {
        if (
          orientation.width > freeRect.width + 0.001 ||
          orientation.height > freeRect.height + 0.001
        ) {
          return
        }

        const leftoverW = freeRect.width - orientation.width
        const leftoverH = freeRect.height - orientation.height
        const candidate = {
          freeIndex,
          width: orientation.width,
          height: orientation.height,
          rotated: orientation.rotated,
          shortSide: Math.min(leftoverW, leftoverH),
          longSide: Math.max(leftoverW, leftoverH),
          areaFit: leftoverW * freeRect.height + orientation.width * leftoverH,
          y: freeRect.y,
          x: freeRect.x,
        }

        if (
          !best ||
          candidate.shortSide < best.shortSide - 0.001 ||
          (Math.abs(candidate.shortSide - best.shortSide) < 0.001 &&
            (candidate.longSide < best.longSide - 0.001 ||
              (Math.abs(candidate.longSide - best.longSide) < 0.001 &&
                (candidate.areaFit < best.areaFit - 0.001 ||
                  (Math.abs(candidate.areaFit - best.areaFit) < 0.001 &&
                    (candidate.y < best.y - 0.001 ||
                      (Math.abs(candidate.y - best.y) < 0.001 && candidate.x < best.x - 0.001)))))))
        ) {
          best = candidate
        }
      })
    })

    if (!best) {
      return
    }

    const chosen = best as RectPlacementChoice
    const host = freeRects[chosen.freeIndex]
    placedItems.push({
      ...item,
      x: host.x,
      y: host.y,
      width: chosen.width,
      height: chosen.height,
      rotated90: chosen.rotated ? !(item.rotated90 ?? false) : (item.rotated90 ?? false),
      flipped: chosen.rotated ? !(item.flipped ?? false) : item.flipped,
    })
    usedArea += item.usedArea

    const nextRects = freeRects.filter((_, index) => index !== chosen.freeIndex)
    const rightRect = {
      x: host.x + chosen.width,
      y: host.y,
      width: host.width - chosen.width,
      height: chosen.height,
    }
    const bottomRect = {
      x: host.x,
      y: host.y + chosen.height,
      width: host.width,
      height: host.height - chosen.height,
    }
    nextRects.push(rightRect, bottomRect)
    freeRects = pruneFreeRects(nextRects)
  })

  const bounds = getPlacementBounds(placedItems)
  return {
    items: placedItems,
    usedArea,
    occupiedWidth: bounds.occupiedWidth,
    occupiedHeight: bounds.occupiedHeight,
    freeRects,
  }
}

/**
 * Recompute placedPolygon for a shaped item after rotation/repositioning.
 * Uses the item's intrinsic dimensions to regenerate the base polygon,
 * then applies the final rotated90 + flipped transforms at (tx, ty).
 */
export function recomputePlacedPolygon(
  item: PreviewItem,
  rotated90: boolean,
  flipped: boolean,
  tx: number,
  ty: number
): Array<{ x: number; y: number }> | undefined {
  let basePts: Array<{ x: number; y: number }> | null = null
  if (
    item.renderShape === "trapezoid" &&
    item.topWidth != null &&
    item.bottomWidth != null &&
    item.height != null
  ) {
    basePts = trapezoidToPolygon(item.topWidth, item.bottomWidth, item.height)
  } else if (
    item.renderShape === "sector" &&
    item.innerRadius != null &&
    item.outerRadius != null &&
    item.arcDegrees != null
  ) {
    basePts = sectorToPolygon(item.innerRadius, item.outerRadius, item.arcDegrees, 48)
  }
  if (!basePts) return undefined

  // Mirror transformBasePolygon logic from nesting-preview-builders.ts
  let pts = basePts.map((p) => ({ x: p.x, y: p.y }))
  if (rotated90) {
    pts = pts.map((p) => ({ x: p.y, y: -p.x }))
  }
  if (flipped) {
    pts = pts.map((p) => ({ x: p.x, y: -p.y }))
  }
  let minX = Infinity
  let minY = Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
  }
  return pts.map((p) => ({ x: p.x - minX + tx, y: p.y - minY + ty }))
}

/**
 * Pack additional items into existing free rects (second-pass gap filling).
 * Uses the same best-short-side-fit heuristic as the guillotine packer.
 */
export function packIntoFreeRects(
  items: Array<PreviewItem & { usedArea: number }>,
  startingFreeRects: OffcutBand[]
): { placed: PreviewItem[]; usedArea: number; remainingFreeRects: OffcutBand[] } {
  type RectChoice = {
    freeIndex: number
    width: number
    height: number
    rotated: boolean
    shortSide: number
    longSide: number
    areaFit: number
    y: number
    x: number
  }

  const sorted = [...items].sort((a, b) => b.usedArea - a.usedArea)
  let freeRects = startingFreeRects.filter((r) => r.width > 0.25 && r.height > 0.25)
  const placed: PreviewItem[] = []
  let usedArea = 0

  const prune = (rects: OffcutBand[]) =>
    rects.filter((rect, i) => {
      if (rect.width <= 0.25 || rect.height <= 0.25) return false
      return !rects.some(
        (other, j) =>
          i !== j &&
          rect.x >= other.x &&
          rect.y >= other.y &&
          rect.x + rect.width <= other.x + other.width &&
          rect.y + rect.height <= other.y + other.height
      )
    })

  sorted.forEach((item) => {
    let best: RectChoice | null = null
    const orientations = [
      { width: item.width, height: item.height, rotated: false },
      ...(Math.abs(item.width - item.height) > 0.001
        ? [{ width: item.height, height: item.width, rotated: true }]
        : []),
    ]

    freeRects.forEach((fr, fi) => {
      orientations.forEach((o) => {
        if (o.width > fr.width + 0.001 || o.height > fr.height + 0.001) return
        const lw = fr.width - o.width
        const lh = fr.height - o.height
        const c: RectChoice = {
          freeIndex: fi,
          width: o.width,
          height: o.height,
          rotated: o.rotated,
          shortSide: Math.min(lw, lh),
          longSide: Math.max(lw, lh),
          areaFit: lw * fr.height + o.width * lh,
          y: fr.y,
          x: fr.x,
        }
        if (
          !best ||
          c.shortSide < best.shortSide - 0.001 ||
          (Math.abs(c.shortSide - best.shortSide) < 0.001 &&
            (c.longSide < best.longSide - 0.001 ||
              (Math.abs(c.longSide - best.longSide) < 0.001 &&
                (c.areaFit < best.areaFit - 0.001 ||
                  (Math.abs(c.areaFit - best.areaFit) < 0.001 &&
                    (c.y < best.y - 0.001 ||
                      (Math.abs(c.y - best.y) < 0.001 && c.x < best.x - 0.001)))))))
        ) {
          best = c
        }
      })
    })

    if (!best) return
    const chosen = best as RectChoice
    const host = freeRects[chosen.freeIndex]
    const finalRotated90 = chosen.rotated ? !(item.rotated90 ?? false) : (item.rotated90 ?? false)
    const finalFlipped = item.flipped ?? false
    placed.push({
      ...item,
      x: host.x,
      y: host.y,
      width: chosen.width,
      height: chosen.height,
      rotated90: finalRotated90,
      flipped: finalFlipped,
      placedPolygon: recomputePlacedPolygon(
        item,
        finalRotated90,
        finalFlipped ?? false,
        host.x,
        host.y
      ),
    })
    usedArea += item.usedArea

    const next = freeRects.filter((_, i) => i !== chosen.freeIndex)
    next.push(
      {
        x: host.x + chosen.width,
        y: host.y,
        width: host.width - chosen.width,
        height: chosen.height,
      },
      {
        x: host.x,
        y: host.y + chosen.height,
        width: host.width,
        height: host.height - chosen.height,
      }
    )
    freeRects = prune(next)
  })

  return { placed, usedArea, remainingFreeRects: freeRects }
}

export function calculatePackedShapeLayout(
  rollW: number,
  rollL: number,
  footprintW: number,
  footprintH: number,
  qty: number,
  options?: {
    stepX?: number
    stepY?: number
    rowOffset?: number
    alternateOffset?: boolean
    flipPattern?: "none" | "row" | "checker"
    rotated90?: boolean
  }
): PackedShapeLayout {
  const positions: ShapePlacement[] = []

  if (footprintW <= 0 || footprintH <= 0 || rollW <= 0 || rollL <= 0) {
    return {
      positions,
      capacity: 0,
      placed: 0,
      overflow: Math.max(0, qty),
      occupiedWidth: 0,
      occupiedHeight: 0,
    }
  }

  const stepX = options?.stepX ?? footprintW
  const stepY = options?.stepY ?? footprintH
  const rowOffset = options?.rowOffset ?? 0
  const flipPattern = options?.flipPattern ?? "none"
  const rotated90 = options?.rotated90 ?? false

  if (stepX <= 0 || stepY <= 0) {
    return {
      positions,
      capacity: 0,
      placed: 0,
      overflow: Math.max(0, qty),
      occupiedWidth: 0,
      occupiedHeight: 0,
    }
  }

  for (let row = 0; ; row += 1) {
    const y = row * stepY
    if (y + footprintH > rollL + 0.001) {
      break
    }

    const xStart = options?.alternateOffset && row % 2 === 1 ? rowOffset : 0

    for (let col = 0; ; col += 1) {
      const x = xStart + col * stepX
      if (x + footprintW > rollW + 0.001) {
        break
      }

      const flipped =
        flipPattern === "checker"
          ? (row + col) % 2 === 1
          : flipPattern === "row"
            ? row % 2 === 1
            : false

      positions.push({
        x,
        y,
        width: footprintW,
        height: footprintH,
        flipped,
        rotated90,
      })
    }
  }

  const capacity = positions.length
  const placed = Math.min(qty, capacity)
  const trimmed = positions.slice(0, placed)
  const { occupiedWidth, occupiedHeight } = getPlacementBounds(trimmed)

  return {
    positions: trimmed,
    capacity,
    placed,
    overflow: Math.max(0, qty - capacity),
    occupiedWidth,
    occupiedHeight,
  }
}
