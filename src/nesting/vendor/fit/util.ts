import ClipperLib from "clipper-lib"
import Vector from "./vector"
import IndexedVector from "./indexed-vector"
import Polygon from "./polygon"
import type Part from "./part"

export {
  approximately,
  bounds,
  onSegment,
  pointInPolygon,
  pointDistance,
  segmentDistance,
  polygonSlideDistance,
  polygonProjectionDistance,
  lineIntersect,
  intersect,
} from "./util-geometry"

import {
  approximately,
  onSegment,
  pointInPolygon,
  polygonSlideDistance,
  polygonProjectionDistance,
  intersect,
} from "./util-geometry"

const clipperScale = 1e7
const clipperThreshold = 0.0001 * clipperScale

function toClipperCoordinates(points: Vector[]): Array<{ X: number; Y: number }> {
  return points.map((p) => ({ X: p.x * clipperScale, Y: p.y * clipperScale }))
}

function toNestCoordinates(path: Array<{ X: number; Y: number }>): Vector[] {
  return path.map((p) => new Vector(p.X / clipperScale, p.Y / clipperScale))
}

function inNfp(p: Vector, nfp: Polygon[]): boolean {
  if (!nfp || nfp.length === 0) return false
  for (let i = 0; i < nfp.length; i++) {
    for (let j = 0; j < nfp[i].points.length; j++) {
      if (p.approximately(nfp[i].points[j])) return true
    }
  }
  return false
}

// eslint-disable-next-line complexity -- vendor algorithm
function searchStartPoint(A: Part, B: Part, inside: boolean, NFP?: Polygon[]): Vector | null {
  const AP = A.points.slice(0)
  const BP = B.points.slice(0)
  if (!AP[0].approximately(AP[AP.length - 1])) AP.push(AP[0])
  if (!BP[0].approximately(BP[BP.length - 1])) BP.push(BP[0])

  for (let i = 0; i < AP.length - 1; i++) {
    if (!AP[i].marked) {
      AP[i].mark()
      for (let j = 0; j < BP.length; j++) {
        B.offset.set(AP[i].sub(BP[j]))
        let Binside: boolean | null = null
        for (let k = 0; k < BP.length; k++) {
          const inpoly = pointInPolygon(BP[k].add(B.offset), A)
          if (inpoly !== null) {
            Binside = inpoly
            break
          }
        }
        if (Binside === null) return null

        let startPoint = B.offset.clone()
        if (
          ((Binside && inside) || (!Binside && !inside)) &&
          !intersect(A, B) &&
          !inNfp(startPoint, NFP ?? [])
        ) {
          return startPoint
        }

        const v = AP[i + 1].sub(AP[i])
        const d1 = polygonProjectionDistance(A, B, v)
        const d2 = polygonProjectionDistance(B, A, v.negative())
        let d: number | null = null
        if (d1 === null && d2 === null) {
          // nothing
        } else if (d1 === null) {
          d = d2
        } else if (d2 === null) {
          d = d1
        } else {
          d = Math.min(d1, d2)
        }
        if (d === null || approximately(d, 0) || d <= 0) continue

        const vd2 = v.squaredLength()
        let vScaled = v
        if (d * d < vd2 && !approximately(d * d, vd2)) {
          const vd = Math.sqrt(vd2)
          vScaled = v.multiplyScalar(d / vd)
        }
        B.offset = B.offset.add(vScaled)

        for (let k = 0; k < BP.length; k++) {
          const inpoly = pointInPolygon(BP[k].add(B.offset), A)
          if (inpoly !== null) {
            Binside = inpoly
            break
          }
        }

        startPoint = B.offset.clone()
        if (
          ((Binside && inside) || (!Binside && !inside)) &&
          !intersect(A, B) &&
          !inNfp(startPoint, NFP ?? [])
        ) {
          return startPoint
        }
      }
    }
  }
  return null
}

function noFitRectanglePolygon(A: Part, B: Part): Polygon | null {
  const abb = A.bounds()
  const bbb = B.bounds()
  if (
    bbb.max.x - bbb.min.x > abb.max.x - abb.min.x ||
    bbb.max.y - bbb.min.y > abb.max.y - abb.min.y
  ) {
    return null
  }
  const p0 = new Vector(abb.min.x - bbb.min.x, abb.min.y - bbb.min.y)
  const p1 = new Vector(abb.max.x - bbb.max.x, abb.min.y - bbb.min.y)
  const p2 = new Vector(abb.max.x - bbb.max.x, abb.max.y - bbb.max.y)
  const p3 = new Vector(abb.min.x - bbb.min.x, abb.max.y - bbb.max.y)
  return new Polygon([
    B.points[0].add(p0),
    B.points[0].add(p1),
    B.points[0].add(p2),
    B.points[0].add(p3),
  ])
}

// eslint-disable-next-line complexity -- vendor algorithm
function noFitPolygon(A: Part, B: Part, inside = false, edges = false): Polygon[] {
  let minA = A.points[0].y
  let minAindex = 0
  let maxB = B.points[0].y
  let maxBindex = 0
  const la = A.points.length
  const lb = B.points.length

  for (let i = 1; i < la; i++) {
    A.points[i].unmark()
    if (A.points[i].y < minA) {
      minA = A.points[i].y
      minAindex = i
    }
  }
  for (let i = 1; i < lb; i++) {
    B.points[i].unmark()
    if (B.points[i].y > maxB) {
      maxB = B.points[i].y
      maxBindex = i
    }
  }

  let startPoint: Vector | null = null
  if (!inside) {
    startPoint = A.points[minAindex].sub(B.points[maxBindex])
  } else {
    startPoint = searchStartPoint(A.clone() as Part, B.clone() as Part, true)
  }

  const result: Polygon[] = []

  while (startPoint !== null) {
    B.offset.set(startPoint)
    let prevVector: Vector | null = null
    let reference = B.points[0].add(B.offset)
    const NFP: Vector[] = [reference.clone()]
    const start = reference.clone()
    let iterations = 0
    const limit = 10 * (la + lb)

    while (iterations++ < limit) {
      const touching: Array<{ type: number; A: number; B: number }> = []

      for (let i = 0; i < la; i++) {
        const nexti = i === la - 1 ? 0 : i + 1
        for (let j = 0; j < lb; j++) {
          const nextj = j === lb - 1 ? 0 : j + 1
          const bj = B.points[j].add(B.offset)
          if (A.points[i].approximately(bj)) {
            touching.push({ type: 0, A: i, B: j })
          } else if (onSegment(A.points[i], A.points[nexti], bj)) {
            touching.push({ type: 1, A: nexti, B: j })
          } else if (onSegment(bj, B.points[nextj].add(B.offset), A.points[i])) {
            touching.push({ type: 2, A: i, B: nextj })
          }
        }
      }

      const vectors: IndexedVector[] = []
      for (let i = 0; i < touching.length; i++) {
        const vertexA = A.points[touching[i].A]
        vertexA.mark()
        let prevAindex = touching[i].A - 1
        let nextAindex = touching[i].A + 1
        prevAindex = prevAindex < 0 ? la - 1 : prevAindex
        nextAindex = nextAindex >= la ? 0 : nextAindex
        const prevA = A.points[prevAindex]
        const nextA = A.points[nextAindex]
        const vertexB = B.points[touching[i].B]
        let prevBindex = touching[i].B - 1
        let nextBindex = touching[i].B + 1
        prevBindex = prevBindex < 0 ? lb - 1 : prevBindex
        nextBindex = nextBindex >= lb ? 0 : nextBindex
        const prevB = B.points[prevBindex]
        const nextB = B.points[nextBindex]

        switch (touching[i].type) {
          case 0: {
            vectors.push(
              new IndexedVector(prevA.sub(vertexA).x, prevA.sub(vertexA).y, vertexA, prevA)
            )
            vectors.push(
              new IndexedVector(nextA.sub(vertexA).x, nextA.sub(vertexA).y, vertexA, nextA)
            )
            vectors.push(
              new IndexedVector(vertexB.sub(prevB).x, vertexB.sub(prevB).y, prevB, vertexB)
            )
            vectors.push(
              new IndexedVector(vertexB.sub(nextB).x, vertexB.sub(nextB).y, nextB, vertexB)
            )
            break
          }
          case 1: {
            const vb = vertexB.add(B.offset)
            const va1 = vertexA.sub(vb)
            const va2 = prevA.sub(vb)
            vectors.push(new IndexedVector(va1.x, va1.y, prevA, vertexA))
            vectors.push(new IndexedVector(va2.x, va2.y, vertexA, prevA))
            break
          }
          case 2: {
            const va1 = A.points[touching[i].A].sub(vertexB.add(B.offset))
            const va2 = A.points[touching[i].A].sub(prevB.add(B.offset))
            vectors.push(new IndexedVector(va1.x, va1.y, prevB, vertexB))
            vectors.push(new IndexedVector(va2.x, va2.y, vertexB, prevB))
            break
          }
        }
      }

      let translate: IndexedVector | null = null
      let maxd = 0

      for (let i = 0; i < vectors.length; i++) {
        if (vectors[i].x === 0 && vectors[i].y === 0) continue
        if (prevVector && vectors[i].dot(prevVector) < 0) {
          const unitVector = vectors[i].normalize()
          const prevUnitVector = prevVector.normalize()
          if (Math.abs(unitVector.cross(prevUnitVector)) < 1e-8) continue
        }
        let d = polygonSlideDistance(A, B, vectors[i], true)
        const vecd2 = vectors[i].squaredLength()
        if (d === null || d * d > vecd2) d = Math.sqrt(vecd2)
        if (d !== null && d > maxd) {
          maxd = d
          translate = vectors[i]
        }
      }

      if (translate === null || approximately(maxd, 0)) break

      translate.start.mark()
      translate.end.mark()

      const vlength2 = translate.squaredLength()
      const maxd2 = maxd * maxd
      let finalTranslate: Vector = translate
      if (maxd2 < vlength2 && !approximately(maxd2, vlength2)) {
        const scale = Math.sqrt(maxd2 / vlength2)
        finalTranslate = translate.multiplyScalar(scale)
      }

      prevVector = translate.clone()
      reference = reference.add(finalTranslate)

      if (reference.approximately(start)) break

      let looped = false
      for (let i = 0; i < NFP.length - 1; i++) {
        if (reference.approximately(NFP[i])) {
          looped = true
          break
        }
      }
      if (looped) break

      NFP.push(reference.clone())
      B.offset = B.offset.add(finalTranslate)
    }

    if (NFP.length > 0) {
      result.push(new Polygon(NFP))
    }

    if (!edges) break
    startPoint = searchStartPoint(A.clone() as Part, B.clone() as Part, inside, result)
  }

  return result
}

function minkowskiDifference(A: Part, B: Part): Polygon[] {
  const Ac = toClipperCoordinates(A.points)
  const Bc = toClipperCoordinates(B.points)
  for (let i = 0; i < Bc.length; i++) {
    Bc[i].X *= -1
    Bc[i].Y *= -1
  }
  const solution = ClipperLib.Clipper.MinkowskiSum(Ac, Bc, true)
  let minArea = Number.MAX_VALUE
  let minPolygon: Polygon | undefined
  for (let i = 0; i < solution.length; i++) {
    const points = toNestCoordinates(solution[i])
    const polygon = new Polygon(points)
    const area = polygon.area()
    if (area < minArea) {
      minArea = area
      minPolygon = polygon
    }
  }
  const offset = B.points[0]
  return [minPolygon!.translate(offset.x, offset.y)]
}

function offsetPolygon(
  polygon: Part,
  offset: number,
  miterLimit = 2.5,
  curveTolerance = 1.0
): Part {
  if (approximately(offset, 0)) return polygon
  const clipper = new ClipperLib.ClipperOffset(miterLimit, curveTolerance * clipperScale)
  const path = toClipperCoordinates(polygon.points)
  clipper.AddPath(path, ClipperLib.JoinType.jtSquare, ClipperLib.EndType.etClosedPolygon)
  const paths = new ClipperLib.Paths()
  clipper.Execute(paths, offset * clipperScale)
  const cloned = polygon.clone() as Part
  cloned.points = toNestCoordinates(paths[0])
  return cloned
}

function createUniqueKey(A: Part, B: Part, inside: boolean): string {
  return JSON.stringify({
    A: A.toString(),
    B: B.toString(),
    inside,
  })
}

export {
  clipperScale,
  clipperThreshold,
  toClipperCoordinates,
  toNestCoordinates,
  noFitRectanglePolygon,
  noFitPolygon,
  minkowskiDifference,
  offsetPolygon,
  createUniqueKey,
}
