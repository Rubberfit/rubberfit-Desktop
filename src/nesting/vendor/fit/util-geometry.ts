import Vector from "./vector"
import BoundingBox from "./bounding-box"
import type Part from "./part"

const TOL = 1e-9

function approximately(a: number, b: number, tolerance = TOL): boolean {
  return Math.abs(a - b) < tolerance
}

function bounds(points: Vector[]): BoundingBox {
  let minX = Number.MAX_VALUE,
    maxX = -Number.MAX_VALUE
  let minY = Number.MAX_VALUE,
    maxY = -Number.MAX_VALUE
  points.forEach((p) => {
    minX = Math.min(p.x, minX)
    minY = Math.min(p.y, minY)
    maxX = Math.max(p.x, maxX)
    maxY = Math.max(p.y, maxY)
  })
  return new BoundingBox(new Vector(minX, minY), new Vector(maxX, maxY))
}

// eslint-disable-next-line complexity -- vendor algorithm
function onSegment(A: Vector, B: Vector, p: Vector): boolean {
  if (approximately(A.x, B.x) && approximately(p.x, A.x)) {
    if (
      !approximately(p.y, B.y) &&
      !approximately(p.y, A.y) &&
      p.y < Math.max(B.y, A.y) &&
      p.y > Math.min(B.y, A.y)
    ) {
      return true
    }
    return false
  }
  if (approximately(A.y, B.y) && approximately(p.y, A.y)) {
    if (
      !approximately(p.x, B.x) &&
      !approximately(p.x, A.x) &&
      p.x < Math.max(B.x, A.x) &&
      p.x > Math.min(B.x, A.x)
    ) {
      return true
    }
    return false
  }
  if (
    (p.x < A.x && p.x < B.x) ||
    (p.x > A.x && p.x > B.x) ||
    (p.y < A.y && p.y < B.y) ||
    (p.y > A.y && p.y > B.y)
  ) {
    return false
  }
  if (
    (approximately(p.x, A.x) && approximately(p.y, A.y)) ||
    (approximately(p.x, B.x) && approximately(p.y, B.y))
  ) {
    return false
  }
  const cross = (p.y - A.y) * (B.x - A.x) - (p.x - A.x) * (B.y - A.y)
  if (Math.abs(cross) > TOL) return false
  const dot = (p.x - A.x) * (B.x - A.x) + (p.y - A.y) * (B.y - A.y)
  if (dot < 0 || approximately(dot, 0)) return false
  const len2 = (B.x - A.x) * (B.x - A.x) + (B.y - A.y) * (B.y - A.y)
  if (dot > len2 || approximately(dot, len2)) return false
  return true
}

function pointInPolygon(point: Vector, polygon: Part): boolean | null {
  if (!polygon || polygon.points.length < 3) return null
  let inside = false
  for (let n = polygon.points.length, i = 0, j = n - 1; i < n; j = i++) {
    const pi = polygon.points[i].add(polygon.offset)
    const pj = polygon.points[j].add(polygon.offset)
    if (pi.approximately(point)) return null
    if (onSegment(pi, pj, point)) return null
    if (pi.approximately(pj)) continue
    const intersected =
      pi.y > point.y !== pj.y > point.y &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x
    if (intersected) inside = !inside
  }
  return inside
}

function pointDistance(
  p: Vector,
  s1: Vector,
  s2: Vector,
  normal: Vector,
  infinite?: boolean
): number | null {
  const norm = normal.normalize()
  const dir = norm.perpendicular()
  const pdot = p.dot(dir)
  const s1dot = s1.dot(dir)
  const s2dot = s2.dot(dir)
  const pdotnorm = p.dot(norm)
  const s1dotnorm = s1.dot(norm)
  const s2dotnorm = s2.dot(norm)

  if (!infinite) {
    if (
      (pdot < s1dot || approximately(pdot, s1dot)) &&
      (pdot < s2dot || approximately(pdot, s2dot))
    ) {
      return null
    }
    if (
      (pdot > s1dot || approximately(pdot, s1dot)) &&
      (pdot > s2dot || approximately(pdot, s2dot))
    ) {
      return null
    }
    if (
      approximately(pdot, s1dot) &&
      approximately(pdot, s2dot) &&
      pdotnorm > s1dotnorm &&
      pdotnorm > s2dotnorm
    ) {
      return Math.min(pdotnorm - s1dotnorm, pdotnorm - s2dotnorm)
    }
    if (
      approximately(pdot, s1dot) &&
      approximately(pdot, s2dot) &&
      pdotnorm < s1dotnorm &&
      pdotnorm < s2dotnorm
    ) {
      return -Math.min(s1dotnorm - pdotnorm, s2dotnorm - pdotnorm)
    }
  }

  return -(pdotnorm - s1dotnorm + ((s1dotnorm - s2dotnorm) * (s1dot - pdot)) / (s1dot - s2dot))
}

// eslint-disable-next-line complexity -- vendor algorithm
function segmentDistance(
  A: Vector,
  B: Vector,
  E: Vector,
  F: Vector,
  direction: Vector
): number | null {
  const normal = direction.perpendicular()
  const dotA = A.dot(normal)
  const dotB = B.dot(normal)
  const dotE = E.dot(normal)
  const dotF = F.dot(normal)
  const crossA = A.cross(direction)
  const crossB = B.cross(direction)
  const ABmin = Math.min(dotA, dotB)
  const ABmax = Math.max(dotA, dotB)
  const EFmax = Math.max(dotE, dotF)
  const EFmin = Math.min(dotE, dotF)

  if (approximately(ABmax, EFmin) || approximately(ABmin, EFmax)) return null
  if (ABmax < EFmin || ABmin > EFmax) return null

  let overlap: number
  if ((ABmax > EFmax && ABmin < EFmin) || (EFmax > ABmax && EFmin < ABmin)) {
    overlap = 1
  } else {
    const minMax = Math.min(ABmax, EFmax)
    const maxMin = Math.max(ABmin, EFmin)
    const maxMax = Math.max(ABmax, EFmax)
    const minMin = Math.min(ABmin, EFmin)
    overlap = (minMax - maxMin) / (maxMax - minMin)
  }

  const ae = E.sub(A)
  const ab = B.sub(A)
  const af = F.sub(A)
  const ef = E.sub(F)
  const crossABE = ae.cross(ab)
  const crossABF = af.cross(ab)

  if (approximately(crossABE, 0) && approximately(crossABF, 0)) {
    const ABnorm = ab.perpendicular().normalize()
    const EFnorm = ef.perpendicular().normalize()
    if (Math.abs(ABnorm.cross(EFnorm)) < TOL && ABnorm.dot(EFnorm) < 0) {
      const normdot = ABnorm.dot(direction)
      if (approximately(normdot, 0)) return null
      if (normdot < 0) return 0
    }
    return null
  }

  const distances: number[] = []
  const reverse = direction.negative()

  if (approximately(dotA, dotE)) {
    distances.push(crossA - E.cross(direction))
  } else if (approximately(dotA, dotF)) {
    distances.push(crossA - F.cross(direction))
  } else if (dotA > EFmin && dotA < EFmax) {
    let d = pointDistance(A, E, F, reverse)
    if (d !== null && approximately(d, 0)) {
      const dB = pointDistance(B, E, F, reverse, true)
      if (dB !== null && (dB < 0 || approximately(dB * overlap, 0))) {
        d = null
      }
    }
    if (d !== null) distances.push(d)
  }

  if (approximately(dotB, dotE)) {
    distances.push(crossB - E.cross(direction))
  } else if (approximately(dotB, dotF)) {
    distances.push(crossB - F.cross(direction))
  } else if (dotB > EFmin && dotB < EFmax) {
    let d = pointDistance(B, E, F, reverse)
    if (d !== null && approximately(d, 0)) {
      const dA = pointDistance(A, E, F, reverse, true)
      if (dA !== null && (dA < 0 || approximately(dA * overlap, 0))) {
        d = null
      }
    }
    if (d !== null) distances.push(d)
  }

  if (dotE > ABmin && dotE < ABmax) {
    let d = pointDistance(E, A, B, direction)
    if (d !== null && approximately(d, 0)) {
      const dF = pointDistance(F, A, B, direction, true)
      if (dF !== null && (dF < 0 || approximately(dF * overlap, 0))) {
        d = null
      }
    }
    if (d !== null) distances.push(d)
  }

  if (dotF > ABmin && dotF < ABmax) {
    let d = pointDistance(F, A, B, direction)
    if (d !== null && approximately(d, 0)) {
      const dE = pointDistance(E, A, B, direction, true)
      if (dE !== null && (dE < 0 || approximately(dE * overlap, 0))) {
        d = null
      }
    }
    if (d !== null) distances.push(d)
  }

  if (distances.length <= 0) return null
  return Math.min(...distances)
}

function polygonSlideDistance(
  A: Part,
  B: Part,
  direction: Vector,
  ignoreNegative: boolean
): number | null {
  const AP = A.points.slice(0)
  const BP = B.points.slice(0)
  if (!AP[0].approximately(AP[AP.length - 1])) AP.push(AP[0])
  if (!BP[0].approximately(BP[BP.length - 1])) BP.push(BP[0])

  let distance: number | null = null
  const dir = direction.normalize()

  for (let i = 0; i < BP.length - 1; i++) {
    for (let j = 0; j < AP.length - 1; j++) {
      const A1 = AP[j].add(A.offset)
      const A2 = AP[j + 1].add(A.offset)
      const B1 = BP[i].add(B.offset)
      const B2 = BP[i + 1].add(B.offset)
      if (A1.approximately(A2) || B1.approximately(B2)) continue

      const d = segmentDistance(A1, A2, B1, B2, dir)
      if (d !== null && (distance === null || d < distance)) {
        if (!ignoreNegative || d > 0 || approximately(d, 0)) {
          distance = d
        }
      }
    }
  }
  return distance
}

function polygonProjectionDistance(A: Part, B: Part, direction: Vector): number | null {
  const AP = A.points.slice(0)
  const BP = B.points.slice(0)
  if (!AP[0].approximately(AP[AP.length - 1])) AP.push(AP[0])
  if (!BP[0].approximately(BP[BP.length - 1])) BP.push(BP[0])

  let distance: number | null = null

  for (let i = 0; i < BP.length; i++) {
    let minProjection: number | null = null
    for (let j = 0; j < AP.length - 1; j++) {
      const p = BP[i].add(B.offset)
      const s1 = AP[j].add(A.offset)
      const s2 = AP[j + 1].add(A.offset)
      const s12 = s2.sub(s1)
      if (Math.abs(s12.cross(direction)) < TOL) continue
      const d = pointDistance(p, s1, s2, direction)
      if (d !== null && (minProjection === null || d < minProjection)) {
        minProjection = d
      }
    }
    if (minProjection !== null && (distance === null || minProjection > distance)) {
      distance = minProjection
    }
  }
  return distance
}

// eslint-disable-next-line complexity -- vendor algorithm
function lineIntersect(
  A: Vector,
  B: Vector,
  E: Vector,
  F: Vector,
  infinite?: boolean
): Vector | null {
  const a1 = B.y - A.y
  const b1 = A.x - B.x
  const c1 = B.x * A.y - A.x * B.y
  const a2 = F.y - E.y
  const b2 = E.x - F.x
  const c2 = F.x * E.y - E.x * F.y
  const denom = a1 * b2 - a2 * b1
  const x = (b1 * c2 - b2 * c1) / denom
  const y = (a2 * c1 - a1 * c2) / denom
  if (!isFinite(x) || !isFinite(y)) return null

  if (!infinite) {
    if (Math.abs(A.x - B.x) > TOL && (A.x < B.x ? x < A.x || x > B.x : x > A.x || x < B.x))
      return null
    if (Math.abs(A.y - B.y) > TOL && (A.y < B.y ? y < A.y || y > B.y : y > A.y || y < B.y))
      return null
    if (Math.abs(E.x - F.x) > TOL && (E.x < F.x ? x < E.x || x > F.x : x > E.x || x < F.x))
      return null
    if (Math.abs(E.y - F.y) > TOL && (E.y < F.y ? y < E.y || y > F.y : y > E.y || y < F.y))
      return null
  }
  return new Vector(x, y)
}

// eslint-disable-next-line complexity -- vendor algorithm
function intersect(A: Part, B: Part): boolean {
  const AP = A.points.slice(0)
  const BP = B.points.slice(0)
  const n = AP.length
  const m = BP.length

  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < m - 1; j++) {
      const a1 = AP[i].add(A.offset)
      const a2 = AP[i + 1].add(A.offset)
      const b1 = BP[j].add(B.offset)
      const b2 = BP[j + 1].add(B.offset)

      let prevbindex = j === 0 ? m - 1 : j - 1
      let prevaindex = i === 0 ? n - 1 : i - 1
      let nextbindex = j + 1 === m - 1 ? 0 : j + 2
      let nextaindex = i + 1 === n - 1 ? 0 : i + 2

      if (BP[prevbindex].approximately(BP[j]))
        prevbindex = prevbindex === 0 ? m - 1 : prevbindex - 1
      if (AP[prevaindex].approximately(AP[i]))
        prevaindex = prevaindex === 0 ? n - 1 : prevaindex - 1
      if (BP[nextbindex].approximately(BP[j + 1]))
        nextbindex = nextbindex === m - 1 ? 0 : nextbindex + 1
      if (AP[nextaindex].approximately(AP[i + 1]))
        nextaindex = nextaindex === n - 1 ? 0 : nextaindex + 1

      const b0 = BP[prevbindex].add(B.offset)
      const b3 = BP[nextbindex].add(B.offset)
      const a0 = AP[prevaindex].add(A.offset)
      const a3 = AP[nextaindex].add(A.offset)

      if (onSegment(a1, a2, b1) || a1.approximately(b1)) {
        const b0in = pointInPolygon(b0, A)
        const b2in = pointInPolygon(b2, A)
        if ((b0in === true && b2in === false) || (b0in === false && b2in === true)) return true
        continue
      }
      if (onSegment(a1, a2, b2) || a2.approximately(b2)) {
        const b1in = pointInPolygon(b1, A)
        const b3in = pointInPolygon(b3, A)
        if ((b1in === true && b3in === false) || (b1in === false && b3in === true)) return true
        continue
      }
      if (onSegment(b1, b2, a1) || a1.approximately(b2)) {
        const a0in = pointInPolygon(a0, B)
        const a2in = pointInPolygon(a2, B)
        if ((a0in === true && a2in === false) || (a0in === false && a2in === true)) return true
        continue
      }
      if (onSegment(b1, b2, a2) || a2.approximately(b1)) {
        const a1in = pointInPolygon(a1, B)
        const a3in = pointInPolygon(a3, B)
        if ((a1in === true && a3in === false) || (a1in === false && a3in === true)) return true
        continue
      }
      const p = lineIntersect(b1, b2, a1, a2)
      if (p !== null) return true
    }
  }
  return false
}

export {
  TOL,
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
}
