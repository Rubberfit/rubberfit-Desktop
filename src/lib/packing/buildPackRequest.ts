// Ported from rema-portal src/application/packing/buildPackRequest.ts.
// Pure TS — no DB, no DI.

import { type PackRequest, type Part, type Bin, PACK_MODE_BUDGETS_MS } from "./types"

export interface BuildPackRequestInput {
  bins: Bin[]
  items: Part[]
  clearance: number
  operatorProfile?: PackRequest["operatorProfile"]
  mode?: PackRequest["mode"]
  timeBudgetMs?: number
  improvementBudgetMs?: number
  seed?: number
}

export function buildPackRequest(input: BuildPackRequestInput): PackRequest {
  if (input.bins.length === 0) {
    throw new Error("buildPackRequest: bins must not be empty")
  }
  if (input.items.length === 0) {
    throw new Error("buildPackRequest: items must not be empty")
  }

  const mode = input.mode ?? "balanced"
  const timeBudgetMs = input.timeBudgetMs ?? PACK_MODE_BUDGETS_MS[mode]

  // Stable sort (ES2019+): equal-comparator entries preserve insertion order.
  const sortedBins = [...input.bins].sort((a, b) => {
    const pa = a.priority ?? 0
    const pb = b.priority ?? 0
    if (pa !== pb) return pb - pa
    if (a.kind !== b.kind) return a.kind === "remnant" ? -1 : 1
    return 0
  })

  return {
    bins: sortedBins,
    items: input.items,
    clearance: input.clearance,
    operatorProfile: input.operatorProfile,
    mode,
    timeBudgetMs,
    improvementBudgetMs: input.improvementBudgetMs,
    seed: input.seed,
  }
}
