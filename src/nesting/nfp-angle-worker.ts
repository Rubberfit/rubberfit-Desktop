// Web Worker entry — executes one packWithRotation call per message.
// Keep this file's imports narrow: Turbopack bundles it separately, and
// clipper-lib (CJS) is the known fragile dependency.

/// <reference lib="webworker" />

import { packWithRotation, type PartPartNfpCache, type GreedyPlacement } from "./nfp-pack-rotation"
import type { Point2D } from "./types"

export interface AngleTaskRequest {
  taskId: number
  originalPoints: Point2D[]
  hullPoints: Point2D[]
  binWidth: number
  binHeight: number
  qty: number
  spacing: number
  angle: number
  partPartNfpCache: PartPartNfpCache
}

export interface AngleTaskResponse {
  taskId: number
  placements: GreedyPlacement[] | null
  error?: string
}

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.addEventListener("message", (event: MessageEvent<AngleTaskRequest>) => {
  const req = event.data
  try {
    const placements = packWithRotation(
      req.originalPoints,
      req.hullPoints,
      req.binWidth,
      req.binHeight,
      req.qty,
      req.spacing,
      req.angle,
      req.partPartNfpCache
    )
    const response: AngleTaskResponse = { taskId: req.taskId, placements }
    ctx.postMessage(response)
  } catch (error) {
    const response: AngleTaskResponse = {
      taskId: req.taskId,
      placements: null,
      error: (error as Error).message,
    }
    ctx.postMessage(response)
  }
})
