// Global multi-sheet bin packing using MaxRects with all 5 heuristics
//
// Ported and adapted from three reference implementations:
//
// 1. Jukka Jylänki — MaxRects reference implementation (C++)
//    https://github.com/juj/RectangleBinPack
//    "A Thousand Ways to Pack the Bin" (2010)
//    All 5 heuristics: BSSF, BLSF, BAF, BL, CP
//    Batch insertion strategy (Insert method)
//
// 2. rectpack — Python 2D rectangle packing library
//    https://github.com/secnot/rectpack
//    PackerGlobal strategy: fill each bin by picking best-fitting item
//    BBF (Bin Best Fit) multi-bin selection
//    Sort strategies: area, perimeter, diff, sside, lside
//
// 3. maxrects-packer — TypeScript MaxRects implementation
//    https://github.com/soimy/maxrects-packer
//    Split/prune reference, rotation handling

import type { PreviewItem } from "./nesting-visualizer-types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All 5 MaxRects heuristics from Jylänki's paper */
export type HeuristicType = "bssf" | "blsf" | "baf" | "bl" | "cp"

export interface FreeRect {
  x: number
  y: number
  w: number
  h: number
}

export interface Placement {
  binIndex: number
  x: number
  y: number
  w: number
  h: number
  rotated: boolean
  itemIndex: number
}

export interface PackableItem {
  index: number
  w: number
  h: number
  item: PreviewItem & { usedArea: number }
}

interface ScoreResult {
  x: number
  y: number
  w: number
  h: number
  score1: number
  score2: number
  rotated: boolean
}

// ---------------------------------------------------------------------------
// MaxRect Bin — ported from Jylänki's MaxRectsBinPack (C++)
// ---------------------------------------------------------------------------

export class MaxRectBin {
  readonly id: number
  readonly binWidth: number
  readonly binHeight: number
  freeRects: FreeRect[]
  usedRects: FreeRect[]

  constructor(id: number, width: number, height: number) {
    this.id = id
    this.binWidth = width
    this.binHeight = height
    this.freeRects = [{ x: 0, y: 0, w: width, h: height }]
    this.usedRects = []
  }

  /**
   * Common interval length between two 1D segments.
   * Used by Contact Point heuristic to measure adjacency.
   * Ported from Jylänki's CommonIntervalLength().
   */
  private commonIntervalLength(s1: number, e1: number, s2: number, e2: number): number {
    if (e1 <= s2 || e2 <= s1) return 0
    return Math.min(e1, e2) - Math.max(s1, s2)
  }

  /**
   * Contact Point score — total edge length touching bin walls or placed rects.
   * Ported from Jylänki's ContactPointScoreNode().
   */
  private contactPointScore(x: number, y: number, w: number, h: number): number {
    let score = 0
    if (x <= 0.001 || x + w >= this.binWidth - 0.001) score += h
    if (y <= 0.001 || y + h >= this.binHeight - 0.001) score += w
    for (const u of this.usedRects) {
      // Vertical adjacency (left/right edges touching)
      if (Math.abs(u.x + u.w - x) < 0.001 || Math.abs(u.x - (x + w)) < 0.001) {
        score += this.commonIntervalLength(u.y, u.y + u.h, y, y + h)
      }
      // Horizontal adjacency (top/bottom edges touching)
      if (Math.abs(u.y + u.h - y) < 0.001 || Math.abs(u.y - (y + h)) < 0.001) {
        score += this.commonIntervalLength(u.x, u.x + u.w, x, x + w)
      }
    }
    return score
  }

  /**
   * Score a rectangle placement using any of the 5 heuristics.
   * Tries both orientations (normal + rotated) and returns the best.
   *
   * Scoring formulas from Jylänki's FindPositionForNewNode* functions:
   * - BSSF: min(leftH, leftV), max(leftH, leftV)
   * - BLSF: max(leftH, leftV), min(leftH, leftV)
   * - BAF:  freeArea - itemArea, min(leftH, leftV)
   * - BL:   freeY + itemH, freeX
   * - CP:   -contactLength, 0
   */
  scoreRect(
    w: number,
    h: number,
    heuristic: HeuristicType,
    allowRotation = true
  ): ScoreResult | null {
    let best: ScoreResult | null = null
    let bestS1 = Infinity
    let bestS2 = Infinity

    const tryFit = (tw: number, th: number, rot: boolean) => {
      for (const r of this.freeRects) {
        if (r.w < tw - 0.001 || r.h < th - 0.001) continue

        let s1: number
        let s2: number
        const leftH = r.w - tw
        const leftV = r.h - th

        switch (heuristic) {
          case "bssf":
            s1 = Math.min(leftH, leftV)
            s2 = Math.max(leftH, leftV)
            break
          case "blsf":
            s1 = Math.max(leftH, leftV)
            s2 = Math.min(leftH, leftV)
            break
          case "baf":
            s1 = r.w * r.h - tw * th
            s2 = Math.min(leftH, leftV)
            break
          case "bl":
            s1 = r.y + th
            s2 = r.x
            break
          case "cp":
            s1 = -this.contactPointScore(r.x, r.y, tw, th)
            s2 = 0
            break
        }

        if (s1 < bestS1 - 0.001 || (Math.abs(s1 - bestS1) < 0.001 && s2 < bestS2 - 0.001)) {
          bestS1 = s1
          bestS2 = s2
          best = {
            x: r.x,
            y: r.y,
            w: tw,
            h: th,
            score1: s1,
            score2: s2,
            rotated: rot,
          }
        }
      }
    }

    tryFit(w, h, false)
    if (allowRotation && Math.abs(w - h) > 0.001) {
      tryFit(h, w, true)
    }

    return best
  }

  /**
   * Place an item and split all overlapping free rects.
   * Ported from Jylänki's SplitFreeNode + PruneFreeList.
   */
  place(x: number, y: number, w: number, h: number): void {
    this.usedRects.push({ x, y, w, h })

    const right = x + w
    const bottom = y + h
    const newRects: FreeRect[] = []

    for (const rr of this.freeRects) {
      const rx = rr.x
      const ry = rr.y
      const rw = rr.w
      const rh = rr.h
      const rRight = rx + rw
      const rBottom = ry + rh

      // SAT — no overlap
      if (
        right <= rx + 0.001 ||
        x >= rRight - 0.001 ||
        bottom <= ry + 0.001 ||
        y >= rBottom - 0.001
      ) {
        newRects.push(rr)
        continue
      }

      // Split into up to 4 maximal remainders
      if (x > rx + 0.001) newRects.push({ x: rx, y: ry, w: x - rx, h: rh })
      if (right < rRight - 0.001) newRects.push({ x: right, y: ry, w: rRight - right, h: rh })
      if (y > ry + 0.001) newRects.push({ x: rx, y: ry, w: rw, h: y - ry })
      if (bottom < rBottom - 0.001) newRects.push({ x: rx, y: bottom, w: rw, h: rBottom - bottom })
    }

    // Prune: remove tiny rects and those fully contained by another
    const valid = newRects.filter((r) => r.w >= 0.25 && r.h >= 0.25)
    valid.sort((a, b) => b.w * b.h - a.w * a.h)
    const pruned: FreeRect[] = []
    for (const rect of valid) {
      const contained = pruned.some(
        (j) =>
          rect.x >= j.x - 0.001 &&
          rect.y >= j.y - 0.001 &&
          rect.x + rect.w <= j.x + j.w + 0.001 &&
          rect.y + rect.h <= j.y + j.h + 0.001
      )
      if (!contained) pruned.push(rect)
    }
    this.freeRects = pruned
  }
}

// ---------------------------------------------------------------------------
// Batch insertion — ported from Jylänki's Insert() + rectpack's PackerGlobal
// ---------------------------------------------------------------------------

/**
 * Fill a single bin by repeatedly picking the best-fitting remaining item.
 * This is the key insight from both Jylänki (batch Insert) and rectpack
 * (PackerGlobal): instead of processing items in a fixed sort order,
 * evaluate ALL remaining items at each step and pick the globally best
 * (item, position) pair. O(n²×F) but dramatically better packing.
 */
export function batchFillBin(
  bin: MaxRectBin,
  items: PackableItem[],
  remaining: Set<number>,
  heuristic: HeuristicType
): Placement[] {
  const placements: Placement[] = []

  while (remaining.size > 0) {
    let bestIdx = -1
    let bestResult: ScoreResult | null = null
    let bestS1 = Infinity
    let bestS2 = Infinity

    for (const idx of remaining) {
      const item = items[idx]
      const rs = item.item.renderShape
      const allowRot = rs !== "trapezoid" && rs !== "sector"
      const result = bin.scoreRect(item.w, item.h, heuristic, allowRot)
      if (
        result &&
        (result.score1 < bestS1 - 0.001 ||
          (Math.abs(result.score1 - bestS1) < 0.001 && result.score2 < bestS2 - 0.001))
      ) {
        bestS1 = result.score1
        bestS2 = result.score2
        bestIdx = idx
        bestResult = result
      }
    }

    if (bestIdx < 0 || !bestResult) break

    bin.place(bestResult.x, bestResult.y, bestResult.w, bestResult.h)
    placements.push({
      binIndex: bin.id,
      x: bestResult.x,
      y: bestResult.y,
      w: bestResult.w,
      h: bestResult.h,
      rotated: bestResult.rotated,
      itemIndex: items[bestIdx].index,
    })
    remaining.delete(bestIdx)
  }

  return placements
}

// globalBatchPack, globalGreedyPack, exhaustiveRotationSearch,
// buildSheetFromPlacements, and globalMultiSheetPack live in
// nesting-global-packer-entry.ts to stay under the max-lines limit.
