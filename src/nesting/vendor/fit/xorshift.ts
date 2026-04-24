export default class XorShift {
  w: number
  x: number
  y: number
  z: number

  constructor(w = 0) {
    this.w = w + 1
    this.x = 0 | (this.w << 13)
    this.y = 0 | ((this.w >>> 9) ^ (this.x << 6))
    this.z = 0 | (this.y >>> 7)
  }

  next(): number {
    const t = this.x ^ (this.x << 11)
    this.x = this.y
    this.y = this.z
    this.z = this.w
    return (this.w = this.w ^ (this.w >>> 19) ^ (t ^ (t >>> 8))) >>> 0
  }

  rand(): number {
    return this.next()
  }

  randInt(min = 0, max = 0x7fffffff): number {
    const r = Math.abs(this.rand())
    return (r % (max - min)) + min
  }

  randFloat(min = 0, max = 1): number {
    return Math.fround((this.rand() % 0xffff) / 0xffff) * (max - min) + min
  }

  shuffle<T>(arr: T[]): T[] {
    const result = arr.concat()
    for (let i = 0; i <= result.length - 2; i = 0 | (i + 1)) {
      const r = this.randInt(i, result.length - 1)
      const tmp = result[i]
      result[i] = result[r]
      result[r] = tmp
    }
    return result
  }
}
