import type { Bin } from "@/lib/packing/types"
import type { PartTemplate } from "./preset-template-data"
import type { StockConfig } from "./stock-preview-configurator"

import { AutoFillBinAllocator } from "./auto-fill-bin-allocator"

export type BinAllocationStrategyKind = "autoFill"

export interface BinAllocationContext {
  stock: StockConfig
  templates: PartTemplate[]
  manualBoost?: number
}

export interface BinAllocationStrategy {
  readonly kind: BinAllocationStrategyKind
  readonly name: string
  allocate(ctx: BinAllocationContext): Bin[]
}

export function strategyFor(kind: BinAllocationStrategyKind): BinAllocationStrategy {
  switch (kind) {
    case "autoFill":
      return new AutoFillBinAllocator()
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}
