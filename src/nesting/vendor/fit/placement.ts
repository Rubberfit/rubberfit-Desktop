import Vector from "./vector"

export default class Placement {
  bin: string
  part: string
  position: Vector
  rotation: number

  constructor(bin: string, part: string, position: Vector, rotation: number) {
    this.bin = bin
    this.part = part
    this.position = position
    this.rotation = rotation
  }
}
