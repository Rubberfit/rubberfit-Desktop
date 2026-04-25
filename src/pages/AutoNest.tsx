import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { FileUp, FileDown, Ruler, Shapes, X } from "lucide-react"
import { save } from "@tauri-apps/plugin-dialog"
import { writeFile } from "@tauri-apps/plugin-fs"

import NestingVisualizer from "@/components/cutting-engine/NestingVisualizer"
import type { SimpleCutDirection } from "@/components/cutting-engine/NestingVisualizer"
import type { SimpleCutMetrics } from "@/components/cutting-engine/nesting-visualizer-types"
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
import {
  getRequestedSqFt,
  getDefaultCutDirection,
  parseCutRatios,
} from "@/components/cutting-engine/cut-planner-utils"
import { buildCutPdf } from "@/components/cutting-engine/cut-history-pdf"
import type { LayoutModel } from "@/components/cutting-engine/layout-model"
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

// ── Page ─────────────────────────────────────────────────────────────────────

export function AutoNestPage() {
  const [presetParts, setPresetParts] = useState<PartTemplate[]>([])
  const [uploadedParts, setUploadedParts] = useState<PartTemplate[]>([])
  const [cutDirection, setCutDirection] = useState<SimpleCutDirection>("vertical_split")
  const [customCutRatioInput, setCustomCutRatioInput] = useState("")
  const [stock, setStock] = useState<StockConfig>(DEMO_STOCK)
  const [cutMetrics, setCutMetrics] = useState<SimpleCutMetrics | null>(null)
  // LayoutModel[] emitted by NestingVisualizer — used by cut-history-pdf
  // to render vector shapes instead of scraping DOM SVG.
  const [layouts, setLayouts] = useState<LayoutModel[]>([])
  const [isExporting, setIsExporting] = useState(false)

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

  const nestingSimpleParts = useMemo(
    () =>
      selectedTemplates.map((template) => ({
        partType: template.partType,
        quantity: template.quantity,
        cutDirection,
        cutRatios: customCutRatios,
        width: template.width,
        length: template.length,
        diameter: template.diameter,
        height: template.height,
        topWidth: template.topWidth,
        bottomWidth: template.bottomWidth,
        innerRadius: template.innerRadius,
        outerRadius: template.outerRadius,
        arcDegrees: template.arcDegrees,
        partNumber: template.partNumber,
      })),
    [selectedTemplates, cutDirection, customCutRatios]
  )

  const nestingSimplePart = useMemo(
    () =>
      selectedTemplate
        ? {
            partType: selectedTemplate.partType,
            quantity: safeQuantity,
            cutDirection,
            cutRatios: customCutRatios,
            width: selectedTemplate.width,
            length: selectedTemplate.length,
            diameter: selectedTemplate.diameter,
            height: selectedTemplate.height,
            topWidth: selectedTemplate.topWidth,
            bottomWidth: selectedTemplate.bottomWidth,
            innerRadius: selectedTemplate.innerRadius,
            outerRadius: selectedTemplate.outerRadius,
            arcDegrees: selectedTemplate.arcDegrees,
          }
        : undefined,
    [selectedTemplate, safeQuantity, cutDirection, customCutRatios]
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
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <LayoutLabel />
                  4. Graph
                </CardTitle>
                {cutMetrics !== null && cutMetrics.partsCompleted > 0 && (
                  <Button size="sm" onClick={handleExportPdf} disabled={isExporting}>
                    <FileDown className="mr-1.5 h-4 w-4" />
                    {isExporting ? "Saving…" : "Export PDF"}
                  </Button>
                )}
              </div>
              <CardDescription>
                The graph starts from rectangular stock and shows the actual cut pieces placed on
                that stock, with reusable offcut in amber and waste in red.
              </CardDescription>
            </CardHeader>

            <CardContent>
              <NestingVisualizer
                defaultRollWidth={stock.width}
                defaultRollLength={stock.length}
                defaultCutWidth={selectedTemplate.width ?? selectedTemplate.diameter ?? 24}
                defaultCutHeight={selectedTemplate.length ?? selectedTemplate.height ?? 24}
                defaultQty={safeQuantity}
                onMetricsChange={setCutMetrics}
                onLayoutChange={setLayouts}
                simpleParts={nestingSimpleParts}
                simplePart={nestingSimplePart}
              />
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
            <NestingVisualizer
              defaultRollWidth={stock.width}
              defaultRollLength={stock.length}
              defaultCutWidth={Math.max(1, stock.width / 4)}
              defaultCutHeight={Math.max(1, stock.length / 8)}
              defaultQty={0}
              simpleParts={[]}
            />
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
