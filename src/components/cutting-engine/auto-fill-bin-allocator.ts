import type { Bin } from "@/lib/packing/types"
import type { PartTemplate } from "./preset-template-data"
import type { StockConfig } from "./stock-preview-configurator"

import type { BinAllocationContext, BinAllocationStrategy } from "./bin-allocation-strategy"
import { partTemplateAreaSqIn } from "./cut-planner-utils"

export const PACKING_EFFICIENCY_FLOOR = 0.65
export const SAFETY_FACTOR = 1 / PACKING_EFFICIENCY_FLOOR
export const MAX_SHEETS = 50
export const MIN_SHEETS = 1

export function estimateTotalPartAreaSqIn(templates: PartTemplate[]): number {
  return templates.reduce((sum, t) => sum + partTemplateAreaSqIn(t), 0)
}

export function estimateSheetCount(
  totalPartAreaSqIn: number,
  sheetWidthIn: number,
  sheetLengthIn: number,
  manualBoost?: number
): number {
  const sheetArea = sheetWidthIn * sheetLengthIn
  if (sheetArea <= 0 || totalPartAreaSqIn <= 0) {
    return clampSheetCount(MIN_SHEETS + (manualBoost ?? 0))
  }
  const heuristic = Math.ceil((totalPartAreaSqIn / sheetArea) * SAFETY_FACTOR)
  return clampSheetCount(heuristic + (manualBoost ?? 0))
}

function clampSheetCount(n: number): number {
  if (!Number.isFinite(n)) return MIN_SHEETS
  return Math.min(MAX_SHEETS, Math.max(MIN_SHEETS, Math.floor(n)))
}

export function buildAutoFillBins(stock: StockConfig, count: number, idPrefix = "stock"): Bin[] {
  const bins: Bin[] = []
  for (let i = 1; i <= count; i++) {
    bins.push({
      binId: `${idPrefix}-${i}`,
      width: stock.width,
      height: stock.length,
      kind: "fresh",
    })
  }
  return bins
}

export class AutoFillBinAllocator implements BinAllocationStrategy {
  readonly kind = "autoFill" as const
  readonly name = "Auto-fill (estimate from part area)"

  allocate({ stock, templates, manualBoost }: BinAllocationContext): Bin[] {
    const totalArea = estimateTotalPartAreaSqIn(templates)
    const count = estimateSheetCount(totalArea, stock.width, stock.length, manualBoost)
    return buildAutoFillBins(stock, count, "stock")
  }
}
