import { lazy, Suspense, useState } from "react"

import { PageHeader } from "@/components/patterns/page-header"
import { PageShell } from "@/components/patterns/page-shell"
import type { PartTemplate } from "@/components/cutting-engine/PresetDimensionSelector"
import type { StockConfig } from "@/components/cutting-engine/stock-preview-configurator"

/**
 * Free-roam nester — CAD-style manual part placement. Lives on its
 * own route so the pre-selection chrome (stock preview, preset
 * dimension selector, cut-list upload) that Auto nest requires is
 * absent — Free roam builds its own UI inside the three-column
 * workspace (parts added via the queue panel, stock editor lives in
 * the Saved-layouts rail, canvas is the CAD surface).
 *
 * TODO(desktop): saved layouts are not yet persisted — the
 * `FreeRoamSavedLayoutsRail` shows an empty list and `recordCut`
 * inside `FreeRoamContent` is a toast-only stub until a local
 * storage backend is wired up.
 */

// Lazy-load the CAD shell — Konva and react-konva are heavy and we
// shouldn't pull them in until the operator actually lands here.
const FreeRoamContent = lazy(() => import("@/components/cutting-engine/free-roam-content"))

const DEFAULT_STOCK: StockConfig = {
  width: 96,
  length: 48,
  material: "",
  thickness: 0.5,
}

// Sample parts seeded so the operator has something to click-place
// on a fresh visit. Replaced by real part entry (CSV upload + manual
// dialog) in a later commit.
const SEED_PARTS: PartTemplate[] = [
  {
    id: "seed-rect-24x12",
    label: '24" × 12"',
    summary: "Rectangle",
    partType: "rectangle",
    width: 24,
    length: 12,
    quantity: 4,
  } as PartTemplate,
  {
    id: "seed-rect-18x18",
    label: '18" × 18"',
    summary: "Rectangle",
    partType: "rectangle",
    width: 18,
    length: 18,
    quantity: 2,
  } as PartTemplate,
  {
    id: "seed-disc-10",
    label: '⌀ 10"',
    summary: "Disc",
    partType: "cylinder",
    diameter: 10,
    quantity: 3,
  } as PartTemplate,
]

export function FreeRoamPage() {
  const [parts, setParts] = useState<PartTemplate[]>(SEED_PARTS)
  const [stock, setStock] = useState<StockConfig>(DEFAULT_STOCK)

  return (
    <PageShell variant="dense">
      <PageHeader
        title="Free roam · Beta"
        subtitle="Manually author a layout — drag parts onto the sheet, snap to grid, rotate, commit as a cut. Same reusable-offcut (amber) and waste (red) semantics as Auto nest."
      />

      <Suspense
        fallback={
          <div className="flex h-96 items-center justify-center text-muted-foreground text-sm">
            Loading free-roam workspace…
          </div>
        }
      >
        <FreeRoamContent
          parts={parts}
          onPartsChange={setParts}
          stock={stock}
          onStockChange={setStock}
          refreshKey={0}
        />
      </Suspense>
    </PageShell>
  )
}
