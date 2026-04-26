import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { FileUp, FileDown, Loader2, Ruler, Shapes, X } from "lucide-react"
import { save } from "@tauri-apps/plugin-dialog"
import { writeFile } from "@tauri-apps/plugin-fs"

import LayoutVisualizer from "@/components/cutting-engine/layout-visualizer"
import type {
  SimpleCutDirection,
  SimpleCutMetrics,
} from "@/components/cutting-engine/nesting-visualizer-types"
import PresetDimensionSelector, {
  type PartTemplate,
} from "@/components/cutting-engine/PresetDimensionSelector"
import CutListUpload from "@/components/cutting-engine/cut-list-upload"
import {
  StockPreviewConfigurator,
  STOCK_PRESETS,
  type StockConfig,
} from "@/components/cutting-engine/stock-preview-configurator"
import { CutConfigCard } from "@/components/cutting-engine/cut-config-card"
import { usePackGate, type PackGateStatus } from "@/hooks/cutting-engine/use-pack-gate"
import {
  getRequestedSqFt,
  getDefaultCutDirection,
  parseCutRatios,
} from "@/components/cutting-engine/cut-planner-utils"
import { buildCutPdf } from "@/components/cutting-engine/cut-history-pdf"
import type { LayoutModel } from "@/components/cutting-engine/layout-model"
import { usePackJob } from "@/components/cutting-engine/use-pack-job"
import { buildPart } from "@/lib/packing/buildPart"
import type { Bin, ConePackingMode, Part } from "@/lib/packing/types"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ExtractedPart } from "@/types/vision"
import type { MaterialType } from "@/types/supabase-models"

// ── Constants ────────────────────────────────────────────────────────────────

const DEMO_STOCK: StockConfig = {
  width: 96,
  length: 48,
  material: "",
  thickness: 0.5,
}

// Desktop has no DB-backed material catalog yet. Empty array keeps
// StockPreviewConfigurator's optional `materialTypes` prop happy and
// the dropdown falls back to a free-form text input.
const MATERIAL_TYPES: MaterialType[] = []

// ── Helpers ──────────────────────────────────────────────────────────────────

function LayoutLabel() {
  return <Ruler className="h-4 w-4 text-slate-500" />
}

/**
 * Map a `PartTemplate` to a canonical `Part` for the Rust packer.
 *
 * Each shape kind picks the matching `buildPart` `shapeSpec` so the
 * polygon vertices are generated consistently with the rema-portal
 * Rust pipeline:
 *   - rectangle → rect (width × length)
 *   - cylinder  → unrolled rect (π·diameter × height) — same flat
 *                 layout the legacy preview pipeline produced
 *   - circle    → circle (diameter)
 *   - cone      → sector (innerRadius / outerRadius / arcDegrees)
 *   - trapezoid → trapezoid (topWidth / bottomWidth / height)
 *
 * Returns `null` for templates missing required dimensions so the
 * caller can filter incomplete entries out of the request.
 */
function templateToPart(template: PartTemplate, tag: string | undefined): Part | null {
  const quantity = Math.max(1, template.quantity)
  try {
    switch (template.partType) {
      case "rectangle": {
        const width = template.width
        const length = template.length
        if (!(width && length)) return null
        return buildPart({
          shapeId: template.id,
          quantity,
          shapeSpec: { kind: "rect", params: { width, height: length } },
          allowRotation: true,
          tag,
        })
      }
      case "cylinder": {
        const d = template.diameter
        const h = template.height
        if (!(d && h)) return null
        return buildPart({
          shapeId: template.id,
          quantity,
          shapeSpec: { kind: "rect", params: { width: Math.PI * d, height: h } },
          allowRotation: true,
          tag,
        })
      }
      case "circle": {
        const d = template.diameter
        if (!d) return null
        return buildPart({
          shapeId: template.id,
          quantity,
          shapeSpec: { kind: "circle", params: { diameter: d } },
          allowRotation: true,
          tag,
        })
      }
      case "cone": {
        const innerRadius = template.innerRadius
        const outerRadius = template.outerRadius
        const arcDegrees = template.arcDegrees
        if (!(innerRadius != null && outerRadius && arcDegrees)) return null
        return buildPart({
          shapeId: template.id,
          quantity,
          shapeSpec: {
            kind: "sector",
            params: { innerRadius, outerRadius, arcDegrees },
          },
          allowRotation: true,
          tag,
        })
      }
      case "trapezoid": {
        const topWidth = template.topWidth
        const bottomWidth = template.bottomWidth
        const h = template.height
        if (!(topWidth && bottomWidth && h)) return null
        return buildPart({
          shapeId: template.id,
          quantity,
          shapeSpec: {
            kind: "trapezoid",
            params: { topWidth, bottomWidth, height: h },
          },
          allowRotation: true,
          tag,
        })
      }
      default:
        return null
    }
  } catch {
    // buildPart throws on degenerate dimensions (negative widths,
    // sub-3-vertex polygons, etc.) — drop the part rather than
    // crashing the page. The visualizer header surfaces the
    // resulting low part-count via its overflow badge.
    return null
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function AutoNestPage() {
  const [presetParts, setPresetParts] = useState<PartTemplate[]>([])
  const [uploadedParts, setUploadedParts] = useState<PartTemplate[]>([])
  const [cutDirection, setCutDirection] = useState<SimpleCutDirection>("vertical_split")
  const [customCutRatioInput, setCustomCutRatioInput] = useState("")
  const [stock, setStock] = useState<StockConfig>(DEMO_STOCK)
  const [cutMetrics, setCutMetrics] = useState<SimpleCutMetrics | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  // Debug overlay: draw jagua's pack polygon when it differs from the
  // rendered shape. Currently cone-only in default hull-packing mode.
  // Off by default; surfaces in the Graph card header only when at
  // least one cone is being packed.
  const [showPackHullOverlay, setShowPackHullOverlay] = useState(false)
  const [showInscribedScrapRects, setShowInscribedScrapRects] = useState(false)
  const [showAabbOverlays, setShowAabbOverlays] = useState(false)
  const [conePackingMode, setConePackingMode] = useState<ConePackingMode>("annularSector")
  const { status: packStatus, requestPack, invalidate } = usePackGate()

  const selectedTemplates = useMemo(
    () => [...uploadedParts, ...presetParts],
    [uploadedParts, presetParts]
  )
  const selectedTemplate = selectedTemplates[0] ?? null

  const requestedSqFt = useMemo(() => getRequestedSqFt(selectedTemplates), [selectedTemplates])

  // Tag map: keyed by String(index) → tag value.
  // Uses part numbers (e.g. "G2") when available, falls back to generated letters (A, B, C…).
  const tagMap = useMemo(() => {
    let fallbackIdx = 0
    return new Map(
      selectedTemplates.map((t, i) => {
        if (t.partNumber) return [String(i), t.partNumber]
        let tag = ""
        let n = fallbackIdx++
        do {
          tag = String.fromCharCode(65 + (n % 26)) + tag
          n = Math.floor(n / 26) - 1
        } while (n >= 0)
        return [String(i), tag]
      })
    )
  }, [selectedTemplates])

  // Lookup by template ID → tag letter (for preset grid badges + uploaded parts)
  const tagByTemplateId = useMemo(() => {
    return new Map(selectedTemplates.map((t, i) => [t.id, tagMap.get(String(i)) ?? ""]))
  }, [selectedTemplates, tagMap])

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleTemplateApply = useCallback((templates: PartTemplate[]) => {
    setPresetParts(templates)
    setCutDirection(getDefaultCutDirection(templates[0]?.partType ?? "rectangle"))
    setCustomCutRatioInput("")
  }, [])

  const handleUploadedParts = (parts: ExtractedPart[], stockWidth?: number) => {
    const uploaded: PartTemplate[] = parts.map((p, i) => {
      const id = `uploaded-${Date.now()}-${i}`
      const summary = p.partNumber ? `Uploaded: ${p.partNumber}` : "Uploaded dimension"
      const base = {
        id,
        summary,
        quantity: p.quantity,
        category: "custom" as const,
        isCustom: true,
        partNumber: p.partNumber,
      }
      switch (p.shapeType) {
        case "rectangle":
          return {
            ...base,
            partType: "rectangle",
            label: `${p.width}" × ${p.length}"`,
            width: p.width,
            length: p.length,
          }
        case "cylinder":
          return {
            ...base,
            partType: "cylinder",
            label: `Ø${p.diameter}" × ${p.height}"`,
            diameter: p.diameter,
            height: p.height,
          }
        case "cone":
          return {
            ...base,
            partType: "cone",
            label: `Cone r${p.innerRadius}–${p.outerRadius}" @ ${p.arcDegrees}°`,
            innerRadius: p.innerRadius,
            outerRadius: p.outerRadius,
            arcDegrees: p.arcDegrees,
          }
        case "trapezoid":
          return {
            ...base,
            partType: "trapezoid",
            label: `Trap ${p.topWidth}/${p.bottomWidth}" × ${p.height}"`,
            topWidth: p.topWidth,
            bottomWidth: p.bottomWidth,
            height: p.height,
          }
      }
    })
    setUploadedParts((prev) => [...prev, ...uploaded])
    if (stockWidth && stockWidth > 0) {
      setStock((prev) => ({ ...prev, width: stockWidth }))
    }
  }

  const removeUploadedPart = (id: string) => {
    setUploadedParts((prev) => prev.filter((p) => p.id !== id))
  }

  const clearUploadedParts = () => {
    setUploadedParts([])
  }

  const safeQuantity = Math.max(1, selectedTemplate?.quantity ?? 1)
  const customCutRatios = useMemo(
    () => parseCutRatios(customCutRatioInput, safeQuantity),
    [customCutRatioInput, safeQuantity]
  )
  const activeStockPreset = STOCK_PRESETS.find(
    (preset) => preset.width === stock.width && preset.length === stock.length
  )?.id

  // Build canonical Parts[] for the Rust pipeline directly from
  // PartTemplate dimensions. Each template becomes one Part with its
  // tag (from tagByTemplateId) so the Rust side echoes the tag onto
  // every produced Placement (see use-pack-job + Phase A2).
  const packParts = useMemo<Part[]>(
    () =>
      selectedTemplates
        .map((t) => templateToPart(t, tagByTemplateId.get(t.id)))
        .filter((p): p is Part => p !== null),
    [selectedTemplates, tagByTemplateId]
  )

  // One bin per stock sheet. Phase A's pack_lbf_lns processes a
  // single-bin request directly; multi-bin (overflow → next sheet)
  // can be wired by extending this array later.
  const packBins = useMemo<Bin[]>(
    () => [
      {
        binId: "stock-1",
        width: stock.width,
        height: stock.length,
        kind: "fresh",
      },
    ],
    [stock.width, stock.length]
  )

  // Drive the Rust pack only when the gate has flipped to "done".
  // The 450ms loader window in usePackGate stays as decorative UX.
  const {
    layouts: packLayouts,
    isPacking,
    packError,
  } = usePackJob({
    bins: packBins,
    parts: packParts,
    clearance: 0.125,
    templates: selectedTemplates,
    tagByShapeId: tagByTemplateId,
    enabled: packStatus === "done",
    conePackingMode,
  })

  // Whether any selected/uploaded part is a cone — gates the cone
  // strategy selector so non-cone workflows don't see an irrelevant
  // control. Reads the canonical Part shape spec rather than the
  // template's `partType` so behavior matches what Rust receives.
  const hasCones = useMemo(
    () => packParts.some((p) => p.shapeSpec?.kind === "sector"),
    [packParts]
  )
  const canShowPackHullOverlay = hasCones && conePackingMode === "convexHull"

  // PDF export consumes layouts. usePackJob owns them now; mirror the
  // hook output into a non-null array so downstream code stays simple.
  const layouts = useMemo<LayoutModel[]>(() => packLayouts ?? [], [packLayouts])

  // Pack-gate invalidation. Whenever any input that feeds the packer
  // changes, drop the gate back to `idle` and clear the prior layout's
  // metrics so the Export-PDF button doesn't promise a stale layout.
  // (usePackJob owns the layouts state; it stops returning fresh data
  // once `enabled` flips to false on the next render.) The operator
  // must press Pack again to recompute.
  useEffect(() => {
    invalidate()
    setCutMetrics(null)
  }, [selectedTemplates, stock, cutDirection, customCutRatios, conePackingMode, invalidate])

  const totalRequestedCuts = useMemo(
    () => selectedTemplates.reduce((sum, t) => sum + Math.max(1, t.quantity), 0),
    [selectedTemplates]
  )

  // ── Export to PDF via Tauri save dialog ───────────────────────────────────
  // Rema-portal's `buildAndUploadCutPdf` uploaded the blob to Supabase
  // Storage and stamped the URL onto the cut_history row. Desktop has
  // no DB-backed cut history yet — instead we let the user pick a
  // location on disk and write the bytes directly via Tauri's fs
  // plugin. The synthetic cutId is just the PDF metadata field; nothing
  // downstream looks it up.
  const handleExportPdf = useCallback(async () => {
    if (!selectedTemplate) return
    setIsExporting(true)
    try {
      const path = await save({
        defaultPath: `cut-${Date.now()}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      })
      if (!path) {
        // User cancelled the dialog.
        setIsExporting(false)
        return
      }

      // Build tag→label map for PDF legend (keyed by tag letter, value
      // is dimension label). Mirrors the rema-portal contract.
      const pdfTagMap = new Map<string, string>()
      for (const [idxStr, tag] of tagMap.entries()) {
        const t = selectedTemplates[Number(idxStr)]
        if (t) pdfTagMap.set(tag, t.label)
      }

      const cutId = `desktop-${Date.now()}`
      const blob = await buildCutPdf(
        cutId,
        stock,
        cutMetrics,
        selectedTemplate,
        selectedTemplates,
        pdfTagMap,
        layouts
      )
      if (!blob) {
        toast.error("Failed to generate PDF")
        return
      }

      const bytes = new Uint8Array(await blob.arrayBuffer())
      await writeFile(path, bytes)
      toast.success("PDF saved")
    } catch (err) {
      console.error("PDF export failed:", err)
      toast.error("Failed to save PDF", {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setIsExporting(false)
    }
  }, [selectedTemplate, selectedTemplates, stock, cutMetrics, tagMap, layouts])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <Badge variant="outline" className="w-fit">
            Cutting Engine
          </Badge>
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-300">
              Auto Nest
            </h1>
            <p className="text-slate-600 dark:text-slate-400">
              Select a finished profile, choose the standard size, set the cut count, and preview
              the nested cut sheet for rectangles, strips, wraps, spreads, and panel layouts.
            </p>
          </div>
        </div>
      </div>

      <CutListUpload onPartsConfirmed={handleUploadedParts} />

      {uploadedParts.length > 0 && (
        <Card className="border border-slate-200 shadow-sm">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <FileUp className="h-4 w-4 text-blue-500" />
                Uploaded Parts
                <Badge variant="secondary" className="ml-1 text-xs">
                  {uploadedParts.reduce((sum, p) => sum + p.quantity, 0)} cuts
                </Badge>
              </CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={clearUploadedParts}
                className="h-7 text-xs text-muted-foreground hover:text-destructive"
              >
                <X className="mr-1 h-3 w-3" />
                Clear All
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {uploadedParts.map((part) => {
                const tag = tagByTemplateId.get(part.id)
                return (
                  <div
                    key={part.id}
                    className="group flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 pl-1 pr-2 py-1 text-xs transition-colors hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600"
                  >
                    {tag && (
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-800 text-[10px] font-bold text-white dark:bg-slate-200 dark:text-slate-800">
                        {tag}
                      </span>
                    )}
                    <span className="font-medium">{part.label}</span>
                    {part.quantity > 1 && (
                      <span className="text-muted-foreground">qty {part.quantity}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeUploadedPart(part.id)}
                      className="ml-0.5 rounded-full p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                      aria-label="Remove part"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <StockPreviewConfigurator
        activeStockPreset={activeStockPreset}
        stock={stock}
        onStockChange={setStock}
        materialTypes={MATERIAL_TYPES}
      />

      <PresetDimensionSelector
        onApply={handleTemplateApply}
        rollWidth={stock.width}
        rollLength={stock.length}
        tagMap={tagByTemplateId}
      />

      {selectedTemplates.length > 0 && selectedTemplate ? (
        <>
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

          <Card className="border border-slate-200 shadow-sm">
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <LayoutLabel />
                  4. Graph
                </CardTitle>
                <div className="flex items-center gap-3">
                  {hasCones && (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      Cone collision
                      <Select
                        value={conePackingMode}
                        onValueChange={(value) => setConePackingMode(value as ConePackingMode)}
                      >
                        <SelectTrigger size="sm" className="w-[138px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="convexHull">Convex hull</SelectItem>
                          <SelectItem value="annularSector">Actual cone</SelectItem>
                        </SelectContent>
                      </Select>
                    </label>
                  )}
                  {canShowPackHullOverlay && (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Checkbox
                        checked={showPackHullOverlay}
                        onCheckedChange={(v) => setShowPackHullOverlay(v === true)}
                      />
                      Show pack hull
                    </label>
                  )}
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={showInscribedScrapRects}
                      onCheckedChange={(v) => setShowInscribedScrapRects(v === true)}
                    />
                    Show inscribed rects
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={showAabbOverlays}
                      onCheckedChange={(v) => setShowAabbOverlays(v === true)}
                    />
                    Show AABBs
                  </label>
                  {cutMetrics !== null && cutMetrics.partsCompleted > 0 && (
                    <Button size="sm" onClick={handleExportPdf} disabled={isExporting}>
                      <FileDown className="mr-1.5 h-4 w-4" />
                      {isExporting ? "Saving…" : "Export PDF"}
                    </Button>
                  )}
                </div>
              </div>
              <CardDescription>
                The graph starts from rectangular stock and shows the actual cut pieces placed on
                that stock, with reusable offcut in amber and waste in red.
              </CardDescription>
            </CardHeader>

            <CardContent>
              {packStatus === "done" ? (
                <LayoutVisualizer
                  layouts={packLayouts}
                  defaultStockWidth={stock.width}
                  defaultStockLength={stock.length}
                  isPacking={isPacking}
                  packError={packError}
                  onMetricsChange={setCutMetrics}
                  debugOptions={{
                    showPackHullOverlay: canShowPackHullOverlay && showPackHullOverlay,
                    showInscribedScrapRects,
                    showAabbOverlays,
                  }}
                />
              ) : (
                <PackPrompt
                  status={packStatus}
                  partCount={totalRequestedCuts}
                  stockLabel={`${stock.width}" × ${stock.length}"`}
                  onPack={requestPack}
                />
              )}
            </CardContent>
          </Card>
        </>
      ) : (
        <Card className="border border-slate-200 shadow-sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <LayoutLabel />
                4. Graph
              </CardTitle>
            </div>
            <CardDescription>
              The loaded stock sheet — no cuts placed yet. Pick a part above to start nesting onto
              it; the layout stays put.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LayoutVisualizer defaultStockWidth={stock.width} defaultStockLength={stock.length} />
            <div className="mt-4 flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-slate-600 text-xs dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
              <Shapes className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                Pick a preset or upload a cut list to start nesting parts onto this sheet.
              </span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

interface PackPromptProps {
  status: PackGateStatus
  partCount: number
  stockLabel: string
  onPack: () => void
}

// Pre-pack placeholder shown inside the Graph card when the pack
// gate hasn't been satisfied yet. Replaces the previous behavior of
// running the packer on every input change. Mirrors the rema-portal
// "press Pack to render" UX so operators can stage 100+ parts without
// the packer churning between every edit.
function PackPrompt({ status, partCount, stockLabel, onPack }: PackPromptProps) {
  const isPacking = status === "packing"
  const partsLabel = `${partCount} cut${partCount === 1 ? "" : "s"}`

  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-slate-200 bg-slate-50 px-6 py-12 text-center dark:border-slate-700 dark:bg-slate-800/40">
      <div className="text-sm font-medium text-foreground">
        {isPacking ? "Packing…" : "Ready to pack"}
      </div>
      <div className="text-xs text-muted-foreground">
        {partsLabel} · Stock {stockLabel}
      </div>
      {isPacking ? (
        <Loader2 className="h-5 w-5 animate-spin text-blue-500" aria-hidden="true" />
      ) : (
        <Button onClick={onPack} disabled={partCount === 0} size="sm">
          Pack
        </Button>
      )}
      {!isPacking && (
        <p className="max-w-md text-[11px] text-muted-foreground/80">
          Layout is computed only when you press Pack. Editing parts, stock, or cut direction resets
          this prompt so the next pack reflects the latest inputs.
        </p>
      )}
    </div>
  )
}
