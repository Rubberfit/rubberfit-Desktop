// Greedy bottom-left NFP placer for identical shape packing
//
// Per-angle placement lives in ./nfp-pack-rotation (shared with the angle worker).
// This file orchestrates the coarse/fine/ultra-fine rotation search and post-processing.

import type { Point2D, Polygon2D } from "./types"
import { convexHull, convexPolygonsOverlap, polygonArea } from "./convex-hull"
import {
  packWithRotation,
  buildPartPartNfpCache,
  type GreedyPlacement,
  type PartPartNfpCache,
} from "./nfp-pack-rotation"
import { getAngleWorkerPool } from "./worker-pool"

export type { GreedyPlacement, PartPartNfpCache }

export interface GreedyPackResult {
  placements: GreedyPlacement[]
  placed: number
  overflow: number
  usedArea: number
  occupiedWidth: number
  occupiedHeight: number
}

/** Compare two packing results: prefer more placements, then tighter bounding box */
function isBetterResult(candidate: GreedyPlacement[], best: GreedyPlacement[]): boolean {
  if (candidate.length > best.length) return true
  if (candidate.length === best.length && best.length > 0) {
    const currentBB = getBoundsFromPlacements(best)
    const newBB = getBoundsFromPlacements(candidate)
    return newBB.area < currentBB.area
  }
  return false
}

/** Default coarse step count — 36 angles = every 10° (fine pass covers gaps) */
const DEFAULT_COARSE_STEPS = 36
/** How many top coarse results to refine */
const FINE_TOP_K = 2
/** Fine pass: ±5° at 1° increments around each top-K seed */
const FINE_RANGE_DEG = 5
const FINE_STEP_DEG = 1
/** Ultra-fine pass: ±1° at 0.25° around the overall best */
const ULTRA_RANGE_DEG = 1
const ULTRA_STEP_DEG = 0.25

const DEG_TO_RAD = Math.PI / 180

/**
 * Remove overlapping placements via convex hull SAT validation.
 */
function removeOverlaps(placements: GreedyPlacement[]): GreedyPlacement[] {
  if (placements.length <= 1) return placements
  const accepted: GreedyPlacement[] = []
  const acceptedHulls: Point2D[][] = []
  for (const p of placements) {
    const hull = convexHull(p.placedPolygon)
    let overlaps = false
    for (const prevHull of acceptedHulls) {
      if (convexPolygonsOverlap(hull, prevHull)) {
        overlaps = true
        break
      }
    }
    if (!overlaps) {
      accepted.push(p)
      acceptedHulls.push(hull)
    }
  }
  return accepted
}

function emptyResult(qty: number): GreedyPackResult {
  return {
    placements: [],
    placed: 0,
    overflow: qty,
    usedArea: 0,
    occupiedWidth: 0,
    occupiedHeight: 0,
  }
}

function finalizeResult(
  placements: GreedyPlacement[],
  qty: number,
  shapeArea: number
): GreedyPackResult {
  const cleaned = removeOverlaps(placements)
  const placed = cleaned.length
  const bb = getBoundsFromPlacements(cleaned)
  return {
    placements: cleaned,
    placed,
    overflow: Math.max(0, qty - placed),
    usedArea: shapeArea * placed,
    occupiedWidth: bb.width,
    occupiedHeight: bb.height,
  }
}

function pickBestCoarse(coarseResults: Array<{ angle: number; placements: GreedyPlacement[] }>): {
  placements: GreedyPlacement[]
  angle: number
} {
  coarseResults.sort((a, b) => {
    if (a.placements.length !== b.placements.length)
      return b.placements.length - a.placements.length
    return getBoundsFromPlacements(a.placements).area - getBoundsFromPlacements(b.placements).area
  })
  return { placements: coarseResults[0].placements, angle: coarseResults[0].angle }
}

function refineSync(
  tryAngle: (angle: number) => GreedyPlacement[] | null,
  seeds: Array<{ angle: number; placements: GreedyPlacement[] }>,
  qty: number
): GreedyPlacement[] {
  let best = seeds[0].placements
  let bestAngle = seeds[0].angle
  if (best.length >= qty) return best

  // Fine pass: ±5° at 1° around top-K seeds
  const topK = seeds.slice(0, FINE_TOP_K)
  for (const seed of topK) {
    for (let delta = -FINE_RANGE_DEG; delta <= FINE_RANGE_DEG; delta += FINE_STEP_DEG) {
      if (delta === 0) continue
      const angle = seed.angle + delta * DEG_TO_RAD
      const result = tryAngle(angle)
      if (result && isBetterResult(result, best)) {
        best = result
        bestAngle = angle
      }
    }
  }

  // Ultra-fine pass: ±1° at 0.25° around the overall best
  if (best.length < qty) {
    for (let delta = -ULTRA_RANGE_DEG; delta <= ULTRA_RANGE_DEG; delta += ULTRA_STEP_DEG) {
      if (Math.abs(delta) < 0.01) continue
      const angle = bestAngle + delta * DEG_TO_RAD
      const result = tryAngle(angle)
      if (result && isBetterResult(result, best)) {
        best = result
      }
    }
  }

  return best
}

/**
 * Pack qty copies of a polygon on the main thread.
 */
export function greedyNfpPack(
  polygon: Polygon2D,
  binWidth: number,
  binHeight: number,
  qty: number,
  spacing = 0,
  rotationSteps = DEFAULT_COARSE_STEPS
): GreedyPackResult {
  const hull = convexHull(polygon.points)
  const shapeArea = polygonArea(polygon.points)

  const partPartNfpCache = buildPartPartNfpCache(hull, spacing)
  if (!partPartNfpCache) return emptyResult(qty)

  const startTime = Date.now()
  const tryAngle = (angle: number): GreedyPlacement[] | null =>
    packWithRotation(
      polygon.points,
      hull,
      binWidth,
      binHeight,
      qty,
      spacing,
      angle,
      partPartNfpCache
    )

  // OPTIMIZATION: THIS IS WHERE THE LONGEST CALCULATIONS TAKE PLACE
  const coarseResults: Array<{ angle: number; placements: GreedyPlacement[] }> = []
  for (let step = 0; step < rotationSteps; step++) {
    const angle = (step / rotationSteps) * Math.PI * 2
    const result = tryAngle(angle)
    if (result && result.length > 0) {
      coarseResults.push({ angle, placements: result })
    }
  }
  const endTime = Date.now()
  console.log(`Time take: ${endTime - startTime} ms`)
  if (coarseResults.length === 0) return emptyResult(qty)

  // pickBestCoarse sorts coarseResults in place (most placements → tightest bb)
  pickBestCoarse(coarseResults)
  const best = refineSync(tryAngle, coarseResults, qty)
  return finalizeResult(best, qty, shapeArea)
}

/**
 * Async variant that fans the coarse-angle pass across a Web Worker pool.
 * Falls back to the sync path if the worker pool is unavailable (e.g., bundling failure).
 */
export async function greedyNfpPackAsync(
  polygon: Polygon2D,
  binWidth: number,
  binHeight: number,
  qty: number,
  spacing = 0,
  rotationSteps = DEFAULT_COARSE_STEPS
): Promise<GreedyPackResult> {
  const pool = getAngleWorkerPool()
  if (!pool.isAvailable()) {
    return greedyNfpPack(polygon, binWidth, binHeight, qty, spacing, rotationSteps)
  }

  const hull = convexHull(polygon.points)
  const shapeArea = polygonArea(polygon.points)

  const partPartNfpCache = buildPartPartNfpCache(hull, spacing)
  if (!partPartNfpCache) return emptyResult(qty)

  const angles: number[] = []
  for (let step = 0; step < rotationSteps; step++) {
    angles.push((step / rotationSteps) * Math.PI * 2)
  }

  const startTime = Date.now()
  const workerResults = await pool.runAngleBatch({
    originalPoints: polygon.points,
    hullPoints: hull,
    binWidth,
    binHeight,
    qty,
    spacing,
    partPartNfpCache,
    angles,
  })
  const endTime = Date.now()
  console.log(`Time take (async): ${endTime - startTime} ms`)

  const coarseResults: Array<{ angle: number; placements: GreedyPlacement[] }> = []
  for (let i = 0; i < workerResults.length; i++) {
    const placements = workerResults[i]
    if (placements && placements.length > 0) {
      coarseResults.push({ angle: angles[i], placements })
    }
  }
  if (coarseResults.length === 0) return emptyResult(qty)

  // Fine/ultra-fine refinement stays on the main thread (few iterations,
  // depends on the best seed so fanning it out has little upside).
  const { placements: bestSeed, angle: seedAngle } = pickBestCoarse(coarseResults)
  const seeds = coarseResults.slice()
  seeds.sort((a, b) => b.placements.length - a.placements.length)
  const tryAngle = (angle: number): GreedyPlacement[] | null =>
    packWithRotation(
      polygon.points,
      hull,
      binWidth,
      binHeight,
      qty,
      spacing,
      angle,
      partPartNfpCache
    )
  const best = refineSync(
    tryAngle,
    [{ angle: seedAngle, placements: bestSeed }, ...seeds.slice(1)],
    qty
  )
  return finalizeResult(best, qty, shapeArea)
}

function getBoundsFromPlacements(placements: GreedyPlacement[]): {
  width: number
  height: number
  area: number
} {
  if (placements.length === 0) return { width: 0, height: 0, area: 0 }
  let maxX = 0
  let maxY = 0
  for (const p of placements) {
    for (const pt of p.placedPolygon) {
      if (pt.x > maxX) maxX = pt.x
      if (pt.y > maxY) maxY = pt.y
    }
  }
  return { width: maxX, height: maxY, area: maxX * maxY }
}
