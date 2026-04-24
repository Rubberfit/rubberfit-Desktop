import Polygon from "./polygon"
import Vector from "./vector"

export default class Part extends Polygon {
  id: string
  offset: Vector
  transformed: number
  rotation: number

  constructor(id: string, points: Vector[], options: Record<string, unknown> = {}) {
    super(points, options)
    this.id = id
    this.offset = new Vector(0, 0)
    this.transformed = 0
    this.rotation = 0
  }

  static fromJSON(json: {
    id: string
    points: { x: number; y: number; marked?: boolean }[]
    options?: Record<string, unknown>
    offset?: { x: number; y: number }
    transformed?: number
    rotation?: number
    groupId?: string
    isBin?: boolean
  }): Part {
    const points = json.points.map((p) => Vector.fromJSON(p))
    const part = new Part(json.id, points, json.options ?? {})
    part.offset = json.offset ? new Vector(json.offset.x, json.offset.y) : new Vector(0, 0)
    part.transformed = json.transformed ?? 0
    part.rotation = json.rotation ?? 0
    part.groupId = json.groupId ?? ""
    return part
  }

  transform(index: number, range: number): Part {
    const cloned = this.clone() as Part
    cloned.transformed = index
    cloned.rotation = ((1.0 * index) / range) * Math.PI * 2
    return cloned
  }

  clone(): Part {
    const points = this.points.map((p) => p.clone())
    const np = new Part(this.id, points, this.options)
    np.offset = this.offset.clone()
    np.transformed = this.transformed
    np.rotation = this.rotation
    np.groupId = this.groupId
    return np
  }

  toString(): string {
    return `${this.groupId}:${this.transformed}`
  }
}
