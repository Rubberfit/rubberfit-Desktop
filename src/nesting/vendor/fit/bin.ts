import Part from "./part"
import Vector from "./vector"

// @ts-expect-error Vendor code: Bin.fromJSON has a different signature than Part.fromJSON
export default class Bin extends Part {
  width: number
  height: number
  isBin: boolean

  constructor(id: string, width: number, height: number, options: Record<string, unknown> = {}) {
    const points = [
      new Vector(0, 0),
      new Vector(width, 0),
      new Vector(width, height),
      new Vector(0, height),
    ]
    super(id, points, options)
    this.width = width
    this.height = height
    this.isBin = true
  }

  static fromJSON(json: {
    id: string
    width: number
    height: number
    options?: Record<string, unknown>
    offset?: { x: number; y: number }
    rotation?: number
    groupId?: string
  }): Bin {
    const bin = new Bin(json.id, json.width, json.height, json.options ?? {})
    bin.offset = json.offset ? new Vector(json.offset.x, json.offset.y) : new Vector(0, 0)
    bin.rotation = json.rotation ?? 0
    bin.groupId = json.groupId ?? ""
    return bin
  }

  clone(): Bin {
    const bin = new Bin(this.id, this.width, this.height, this.options)
    bin.offset = new Vector(this.offset.x, this.offset.y)
    bin.rotation = this.rotation
    bin.groupId = this.groupId
    return bin
  }

  toString(): string {
    return `bin:${this.id}`
  }
}
