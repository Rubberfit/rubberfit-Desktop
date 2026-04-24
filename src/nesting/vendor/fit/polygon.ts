import Vector from "./vector"
import BoundingBox from "./bounding-box"

export default class Polygon {
  points: Vector[]
  options: Record<string, unknown>
  groupId: string

  constructor(points: Vector[], options: Record<string, unknown> = {}) {
    this.points = points
    this.options = options
    this.groupId = ""
  }

  static fromJSON(json: {
    points: { x: number; y: number; marked?: boolean }[]
    options?: Record<string, unknown>
    groupId?: string
  }): Polygon {
    const points = json.points.map((p) => Vector.fromJSON(p))
    const poly = new Polygon(points, json.options ?? {})
    poly.groupId = json.groupId ?? ""
    return poly
  }

  bounds(): BoundingBox {
    let minX = Number.MAX_VALUE,
      maxX = -Number.MAX_VALUE
    let minY = Number.MAX_VALUE,
      maxY = -Number.MAX_VALUE

    this.points.forEach((p) => {
      minX = Math.min(p.x, minX)
      minY = Math.min(p.y, minY)
      maxX = Math.max(p.x, maxX)
      maxY = Math.max(p.y, maxY)
    })

    return new BoundingBox(new Vector(minX, minY), new Vector(maxX, maxY))
  }

  translate(dx: number, dy: number): Polygon {
    const np = this.clone()
    np.points = np.points.map((p) => p.translate(dx, dy))
    return np
  }

  rotate(angle = 0): Polygon {
    const np = this.clone()
    const sin = Math.sin(angle)
    const cos = Math.cos(angle)
    np.points = np.points.map(
      (p) => new Vector(p.x * cos - p.y * sin, p.x * sin + p.y * cos, p.marked)
    )
    return np
  }

  clone(): Polygon {
    const points = this.points.map((p) => p.clone())
    const np = new Polygon(points, this.options)
    np.groupId = this.groupId
    return np
  }

  area(): number {
    let area = 0
    const n = this.points.length
    for (let i = 0, j = n - 1; i < n; j = i++) {
      area += (this.points[j].x + this.points[i].x) * (this.points[j].y - this.points[i].y)
    }
    return 0.5 * area
  }

  approximately(other: Polygon): boolean {
    const n = this.points.length
    if (n !== other.points.length) return false
    for (let i = 0; i < n; i++) {
      if (!this.points[i].approximately(other.points[i])) return false
    }
    return true
  }
}
