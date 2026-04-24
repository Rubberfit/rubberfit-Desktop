import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import { WorkspaceColumn, WorkspaceRow } from "@/components/patterns/workspace-column"
import type { CutHistory } from "@/types/supabase-models"
import type { PartTemplate } from "./PresetDimensionSelector"
import type { StockConfig } from "./stock-preview-configurator"
import type { SimpleCutMetrics } from "./nesting-visualizer-types"
import { PartsQueuePanel, type PartsFilter } from "./parts-queue-panel"
import { CanvasToolbar } from "./canvas-toolbar"
import KonvaSheetRenderer from "./KonvaSheetRenderer"
import { buildFreeRoamLayout } from "./free-roam-layout"
import { deriveManualMetrics } from "./free-roam-metrics"
import { useFreeRoamPlacements } from "./use-free-roam-placements"
import { FreeRoamSavedLayoutsRail } from "./free-roam-saved-layouts-rail"
import { computeAdaptiveRegions } from "./free-roam-regions"
import { useDragSnapshot } from "./use-drag-snapshot"
import { FreeRoamAddShapeDialog } from "./free-roam-add-shape-dialog"
// useRecordManualCut, useLoadManualCut, CutLoader were deleted as part
// of the desktop migration (DB-driven, not yet ported). Wave-2 will
// reintroduce them with a local-storage backend.

interface FreeRoamContentProps {
  parts: PartTemplate[]
  /** Fires when the operator adds a new shape from the registry. */
  onPartsChange: (parts: PartTemplate[]) => void
  stock: StockConfig
  onStockChange: (stock: StockConfig) => void
  refreshKey: number
  /**
   * Optional hook fired after a saved cut is loaded. State restoration
   * (placements, parts queue, stock) happens inside this component
   * since it owns those setters.
   */
  onAfterLoadCut?: (cut: CutHistory) => void
  /**
   * Fires after a manual cut is recorded so the parent can bump any
   * `refreshKey` / re-fetch side effects.
   */
  onCutRecorded?: () => void
}

export default function FreeRoamContent({
  parts,
  onPartsChange,
  stock,
  onStockChange,
  refreshKey,
  onAfterLoadCut,
  onCutRecorded,
}: FreeRoamContentProps) {
  const [partsFilter, setPartsFilter] = useState<PartsFilter>("all")
  const [addShapeOpen, setAddShapeOpen] = useState(false)
  const handleAddShape = useCallback(
    (template: PartTemplate) => {
      onPartsChange([...parts, template])
      toast.success(`${template.label} added to queue`)
    },
    [parts, onPartsChange]
  )

  const [zoomPct, setZoomPct] = useState(100)
  const [showGrid, setShowGrid] = useState(true)
  const handleResetView = useCallback(() => void (setZoomPct(100), setShowGrid(true)), [])
  const handleAddSheet = useCallback(() => {
    toast.message("Multi-sheet layouts", {
      description: "Coming in a later commit - the current sheet is the only one for now.",
    })
  }, [])

  const handleRotateSheet = useCallback(() => {
    onStockChange({ ...stock, width: stock.length, length: stock.width })
  }, [stock, onStockChange])

  const {
    placements,
    setPlacements,
    placedCounts,
    selectedPartId,
    setSelectedPartId,
    handleAddInstance,
    handlePartDragEnd,
  } = useFreeRoamPlacements(parts, stock, { onRotateSheet: handleRotateSheet })

  // STUB: rema-portal wired this up to a Supabase-backed loader. On
  // desktop the load path is wave-2's responsibility - for now the
  // handler is a no-op so the rail keeps compiling.
  const handleLoadCut = useCallback(
    (cut: CutHistory) => {
      // TODO(wave-2): hydrate placements/parts/stock from cut.* and
      // call setPlacements / onPartsChange / onStockChange.
      onAfterLoadCut?.(cut)
    },
    [onAfterLoadCut]
  )
  // Reference setPlacements so the unused-local lint stays quiet
  // before wave-2 wires it back into handleLoadCut.
  void setPlacements

  const blurIfEditable = () => {
    const active = document.activeElement as HTMLElement | null
    if (
      active &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)
    ) {
      active.blur()
    }
  }
  const handlePartClick = useCallback(
    (partId: string) => {
      blurIfEditable()
      setSelectedPartId(partId)
    },
    [setSelectedPartId]
  )
  const handleSheetClick = useCallback(() => {
    blurIfEditable()
    setSelectedPartId(null)
  }, [setSelectedPartId])

  const tagByTemplateId = useMemo(() => {
    const map = new Map<string, string>()
    let fallbackIdx = 0
    for (const part of parts) {
      if (part.partNumber) {
        map.set(part.id, part.partNumber)
      } else {
        let n = fallbackIdx++
        let tag = ""
        do {
          tag = String.fromCharCode(65 + (n % 26)) + tag
          n = Math.floor(n / 26) - 1
        } while (n >= 0)
        map.set(part.id, tag)
      }
    }
    return map
  }, [parts])

  const {
    snapshot: dragSnapshot,
    onDragMove: handlePartDragMove,
    onDragEnd: clearDragSnapshot,
  } = useDragSnapshot()

  const handlePartDragEndWrapped = useCallback(
    (partId: string, xIn: number, yIn: number) => {
      clearDragSnapshot()
      handlePartDragEnd(partId, xIn, yIn)
    },
    [clearDragSnapshot, handlePartDragEnd]
  )

  const effectivePlacements = useMemo(() => {
    if (!dragSnapshot) return placements
    return placements.map((p) =>
      p.id === dragSnapshot.partId ? { ...p, x: dragSnapshot.x, y: dragSnapshot.y } : p
    )
  }, [placements, dragSnapshot])

  const regions = useMemo(
    () => computeAdaptiveRegions(effectivePlacements, parts, stock),
    [effectivePlacements, parts, stock]
  )

  const layout = useMemo(() => {
    const base = buildFreeRoamLayout(effectivePlacements, parts, stock, tagByTemplateId)
    return { ...base, offcuts: regions.offcuts, scrap: regions.scrap }
  }, [effectivePlacements, parts, stock, tagByTemplateId, regions])

  const committedRegions = useMemo(
    () => (dragSnapshot ? computeAdaptiveRegions(placements, parts, stock) : regions),
    [placements, parts, stock, dragSnapshot, regions]
  )

  const derivedMetrics = useMemo<SimpleCutMetrics | null>(
    () => deriveManualMetrics(placements, parts, stock, committedRegions),
    [placements, parts, stock, committedRegions]
  )

  // STUB: rema-portal recorded the manual cut into Supabase. Wave-2
  // will replace this with a local-storage equivalent. For now the
  // rail keeps the same `onRecordCut` / `isRecordingCut` props so the
  // button renders, but the click is a soft no-op (toast only).
  const [isRecordingCut, setIsRecordingCut] = useState(false)
  const recordCut = useCallback(() => {
    setIsRecordingCut(true)
    toast.info("Cut persistence is not yet wired on desktop.")
    setIsRecordingCut(false)
    onCutRecorded?.()
  }, [onCutRecorded])

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background shadow-sm">
      <WorkspaceRow className="min-h-[560px]">
        <WorkspaceColumn column="left">
          <PartsQueuePanel
            parts={parts}
            activeFilter={partsFilter}
            onFilterChange={setPartsFilter}
            placedCounts={placedCounts}
            onAddInstance={handleAddInstance}
            onAddShape={() => setAddShapeOpen(true)}
          />
        </WorkspaceColumn>

        <WorkspaceColumn column="center">
          <div className="flex h-full flex-col">
            <CanvasToolbar
              zoom={zoomPct}
              onZoomChange={setZoomPct}
              showGrid={showGrid}
              onShowGridChange={setShowGrid}
              onResetView={handleResetView}
              onAddSheet={handleAddSheet}
            />
            <div className="relative flex-1 bg-muted/10 overflow-hidden">
              <KonvaSheetRenderer
                layout={layout}
                onPartDragEnd={handlePartDragEndWrapped}
                onPartDragMove={handlePartDragMove}
                selectedPartId={selectedPartId}
                onPartClick={handlePartClick}
                onSheetClick={handleSheetClick}
                defaultFill="offcut"
                zoomPct={zoomPct}
                showGrid={showGrid}
              />
              {parts.length === 0 ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
                  <div className="rounded-md border border-border/60 bg-background/95 px-3 py-2 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
                    Add parts from the queue to start.
                  </div>
                </div>
              ) : placements.length === 0 ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
                  <div className="rounded-md border border-border/60 bg-background/95 px-3 py-2 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
                    Click a part to place. Drag to move, click to select, R to rotate, Delete to
                    remove.
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </WorkspaceColumn>

        <WorkspaceColumn column="right" scroll="y">
          <FreeRoamSavedLayoutsRail
            stock={stock}
            onStockChange={onStockChange}
            cutMetrics={derivedMetrics}
            onRecordCut={recordCut}
            isRecordingCut={isRecordingCut}
            refreshKey={refreshKey}
            onLoadCut={handleLoadCut}
          />
        </WorkspaceColumn>
      </WorkspaceRow>

      <FreeRoamAddShapeDialog
        open={addShapeOpen}
        onOpenChange={setAddShapeOpen}
        onAdd={handleAddShape}
      />
    </div>
  )
}
