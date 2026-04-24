// Minimal worker pool for the coarse-angle NFP pass.
// Lazily spins up workers; silently falls back (isAvailable() -> false) if
// Turbopack can't bundle the worker (known risk with clipper-lib CJS).

import type { Point2D } from "./types"
import type { PartPartNfpCache, GreedyPlacement } from "./nfp-pack-rotation"
import type { AngleTaskRequest, AngleTaskResponse } from "./nfp-angle-worker"

export interface AngleBatchInput {
  originalPoints: ReadonlyArray<Point2D>
  hullPoints: ReadonlyArray<Point2D>
  binWidth: number
  binHeight: number
  qty: number
  spacing: number
  partPartNfpCache: PartPartNfpCache
  angles: number[]
}

type Pending = {
  resolve: (placements: GreedyPlacement[] | null) => void
  reject: (err: Error) => void
}

class AngleWorkerPool {
  private workers: Worker[] = []
  private nextTaskId = 1
  private pending = new Map<number, Pending>()
  private available: boolean
  private initAttempted = false

  constructor() {
    this.available = typeof window !== "undefined" && typeof Worker !== "undefined"
  }

  isAvailable(): boolean {
    if (!this.available) return false
    if (!this.initAttempted) this.init()
    return this.available
  }

  private init(): void {
    this.initAttempted = true
    const size = Math.min(8, Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1))
    try {
      for (let i = 0; i < size; i++) {
        const worker = new Worker(new URL("./nfp-angle-worker.ts", import.meta.url), {
          type: "module",
        })
        worker.addEventListener("message", (event: MessageEvent<AngleTaskResponse>) => {
          const { taskId, placements, error } = event.data
          const pending = this.pending.get(taskId)
          if (!pending) return
          this.pending.delete(taskId)
          if (error) pending.reject(new Error(error))
          else pending.resolve(placements)
        })
        worker.addEventListener("error", (event) => {
          console.error("[nfp-angle-worker]", event.message)
        })
        this.workers.push(worker)
      }
    } catch (error) {
      console.warn("[worker-pool] failed to spin up NFP angle workers, falling back", error)
      this.available = false
      this.workers = []
    }
  }

  private runSingle(
    worker: Worker,
    input: AngleBatchInput,
    angle: number
  ): Promise<GreedyPlacement[] | null> {
    const taskId = this.nextTaskId++
    const req: AngleTaskRequest = {
      taskId,
      originalPoints: input.originalPoints as Point2D[],
      hullPoints: input.hullPoints as Point2D[],
      binWidth: input.binWidth,
      binHeight: input.binHeight,
      qty: input.qty,
      spacing: input.spacing,
      angle,
      partPartNfpCache: input.partPartNfpCache,
    }
    return new Promise<GreedyPlacement[] | null>((resolve, reject) => {
      this.pending.set(taskId, { resolve, reject })
      worker.postMessage(req)
    })
  }

  /**
   * Distribute each angle across the worker pool round-robin.
   * Returns results in the same order as input.angles.
   */
  async runAngleBatch(input: AngleBatchInput): Promise<Array<GreedyPlacement[] | null>> {
    if (!this.isAvailable() || this.workers.length === 0) {
      throw new Error("worker pool is not available")
    }
    const results: Array<GreedyPlacement[] | null> = new Array(input.angles.length)
    // Round-robin dispatch so slower tasks don't stall one worker while others idle.
    const promises = input.angles.map((angle, idx) => {
      const worker = this.workers[idx % this.workers.length]
      return this.runSingle(worker, input, angle).then(
        (placements) => {
          results[idx] = placements
        },
        (err: Error) => {
          console.error("[worker-pool] angle task failed", err)
          results[idx] = null
        }
      )
    })
    await Promise.all(promises)
    return results
  }
}

let poolSingleton: AngleWorkerPool | null = null

export function getAngleWorkerPool(): AngleWorkerPool {
  if (!poolSingleton) poolSingleton = new AngleWorkerPool()
  return poolSingleton
}
