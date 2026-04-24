import XorShift from "./xorshift"
import GA from "./ga/ga"
import type DNA from "./ga/dna"
import {
  createUniqueKey,
  offsetPolygon,
  noFitRectanglePolygon,
  noFitPolygon,
  minkowskiDifference,
} from "./util"
import Part from "./part"
import type Bin from "./bin"
import Polygon from "./polygon"
import { place } from "./placer"
import type Placement from "./placement"

export interface PackerConfig {
  spacing?: number
  rotationSteps?: number
  population?: number
  mutationRate?: number
  generations?: number
  seed?: number
}

export interface PackingEvent {
  generation: number
  placements: Placement[]
  unplaced: Part[]
  bins: Bin[]
  placed: Part[]
  dominant?: DNA
}

export interface PackerCallbacks {
  onStart?: () => void
  onEvaluation?: (e: { generation: number; progress: number }) => void
  onPacking?: (e: PackingEvent) => void
  onPackingCompleted?: (e: PackingEvent) => void
}

export default class Packer {
  running: boolean
  bins: Bin[]
  parts: Part[]
  source: Part[]
  config: PackerConfig
  rnd: XorShift

  constructor() {
    this.running = false
    this.bins = []
    this.parts = []
    this.source = []
    this.config = {}
    this.rnd = new XorShift(0)
  }

  start(bins: Bin[], parts: Part[], config: PackerConfig, callbacks: PackerCallbacks = {}): void {
    if (this.running) this.stop()
    this.running = true

    this.bins = bins
    this.source = this.parts = parts
      .slice()
      .sort((p0, p1) => Math.abs(p1.area()) - Math.abs(p0.area()))
    this.config = config || {}
    this.rnd = new XorShift(this.config.seed ?? 0)

    this.group(this.bins, "bin")
    this.group(this.source, "polygon")

    callbacks.onStart?.()

    if (this.config.spacing && this.config.spacing > 0) {
      this.parts = this.parts.map((part) => offsetPolygon(part, this.config.spacing!))
    }

    this.packSync(callbacks)
  }

  stop(): void {
    this.running = false
  }

  private group(polygons: Part[], prefix = ""): void {
    const items = polygons.slice()
    const groups: Part[][] = []
    groups.push([items.pop()!])

    items.forEach((poly) => {
      let found = false
      for (let i = 0; i < groups.length; i++) {
        const head = groups[i][0]
        if (head.approximately(poly)) {
          groups[i].push(poly)
          found = true
          break
        }
      }
      if (!found) groups.push([poly])
    })

    groups.forEach((grp, idx) => {
      grp.forEach((poly) => {
        poly.groupId = `${prefix}${idx}`
      })
    })
  }

  private format(args: {
    generation: number
    placements: Placement[]
    unplaced: Part[]
    dominant?: DNA
  }): PackingEvent {
    const placed = this.applyPlacements(
      args.placements,
      this.source.map((p) => p.clone() as Part)
    )
    return {
      generation: args.generation,
      placements: args.placements,
      bins: this.bins,
      placed,
      unplaced: args.unplaced.map((p) => this.source.find((part) => part.id === p.id)!),
      dominant: args.dominant,
    }
  }

  private applyPlacements(placements: Placement[], parts: Part[]): Part[] {
    const packed: Part[] = []
    placements.forEach((placement) => {
      const idx = parts.findIndex((part) => part.id === placement.part)
      if (idx !== -1) {
        parts[idx] = (parts[idx].rotate(placement.rotation) as Part).translate(
          placement.position.x,
          placement.position.y
        ) as unknown as Part
        packed.push(parts[idx])
      }
    })
    return packed
  }

  private transform(dna: DNA, parts: Part[], range: number): Part[] {
    return parts.map((part, idx) => part.transform(dna.genes[idx], range))
  }

  private packSync(callbacks: PackerCallbacks): void {
    const cache: Record<string, Polygon[]> = {}

    // Initializing the genetic algorithm
    const ga = new GA(this.rnd, this.parts.length, {
      population: this.config.population ?? 10,
      mutationRate: this.config.mutationRate ?? 0.2,
      steps: this.config.rotationSteps ?? 4,
    })

    const generations = this.config.generations ?? 30
    let dominant: DNA | null = null

    for (let gen = 0; gen <= generations; gen++) {
      if (!this.running) break

      // Evaluate all individuals
      for (let i = 0; i < ga.population.length; i++) {
        const dna = ga.population[i]
        const transformed = this.transform(dna, this.parts, this.config.rotationSteps ?? 4)

        // Compute NFPs
        this.createNfps(transformed, cache, false, false)

        // Place parts
        const result = place(this.bins, transformed, cache)
        dna.evaluate(result.cost, {
          placements: result.placements,
          unplaced: result.unplaced,
        } as Record<string, unknown>)

        callbacks.onEvaluation?.({
          generation: gen,
          progress: (i + 1) / ga.population.length,
        })
      }

      const cand = ga.getDominant()
      if (dominant === null || cand.cost < dominant.cost) {
        dominant = cand.clone()
      }

      const result = this.format({
        generation: gen,
        placements: dominant.options.placements as Placement[],
        unplaced: dominant.options.unplaced as Part[],
        dominant,
      })

      if (gen < generations) {
        callbacks.onPacking?.(result)
        ga.step()
      } else {
        callbacks.onPackingCompleted?.(result)
      }
    }

    // Cleanup cache
    for (const key in cache) {
      delete cache[key]
    }
  }

  private createNfps(
    parts: Part[],
    cache: Record<string, Polygon[]>,
    inside: boolean,
    edges: boolean
  ): void {
    // Bin-part NFPs
    for (let i = 0; i < this.bins.length; i++) {
      const bin = this.bins[i]
      for (let j = 0; j < parts.length; j++) {
        const polygon = parts[j]
        const key = createUniqueKey(bin, polygon, inside)
        if (!(key in cache)) {
          cache[key] = this.computeNfp(bin, polygon, inside, edges)
        }
      }
    }

    // Part-part NFPs
    for (let i = 0; i < parts.length; i++) {
      for (let j = 0; j < parts.length; j++) {
        if (i === j) continue
        const key = createUniqueKey(parts[i], parts[j], inside)
        if (!(key in cache)) {
          cache[key] = this.computeNfp(parts[i], parts[j], inside, edges)
        }
      }
    }
  }

  private computeNfp(A: Part, B: Part, inside: boolean, edges: boolean): Polygon[] {
    const pa = A.rotate(A.rotation) as Part
    const pb = B.rotate(B.rotation) as Part

    let result: Polygon[]
    if ((A as unknown as { isBin?: boolean }).isBin) {
      const polygon = noFitRectanglePolygon(pa, pb)
      result = polygon ? [polygon] : []
    } else {
      if (edges) {
        result = noFitPolygon(pa, pb, inside, edges)
      } else {
        result = minkowskiDifference(pa, pb)
      }
    }

    return result.map((polygon) => {
      if (polygon.area() > 0) {
        polygon.points.reverse()
      }
      return polygon
    })
  }
}
