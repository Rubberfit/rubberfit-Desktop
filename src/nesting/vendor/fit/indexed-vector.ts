import Vector from "./vector"

export default class IndexedVector extends Vector {
  start: Vector
  end: Vector

  constructor(x: number, y: number, start: Vector, end: Vector) {
    super(x, y)
    this.start = start
    this.end = end
  }

  clone(): IndexedVector {
    return new IndexedVector(this.x, this.y, this.start.clone(), this.end.clone())
  }
}
