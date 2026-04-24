import DNA from "./dna"
import type XorShift from "../xorshift"

export interface GAConfig {
  steps: number // Number of rotations
  population: number // How many candiates per generation
  mutationRate: number // How often genes change
}

export default class GA {
  rnd: XorShift
  generations: number
  population: DNA[]
  config: GAConfig

  constructor(rnd: XorShift, gene: number, config: Partial<GAConfig> = {}) {
    this.rnd = rnd // Deterministic random number generator
    this.generations = 0 // Total generations (iterations)
    this.population = [] // Population to be evaluated

    this.config = {
      steps: config.steps ?? 4,
      population: config.population ?? 30,
      mutationRate: config.mutationRate ?? 0.2,
    }

    const count = Math.max(3, this.config.population)
    for (let i = 0; i < count; i++) {
      this.population.push(this.adam(gene, this.config.steps))
    }
  }

  // Creates random genes
  adam(length: number, steps = 4): DNA {
    const gene: number[] = []
    for (let i = 0; i < length; i++) {
      const v = Math.floor(this.rnd.randFloat() * steps) % steps
      gene.push(v)
    }
    return new DNA(gene)
  }

  // Heart of the algorithm
  // Performs reproduction
  step(): void {
    this.generations++

    let pool = this.select()
    if (pool.length <= 0) {
      pool = this.population
    }

    for (let i = 0, n = this.population.length; i < n; i++) {
      const mi = this.rnd.randInt(0, pool.length)
      const di = this.rnd.randInt(0, pool.length)

      const mom = pool[mi]
      const dad = pool[di]
      let child = mom.crossOver(this.rnd, dad)
      child = child.mutate(this.rnd, this.config.mutationRate, this.config.steps)

      this.population[i] = child
    }
  }

  select(): DNA[] {
    const pool: DNA[] = []
    const range = this.getMinMaxCost()
    const l = range.max - range.min // Possible division by 0
    this.population.forEach((dna) => {
      const cost01 = 1.0 - (dna.cost - range.min) / l
      const n = Math.floor(cost01 * 50)
      for (let i = 0; i < n; i++) {
        pool.push(dna)
      }
    })
    return pool
  }

  getDominant(): DNA {
    let dominant: DNA | null = null
    let min = Number.MAX_VALUE
    this.population.forEach((dna) => {
      if (dna.cost < min) {
        min = dna.cost
        dominant = dna
      }
    })
    return dominant!
  }

  getMinMaxCost(): { min: number; max: number } {
    let min = Number.MAX_VALUE
    let max = -Number.MAX_VALUE
    this.population.forEach((dna) => {
      max = Math.max(max, dna.cost)
      min = Math.min(min, dna.cost)
    })
    return { min, max }
  }
}
