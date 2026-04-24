// Offcut band calculation and placement bounds utilities
// Split from nesting-layout-utils.ts to stay under the max-lines limit

import type { OffcutBand, PreviewItem, ShapePlacement } from "./nesting-visualizer-types"
import {
  MIN_REUSABLE_OFFCUT_WIDTH,
  MIN_REUSABLE_OFFCUT_HEIGHT,
  MIN_REUSABLE_STRIP_WIDTH,
  MIN_REUSABLE_STRIP_LENGTH,
} from "./nesting-visualizer-types"

const MIN_GAP_BAND_SIZE = 0.25

export function buildRowCounts(placed: number, cols: number) {
  const rows = Math.ceil(placed / cols)
  return Array.from({ length: rows }, (_, rowIndex) => {
    if (rowIndex < rows - 1) {
      return cols
    }
    return placed - cols * (rows - 1)
  })
}

export function buildRectPlacements(pieceW: number, pieceH: number, rowCounts: number[]) {
  const placements: ShapePlacement[] = []
  rowCounts.forEach((count, rowIndex) => {
    for (let colIndex = 0; colIndex < count; colIndex += 1) {
      placements.push({
        x: colIndex * pieceW,
        y: rowIndex * pieceH,
        width: pieceW,
        height: pieceH,
      })
    }
  })
  return placements
}

export function buildOriginRectOffcutBands(
  placements: ShapePlacement[],
  rollW: number,
  rollL: number
) {
  if (placements.length === 0) {
    return []
  }

  const rows = new Map<number, { y: number; height: number; maxX: number }>()

  placements.forEach((placement) => {
    const existing = rows.get(placement.y)
    const maxX = placement.x + placement.width
    if (!existing) {
      rows.set(placement.y, {
        y: placement.y,
        height: placement.height,
        maxX,
      })
      return
    }

    existing.maxX = Math.max(existing.maxX, maxX)
    existing.height = Math.max(existing.height, placement.height)
  })

  const sortedRows = Array.from(rows.values()).sort((a, b) => a.y - b.y)
  const bands: OffcutBand[] = []

  sortedRows.forEach((row) => {
    const width = rollW - row.maxX
    if (width > MIN_GAP_BAND_SIZE) {
      bands.push({
        x: row.maxX,
        y: row.y,
        width,
        height: row.height,
      })
    }
  })

  const lastRow = sortedRows.at(-1)
  if (lastRow) {
    const bottomY = lastRow.y + lastRow.height
    const bottomHeight = rollL - bottomY
    if (bottomHeight > MIN_GAP_BAND_SIZE) {
      bands.push({
        x: 0,
        y: bottomY,
        width: rollW,
        height: bottomHeight,
      })
    }
  }

  return bands
}

/**
 * Subtract a placement's AABB from a single band rect, returning 0–4
 * non-overlapping sub-bands. Used to clip shelf-gap bands so they never
 * paint over placements from other rows (NFP rotation gives each placement
 * a unique y, so the per-row bands otherwise span across other placements).
 */
function subtractPlacementFromBand(band: OffcutBand, placement: ShapePlacement): OffcutBand[] {
  const bx1 = band.x
  const bx2 = band.x + band.width
  const by1 = band.y
  const by2 = band.y + band.height
  const px1 = placement.x
  const px2 = placement.x + placement.width
  const py1 = placement.y
  const py2 = placement.y + placement.height

  const ox1 = Math.max(bx1, px1)
  const ox2 = Math.min(bx2, px2)
  const oy1 = Math.max(by1, py1)
  const oy2 = Math.min(by2, py2)
  if (ox1 >= ox2 || oy1 >= oy2) {
    return [band]
  }

  const result: OffcutBand[] = []
  if (ox1 - bx1 > MIN_GAP_BAND_SIZE) {
    result.push({ ...band, x: bx1, y: by1, width: ox1 - bx1, height: band.height })
  }
  if (bx2 - ox2 > MIN_GAP_BAND_SIZE) {
    result.push({ ...band, x: ox2, y: by1, width: bx2 - ox2, height: band.height })
  }
  if (oy1 - by1 > MIN_GAP_BAND_SIZE) {
    result.push({ ...band, x: ox1, y: by1, width: ox2 - ox1, height: oy1 - by1 })
  }
  if (by2 - oy2 > MIN_GAP_BAND_SIZE) {
    result.push({ ...band, x: ox1, y: oy2, width: ox2 - ox1, height: by2 - oy2 })
  }
  return result
}

export function buildShelfGapBands(placements: ShapePlacement[], rollW: number, rollL: number) {
  if (placements.length === 0) {
    return [] as OffcutBand[]
  }

  /**
   * Stage 1: Group placements into rows (lines 149-163)
   * Items are grouped by their exact y-coordinate.
   * Each row tracks its y position, the maximum height of any item in the row, and the list of placements.
   */

  const rows = new Map<number, { y: number; height: number; placements: ShapePlacement[] }>()

  placements.forEach((placement) => {
    const existing = rows.get(placement.y)
    if (!existing) {
      rows.set(placement.y, {
        y: placement.y,
        height: placement.height,
        placements: [placement],
      })
      return
    }

    existing.height = Math.max(existing.height, placement.height)
    existing.placements.push(placement)
  })

  /**
   * Stage 2: Walk each row and find gaps. (lines 172-220)
   * For each row, sort placements left-to-right by x, then scan across
   */
  const candidateBands: OffcutBand[] = []
  const sortedRows = Array.from(rows.values()).sort((a, b) => a.y - b.y)

  sortedRows.forEach((row) => {
    const sortedPlacements = [...row.placements].sort((a, b) => a.x - b.x)
    let rowMaxX = 0

    sortedPlacements.forEach((placement, idx) => {
      // Leading gap (first placement doesn't start at x=0)
      if (idx === 0 && placement.x > MIN_GAP_BAND_SIZE) {
        candidateBands.push({ x: 0, y: row.y, width: placement.x, height: row.height })
      }
      // Inter-placement gap (gap between consecutive placements)
      if (idx > 0) {
        const prevEnd = sortedPlacements[idx - 1].x + sortedPlacements[idx - 1].width
        const gapWidth = placement.x - prevEnd
        if (gapWidth > MIN_GAP_BAND_SIZE) {
          candidateBands.push({ x: prevEnd, y: row.y, width: gapWidth, height: row.height })
        }
      }
      rowMaxX = Math.max(rowMaxX, placement.x + placement.width)
      const underfillHeight = row.height - placement.height
      if (underfillHeight > MIN_GAP_BAND_SIZE) {
        const underfillBand: OffcutBand = {
          x: placement.x,
          y: placement.y + placement.height,
          width: placement.width,
          height: underfillHeight,
        }
        // Only emit when the strip is large enough to be reusable. Otherwise
        // a row of short cones next to a tall one produces thin scrap bands
        // below each short cone, which paint a horizontal waste stripe and
        // also shift withWaste's proportional split toward scrap.
        if (isReusableOffcutBand(underfillBand)) {
          candidateBands.push(underfillBand)
        }
      }
    })

    const trailingWidth = rollW - rowMaxX
    if (trailingWidth > MIN_GAP_BAND_SIZE) {
      candidateBands.push({
        x: rowMaxX,
        y: row.y,
        width: trailingWidth,
        height: row.height,
      })
    }
  })

  const lastRow = sortedRows.at(-1)
  if (lastRow) {
    const bottomY = lastRow.y + lastRow.height
    const bottomHeight = rollL - bottomY
    if (bottomHeight > MIN_GAP_BAND_SIZE) {
      candidateBands.push({
        x: 0,
        y: bottomY,
        width: rollW,
        height: bottomHeight,
      })
    }
  }

  /**
   * Stage 3: Clip against all placements
   * Every candidate band is run through subtractPlacementFromBand against every placement.
   * This splits bands that would overlap a shape's AABB into sub bands around it.
   * This matters for NFP-rotated layouts where items in different rows might have overlapping x-ranges.
   */

  // Clip every candidate against every placement so no band overlaps a
  // placement's AABB. Without this, rows of NFP-rotated placements emit
  // leading/trailing strips that paint across other rows' shapes.
  const bands: OffcutBand[] = []
  for (const band of candidateBands) {
    let pieces: OffcutBand[] = [band]
    for (const placement of placements) {
      pieces = pieces.flatMap((p) => subtractPlacementFromBand(p, placement))
      if (pieces.length === 0) break
    }
    bands.push(...pieces)
  }

  return bands
}

export function countPieceFitsInBand(band: OffcutBand, pieceW: number, pieceH: number) {
  const direct = Math.floor(band.width / pieceW) * Math.floor(band.height / pieceH)
  const rotated =
    pieceW === pieceH ? direct : Math.floor(band.width / pieceH) * Math.floor(band.height / pieceW)
  return Math.max(direct, rotated)
}

export function isReusableOffcutBand(band: OffcutBand, pieceW?: number, pieceH?: number) {
  const matchesCurrentPiece =
    pieceW && pieceH ? countPieceFitsInBand(band, pieceW, pieceH) > 0 : false
  const matchesStandardOffcut =
    countPieceFitsInBand(band, MIN_REUSABLE_OFFCUT_WIDTH, MIN_REUSABLE_OFFCUT_HEIGHT) > 0
  const matchesReusableStrip =
    countPieceFitsInBand(band, MIN_REUSABLE_STRIP_LENGTH, MIN_REUSABLE_STRIP_WIDTH) > 0

  return matchesCurrentPiece || matchesStandardOffcut || matchesReusableStrip
}

export function bandFitsAnyPreviewItem(band: OffcutBand, items: PreviewItem[]) {
  return (
    items.some((item) => countPieceFitsInBand(band, item.width, item.height) > 0) ||
    isReusableOffcutBand(band)
  )
}

export function computeIntraBlankWaste(item: PreviewItem): number {
  const boxArea = item.width * item.height
  if (item.renderShape === "sector") {
    const arc = item.arcDegrees ?? 120
    const oR = item.outerRadius ?? 0
    const iR = item.innerRadius ?? 0
    return boxArea - (arc / 360) * Math.PI * (oR ** 2 - iR ** 2)
  }
  if (item.renderShape === "trapezoid") {
    const tW = item.topWidth ?? item.width
    const bW = item.bottomWidth ?? item.width
    return boxArea - ((tW + bW) / 2) * item.height
  }
  if (item.renderShape === "circle") {
    const d = item.diameter ?? item.width
    return boxArea - Math.PI * (d / 2) ** 2
  }
  return 0
}

export function getPlacementBounds(positions: ShapePlacement[]) {
  if (positions.length === 0) {
    return {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      occupiedWidth: 0,
      occupiedHeight: 0,
    }
  }

  const minX = Math.min(...positions.map((position) => position.x))
  const minY = Math.min(...positions.map((position) => position.y))
  const maxX = Math.max(...positions.map((position) => position.x + position.width))
  const maxY = Math.max(...positions.map((position) => position.y + position.height))

  return {
    minX,
    minY,
    maxX,
    maxY,
    occupiedWidth: maxX - minX,
    occupiedHeight: maxY - minY,
  }
}

export function centerPlacements(positions: ShapePlacement[], rollW: number, rollL: number) {
  if (positions.length === 0) {
    return {
      positions,
      occupiedWidth: 0,
      occupiedHeight: 0,
    }
  }

  const bounds = getPlacementBounds(positions)
  const offsetX = (rollW - bounds.occupiedWidth) / 2 - bounds.minX
  const offsetY = (rollL - bounds.occupiedHeight) / 2 - bounds.minY
  const centered = positions.map((position) => ({
    ...position,
    x: position.x + offsetX,
    y: position.y + offsetY,
  }))
  const centeredBounds = getPlacementBounds(centered)

  return {
    positions: centered,
    occupiedWidth: centeredBounds.occupiedWidth,
    occupiedHeight: centeredBounds.occupiedHeight,
  }
}

export function buildOffcutBands(
  bounds: ReturnType<typeof getPlacementBounds>,
  rollW: number,
  rollL: number,
  placementMode: "origin" | "center"
): OffcutBand[] {
  if (bounds.occupiedWidth <= 0 || bounds.occupiedHeight <= 0) {
    return []
  }

  const bands: OffcutBand[] = []
  const left = bounds.minX
  const right = rollW - bounds.maxX
  const top = bounds.minY
  const bottom = rollL - bounds.maxY

  if (placementMode === "origin") {
    if (right > MIN_GAP_BAND_SIZE) {
      bands.push({
        x: bounds.maxX,
        y: 0,
        width: right,
        height: bottom > MIN_GAP_BAND_SIZE ? bounds.maxY : rollL,
      })
    }
    if (bottom > MIN_GAP_BAND_SIZE) {
      bands.push({ x: 0, y: bounds.maxY, width: rollW, height: bottom })
    }
    return bands
  }

  if (top > MIN_GAP_BAND_SIZE) {
    bands.push({ x: 0, y: 0, width: rollW, height: top })
  }
  if (bottom > MIN_GAP_BAND_SIZE) {
    bands.push({ x: 0, y: bounds.maxY, width: rollW, height: bottom })
  }
  if (left > MIN_GAP_BAND_SIZE) {
    bands.push({ x: 0, y: bounds.minY, width: left, height: bounds.occupiedHeight })
  }
  if (right > MIN_GAP_BAND_SIZE) {
    bands.push({ x: bounds.maxX, y: bounds.minY, width: right, height: bounds.occupiedHeight })
  }

  return bands
}
