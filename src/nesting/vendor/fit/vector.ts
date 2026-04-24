export default class Vector {
  x: number
  y: number
  marked: boolean

  constructor(x = 0, y = 0, marked = false) {
    this.x = x
    this.y = y
    this.marked = marked
  }

  static fromJSON(json: { x: number; y: number; marked?: boolean }): Vector {
    return new Vector(json.x, json.y, json.marked ?? false)
  }

  set(v: Vector): this {
    this.x = v.x
    this.y = v.y
    return this
  }

  normalize(): Vector {
    const nl = this.length()
    return new Vector(this.x / nl, this.y / nl)
  }

  add(v: Vector): Vector {
    return new Vector(this.x + v.x, this.y + v.y)
  }

  sub(v: Vector): Vector {
    return new Vector(this.x - v.x, this.y - v.y)
  }

  multiplyScalar(scalar: number): Vector {
    return new Vector(this.x * scalar, this.y * scalar, this.marked)
  }

  squaredLength(): number {
    return this.x * this.x + this.y * this.y
  }

  length(): number {
    return Math.sqrt(this.squaredLength())
  }

  dot(v: Vector): number {
    return this.x * v.x + this.y * v.y
  }

  cross(v: Vector): number {
    return this.y * v.x - this.x * v.y
  }

  perpendicular(): Vector {
    return new Vector(this.y, -this.x)
  }

  negative(): Vector {
    return new Vector(-this.x, -this.y)
  }

  translate(dx: number, dy: number): Vector {
    return new Vector(this.x + dx, this.y + dy)
  }

  mark(): this {
    this.marked = true
    return this
  }

  unmark(): this {
    this.marked = false
    return this
  }

  approximately(v: Vector, tolerance = 1e-9): boolean {
    return Math.abs(this.x - v.x) < tolerance && Math.abs(this.y - v.y) < tolerance
  }

  clone(): Vector {
    return new Vector(this.x, this.y, this.marked)
  }
}
