import ClipperLib from "clipper-lib"
import {
  approximately,
  bounds,
  createUniqueKey,
  toClipperCoordinates,
  toNestCoordinates,
  clipperScale,
  clipperThreshold,
} from "./util"
import Polygon from "./polygon"
import type Part from "./part"
import type Bin from "./bin"
import Vector from "./vector"
import Placement from "./placement"

export interface PlaceResult {
  placements: Placement[]
  cost: number
  unplaced: Part[]
}

// eslint-disable-next-line complexity -- vendor algorithm
export function place(
  bins: Bin[],
  parts: Part[],
  nfpCache: Record<string, Polygon[]>
): PlaceResult {
  // Rotate parts by their assigned rotation
  const rotatedParts = parts.map((part) => part.rotate(part.rotation) as Part)
  const remainingParts = rotatedParts.slice()

  let allPlacements: Placement[] = []
  let cost = 0

  for (let idx = 0; idx < bins.length; idx++) {
    const placed: Part[] = []
    const placements: Placement[] = []
    const bin = bins[idx]
    const binArea = Math.abs(bin.area())

    cost += 1 // cost for each new bin opened

    let minWidth: number | null = null

    for (let i = 0; i < remainingParts.length; i++) {
      const part = remainingParts[i]

      // Inner NFP (bin vs part)
      const key = createUniqueKey(bin, part, false)
      const binNfp = nfpCache[key]

      if (!binNfp || binNfp.length <= 0) continue

      // Ensure all necessary NFPs exist
      const error = placed.find((p) => !nfpCache[createUniqueKey(p, part, false)]) !== undefined
      if (error) continue

      // First placement — put it on the left
      if (placed.length <= 0) {
        let newPlacement: Placement | null = null
        for (let j = 0; j < binNfp.length; j++) {
          for (let k = 0; k < binNfp[j].points.length; k++) {
            const point = Vector.fromJSON(binNfp[j].points[k])
            if (newPlacement === null || point.x - part.points[0].x < newPlacement.position.x) {
              newPlacement = new Placement(
                bin.id,
                part.id,
                point.sub(part.points[0]),
                part.rotation
              )
            }
          }
        }
        if (newPlacement) {
          placements.push(newPlacement)
          placed.push(part)
        }
        continue
      }

      const clipperBinNfp: Array<Array<{ X: number; Y: number }>> = []
      for (let j = 0; j < binNfp.length; j++) {
        clipperBinNfp.push(toClipperCoordinates(binNfp[j].points))
      }

      const clipper = new ClipperLib.Clipper()

      for (let j = 0; j < placed.length; j++) {
        const nfpKey = createUniqueKey(placed[j], part, false)
        const nfp = nfpCache[nfpKey]
        if (!nfp) continue

        for (let k = 0; k < nfp.length; k++) {
          let clone = toClipperCoordinates(nfp[k].points)
          for (let m = 0; m < clone.length; m++) {
            clone[m].X += placements[j].position.x * clipperScale
            clone[m].Y += placements[j].position.y * clipperScale
          }
          clone = ClipperLib.Clipper.CleanPolygon(clone, clipperThreshold)
          const area = Math.abs(ClipperLib.Clipper.Area(clone))
          if (clone.length > 2 && area > 0.1 * clipperScale * clipperScale) {
            clipper.AddPath(clone, ClipperLib.PolyType.ptSubject, true)
          }
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
        continue
      }

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
        continue
      }

      const cleanedNfp = ClipperLib.Clipper.CleanPolygons(finalNfp, clipperThreshold)

      const validNfp: Array<Array<{ X: number; Y: number }>> = []
      for (let j = 0; j < cleanedNfp.length; j++) {
        const area = Math.abs(ClipperLib.Clipper.Area(cleanedNfp[j]))
        if (cleanedNfp[j].length >= 3 && area >= 0.1 * clipperScale * clipperScale) {
          validNfp.push(cleanedNfp[j])
        }
      }

      if (validNfp.length <= 0) continue

      const candidates = validNfp.map((path) => new Polygon(toNestCoordinates(path)))

      let newPlacement: Placement | null = null
      let minArea: number | null = null
      let minX: number | null = null

      for (let j = 0; j < candidates.length; j++) {
        const polygon = candidates[j]
        if (Math.abs(polygon.area()) < 2) continue

        for (let k = 0; k < polygon.points.length; k++) {
          const allPoints: Vector[] = []

          for (let m = 0; m < placed.length; m++) {
            for (let n2 = 0; n2 < placed[m].points.length; n2++) {
              allPoints.push(placed[m].points[n2].add(placements[m].position))
            }
          }

          const point = polygon.points[k]
          const shiftVector = new Placement(
            bin.id,
            part.id,
            point.sub(part.points[0]),
            part.rotation
          )

          for (let m = 0; m < part.points.length; m++) {
            allPoints.push(part.points[m].add(shiftVector.position))
          }

          const bb = bounds(allPoints)
          const area = bb.width * 2 + bb.height

          if (
            minArea === null ||
            area < minArea ||
            (approximately(minArea, area) && (minX === null || shiftVector.position.x < minX))
          ) {
            newPlacement = shiftVector
            minArea = area
            minWidth = bb.width * bb.height
            minX = shiftVector.position.x
          }
        }
      }

      if (newPlacement !== null) {
        placements.push(newPlacement)
        placed.push(part)
      }
    }

    if (minWidth !== null) {
      cost += minWidth / binArea
    }

    // Remove placed parts from remaining
    for (let i = 0; i < placed.length; i++) {
      const index = remainingParts.indexOf(placed[i])
      if (index >= 0) remainingParts.splice(index, 1)
    }

    if (placements.length > 0) {
      allPlacements = allPlacements.concat(placements)
    }
  }

  cost += 2 * remainingParts.length

  return { placements: allPlacements, cost, unplaced: remainingParts }
}
