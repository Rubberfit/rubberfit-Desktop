// LayoutModel-driven SVG renderer for AutoNest.
//
// Replaces NestingVisualizer's coupling to the legacy SimplePartPreview
// shape. Inputs are pre-computed LayoutModels (one per stock sheet)
// produced by `pack-result-to-layout-model.ts` from the Rust pack_job
// output. This component is pure presentation — no packing, no
// free-space computation.
//
// Issue #13 — closes out the AutoNest TypeScript → Rust migration
// (issue #12 Phase B5).

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import type { LayoutModel, LayoutRegion, PlacedPart, RenderShape } from "./layout-model"
import type { SimpleCutMetrics } from "./nesting-visualizer-types"
import { formatInches } from "./format-inches"
import { partLabelCenter } from "./part-label"

// ── Display constants ─────────────────────────────────────────────────────

const VIEW_WIDTH = 980
const VIEW_HEIGHT = 560
const PAD_LEFT = 74
const PAD_RIGHT = 112
const PAD_TOP = 82
const PAD_BOTTOM = 80

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Debug overlay toggles. Bundled into a single prop so the visualizer
 * tree's signatures don't grow each time we add a new diagnostic
 * overlay. Consumers spread the fields they care about; everything
 * else stays `undefined` and is treated as off.
 */
export interface DebugOverlayOptions {
  /**
   * If true, draw each placed part's `packPolygon` as a translucent
   * dashed amber stroke on top of the rendered shape. Cone-only today,
   * and only present when the cone collision surface differs from the
   * rendered annular sector.
   */
  showPackHullOverlay?: boolean
  /**
   * Paint each `LayoutModel.debugScrapRects` entry as a dashed
   * darker-red outline so the operator can see the raw inscribed-rect
   * / monotonic-histogram output from `extract_offcuts_with_obstacles`.
   * Production rendering ignores these rects (they overlap the
   * bin-wide scrap polygon already).
   */
  showInscribedScrapRects?: boolean
  /**
   * Paint axis-aligned bounding boxes for every placed part (violet)
   * and every reusable offcut (emerald). Diagnostic for the case
   * where a curved shape's silhouette appears to dip into a reusable
   * offcut: if the part's AABB doesn't overlap any offcut's AABB,
   * the apparent intrusion is just the silhouette outside the AABB,
   * not a classifier miss.
   */
  showAabbOverlays?: boolean
}

export interface LayoutVisualizerProps {
  /**
   * Pre-computed layouts (one per stock sheet) from `usePackJob`.
   * `null` / empty array → renders the empty stock placeholder.
   */
  layouts?: LayoutModel[] | null
  /** Stock dimensions for the empty-state render (and fallback header). */
  defaultStockWidth: number
  defaultStockLength: number
  /** True while a Rust pack is in flight. */
  isPacking?: boolean
  /** Error message from the last pack attempt, if any. */
  packError?: string | null
  /**
   * Receives a `SimpleCutMetrics` summary every time `layouts` updates.
   * Compatible with the existing `cut-history-pdf` consumer.
   */
  onMetricsChange?: (metrics: SimpleCutMetrics) => void
  /**
   * Echoes `layouts` upward whenever they change. The PDF exporter
   * subscribes through this so it can render vector shapes from
   * the same `LayoutModel` data the visualizer paints.
   */
  onLayoutChange?: (layouts: LayoutModel[]) => void
  /** Diagnostic overlays. See {@link DebugOverlayOptions}. */
  debugOptions?: DebugOverlayOptions
}

export default function LayoutVisualizer({
  layouts,
  defaultStockWidth,
  defaultStockLength,
  isPacking,
  packError,
  onMetricsChange,
  onLayoutChange,
  debugOptions,
}: LayoutVisualizerProps) {
  const patternSeed = useId().replace(/:/g, "")
  const sheets = layouts && layouts.length > 0 ? layouts : null

  // Push metrics + layouts upward whenever the input changes.
  useEffect(() => {
    if (!sheets) return
    if (onLayoutChange) onLayoutChange(sheets)
    if (onMetricsChange) onMetricsChange(buildMetrics(sheets))
  }, [sheets, onLayoutChange, onMetricsChange])

  if (!sheets) {
    // Three sub-states for the no-layouts branch:
    //   1. isPacking → centred "Packing…" indicator (Rust call in
    //      flight; flashing the empty sheet here looks like a regression).
    //   2. packError → centred error block.
    //   3. otherwise → empty stock placeholder (truly idle).
    return (
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <SheetHeader
          title="Rubber Sheet Nesting Layout"
          subtitle={
            isPacking
              ? "Packing…"
              : packError
                ? `Pack failed: ${packError}`
                : "No parts placed yet."
          }
          totals={null}
        />
        <div className="bg-card px-2 py-4 sm:px-4">
          {isPacking ? (
            <PackingPlaceholder />
          ) : packError ? (
            <ErrorPlaceholder message={packError} />
          ) : (
            <EmptySheet
              sheetWidth={defaultStockWidth}
              sheetLength={defaultStockLength}
              patternSeed={patternSeed}
            />
          )}
        </div>
      </div>
    )
  }

  const isMulti = sheets.length > 1
  const totals = buildTotals(sheets)
  // "Sheet N of M" headers count real packed bins only; promoted
  // reusable offcuts get their own header style and don't bump M.
  const standardTotal = sheets.filter((s) => s.sheetKind !== "offcut-extract").length

  let standardCounter = 0
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <SheetHeader
        title="Rubber Sheet Nesting Layout"
        subtitle={summaryLine(sheets)}
        totals={totals}
        isPacking={isPacking}
        packError={packError}
        sheetCount={standardTotal}
      />

      <Legend layouts={sheets} />

      <div
        className={`bg-card px-2 py-4 sm:px-4 ${
          isMulti ? "flex flex-col gap-6" : "overflow-x-auto"
        }`}
      >
        {sheets.map((layout, i) => {
          const isExtract = layout.sheetKind === "offcut-extract"
          const standardNumber = isExtract ? undefined : ++standardCounter
          return (
            <SheetSvg
              key={`sheet-${i}`}
              layout={layout}
              totalSheets={sheets.length}
              standardNumber={standardNumber}
              standardTotal={standardTotal}
              patternSeed={`${patternSeed}-s${i}`}
              debugOptions={debugOptions}
            />
          )
        })}
      </div>

      <SheetMetricsFooter totals={totals} />
    </div>
  )
}

// ── Header / Metrics chips ────────────────────────────────────────────────

interface Totals {
  usedSqFt: number
  reusableSqFt: number
  scrapSqFt: number
  stockSqFt: number
  partsPlaced: number
  partsOverflow: number
  fabScore: number
  reusableOffcutCount: number
}

function buildTotals(sheets: LayoutModel[]): Totals {
  let usedSqFt = 0
  let reusableSqFt = 0
  let scrapSqFt = 0
  let stockSqFt = 0
  let partsPlaced = 0
  let partsOverflow = 0
  let weightedFab = 0
  let standardCount = 0
  let reusableOffcutCount = 0
  for (const s of sheets) {
    const isExtract = s.sheetKind === "offcut-extract"
    usedSqFt += s.usedAreaSqFt
    reusableSqFt += s.reusableAreaSqFt
    scrapSqFt += s.scrapAreaSqFt
    if (!isExtract) {
      // Synthetic offcut sheets are derived from a parent's stock —
      // counting their area would double-count the underlying material.
      stockSqFt += (s.sheetWidth * s.sheetLength) / 144
      weightedFab += s.fabScore
      standardCount++
    }
    // Each reusable offcut piece counts once: promotion removes the
    // piece from its parent's offcuts[] and re-adds it as the single
    // entry on the synthetic, so summing across all sheets is the
    // distinct-piece count regardless of promotion state.
    reusableOffcutCount += s.offcuts.length
    partsPlaced += s.placedCount
    partsOverflow += s.overflowCount
  }
  const fabScore = standardCount > 0 ? weightedFab / standardCount : 0
  return {
    usedSqFt,
    reusableSqFt,
    scrapSqFt,
    stockSqFt,
    partsPlaced,
    partsOverflow,
    fabScore,
    reusableOffcutCount,
  }
}

function buildMetrics(sheets: LayoutModel[]): SimpleCutMetrics {
  const t = buildTotals(sheets)
  const offcutPieces = sheets.flatMap((s) =>
    s.offcuts.map((o) => ({
      widthIn: o.width,
      lengthIn: o.height,
      areaSqft: (o.width * o.height) / 144,
    }))
  )
  return {
    partsCompleted: t.partsPlaced,
    cutPieces: t.partsPlaced,
    materialUsedSqFt: t.usedSqFt,
    reusableOffsetSqFt: t.reusableSqFt,
    scrapSqFt: t.scrapSqFt,
    fabScore: t.fabScore,
    offcutPieces,
  }
}

function summaryLine(sheets: LayoutModel[]): string {
  const t = buildTotals(sheets)
  const standardCount = sheets.filter((s) => s.sheetKind !== "offcut-extract").length
  const sheetWord = standardCount === 1 ? "sheet" : "sheets"
  const overflowSuffix = t.partsOverflow > 0 ? `, ${t.partsOverflow} overflow` : ""
  return `${standardCount} ${sheetWord}, ${t.partsPlaced} parts placed${overflowSuffix}`
}

function SheetHeader({
  title,
  subtitle,
  totals,
  isPacking,
  packError,
  sheetCount,
}: {
  title: string
  subtitle: string
  totals: Totals | null
  isPacking?: boolean
  packError?: string | null
  sheetCount?: number
}) {
  const reusablePct =
    totals && totals.stockSqFt > 0 ? (totals.reusableSqFt / totals.stockSqFt) * 100 : 0
  const scrapPct = totals && totals.stockSqFt > 0 ? (totals.scrapSqFt / totals.stockSqFt) * 100 : 0

  return (
    <div className="border-b border-border bg-muted/30 px-4 py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">{title}</div>
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        </div>
        {totals && (
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-green-500/40 bg-green-500/10 px-3 py-1 font-medium text-green-600">
              Cut pieces: {totals.partsPlaced}
            </span>
            {totals.reusableSqFt > 0 && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 font-medium text-amber-600">
                Reusable offcut: {reusablePct.toFixed(1)}%
              </span>
            )}
            {totals.reusableOffcutCount > 0 && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 font-medium text-amber-600">
                {totals.reusableOffcutCount} reusable piece
                {totals.reusableOffcutCount === 1 ? "" : "s"}
              </span>
            )}
            <span className="rounded-full border border-red-500/40 bg-red-500/10 px-3 py-1 font-medium text-red-600">
              Waste: {scrapPct.toFixed(1)}%
            </span>
            {totals.partsOverflow > 0 && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 font-medium text-amber-600">
                +{totals.partsOverflow} part{totals.partsOverflow === 1 ? "" : "s"} overflow
              </span>
            )}
            {sheetCount && sheetCount > 1 && (
              <span className="rounded-full border border-blue-500/40 bg-blue-500/10 px-3 py-1 font-medium text-blue-400">
                {sheetCount} sheets
              </span>
            )}
            <span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-3 py-1 font-medium text-violet-300">
              Rust packed
            </span>
            {isPacking && (
              <span className="rounded-full border border-stone-500/40 bg-stone-500/10 px-3 py-1 font-medium text-stone-400 animate-pulse">
                Packing…
              </span>
            )}
            {packError && (
              <span
                className="rounded-full border border-red-500/40 bg-red-500/10 px-3 py-1 font-medium text-red-400"
                title={packError}
              >
                Error
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Legend ────────────────────────────────────────────────────────────────

function Legend({ layouts }: { layouts: LayoutModel[] }) {
  // Distinct (tag, descriptor) pairs across all sheets. The descriptor
  // is the part's *dimensions* — uploaded parts no longer carry a
  // human-readable partNumber, and falling through to shapeId leaks
  // internal IDs like "uploaded-1733000000000-0" into the legend.
  // Showing dimensions matches the Reusable Offcuts card and the
  // upload-review dialog and is the most useful identifier for an
  // operator picking parts off the layout.
  const seen = new Map<string, string>()
  for (const layout of layouts) {
    for (const part of layout.parts) {
      const key = part.label
      if (!seen.has(key)) {
        seen.set(key, partDimensionLabel(part))
      }
    }
  }
  if (seen.size === 0) return null
  return (
    <div className="flex flex-wrap gap-3 border-b border-border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
      {[...seen.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([tag, label]) => (
          <span key={tag} className="flex items-center gap-1.5">
            <span
              className="inline-flex h-5 w-5 items-center justify-center rounded border text-[10px] font-bold leading-none shadow-sm"
              style={tagPillStyle(tag)}
            >
              {tag}
            </span>
            <span>{label}</span>
          </span>
        ))}
    </div>
  )
}

/**
 * Human-readable dimension label for a placed part. Mirrors the
 * label format the upload-review dialog and the preset template grid
 * use (width × length for rects, Ø for circles, top/bottom for
 * trapezoids, etc.). Falls back to the placement bbox when the
 * shape-specific fields aren't populated.
 */
function partDimensionLabel(part: PlacedPart): string {
  switch (part.renderShape) {
    case "circle":
      if (part.diameter != null && part.diameter > 0) {
        return `Ø${formatInches(part.diameter)}"`
      }
      break
    case "trapezoid":
      if (part.topWidth != null && part.bottomWidth != null) {
        return `${formatInches(part.topWidth)}/${formatInches(part.bottomWidth)}" × ${formatInches(part.height)}"`
      }
      break
    case "sector":
      if (
        part.innerRadius != null &&
        part.outerRadius != null &&
        part.arcDegrees != null
      ) {
        return `Cone R${formatInches(part.innerRadius)}-${formatInches(part.outerRadius)}" · ${formatInches(part.arcDegrees)}°`
      }
      break
    case "ring":
      if (part.innerRadius != null && part.outerRadius != null) {
        return `Ring ${formatInches(part.innerRadius)}-${formatInches(part.outerRadius)}"`
      }
      break
  }
  return `${formatInches(part.width)}" × ${formatInches(part.height)}"`
}

const TAG_PILL_COLORS = [
  { backgroundColor: "#2563eb", borderColor: "#1d4ed8", color: "#ffffff" },
  { backgroundColor: "#059669", borderColor: "#047857", color: "#ffffff" },
  { backgroundColor: "#7c3aed", borderColor: "#6d28d9", color: "#ffffff" },
  { backgroundColor: "#be123c", borderColor: "#9f1239", color: "#ffffff" },
  { backgroundColor: "#0f766e", borderColor: "#115e59", color: "#ffffff" },
  { backgroundColor: "#c2410c", borderColor: "#9a3412", color: "#ffffff" },
  { backgroundColor: "#4f46e5", borderColor: "#4338ca", color: "#ffffff" },
  { backgroundColor: "#a21caf", borderColor: "#86198f", color: "#ffffff" },
  { backgroundColor: "#0369a1", borderColor: "#075985", color: "#ffffff" },
  { backgroundColor: "#4d7c0f", borderColor: "#3f6212", color: "#ffffff" },
]

function tagPillStyle(tag: string) {
  let hash = 0
  for (let i = 0; i < tag.length; i += 1) {
    hash = (hash * 31 + tag.charCodeAt(i)) >>> 0
  }
  return TAG_PILL_COLORS[hash % TAG_PILL_COLORS.length]
}

// ── Footer (per-sheet totals) ─────────────────────────────────────────────

function SheetMetricsFooter({ totals }: { totals: Totals }) {
  const fabScore100 = Math.round(totals.fabScore * 100)
  const hasFabrication = totals.partsPlaced > 0
  const fabValueClass = !hasFabrication
    ? "text-muted-foreground"
    : fabScore100 >= 80
      ? "text-green-600"
      : fabScore100 >= 60
        ? "text-amber-600"
        : "text-red-600"

  return (
    <div className="grid gap-3 border-t border-border bg-background px-4 py-4 md:grid-cols-6">
      <MetricCard label="Parts Completed" value={`${totals.partsPlaced}`} />
      <MetricCard label="Material Used" value={`${totals.usedSqFt.toFixed(2)} sq ft`} />
      <MetricCard
        label="Reusable Offcut"
        value={`${totals.reusableSqFt.toFixed(2)} sq ft`}
        valueClass="text-amber-600"
      />
      <MetricCard
        label="Scrap / Waste"
        value={`${totals.scrapSqFt.toFixed(2)} sq ft`}
        valueClass="text-red-600"
      />
      <MetricCard label="Cut Pieces" value={`${totals.partsPlaced + totals.partsOverflow}`} />
      <MetricCard
        label="Fab Score"
        value={hasFabrication ? `${fabScore100}/100` : "—"}
        valueClass={fabValueClass}
      />
    </div>
  )
}

function MetricCard({
  label,
  value,
  valueClass = "text-foreground",
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-semibold ${valueClass}`}>{value}</div>
    </div>
  )
}

// ── In-flight & error placeholders ────────────────────────────────────────

function PackingPlaceholder() {
  return (
    <div className="flex h-[440px] flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/40">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700 dark:border-slate-600 dark:border-t-slate-200" />
      <div className="text-sm font-medium text-foreground">Packing…</div>
      <div className="text-xs text-muted-foreground">Running rf-layout pack_lbf_lns</div>
    </div>
  )
}

function ErrorPlaceholder({ message }: { message: string }) {
  return (
    <div className="flex h-[440px] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-red-300 bg-red-50 px-6 text-center dark:border-red-700 dark:bg-red-900/20">
      <div className="text-sm font-semibold text-red-700 dark:text-red-300">Pack failed</div>
      <div className="max-w-md text-xs text-red-700/80 dark:text-red-300/80">{message}</div>
    </div>
  )
}

// ── Empty-state sheet (no parts placed) ───────────────────────────────────

function EmptySheet({
  sheetWidth,
  sheetLength,
  patternSeed,
}: {
  sheetWidth: number
  sheetLength: number
  patternSeed: string
}) {
  const layout = computeSheetLayout(sheetWidth, sheetLength)
  const stockId = `stock-${patternSeed}`
  return (
    <svg viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} className="mx-auto block w-full max-w-6xl">
      <PatternDefs patternSeed={patternSeed} />
      <SheetTitle width={sheetWidth} length={sheetLength} />
      <rect
        x={layout.surfaceX}
        y={layout.surfaceY}
        width={layout.surfacePxW}
        height={layout.surfacePxH}
        fill={`url(#${stockId})`}
        className="stroke-border"
        strokeWidth="2"
      />
      <DimensionLabels layout={layout} sheetWidth={sheetWidth} sheetLength={sheetLength} />
    </svg>
  )
}

// ── Single populated sheet ────────────────────────────────────────────────

interface SheetLayout {
  scale: number
  surfaceX: number
  surfaceY: number
  surfacePxW: number
  surfacePxH: number
}

function computeSheetLayout(sheetWidth: number, sheetLength: number): SheetLayout {
  const drawWidth = VIEW_WIDTH - PAD_LEFT - PAD_RIGHT
  const drawHeight = VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM
  const scale = Math.min(drawWidth / Math.max(sheetWidth, 1), drawHeight / Math.max(sheetLength, 1))
  const surfacePxW = sheetWidth * scale
  const surfacePxH = sheetLength * scale
  const surfaceX = PAD_LEFT + (drawWidth - surfacePxW) / 2
  const surfaceY = PAD_TOP + (drawHeight - surfacePxH) / 2
  return { scale, surfaceX, surfaceY, surfacePxW, surfacePxH }
}

function SheetSvg({
  layout: model,
  totalSheets,
  standardNumber,
  standardTotal,
  patternSeed,
  debugOptions,
}: {
  layout: LayoutModel
  totalSheets: number
  /** 1-indexed position within the *standard* (non-promoted) sheets, or undefined for promoted offcut sheets. */
  standardNumber?: number
  /** Total count of standard sheets (excludes promoted offcut sheets). */
  standardTotal?: number
  patternSeed: string
  debugOptions?: DebugOverlayOptions
}) {
  const layout = useMemo(
    () => computeSheetLayout(model.sheetWidth, model.sheetLength),
    [model.sheetWidth, model.sheetLength]
  )
  const stockId = `stock-${patternSeed}`
  const offcutId = `offcut-${patternSeed}`
  const wasteId = `waste-${patternSeed}`
  const clipId = `stock-clip-${patternSeed}`

  // ── Zoom + pan ──
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{
    startX: number
    startY: number
    startPanX: number
    startPanY: number
  } | null>(null)
  const zoomRef = useRef(zoom)
  const panRef = useRef(pan)
  useEffect(() => {
    zoomRef.current = zoom
    panRef.current = pan
  }, [zoom, pan])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const speed = 0.003
      setZoom((prev) => {
        const raw = prev * Math.pow(2, -e.deltaY * speed)
        const next = Math.min(8, Math.max(1, raw))
        if (next === prev) return prev
        const cur = panRef.current
        const rect = svg.getBoundingClientRect()
        const vbW = VIEW_WIDTH / prev
        const vbH = VIEW_HEIGHT / prev
        const fx = (e.clientX - rect.left) / rect.width
        const fy = (e.clientY - rect.top) / rect.height
        const sx = cur.x + fx * vbW
        const sy = cur.y + fy * vbH
        const newVbW = VIEW_WIDTH / next
        const newVbH = VIEW_HEIGHT / next
        setPan({
          x: Math.max(0, Math.min(sx - fx * newVbW, VIEW_WIDTH - newVbW)),
          y: Math.max(0, Math.min(sy - fy * newVbH, VIEW_HEIGHT - newVbH)),
        })
        return next
      })
    }
    svg.addEventListener("wheel", handler, { passive: false })
    return () => svg.removeEventListener("wheel", handler)
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (zoomRef.current <= 1) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPanX: panRef.current.x,
      startPanY: panRef.current.y,
    }
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const vbW = VIEW_WIDTH / zoomRef.current
    const vbH = VIEW_HEIGHT / zoomRef.current
    const dx = ((e.clientX - dragRef.current.startX) / rect.width) * vbW
    const dy = ((e.clientY - dragRef.current.startY) / rect.height) * vbH
    setPan({
      x: Math.max(0, Math.min(dragRef.current.startPanX - dx, VIEW_WIDTH - vbW)),
      y: Math.max(0, Math.min(dragRef.current.startPanY - dy, VIEW_HEIGHT - vbH)),
    })
  }, [])
  const onPointerUp = useCallback(() => {
    dragRef.current = null
  }, [])

  const vbW = VIEW_WIDTH / zoom
  const vbH = VIEW_HEIGHT / zoom
  const isMulti = totalSheets > 1
  const isExtract = model.sheetKind === "offcut-extract"

  return (
    <div className="group relative">
      <ZoomControls
        zoom={zoom}
        onZoom={setZoom}
        onReset={() => {
          setZoom(1)
          setPan({ x: 0, y: 0 })
        }}
      />
      {isExtract ? (
        <div className="mb-1 text-center text-xs font-medium text-amber-700">
          {`Reusable Offcut from Sheet ${(model.parentSheetIndex ?? 0) + 1} `}
          {`(${formatInches(model.sheetWidth)}" × ${formatInches(model.sheetLength)}")`}
        </div>
      ) : (
        isMulti &&
        standardNumber !== undefined &&
        standardTotal !== undefined && (
          <div className="mb-1 text-center text-xs font-medium text-muted-foreground">
            Sheet {standardNumber} of {standardTotal}
          </div>
        )
      )}
      <svg
        ref={svgRef}
        viewBox={`${pan.x} ${pan.y} ${vbW} ${vbH}`}
        className="mx-auto block w-full max-w-6xl rounded-xl"
        style={{ cursor: zoom > 1 ? "grab" : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <PatternDefs patternSeed={patternSeed} />
        <SheetTitle
          width={model.sheetWidth}
          length={model.sheetLength}
          variant={isExtract ? "offcut-extract" : "stock"}
        />
        <clipPath id={clipId}>
          <rect
            x={layout.surfaceX}
            y={layout.surfaceY}
            width={layout.surfacePxW}
            height={layout.surfacePxH}
          />
        </clipPath>
        <rect
          x={layout.surfaceX}
          y={layout.surfaceY}
          width={layout.surfacePxW}
          height={layout.surfacePxH}
          fill={isExtract ? `url(#${offcutId})` : `url(#${stockId})`}
          stroke={isExtract ? OFFCUT_OUTLINE : undefined}
          strokeWidth="2"
          strokeDasharray={isExtract ? "6 4" : undefined}
          className={isExtract ? undefined : "stroke-border"}
        />
        <g clipPath={`url(#${clipId})`}>
          {/* Synthetic offcut-extract sheets paint the amber pattern +
              dashed border on the outer rect above; skip the per-region
              offcut/scrap rendering to avoid stacking a solid amber
              outline over the dashed border. */}
          {!isExtract && (
            <>
              {/* Scrap layer — combines every `BinResult.freeRegions`
                  polygon (one outer + one hole-reversed per placed part)
                  into a single evenodd path, with reusable amber rects
                  added as cutout subpaths. evenodd correctly resolves the
                  shape: the outer paints the bin red, hole-reverseds cancel
                  cone interiors (point in cone counted twice → not filled),
                  offcut cutouts cancel reusable rect areas (point in offcut
                  flips count → not filled). The chord-vs-arc gap, sub-cell
                  residual, and post-iteration leftover all paint as red,
                  matching the displayed `scrapAreaSqFt` total. */}
              <ScrapLayer
                regions={model.scrap}
                offcuts={model.offcuts}
                fill={`url(#${wasteId})`}
                layout={layout}
              />
              {/* Reusable offcuts (amber). Each gets its W × L printed at
                  the centre so the operator can size the leftover at a glance. */}
              {model.offcuts.map((region, i) => (
                <React.Fragment key={`offcut-${i}`}>
                  <RegionShape
                    region={region}
                    fill={`url(#${offcutId})`}
                    stroke={OFFCUT_OUTLINE}
                    layout={layout}
                  />
                  <OffcutLabel region={region} layout={layout} />
                </React.Fragment>
              ))}
            </>
          )}
          {/* Debug overlay: inscribed Scrap-classified rects, dashed
              darker-red outline. Only rendered when the operator
              ticks "Show inscribed rects". */}
          {debugOptions?.showInscribedScrapRects &&
            model.debugScrapRects?.map((region, i) => (
              <rect
                key={`debug-scrap-${i}`}
                x={layout.surfaceX + region.x * layout.scale}
                y={layout.surfaceY + region.y * layout.scale}
                width={region.width * layout.scale}
                height={region.height * layout.scale}
                fill="none"
                stroke="rgba(153, 27, 27, 0.85)"
                strokeWidth={1.25}
                strokeDasharray="4 3"
                style={{ pointerEvents: "none" }}
              />
            ))}
          {/* Debug overlay: AABBs for placed parts (violet) and
              reusable offcuts (emerald). Only rendered when the
              operator ticks "Show AABBs". Painted before parts so the
              part fill stays readable but the outline still sits on
              top of the offcut/scrap fills underneath. */}
          {debugOptions?.showAabbOverlays && (
            <>
              {model.offcuts.map((region, i) => (
                <rect
                  key={`debug-aabb-offcut-${i}`}
                  x={layout.surfaceX + region.x * layout.scale}
                  y={layout.surfaceY + region.y * layout.scale}
                  width={region.width * layout.scale}
                  height={region.height * layout.scale}
                  fill="none"
                  stroke="rgba(16, 185, 129, 0.95)"
                  strokeWidth={1.0}
                  strokeDasharray="6 3"
                  style={{ pointerEvents: "none" }}
                />
              ))}
              {model.parts.map((part, i) => {
                const aabb = partAabb(part)
                return (
                  <rect
                    key={`debug-aabb-part-${i}`}
                    x={layout.surfaceX + aabb.x * layout.scale}
                    y={layout.surfaceY + aabb.y * layout.scale}
                    width={aabb.width * layout.scale}
                    height={aabb.height * layout.scale}
                    fill="none"
                    stroke="rgba(124, 58, 237, 0.95)"
                    strokeWidth={1.5}
                    strokeDasharray="6 3"
                    style={{ pointerEvents: "none" }}
                  />
                )
              })}
            </>
          )}
          {/* Placed parts. */}
          {model.parts.map((part, i) => (
            <PartShape key={`part-${i}`} part={part} layout={layout} debugOptions={debugOptions} />
          ))}
        </g>
        <DimensionLabels
          layout={layout}
          sheetWidth={model.sheetWidth}
          sheetLength={model.sheetLength}
        />
      </svg>
    </div>
  )
}

// ── Scrap layer (combined evenodd) ────────────────────────────────────────

/**
 * Renders the bin's entire scrap coverage as ONE SVG path with
 * `fill-rule="evenodd"`, combining every `BinResult.freeRegions`
 * polygon plus the reusable offcut rects as cutout subpaths.
 *
 * Why one combined path (and not per-polygon `RegionShape` calls):
 * the rf-geom Clipper wrapper splits "stock − parts" into separate
 * positive-CCW polygons — one outer (the bin) plus one hole-reversed
 * per placed part. Painted independently, the outer would fill the
 * whole bin red and each hole-reversed would also fill its part's
 * area red. Per-polygon evenodd cancellation requires every polygon
 * to know which cutouts apply to it, which breaks for concave parts
 * whose bbox centre falls outside their polygon (e.g. a 150° annular
 * sector — the inner-arc hole swallows the bbox centre, so a
 * point-in-polygon containment test misses the part itself).
 *
 * Combining everything into one evenodd path side-steps that: the
 * rule simply counts how many contours a horizontal ray crosses.
 *   - Inside the bin, outside every cone, outside every offcut:
 *     outer=1, holes=0, offcuts=0 → 1 → filled red. ✓
 *   - Inside a cone interior: outer=1, that cone's hole-reversed=1,
 *     others=0, offcuts=0 → 2 → not filled. ✓
 *   - Inside an offcut (outside cones): outer=1, holes=0,
 *     offcut=1 → 2 → not filled. ✓
 *   - Outside the bin: 0 → not filled. ✓
 *
 * Stroke is intentionally omitted — a stroke on the combined contour
 * would trace every polygon AND every cutout, drawing red lines
 * along the cone silhouettes and offcut edges. The faint
 * anti-aliased seam against the underlying stock pattern is the
 * accepted tradeoff (matches prior single-polygon behaviour).
 */
function ScrapLayer({
  regions,
  offcuts,
  fill,
  layout,
}: {
  regions: ReadonlyArray<LayoutRegion>
  offcuts: ReadonlyArray<LayoutRegion>
  fill: string
  layout: SheetLayout
}) {
  if (regions.length === 0) return null
  const tx = (x: number) => layout.surfaceX + x * layout.scale
  const ty = (y: number) => layout.surfaceY + y * layout.scale

  const segments: string[] = []
  for (const r of regions) {
    if (r.polygon && r.polygon.length >= 3) {
      segments.push(polygonToPathSegment(r.polygon, tx, ty))
    } else if (r.width > 0 && r.height > 0) {
      // Defensive fallback for any region that arrives without a
      // polygon — paint its bbox.
      const x0 = tx(r.x)
      const y0 = ty(r.y)
      const x1 = tx(r.x + r.width)
      const y1 = ty(r.y + r.height)
      segments.push(`M ${x0} ${y0} L ${x1} ${y0} L ${x1} ${y1} L ${x0} ${y1} Z`)
    }
  }
  for (const o of offcuts) {
    const x0 = tx(o.x)
    const y0 = ty(o.y)
    const x1 = tx(o.x + o.width)
    const y1 = ty(o.y + o.height)
    segments.push(`M ${x0} ${y0} L ${x1} ${y0} L ${x1} ${y1} L ${x0} ${y1} Z`)
  }

  return <path d={segments.join(" ")} fill={fill} fillRule="evenodd" opacity="0.95" />
}

// ── Region renderer (offcut + scrap) ──────────────────────────────────────

/**
 * Visible amber outline drawn around each Reusable offcut so its bbox
 * reads at a glance against the bin-wide scrap pattern. Picked to match
 * the diagonal-stripe colour inside the offcut pattern itself
 * (`rgba(245,158,11,0.55)`) at slightly higher opacity, so the outline
 * looks like a thicker version of the fill rather than an unrelated
 * border colour. The stroke also covers the sub-pixel anti-aliased rim
 * where the underlying stock pattern (#f5f5f4 — near-white) would
 * otherwise bleed through.
 *
 * Scrap regions intentionally render without a stroke: a light-red
 * rim around every scrap polygon read as if the offcut/sheet borders
 * themselves were classified as waste. The faint anti-aliased seam
 * against the stock pattern is the accepted tradeoff.
 */
const OFFCUT_OUTLINE = "rgba(245, 158, 11, 0.75)"

/**
 * Renders one scrap or offcut region. When `cutouts` is supplied, any
 * placed part whose bbox overlaps the region is treated as a hole and
 * punched out via SVG `fill-rule="evenodd"`. This is the visual fix
 * for the user-reported bug where cones nesting into each other's
 * concave notches saw waste regions painted across their bodies — the
 * Rust shape-trapped pipeline emits per-part `bbox(P) − P.polygon`
 * polygons (see `crates/rf-layout/src/application/free_space.rs`),
 * which by themselves overlap any other part sitting inside P's bbox.
 * The rf-geom Clipper wrapper can't subtract those other parts on the
 * Rust side without losing hole topology, so we punch them out at
 * render time instead.
 */
/**
 * Anything axis-aligned with an optional polygon can act as a cutout.
 * `PlacedPart` and `LayoutRegion` (e.g. reusable offcuts) both satisfy
 * this — keeping the prop generic lets `SheetSvg` punch parts AND
 * reusable rects out of the bin-wide scrap polygon in one pass.
 */
interface CutoutShape {
  x: number
  y: number
  width: number
  height: number
  polygon?: ReadonlyArray<{ x: number; y: number }>
}

function RegionShape({
  region,
  fill,
  stroke,
  layout,
  cutouts,
}: {
  region: LayoutRegion
  fill: string
  stroke?: string
  layout: SheetLayout
  cutouts?: ReadonlyArray<CutoutShape>
}) {
  const transformX = (x: number) => layout.surfaceX + x * layout.scale
  const transformY = (y: number) => layout.surfaceY + y * layout.scale
  // 1.5 device pixels — thick enough to read as a deliberate outline
  // around Reusable offcuts (rather than the hairline anti-aliasing
  // cover the previous 1.05 width acted as), still thin enough to not
  // hide the offcut's diagonal-stripe pattern. Applied only to the
  // OUTER contour as a separate overlay element so the cutout
  // subpaths (placed parts) don't also get rimmed.
  const strokeWidth = 1.5

  if (region.polygon && region.polygon.length >= 3) {
    const overlappingCutouts = cutouts ? cutoutsOverlapping(region, cutouts) : []
    const outerPath = polygonToPathSegment(region.polygon, transformX, transformY)
    if (overlappingCutouts.length === 0) {
      return (
        <>
          <path d={outerPath} fill={fill} opacity="0.95" />
          {stroke && <path d={outerPath} fill="none" stroke={stroke} strokeWidth={strokeWidth} />}
        </>
      )
    }
    const cutoutPaths = overlappingCutouts
      .map((c) => cutoutToPathSegment(c, transformX, transformY))
      .join(" ")
    return (
      <>
        <path d={`${outerPath} ${cutoutPaths}`} fill={fill} fillRule="evenodd" opacity="0.95" />
        {stroke && <path d={outerPath} fill="none" stroke={stroke} strokeWidth={strokeWidth} />}
      </>
    )
  }
  // Rect-only fallback (no polygon). Cutouts via evenodd still apply.
  const overlappingCutouts = cutouts ? cutoutsOverlappingRect(region, cutouts) : []
  const rx = transformX(region.x)
  const ry = transformY(region.y)
  const rw = region.width * layout.scale
  const rh = region.height * layout.scale
  if (overlappingCutouts.length === 0) {
    return (
      <>
        <rect x={rx} y={ry} width={rw} height={rh} fill={fill} opacity="0.95" />
        {stroke && (
          <rect
            x={rx}
            y={ry}
            width={rw}
            height={rh}
            fill="none"
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
        )}
      </>
    )
  }
  const rectPath = `M ${rx} ${ry} h ${rw} v ${rh} h ${-rw} Z`
  const cutoutPaths = overlappingCutouts
    .map((c) => polygonToPathSegment(c.polygon!, transformX, transformY))
    .join(" ")
  return (
    <>
      <path d={`${rectPath} ${cutoutPaths}`} fill={fill} fillRule="evenodd" opacity="0.95" />
      {stroke && (
        <rect
          x={rx}
          y={ry}
          width={rw}
          height={rh}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      )}
    </>
  )
}

// Below this on-screen min dimension, an offcut is too small to host
// readable text — the label is suppressed so the surface stays clean.
// Label hides only for truly tiny rects. The 6"×24" minimum-strip
// reusable-offcut threshold renders ~25 SVG px on the short axis at
// the typical 120×96 sheet scale, so anything stricter than ~20 drops
// labels off legitimate reusable pieces. Narrow strips rotate the
// label 90° so it reads along the long axis.
const OFFCUT_LABEL_MIN_PX = 18
const OFFCUT_LABEL_ROTATE_RATIO = 1.7

function OffcutLabel({ region, layout }: { region: LayoutRegion; layout: SheetLayout }) {
  const widthPx = region.width * layout.scale
  const heightPx = region.height * layout.scale
  const minPx = Math.min(widthPx, heightPx)
  const maxPx = Math.max(widthPx, heightPx)
  if (minPx < OFFCUT_LABEL_MIN_PX) return null

  const cx = layout.surfaceX + (region.x + region.width / 2) * layout.scale
  const cy = layout.surfaceY + (region.y + region.height / 2) * layout.scale
  const text = `${formatInches(region.width)}" × ${formatInches(region.height)}"`
  // Estimated label width at 1px font size — helvetica ~0.55 em-ratio.
  // Used to pick a font size that actually fits along the chosen axis.
  const labelEmWidth = text.length * 0.55

  // Rotate when one axis is significantly longer; the label then reads
  // along the long axis and we size against that axis instead.
  const isVerticalStrip = heightPx > widthPx * OFFCUT_LABEL_ROTATE_RATIO
  const isHorizontalStrip = widthPx > heightPx * OFFCUT_LABEL_ROTATE_RATIO
  const rotated = isVerticalStrip
  const longAxisPx = isVerticalStrip || isHorizontalStrip ? maxPx : widthPx
  const shortAxisPx = isVerticalStrip || isHorizontalStrip ? minPx : heightPx

  // Pick the largest font size that fits within the label's available
  // axes (long axis bounds the text length, short axis bounds the
  // text height ~ 1.2em). Capped 7-13px for legibility.
  const fontFromLength = (longAxisPx * 0.92) / labelEmWidth
  const fontFromHeight = shortAxisPx / 1.4
  const fontSize = Math.max(7, Math.min(13, Math.min(fontFromLength, fontFromHeight)))
  const transform = rotated ? `rotate(-90 ${cx} ${cy})` : undefined

  return (
    <text
      x={cx}
      y={cy}
      textAnchor="middle"
      dominantBaseline="central"
      fill="#000"
      fontSize={fontSize}
      fontWeight="600"
      transform={transform}
      style={{ pointerEvents: "none", userSelect: "none" }}
    >
      {text}
    </text>
  )
}

function polygonToPathSegment(
  polygon: ReadonlyArray<{ x: number; y: number }>,
  transformX: (x: number) => number,
  transformY: (y: number) => number
): string {
  if (polygon.length < 3) return ""
  const head = polygon[0]
  let d = `M ${transformX(head.x)} ${transformY(head.y)}`
  for (let i = 1; i < polygon.length; i++) {
    d += ` L ${transformX(polygon[i].x)} ${transformY(polygon[i].y)}`
  }
  d += " Z"
  return d
}

function cutoutsOverlapping(
  region: LayoutRegion,
  cutouts: ReadonlyArray<CutoutShape>
): CutoutShape[] {
  const r = polygonBbox(region.polygon!)
  return cutouts.filter((c) => bboxesOverlap(r, cutoutBbox(c)))
}

function cutoutsOverlappingRect(
  region: LayoutRegion,
  cutouts: ReadonlyArray<CutoutShape>
): CutoutShape[] {
  const r = {
    minX: region.x,
    minY: region.y,
    maxX: region.x + region.width,
    maxY: region.y + region.height,
  }
  return cutouts.filter((c) => bboxesOverlap(r, cutoutBbox(c)))
}

function cutoutBbox(c: CutoutShape): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  if (c.polygon && c.polygon.length >= 3) return polygonBbox(c.polygon)
  return {
    minX: c.x,
    minY: c.y,
    maxX: c.x + c.width,
    maxY: c.y + c.height,
  }
}

function cutoutToPathSegment(
  c: CutoutShape,
  transformX: (x: number) => number,
  transformY: (y: number) => number
): string {
  if (c.polygon && c.polygon.length >= 3) {
    return polygonToPathSegment(c.polygon, transformX, transformY)
  }
  const x0 = transformX(c.x)
  const y0 = transformY(c.y)
  const x1 = transformX(c.x + c.width)
  const y1 = transformY(c.y + c.height)
  return `M ${x0} ${y0} L ${x1} ${y0} L ${x1} ${y1} L ${x0} ${y1} Z`
}

function polygonBbox(polygon: ReadonlyArray<{ x: number; y: number }>): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of polygon) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

function bboxesOverlap(
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number }
): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY
}

// ── Part renderer ─────────────────────────────────────────────────────────

/**
 * Axis-aligned bounding box of a placed part in stock-local inches.
 *
 * For shapes carrying a `polygon` (cones / sectors / trapezoids /
 * ngons / custom polygons) the bbox is computed from the polygon
 * vertices, which are already post-rotation and post-translation —
 * this is the only correct path for non-rect shapes, since
 * `part.x`/`part.y` are jagua's rotation-origin translation, not the
 * rotated bbox top-left. For rect-family shapes without a polygon
 * (`rect` / bare `circle` rendered via `rectFallback`) the placement
 * rect is already the bbox.
 *
 * Used by both the part-label centring math in `PartShape` and the
 * "Show AABBs" debug overlay in `SheetSvg` so the two never drift.
 */
function partAabb(part: PlacedPart): { x: number; y: number; width: number; height: number } {
  if (part.polygon && part.polygon.length >= 3) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const pt of part.polygon) {
      if (pt.x < minX) minX = pt.x
      if (pt.y < minY) minY = pt.y
      if (pt.x > maxX) maxX = pt.x
      if (pt.y > maxY) maxY = pt.y
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  }
  return { x: part.x, y: part.y, width: part.width, height: part.height }
}

// partLabelCenter / polygonCentroid moved to ./part-label.ts so the
// PDF exporter shares the same area-weighted-centroid placement and a
// tag that reads inside the cone silhouette on screen does the same in
// the printed report.

function PartShape({
  part,
  layout,
  debugOptions,
}: {
  part: PlacedPart
  layout: SheetLayout
  debugOptions?: DebugOverlayOptions
}) {
  const { surfaceX, surfaceY, scale } = layout

  // Label position: polygon centroid (area-weighted), NOT the bbox /
  // hull centre. For concave shapes whose bbox centre lands outside
  // the polygon — a 150° annular sector's bbox centre falls in the
  // inner-arc hole, outside the cone silhouette — the centroid sits
  // inside the actual filled region. Convex shapes (rect, circle,
  // ellipse, trapezoid, triangle, ngon) keep getting their geometric
  // centre, indistinguishable from bbox centre for rect-aligned
  // shapes. Font size still keys off the bbox min dimension so the
  // tag scales with the visual footprint, not the centroid's
  // distance to the nearest edge.
  const center = partLabelCenter(part)
  const labelX = surfaceX + center.x * scale
  const labelY = surfaceY + center.y * scale
  const labelDim = center.minDim * scale

  return (
    <g>
      {renderPartGeometry(part, layout)}
      {debugOptions?.showPackHullOverlay && part.packPolygon && part.packPolygon.length >= 3 && (
        <polygon
          points={part.packPolygon
            .map((p) => `${surfaceX + p.x * scale},${surfaceY + p.y * scale}`)
            .join(" ")}
          fill="none"
          stroke="rgba(245, 158, 11, 0.85)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          style={{ pointerEvents: "none" }}
        />
      )}
      <text
        x={labelX}
        y={labelY}
        textAnchor="middle"
        dominantBaseline="central"
        fill="#000"
        fontSize={Math.max(10, Math.min(18, labelDim * 0.32))}
        fontWeight="700"
        style={{ pointerEvents: "none", userSelect: "none" }}
      >
        {part.label}
      </text>
    </g>
  )
}

function renderPartGeometry(part: PlacedPart, layout: SheetLayout): React.ReactElement {
  const { surfaceX, surfaceY, scale } = layout
  if (part.polygon && part.polygon.length >= 3) {
    const points = part.polygon
      .map((p) => `${surfaceX + p.x * scale},${surfaceY + p.y * scale}`)
      .join(" ")
    return (
      <polygon
        points={points}
        fill="rgba(56,189,248,0.32)"
        stroke="rgba(56,189,248,0.85)"
        strokeWidth="1.5"
      />
    )
  }
  // Shape-specific fallback for templates that don't carry a polygon.
  return rectFallback(part, layout)
}

function rectFallback(part: PlacedPart, layout: SheetLayout): React.ReactElement {
  const { surfaceX, surfaceY, scale } = layout
  const x = surfaceX + part.x * scale
  const y = surfaceY + part.y * scale
  const w = part.width * scale
  const h = part.height * scale
  if (part.renderShape === "circle" && part.diameter) {
    const r = (part.diameter * scale) / 2
    return (
      <circle
        cx={x + w / 2}
        cy={y + h / 2}
        r={r}
        fill="rgba(56,189,248,0.32)"
        stroke="rgba(56,189,248,0.85)"
        strokeWidth="1.5"
      />
    )
  }
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      fill="rgba(56,189,248,0.32)"
      stroke="rgba(56,189,248,0.85)"
      strokeWidth="1.5"
    />
  )
}

// ── Patterns + chrome ─────────────────────────────────────────────────────

function PatternDefs({ patternSeed }: { patternSeed: string }) {
  return (
    <defs>
      <pattern
        id={`stock-${patternSeed}`}
        width="18"
        height="18"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect width="18" height="18" fill="#f5f5f4" />
        <line x1="0" y1="0" x2="0" y2="18" stroke="rgba(120,113,108,0.18)" strokeWidth="1.5" />
      </pattern>
      <pattern
        id={`offcut-${patternSeed}`}
        width="14"
        height="14"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect width="14" height="14" fill="#fef3c7" />
        <line x1="0" y1="0" x2="0" y2="14" stroke="rgba(245,158,11,0.55)" strokeWidth="2" />
      </pattern>
      <pattern
        id={`waste-${patternSeed}`}
        width="10"
        height="10"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect width="10" height="10" fill="#fee2e2" />
        <line x1="0" y1="0" x2="0" y2="10" stroke="rgba(239,68,68,0.55)" strokeWidth="2" />
      </pattern>
    </defs>
  )
}

function SheetTitle({
  width,
  length,
  variant = "stock",
}: {
  width: number
  length: number
  variant?: "stock" | "offcut-extract"
}) {
  const title = variant === "offcut-extract" ? "Reusable Offcut" : "Rubber Sheet Nesting Layout"
  const subtitle =
    variant === "offcut-extract"
      ? `Promoted ${formatInches(width)}" × ${formatInches(length)}" leftover`
      : `Typical ${formatInches(width)}" × ${formatInches(length)}" stock sheet`
  return (
    <>
      <text
        x={VIEW_WIDTH / 2}
        y="34"
        textAnchor="middle"
        className="fill-foreground"
        fontSize="20"
        fontWeight="700"
      >
        {title}
      </text>
      <text
        x={VIEW_WIDTH / 2}
        y="60"
        textAnchor="middle"
        className="fill-muted-foreground"
        fontSize="12"
      >
        {subtitle}
      </text>
    </>
  )
}

function DimensionLabels({
  layout,
  sheetWidth,
  sheetLength,
}: {
  layout: SheetLayout
  sheetWidth: number
  sheetLength: number
}) {
  // Width label (under the sheet)
  const wLabelY = layout.surfaceY + layout.surfacePxH + 30
  // Length label (right of the sheet)
  const lLabelX = layout.surfaceX + layout.surfacePxW + 30
  return (
    <>
      <text
        x={layout.surfaceX + layout.surfacePxW / 2}
        y={wLabelY}
        textAnchor="middle"
        className="fill-muted-foreground"
        fontSize="13"
        fontWeight="500"
      >
        {`${formatInches(sheetWidth)}"`}
      </text>
      <text
        x={lLabelX}
        y={layout.surfaceY + layout.surfacePxH / 2}
        textAnchor="middle"
        className="fill-muted-foreground"
        fontSize="13"
        fontWeight="500"
        transform={`rotate(90 ${lLabelX} ${layout.surfaceY + layout.surfacePxH / 2})`}
      >
        {`${formatInches(sheetLength)}"`}
      </text>
    </>
  )
}

function ZoomControls({
  zoom,
  onZoom,
  onReset,
}: {
  zoom: number
  onZoom: (updater: (z: number) => number) => void
  onReset: () => void
}) {
  return (
    <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-lg border border-border/60 bg-background/90 px-2 py-1 opacity-0 shadow-sm backdrop-blur transition-opacity group-hover:opacity-100">
      <button
        type="button"
        onClick={() => onZoom((z) => Math.max(1, +(z * 0.67).toFixed(2)))}
        className="flex h-6 w-6 items-center justify-center rounded text-xs font-bold text-foreground hover:bg-muted"
        aria-label="Zoom out"
      >
        −
      </button>
      <span className="min-w-[3ch] text-center text-[10px] font-medium text-muted-foreground">
        {Math.round(zoom * 100)}%
      </span>
      <button
        type="button"
        onClick={() => onZoom((z) => Math.min(8, +(z * 1.5).toFixed(2)))}
        className="flex h-6 w-6 items-center justify-center rounded text-xs font-bold text-foreground hover:bg-muted"
        aria-label="Zoom in"
      >
        +
      </button>
      {zoom !== 1 && (
        <button
          type="button"
          onClick={onReset}
          className="ml-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
        >
          Reset
        </button>
      )}
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────

// formatInches now lives in ./format-inches.ts so the visualizer, the
// Reusable Offcuts card, and the PDF report share one rounding rule.

// Re-export the RenderShape union so consumers that read the source
// from this module find it next to LayoutVisualizer.
export type { RenderShape }
