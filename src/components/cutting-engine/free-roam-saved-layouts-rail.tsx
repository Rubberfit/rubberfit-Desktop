import { Scissors } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { CutHistory } from "@/types/supabase-models"
import type { StockConfig } from "./stock-preview-configurator"
import type { SimpleCutMetrics } from "./nesting-visualizer-types"
// `RecordedCutSelect` was deleted as part of the desktop migration
// (DB-driven). Wave-2 will reintroduce a local-storage equivalent.
// `onLoadCut` / `refreshKey` props stay so the wiring lands in place.
import { ResultsBreakdown } from "./results-breakdown"
import { FreeRoamStockEditor } from "./free-roam-stock-editor"

interface SavedLayoutsRailProps {
  stock: StockConfig
  onStockChange: (stock: StockConfig) => void
  cutMetrics: SimpleCutMetrics | null
  onRecordCut: () => void
  isRecordingCut: boolean
  refreshKey: number
  onLoadCut: (cut: CutHistory) => void
}

export function FreeRoamSavedLayoutsRail({
  stock,
  onStockChange,
  cutMetrics,
  onRecordCut,
  isRecordingCut,
  refreshKey,
  onLoadCut,
}: SavedLayoutsRailProps) {
  // Reference props that lose their consumer (RecordedCutSelect) but
  // are kept on the public surface so wave-2 can reintroduce the dropdown
  // without changing the public type.
  void onLoadCut
  void refreshKey
  return (
    <div className="flex flex-col gap-0 h-full">
      <div className="px-4 pt-4 pb-3 border-b border-border/40">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">Saved layouts</span>
          <span className="text-xs text-muted-foreground italic">
            Saved layouts dropdown coming back in wave-2
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        <section>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Stock
          </p>
          <FreeRoamStockEditor stock={stock} onChange={onStockChange} />
        </section>

        {cutMetrics && (
          <section>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Results
            </p>
            <ResultsBreakdown cutMetrics={cutMetrics} stock={stock} />

            {(cutMetrics.partsCompleted ?? 0) > 0 && (
              <Button
                size="sm"
                onClick={onRecordCut}
                disabled={isRecordingCut}
                className="mt-4 w-full"
              >
                <Scissors className="mr-1.5 h-4 w-4" />
                {isRecordingCut ? "Recording..." : "Cut"}
              </Button>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
