import Vector from "./vector"

export default class BoundingBox {
  min: Vector
  max: Vector
  width: number
  height: number

  /**
   * @summary AABB with min-max implementation.
   * @param min
   * @param max
   */
  constructor(min: Vector, max: Vector) {
    this.min = min
    this.max = max
    this.width = this.max.x - this.min.x
    this.height = this.max.y - this.min.y
  }
}
