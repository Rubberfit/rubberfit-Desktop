import { useState } from "react"
import { Scissors } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { type StockConfig } from "./stock-preview-configurator"
import { CutConfigCard } from "./cut-config-card"
// `RecordedCutSelect` was deleted as part of the desktop migration
// (DB-driven). Wave-2 will reintroduce a local-storage equivalent.
import { ResultsBreakdown } from "./results-breakdown"
import type { CutHistory } from "@/types/supabase-models"
import type { PartTemplate } from "./PresetDimensionSelector"
import type { SimpleCutDirection } from "./NestingVisualizer"
import type { SimpleCutMetrics } from "./nesting-visualizer-types"
import type { PackRequest } from "@/lib/packing/types"

type PackMode = NonNullable<PackRequest["mode"]>

const QUALITY_STEPS: Array<{ mode: PackMode; label: string; caption: string }> = [
  { mode: "fast", label: "Fast", caption: "~1s . good enough" },
  { mode: "balanced", label: "Balanced", caption: "~5s . recommended" },
  { mode: "thorough", label: "Thorough", caption: "~20s . best" },
]

interface StrategyResultsPanelProps {
  /** Stock geometry - read-only here; editor lives above the tabs. */
  stock: StockConfig
  // Cut config
  selectedTemplate: PartTemplate | null
  selectedTemplates: PartTemplate[]
  safeQuantity: number
  cutDirection: SimpleCutDirection
  setCutDirection: (d: SimpleCutDirection) => void
  customCutRatioInput: string
  setCustomCutRatioInput: (v: string) => void
  customCutRatios: number[] | undefined
  requestedSqFt: number
  // Results
  cutMetrics: SimpleCutMetrics | null
  onRecordCut: () => void
  isRecordingCut: boolean
  // History
  refreshKey: number
  onLoadCut: (cut: CutHistory) => void
}

export function StrategyResultsPanel({
  stock,
  selectedTemplate,
  selectedTemplates,
  safeQuantity,
  cutDirection,
  setCutDirection,
  customCutRatioInput,
  setCustomCutRatioInput,
  customCutRatios,
  requestedSqFt,
  cutMetrics,
  onRecordCut,
  isRecordingCut,
  refreshKey,
  onLoadCut,
}: StrategyResultsPanelProps) {
  // Quality mode is scaffold-only. Wiring to PackRequest lands in C8.
  const [packMode, setPackMode] = useState<PackMode>("balanced")

  // RecordedCutSelect was deleted; props stay on the surface for
  // wave-2's reintroduction.
  void onLoadCut
  void refreshKey

  return (
    <div className="flex flex-col gap-0 h-full">
      <div className="px-4 pt-4 pb-3 border-b border-border/40">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">Strategy &amp; results</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        <section>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Quality
          </p>
          <div className="flex rounded-md border border-border/60 overflow-hidden">
            {QUALITY_STEPS.map(({ mode, label }) => (
              <button
                key={mode}
                type="button"
                onClick={() => setPackMode(mode)}
                className={cn(
                  "flex-1 py-1.5 text-xs font-medium transition-colors",
                  packMode === mode
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-muted/60"
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground text-center">
            {QUALITY_STEPS.find((s) => s.mode === packMode)?.caption}
          </p>
        </section>

        {selectedTemplate && (
          <section>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Parameters
            </p>
            <CutConfigCard
              selectedTemplate={selectedTemplate}
              selectedTemplates={selectedTemplates}
              safeQuantity={safeQuantity}
              cutDirection={cutDirection}
              setCutDirection={setCutDirection}
              customCutRatioInput={customCutRatioInput}
              setCustomCutRatioInput={setCustomCutRatioInput}
              customCutRatios={customCutRatios}
              requestedSqFt={requestedSqFt}
            />
          </section>
        )}

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
