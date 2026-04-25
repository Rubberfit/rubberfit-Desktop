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

// ── Display constants ─────────────────────────────────────────────────────

const VIEW_WIDTH = 980
const VIEW_HEIGHT = 560
const PAD_LEFT = 74
const PAD_RIGHT = 112
const PAD_TOP = 82
const PAD_BOTTOM = 80

// ── Public API ────────────────────────────────────────────────────────────

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
}

export default function LayoutVisualizer({
  layouts,
  defaultStockWidth,
  defaultStockLength,
  isPacking,
  packError,
  onMetricsChange,
  onLayoutChange,
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

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <SheetHeader
        title="Rubber Sheet Nesting Layout"
        subtitle={summaryLine(sheets)}
        totals={totals}
        isPacking={isPacking}
        packError={packError}
        sheetCount={sheets.length}
      />

      <Legend layouts={sheets} />

      <div
        className={`bg-card px-2 py-4 sm:px-4 ${
          isMulti ? "flex flex-col gap-6" : "overflow-x-auto"
        }`}
      >
        {sheets.map((layout, i) => (
          <SheetSvg
            key={`sheet-${i}`}
            layout={layout}
            sheetIndex={i}
            totalSheets={sheets.length}
            patternSeed={`${patternSeed}-s${i}`}
          />
        ))}
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
}

function buildTotals(sheets: LayoutModel[]): Totals {
  let usedSqFt = 0
  let reusableSqFt = 0
  let scrapSqFt = 0
  let stockSqFt = 0
  let partsPlaced = 0
  let partsOverflow = 0
  let weightedFab = 0
  for (const s of sheets) {
    usedSqFt += s.usedAreaSqFt
    reusableSqFt += s.reusableAreaSqFt
    scrapSqFt += s.scrapAreaSqFt
    stockSqFt += (s.sheetWidth * s.sheetLength) / 144
    partsPlaced += s.placedCount
    partsOverflow += s.overflowCount
    weightedFab += s.fabScore
  }
  const fabScore = sheets.length > 0 ? weightedFab / sheets.length : 0
  return { usedSqFt, reusableSqFt, scrapSqFt, stockSqFt, partsPlaced, partsOverflow, fabScore }
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
  const sheetWord = sheets.length === 1 ? "sheet" : "sheets"
  const overflowSuffix = t.partsOverflow > 0 ? `, ${t.partsOverflow} overflow` : ""
  return `${sheets.length} ${sheetWord}, ${t.partsPlaced} parts placed${overflowSuffix}`
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
  // Distinct (label, partNumber) pairs across all sheets, in first-encounter order.
  const seen = new Map<string, string>()
  for (const layout of layouts) {
    for (const part of layout.parts) {
      const key = part.label
      if (!seen.has(key)) {
        seen.set(key, part.partNumber ?? part.shapeId)
      }
    }
  }
  if (seen.size === 0) return null
  return (
    <div className="flex flex-wrap gap-3 border-b border-border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
      {[...seen.entries()].map(([tag, label]) => (
        <span key={tag} className="flex items-center gap-1.5">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-foreground text-[10px] font-bold text-background">
            {tag}
          </span>
          <span>{label}</span>
        </span>
      ))}
    </div>
  )
}

// ── Footer (per-sheet totals) ─────────────────────────────────────────────

function SheetMetricsFooter({ totals }: { totals: Totals }) {
  return (
    <div className="grid grid-cols-2 gap-3 border-t border-border bg-muted/30 px-4 py-3 text-xs sm:grid-cols-4">
      <Metric label="Stock" value={`${totals.stockSqFt.toFixed(2)} sq ft`} />
      <Metric label="Used" value={`${totals.usedSqFt.toFixed(2)} sq ft`} />
      <Metric label="Reusable offcut" value={`${totals.reusableSqFt.toFixed(2)} sq ft`} />
      <Metric label="Scrap" value={`${totals.scrapSqFt.toFixed(2)} sq ft`} />
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-semibold text-foreground">{value}</div>
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
  sheetIndex,
  totalSheets,
  patternSeed,
}: {
  layout: LayoutModel
  sheetIndex: number
  totalSheets: number
  patternSeed: string
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
      {isMulti && (
        <div className="mb-1 text-center text-xs font-medium text-muted-foreground">
          Sheet {sheetIndex + 1} of {totalSheets}
        </div>
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
        <SheetTitle width={model.sheetWidth} length={model.sheetLength} />
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
          fill={`url(#${stockId})`}
          className="stroke-border"
          strokeWidth="2"
        />
        <g clipPath={`url(#${clipId})`}>
          {/* Scrap polygons (irregular waste shapes — painted first so amber offcuts overlay on top). */}
          {model.scrap.map((region, i) => (
            <RegionShape
              key={`scrap-${i}`}
              region={region}
              fill={`url(#${wasteId})`}
              layout={layout}
            />
          ))}
          {/* Reusable offcuts (amber). */}
          {model.offcuts.map((region, i) => (
            <RegionShape
              key={`offcut-${i}`}
              region={region}
              fill={`url(#${offcutId})`}
              layout={layout}
            />
          ))}
          {/* Placed parts. */}
          {model.parts.map((part, i) => (
            <PartShape key={`part-${i}`} part={part} layout={layout} />
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

// ── Region renderer (offcut + scrap) ──────────────────────────────────────

function RegionShape({
  region,
  fill,
  layout,
}: {
  region: LayoutRegion
  fill: string
  layout: SheetLayout
}) {
  if (region.polygon && region.polygon.length >= 3) {
    const points = region.polygon
      .map((p) => `${layout.surfaceX + p.x * layout.scale},${layout.surfaceY + p.y * layout.scale}`)
      .join(" ")
    return <polygon points={points} fill={fill} opacity="0.95" />
  }
  return (
    <rect
      x={layout.surfaceX + region.x * layout.scale}
      y={layout.surfaceY + region.y * layout.scale}
      width={region.width * layout.scale}
      height={region.height * layout.scale}
      fill={fill}
      opacity="0.95"
    />
  )
}

// ── Part renderer ─────────────────────────────────────────────────────────

function PartShape({ part, layout }: { part: PlacedPart; layout: SheetLayout }) {
  const { surfaceX, surfaceY, scale } = layout

  // Label position. Prefer the polygon bbox centre — `part.x`/`part.y`
  // come from `rf_layout::Placement` which stores the jagua rotation-
  // origin translation, NOT the bbox top-left under rotation. Using
  // them directly puts the tag outside the shape (or outside the
  // stock, where the parent clipPath swallows it). The polygon is
  // already in stock-local post-rotation coordinates — the same data
  // `renderPartGeometry` uses to draw the shape — so its bbox centre
  // is guaranteed to sit inside the rendered geometry for every
  // convex/quasi-convex shape AutoNest packs (rect, circle, sector,
  // trapezoid).
  let labelX: number
  let labelY: number
  let labelDim: number
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
    labelX = surfaceX + ((minX + maxX) / 2) * scale
    labelY = surfaceY + ((minY + maxY) / 2) * scale
    labelDim = Math.min(maxX - minX, maxY - minY) * scale
  } else {
    const pxX = surfaceX + part.x * scale
    const pxY = surfaceY + part.y * scale
    const pxW = part.width * scale
    const pxH = part.height * scale
    labelX = pxX + pxW / 2
    labelY = pxY + pxH / 2
    labelDim = Math.min(pxW, pxH)
  }

  return (
    <g>
      {renderPartGeometry(part, layout)}
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

function SheetTitle({ width, length }: { width: number; length: number }) {
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
        Rubber Sheet Nesting Layout
      </text>
      <text
        x={VIEW_WIDTH / 2}
        y="60"
        textAnchor="middle"
        className="fill-muted-foreground"
        fontSize="12"
      >
        {`Typical ${formatInches(width)}" × ${formatInches(length)}" stock sheet`}
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

function formatInches(n: number): string {
  // Trim trailing .0 for whole inches, keep one decimal otherwise.
  return Number.isInteger(n) ? n.toString() : n.toFixed(1)
}

// Re-export the RenderShape union so consumers that read the source
// from this module find it next to LayoutVisualizer.
export type { RenderShape }
