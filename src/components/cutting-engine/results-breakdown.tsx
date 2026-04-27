import { cn } from "@/lib/utils"
import type { StockConfig } from "./stock-preview-configurator"
import type { SimpleCutMetrics } from "./nesting-visualizer-types"

type ResultTone = "neutral" | "utilization" | "reusable" | "waste"

const TONE_CLASS: Record<ResultTone, string> = {
  neutral: "text-foreground",
  utilization: "text-emerald-600 dark:text-emerald-400",
  reusable: "text-amber-600 dark:text-amber-400",
  waste: "text-red-600 dark:text-red-400",
}

const TONE_DOT: Record<ResultTone, string> = {
  neutral: "",
  utilization: "bg-emerald-500",
  reusable: "bg-amber-500",
  waste: "bg-red-500",
}

function ResultRow({
  label,
  value,
  tone = "neutral",
}: {
  label: string
  value: string
  tone?: ResultTone
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        {tone !== "neutral" && (
          <span aria-hidden className={cn("inline-block h-2 w-2 rounded-full", TONE_DOT[tone])} />
        )}
        <span className="text-muted-foreground">{label}</span>
      </div>
      <span className={cn("font-medium tabular-nums", TONE_CLASS[tone])}>{value}</span>
    </div>
  )
}

/**
 * Shared utilization / reusable / waste breakdown card used by both
 * the Auto-nest (StrategyResultsPanel) and Free-roam (SavedLayoutsRail)
 * right-column panels. Stays dumb — all numbers come in via
 * `cutMetrics`; layout + stock give the denominator for percentages.
 */
export function ResultsBreakdown({
  cutMetrics,
  stock,
}: {
  cutMetrics: SimpleCutMetrics
  stock: StockConfig
}) {
  const hasFabrication = (cutMetrics.partsCompleted ?? 0) > 0
  const totalSqFt = (stock.width * stock.length) / 144
  const used = cutMetrics.materialUsedSqFt ?? 0
  const reusable = cutMetrics.reusableOffsetSqFt ?? 0
  const waste = cutMetrics.scrapSqFt ?? 0
  const pct = (n: number) => (totalSqFt > 0 ? ((n / totalSqFt) * 100).toFixed(1) : "0.0")
  const utilization = Math.round((cutMetrics.fabScore ?? 0) * 100)
  const usedBarPct = totalSqFt > 0 ? Math.min(100, (used / totalSqFt) * 100).toFixed(1) : "0"

  return (
    <>
      <div className="space-y-1.5 text-xs">
        <ResultRow
          label="Utilization"
          value={hasFabrication ? `${utilization}%` : "—"}
          tone="utilization"
        />
        <ResultRow label="Parts placed" value={String(cutMetrics.partsCompleted ?? 0)} />
        <ResultRow label="Material used" value={`${used.toFixed(2)} sq ft`} />
        <ResultRow
          label="Reusable offcut"
          value={`${reusable.toFixed(2)} sq ft (${pct(reusable)}%)`}
          tone="reusable"
        />
        <ResultRow
          label="Waste"
          value={`${waste.toFixed(2)} sq ft (${pct(waste)}%)`}
          tone="waste"
        />
      </div>

      {totalSqFt > 0 && (
        <div className="mt-3">
          <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-emerald-500" style={{ width: `${usedBarPct}%` }} />
            <div className="h-full bg-amber-500" style={{ width: `${pct(reusable)}%` }} />
            <div className="h-full bg-red-500" style={{ width: `${pct(waste)}%` }} />
          </div>
        </div>
      )}
    </>
  )
}
