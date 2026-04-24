// Single-angle NFP packing — called by nfp-greedy-placer.ts to try one
// rotation of the base polygon and produce a candidate placement set.

import ClipperLib from "clipper-lib"
import type { Point2D } from "./types"
import { convexHull, convexPolygonsOverlap } from "./convex-hull"
import Part from "./vendor/fit/part"
import Bin from "./vendor/fit/bin"
import Vector from "./vendor/fit/vector"
import {
  minkowskiDifference,
  noFitRectanglePolygon,
  offsetPolygon,
  clipperScale,
  clipperThreshold,
  toClipperCoordinates,
  toNestCoordinates,
} from "./vendor/fit/util"

export interface GreedyPlacement {
  x: number
  y: number
  rotation: number
  placedPolygon: Point2D[]
  width: number
  height: number
}

export interface PartPartNfpCache {
  /** Minkowski(A_0, A_0) with the angle-0 first-point offset stripped off */
  corePolygons: Point2D[][]
  /** First point of the angle-0 normalized (offset-applied) part */
  basePartFirst: Point2D
}

function pointsToVectors(points: ReadonlyArray<Point2D>): Vector[] {
  return points.map((p) => new Vector(p.x, p.y))
}

function rotatePoints(points: ReadonlyArray<Point2D>, angle: number): Point2D[] {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return points.map((p) => ({
    x: p.x * cos - p.y * sin,
    y: p.x * sin + p.y * cos,
  }))
}

function normalizeToOrigin(points: Point2D[]): { points: Point2D[] } {
  let minX = Infinity
  let minY = Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
  }
  return { points: points.map((p) => ({ x: p.x - minX, y: p.y - minY })) }
}

function getBounds(points: ReadonlyArray<Point2D>): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

/**
 * Build the part-part NFP cache once for a given polygon + spacing.
 * Shared by the sync and async placers so workers don't redo Minkowski per angle.
 */
export function buildPartPartNfpCache(
  hullPoints: ReadonlyArray<Point2D>,
  spacing: number
): PartPartNfpCache | null {
  const baseHullNorm = normalizeToOrigin(rotatePoints(hullPoints, 0)).points
  let basePart = new Part("shape", pointsToVectors(baseHullNorm))
  if (spacing > 0) basePart = offsetPolygon(basePart, spacing) as Part
  const baseNfp = minkowskiDifference(basePart, basePart)
  if (baseNfp.length === 0) return null
  const basePartFirst = { x: basePart.points[0].x, y: basePart.points[0].y }
  return {
    corePolygons: baseNfp.map((poly) =>
      poly.points.map((pt) => ({ x: pt.x - basePartFirst.x, y: pt.y - basePartFirst.y }))
    ),
    basePartFirst,
  }
}

// eslint-disable-next-line complexity -- NFP placement algorithm with nested Clipper operations
export function packWithRotation(
  originalPoints: ReadonlyArray<Point2D>,
  hullPoints: ReadonlyArray<Point2D>,
  binWidth: number,
  binHeight: number,
  qty: number,
  spacing: number,
  rotation: number,
  partPartNfpCache: PartPartNfpCache
): GreedyPlacement[] | null {
  const rotated = rotatePoints(hullPoints, rotation)
  const norm = normalizeToOrigin(rotated)
  const hull = norm.points

  const rotatedOriginal = rotatePoints(originalPoints, rotation)
  const normOrig = normalizeToOrigin(rotatedOriginal)
  const origPoly = normOrig.points

  const origHull = convexHull(origPoly)
  const placedHulls: Point2D[][] = []

  const partVectors = pointsToVectors(hull)
  let part = new Part("shape", partVectors)
  const bin = new Bin("bin", binWidth, binHeight)

  if (spacing > 0) {
    part = offsetPolygon(part, spacing) as Part
  }

  // Bin NFP must be recomputed per angle (bin is axis-aligned, part rotates)
  const binNfp = noFitRectanglePolygon(bin, part)
  if (!binNfp) return null
  const clipperBinNfp = [toClipperCoordinates(binNfp.points)]

  // Part-part NFP via rotation equivariance of Minkowski for identical shapes.
  const cosR = Math.cos(rotation)
  const sinR = Math.sin(rotation)
  const partFirst = part.points[0]
  const partPartNfp = partPartNfpCache.corePolygons.map((core) => ({
    points: core.map(
      (pt) =>
        new Vector(pt.x * cosR - pt.y * sinR + partFirst.x, pt.x * sinR + pt.y * cosR + partFirst.y)
    ),
  }))
  if (partPartNfp.length === 0) return null

  const placements: GreedyPlacement[] = []
  // Incremental NFP union: instead of rebuilding from all j < i placements
  // each iteration (O(qty²) Clipper paths), keep a running union and add
  // only the most-recently-placed shape's NFPs each time (O(qty)).
  let runningNfpUnion = new ClipperLib.Paths()

  for (let i = 0; i < qty; i++) {
    if (i === 0) {
      let bestX = Infinity
      let bestY = Infinity
      for (const pt of binNfp.points) {
        const px = pt.x - part.points[0].x
        const py = pt.y - part.points[0].y
        if (px < bestX || (Math.abs(px - bestX) < 0.001 && py < bestY)) {
          bestX = px
          bestY = py
        }
      }

      const placedPoly = origPoly.map((p) => ({ x: p.x + bestX, y: p.y + bestY }))
      placedHulls.push(origHull.map((p) => ({ x: p.x + bestX, y: p.y + bestY })))
      const bb = getBounds(placedPoly)
      placements.push({
        x: bestX,
        y: bestY,
        rotation,
        placedPolygon: placedPoly,
        width: bb.maxX - bb.minX,
        height: bb.maxY - bb.minY,
      })
      continue
    }

    // Incrementally union only the latest placement's NFPs onto the running result
    const clipper = new ClipperLib.Clipper()
    if (runningNfpUnion.length > 0) {
      clipper.AddPaths(runningNfpUnion, ClipperLib.PolyType.ptSubject, true)
    }
    const lastPlaced = placements[i - 1]
    for (const nfp of partPartNfp) {
      let clone = toClipperCoordinates(nfp.points)
      for (let m = 0; m < clone.length; m++) {
        clone[m].X += Math.round(lastPlaced.x * clipperScale)
        clone[m].Y += Math.round(lastPlaced.y * clipperScale)
      }
      clone = ClipperLib.Clipper.CleanPolygon(clone, clipperThreshold)
      const area = Math.abs(ClipperLib.Clipper.Area(clone))
      if (clone.length > 2 && area > 0.1 * clipperScale * clipperScale) {
        clipper.AddPath(clone, ClipperLib.PolyType.ptSubject, true)
      }
    }

    const combinedNfp = new ClipperLib.Paths()
    if (
      !clipper.Execute(
        ClipperLib.ClipType.ctUnion,
        combinedNfp,
        ClipperLib.PolyFillType.pftNonZero,
        ClipperLib.PolyFillType.pftNonZero
      )
    ) {
      break
    }
    runningNfpUnion = combinedNfp

    const finalNfp = new ClipperLib.Paths()
    const clipper2 = new ClipperLib.Clipper()
    clipper2.AddPaths(combinedNfp, ClipperLib.PolyType.ptClip, true)
    clipper2.AddPaths(clipperBinNfp, ClipperLib.PolyType.ptSubject, true)
    if (
      !clipper2.Execute(
        ClipperLib.ClipType.ctDifference,
        finalNfp,
        ClipperLib.PolyFillType.pftNonZero,
        ClipperLib.PolyFillType.pftNonZero
      )
    ) {
      break
    }

    const cleanedNfp = ClipperLib.Clipper.CleanPolygons(finalNfp, clipperThreshold)

    const candidates: Array<{ x: number; y: number }> = []
    for (const path of cleanedNfp) {
      const area = Math.abs(ClipperLib.Clipper.Area(path))
      if (path.length < 3 || area < 0.1 * clipperScale * clipperScale) continue
      const points = toNestCoordinates(path)
      for (const pt of points) {
        candidates.push({
          x: pt.x - part.points[0].x,
          y: pt.y - part.points[0].y,
        })
      }
    }

    candidates.sort((a, b) => a.x - b.x || a.y - b.y)

    let bestX: number | null = null
    let bestY: number | null = null
    for (const cand of candidates) {
      const candidateHull = origHull.map((p) => ({ x: p.x + cand.x, y: p.y + cand.y }))
      let overlaps = false
      for (const prevHull of placedHulls) {
        if (convexPolygonsOverlap(candidateHull, prevHull)) {
          overlaps = true
          break
        }
      }
      if (!overlaps) {
        bestX = cand.x
        bestY = cand.y
        break
      }
    }

    if (bestX === null || bestY === null) break

    const finalX = bestX
    const finalY = bestY
    const placedPoly = origPoly.map((p) => ({ x: p.x + finalX, y: p.y + finalY }))
    placedHulls.push(origHull.map((p) => ({ x: p.x + finalX, y: p.y + finalY })))
    const bb = getBounds(placedPoly)
    placements.push({
      x: finalX,
      y: finalY,
      rotation,
      placedPolygon: placedPoly,
      width: bb.maxX - bb.minX,
      height: bb.maxY - bb.minY,
    })
  }

  return placements.length > 0 ? placements : null
}
