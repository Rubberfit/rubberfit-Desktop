import { stdSeed } from "../gaussian"
import type XorShift from "../xorshift"

export default class DNA {
  genes: number[]
  cost: number
  options: Record<string, unknown>

  constructor(genes: number[] = []) {
    this.genes = genes
    this.cost = 1e5 // initial value for a failed case
    this.options = {}
  }

  clone(): DNA {
    const cloned = new DNA(this.genes.map((v) => v))
    cloned.cost = this.cost
    cloned.options = this.options
    return cloned
  }

  evaluate(cost: number, options: Record<string, unknown> = {}): void {
    this.cost = cost
    this.options = options
  }

  crossOver(rnd: XorShift, partner: DNA): DNA {
    const childGenes: number[] = []
    const mid = Math.floor(rnd.randFloat() * this.genes.length)

    for (let i = 0, n = this.genes.length; i < n; i++) {
      if (i > mid) {
        childGenes[i] = this.genes[i]
      } else {
        childGenes[i] = partner.genes[i]
      }
    }

    return new DNA(childGenes)
  }

  mutate(rnd: XorShift, m: number, steps: number): DNA {
    const genes: number[] = []
    for (let i = 0, n = this.genes.length; i < n; i++) {
      let v = this.genes[i]
      if (rnd.randFloat() <= m) {
        const delta = stdSeed(rnd, 0, 1) * steps
        v = Math.floor(v + delta) % steps
        if (v < 0) {
          v = (steps + v) % steps
        }
      }
      genes.push(v)
    }
    return new DNA(genes)
  }
}
