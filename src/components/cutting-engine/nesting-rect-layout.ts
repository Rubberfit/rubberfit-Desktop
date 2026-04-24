// Rect and circle layout calculation utilities
// Split from nesting-layout-utils.ts to stay under the max-lines limit

import type {
  ShapePlacement,
  SimpleCircleLayout,
  SimpleRectLayout,
} from "./nesting-visualizer-types"
import {
  buildRowCounts,
  buildRectPlacements,
  buildOriginRectOffcutBands,
  isReusableOffcutBand,
  countPieceFitsInBand,
} from "./nesting-offcut-utils"

export function buildRectLayoutCandidate(
  rollW: number,
  rollL: number,
  pieceW: number,
  pieceH: number,
  qty: number,
  orientation: "default" | "rotated"
): SimpleRectLayout {
  const maxCols = Math.floor(rollW / pieceW)
  const maxRows = Math.floor(rollL / pieceH)
  const capacity = Math.max(0, maxCols * maxRows)
  const placed = Math.min(qty, capacity)
  const overflow = Math.max(0, qty - capacity)

  if (capacity === 0 || placed === 0) {
    return {
      orientation,
      pieceW,
      pieceH,
      cols: 0,
      rows: 0,
      rowCounts: [],
      capacity,
      placed,
      overflow,
      usedArea: 0,
      wasteArea: rollW * rollL,
      wastePct: 100,
      reusableArea: 0,
      scrapArea: rollW * rollL,
      reusablePieces: 0,
    }
  }

  let bestCandidate: SimpleRectLayout | null = null

  for (let cols = 1; cols <= maxCols; cols += 1) {
    const rowCounts = buildRowCounts(placed, cols)
    const rows = rowCounts.length
    if (rows > maxRows) {
      continue
    }

    const placements = buildRectPlacements(pieceW, pieceH, rowCounts)
    const offcutBands = buildOriginRectOffcutBands(placements, rollW, rollL)
    let reusableArea = 0
    let scrapArea = 0
    let reusablePieces = 0
    let largestReusableBand = 0

    offcutBands.forEach((band) => {
      const area = band.width * band.height
      if (isReusableOffcutBand(band, pieceW, pieceH)) {
        reusableArea += area
        reusablePieces += countPieceFitsInBand(band, pieceW, pieceH)
        largestReusableBand = Math.max(largestReusableBand, area)
      } else {
        scrapArea += area
      }
    })

    const candidate: SimpleRectLayout = {
      orientation,
      pieceW,
      pieceH,
      cols,
      rows,
      rowCounts,
      capacity,
      placed,
      overflow,
      usedArea: placed * pieceW * pieceH,
      wasteArea: Math.max(0, rollW * rollL - placed * pieceW * pieceH),
      wastePct:
        rollW * rollL > 0
          ? (Math.max(0, rollW * rollL - placed * pieceW * pieceH) / (rollW * rollL)) * 100
          : 100,
      reusableArea,
      scrapArea,
      reusablePieces,
    }

    if (!bestCandidate) {
      bestCandidate = candidate
      continue
    }

    const currentBest = bestCandidate

    if (candidate.scrapArea < currentBest.scrapArea - 0.001) {
      bestCandidate = candidate
      continue
    }
    if (Math.abs(candidate.scrapArea - currentBest.scrapArea) < 0.001) {
      if (candidate.reusablePieces > currentBest.reusablePieces) {
        bestCandidate = candidate
        continue
      }
      if (candidate.reusablePieces === currentBest.reusablePieces) {
        const bestLargestReusableBand = Math.max(
          0,
          ...buildOriginRectOffcutBands(
            buildRectPlacements(currentBest.pieceW, currentBest.pieceH, currentBest.rowCounts),
            rollW,
            rollL
          )
            .filter((band) => isReusableOffcutBand(band, currentBest.pieceW, currentBest.pieceH))
            .map((band) => band.width * band.height)
        )

        if (largestReusableBand > bestLargestReusableBand + 0.001) {
          bestCandidate = candidate
          continue
        }
        if (Math.abs(largestReusableBand - bestLargestReusableBand) < 0.001) {
          if (candidate.rows < currentBest.rows) {
            bestCandidate = candidate
            continue
          }
          if (candidate.rows === currentBest.rows && candidate.cols > currentBest.cols) {
            bestCandidate = candidate
          }
        }
      }
    }
  }

  return (
    bestCandidate ?? {
      orientation,
      pieceW,
      pieceH,
      cols: 0,
      rows: 0,
      rowCounts: [],
      capacity,
      placed,
      overflow,
      usedArea: 0,
      wasteArea: rollW * rollL,
      wastePct: 100,
      reusableArea: 0,
      scrapArea: rollW * rollL,
      reusablePieces: 0,
    }
  )
}

export function calculateSimpleRectLayout(
  rollW: number,
  rollL: number,
  cutW: number,
  cutH: number,
  qty: number
) {
  const candidates = [buildRectLayoutCandidate(rollW, rollL, cutW, cutH, qty, "default")]

  if (cutW !== cutH) {
    candidates.push(buildRectLayoutCandidate(rollW, rollL, cutH, cutW, qty, "rotated"))
  }

  candidates.sort((a, b) => {
    if (a.placed !== b.placed) return b.placed - a.placed
    if (a.overflow !== b.overflow) return a.overflow - b.overflow
    if (a.scrapArea !== b.scrapArea) return a.scrapArea - b.scrapArea
    if (a.reusablePieces !== b.reusablePieces) return b.reusablePieces - a.reusablePieces
    if (a.reusableArea !== b.reusableArea) return b.reusableArea - a.reusableArea
    if (a.cols !== b.cols) return b.cols - a.cols
    return a.orientation === "default" ? -1 : 1
  })

  return candidates[0]
}

export function _calculateSimpleCircleLayout(
  rollW: number,
  rollL: number,
  diameter: number,
  qty: number
): SimpleCircleLayout {
  if (diameter <= 0 || rollW <= 0 || rollL <= 0) {
    return {
      positions: [],
      blankSize: diameter,
      capacity: 0,
      placed: 0,
      overflow: qty,
      usedArea: 0,
      wasteArea: rollW * rollL,
      wastePct: 100,
    }
  }

  const layout = calculateSimpleRectLayout(rollW, rollL, diameter, diameter, qty)
  const radius = diameter / 2
  const usedArea = layout.placed * Math.PI * radius * radius
  const positions = buildRectPlacements(diameter, diameter, layout.rowCounts)

  return {
    positions,
    blankSize: diameter,
    capacity: layout.capacity,
    placed: layout.placed,
    overflow: layout.overflow,
    usedArea,
    wasteArea: Math.max(0, rollW * rollL - usedArea),
    wastePct:
      rollW * rollL > 0 ? (Math.max(0, rollW * rollL - usedArea) / (rollW * rollL)) * 100 : 100,
  }
}

export function calculateDirectCircleProfileLayout(
  rollW: number,
  rollL: number,
  diameter: number,
  qty: number,
  mode: "grid" | "hex" = "hex"
): SimpleCircleLayout {
  const radius = diameter / 2
  const positions: ShapePlacement[] = []

  if (radius <= 0 || rollW <= 0 || rollL <= 0) {
    return {
      positions: [],
      blankSize: diameter,
      capacity: 0,
      placed: 0,
      overflow: qty,
      usedArea: 0,
      wasteArea: rollW * rollL,
      wastePct: 100,
    }
  }

  const rowStep = mode === "hex" ? diameter * 0.8660254 : diameter

  for (let row = 0; ; row += 1) {
    const cy = radius + row * rowStep
    if (cy + radius > rollL + 0.001) break

    const offset = mode === "hex" && row % 2 === 1 ? radius : 0
    for (let col = 0; ; col += 1) {
      const cx = radius + offset + col * diameter
      if (cx + radius > rollW + 0.001) break

      positions.push({
        x: cx - radius,
        y: cy - radius,
        width: diameter,
        height: diameter,
      })
    }
  }

  const capacity = positions.length
  const placed = Math.min(qty, capacity)
  const overflow = Math.max(0, qty - capacity)
  const usedArea = placed * Math.PI * radius * radius

  return {
    positions: positions.slice(0, placed),
    blankSize: diameter,
    capacity,
    placed,
    overflow,
    usedArea,
    wasteArea: Math.max(0, rollW * rollL - usedArea),
    wastePct:
      rollW * rollL > 0 ? (Math.max(0, rollW * rollL - usedArea) / (rollW * rollL)) * 100 : 100,
  }
}
