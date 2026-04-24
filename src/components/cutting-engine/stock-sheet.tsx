import { useId, useMemo } from "react"

import { cn } from "@/lib/utils"

import { SimpleModePatternDefs } from "./nesting-viz-simple-parts"

/**
 * Canonical stock-sheet renderer. Mounted by:
 *
 *   • the cutting-engine empty-state card (no parts placed yet)
 *   • the inventory detail drawer (shows the source roll)
 *
 * Shares the **exact** pattern palette used by `NestingVisualizer`
 * — `SimpleModePatternDefs` is imported directly rather than
 * re-implemented so the stock fill, offcut hatching, and scrap
 * hatching never drift between the full engine graph and the
 * blank-sheet preview. Any change over there automatically flows
 * into both consumers of this component.
 *
 * Optional `usage` blob turns on proportional amber / red overlays
 * on the left (consumed) portion of the sheet — used by the
 * inventory drawer when the roll has linked cut history. Not used
 * by the engine empty state (nothing's been cut yet).
 */

export interface StockSheetUsage {
  reusableSqft: number
  scrapSqft: number
  cutCount: number
}

interface StockSheetProps {
  width: number
  length: number
  remainingLength?: number
  materialLabel?: string
  usage?: StockSheetUsage | null
  className?: string
  /** Maximum rendered SVG width in px. Shorter rolls scale down. */
  maxWidthPx?: number
  /** Maximum rendered SVG height in px. */
  maxHeightPx?: number
  /** Show the remaining-vs-total progress bar under the sheet. */
  showUsageBar?: boolean
}

const H_PAD = 56
const V_PAD_TOP = 32
const V_PAD_BOTTOM = 32
// Previously clamped to [0.35, 3] which lied about thin-strip rolls
// like a 7" × 218" (≈ 31:1) Nitrile offcut — it would render as
// though it were 3:1, more than 10× fatter than reality. Now true
// to proportion; we still cap the rendered height so very long
// rolls don't pancake into illegible slivers.

// These match `SimpleModePatternDefs` — the rect / text colours
// that surround the patterns aren't encoded in that component, so
// we mirror them here. If the engine visualizer frame styling
// changes, update both.
const CALLOUT = "#a8a29e"
const FRAME_STROKE = "rgba(168,162,158,0.6)"
const LABEL_BG = "#1c1c1a"
const LABEL_BORDER = "rgba(168,162,158,0.45)"
const LABEL_FG = "#f5f4f1"

interface SheetLayout {
  svgW: number
  svgH: number
  rectX: number
  rectY: number
  rectW: number
  rectH: number
  consumedW: number
}

function computeLayout(
  width: number,
  length: number,
  remainingLength: number | undefined,
  maxWidthPx: number,
  maxHeightPx: number
): SheetLayout {
  // `aspect` here is length-over-width. We render length along X
  // (horizontal) and width along Y (vertical), so the rendered
  // rectangle's W/H ratio equals `aspect`. No clamping — the
  // rendered shape matches the real roll within the bounding box
  // we're given. Extreme-aspect rolls (e.g. a 7" × 218" offcut)
  // render as the thin strip they actually are; the material chip
  // inside the sheet is suppressed below when there's not enough
  // height for it.
  const aspect = width > 0 && length > 0 ? length / width : 1
  // Clamp against pathological small viewports (H_PAD ~ 28px, V_PAD
  // ~ 30px each). Negative rectW/rectH would render an inverted SVG
  // rect and trip the consumed overlay math downstream.
  let rectW = Math.max(0, maxWidthPx - H_PAD * 2)
  let rectH = aspect > 0 ? rectW / aspect : 0
  const maxRectH = Math.max(0, maxHeightPx - V_PAD_TOP - V_PAD_BOTTOM)
  if (rectH > maxRectH) {
    rectH = maxRectH
    rectW = rectH * aspect
  }
  const consumed =
    remainingLength !== undefined && remainingLength >= 0 && remainingLength <= length
      ? length - remainingLength
      : 0
  const consumedW = length > 0 ? (consumed / length) * rectW : 0
  return {
    svgW: rectW + H_PAD * 2,
    svgH: rectH + V_PAD_TOP + V_PAD_BOTTOM,
    rectX: H_PAD,
    rectY: V_PAD_TOP,
    rectW,
    rectH,
    consumedW,
  }
}

function WidthCallout({ layout, label }: { layout: SheetLayout; label: string }) {
  const { rectX, rectY, rectH } = layout
  // Mirrors the length callout: chip behind the rotated label so
  // the callout line doesn't cut through the digits.
  const cy = rectY + rectH / 2
  const chipW = Math.max(42, label.length * 7 + 16)
  const chipH = 16
  return (
    <g>
      <line
        x1={rectX - 14}
        y1={rectY}
        x2={rectX - 14}
        y2={rectY + rectH}
        stroke={CALLOUT}
        strokeWidth="0.75"
      />
      <line
        x1={rectX - 18}
        y1={rectY}
        x2={rectX - 10}
        y2={rectY}
        stroke={CALLOUT}
        strokeWidth="0.75"
      />
      <line
        x1={rectX - 18}
        y1={rectY + rectH}
        x2={rectX - 10}
        y2={rectY + rectH}
        stroke={CALLOUT}
        strokeWidth="0.75"
      />
      <g transform={`rotate(-90 ${rectX - 26} ${cy})`}>
        <rect
          x={rectX - 26 - chipW / 2}
          y={cy - chipH / 2}
          width={chipW}
          height={chipH}
          rx="3"
          fill={LABEL_BG}
          stroke={LABEL_BORDER}
          strokeWidth="0.5"
        />
        <text
          x={rectX - 26}
          y={cy + 4}
          textAnchor="middle"
          fill={LABEL_FG}
          fontFamily="var(--font-mono, monospace)"
          fontSize="11"
        >
          {label}
        </text>
      </g>
    </g>
  )
}

function LengthCallout({ layout, label }: { layout: SheetLayout; label: string }) {
  const { rectX, rectY, rectW, rectH } = layout
  // Text chip is drawn on top of the callout line, so we lay a bg
  // rect behind it to cut out the stroke underneath. Previous
  // version had the text directly on the line — barely legible on
  // the dark card background.
  const chipW = Math.max(56, label.length * 7 + 18)
  const chipH = 16
  const chipX = rectX + rectW / 2 - chipW / 2
  const chipY = rectY + rectH + 16 - chipH / 2
  return (
    <g>
      <line
        x1={rectX}
        y1={rectY + rectH + 16}
        x2={rectX + rectW}
        y2={rectY + rectH + 16}
        stroke={CALLOUT}
        strokeWidth="0.75"
      />
      <line
        x1={rectX}
        y1={rectY + rectH + 12}
        x2={rectX}
        y2={rectY + rectH + 20}
        stroke={CALLOUT}
        strokeWidth="0.75"
      />
      <line
        x1={rectX + rectW}
        y1={rectY + rectH + 12}
        x2={rectX + rectW}
        y2={rectY + rectH + 20}
        stroke={CALLOUT}
        strokeWidth="0.75"
      />
      <rect
        x={chipX}
        y={chipY}
        width={chipW}
        height={chipH}
        rx="3"
        fill={LABEL_BG}
        stroke={LABEL_BORDER}
        strokeWidth="0.5"
      />
      <text
        x={rectX + rectW / 2}
        y={rectY + rectH + 20}
        textAnchor="middle"
        fill={LABEL_FG}
        fontFamily="var(--font-mono, monospace)"
        fontSize="11"
      >
        {label}
      </text>
    </g>
  )
}

function MaterialChip({ layout, label }: { layout: SheetLayout; label: string }) {
  const chipW = Math.max(48, label.length * 7 + 18)
  return (
    <g>
      <rect
        x={layout.rectX + 10}
        y={layout.rectY + 10}
        rx="4"
        height="22"
        width={chipW}
        fill={LABEL_BG}
        stroke={LABEL_BORDER}
        strokeWidth="0.75"
      />
      <text
        x={layout.rectX + 19}
        y={layout.rectY + 25}
        fill={LABEL_FG}
        fontFamily="var(--font-sans, sans-serif)"
        fontSize="11"
        fontWeight="600"
      >
        {label}
      </text>
    </g>
  )
}

function ConsumedOverlay({
  layout,
  reusableRatio,
  scrapRatio,
  offcutId,
  wasteId,
}: {
  layout: SheetLayout
  reusableRatio: number
  scrapRatio: number
  offcutId: string
  wasteId: string
}) {
  const safeReusable = Math.max(0, Math.min(1, reusableRatio))
  const safeScrap = Math.max(0, Math.min(1 - safeReusable, scrapRatio))
  const reusableW = layout.consumedW * safeReusable
  const scrapW = layout.consumedW * safeScrap
  return (
    <>
      {reusableW > 2 && (
        <rect
          x={layout.rectX}
          y={layout.rectY}
          width={reusableW}
          height={layout.rectH}
          fill={`url(#${offcutId})`}
        />
      )}
      {scrapW > 2 && (
        <rect
          x={layout.rectX + reusableW}
          y={layout.rectY}
          width={scrapW}
          height={layout.rectH}
          fill={`url(#${wasteId})`}
        />
      )}
    </>
  )
}

function UsageBar({
  remainingLength,
  totalLength,
}: {
  remainingLength: number
  totalLength: number
}) {
  const cleanRemaining = Number(remainingLength.toFixed(2))
  const cleanTotal = Number(totalLength.toFixed(2))
  const pct =
    totalLength > 0 ? Math.max(0, Math.min(100, (remainingLength / totalLength) * 100)) : 0
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
          Remaining
        </span>
        <span className="font-mono text-foreground">
          {cleanRemaining}″{" "}
          <span className="text-muted-foreground">
            of {cleanTotal}″ · {pct.toFixed(0)}%
          </span>
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground/70 transition-[width]"
          style={{ width: `${pct}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  )
}

export function StockSheet({
  width,
  length,
  remainingLength,
  materialLabel,
  usage,
  className,
  maxWidthPx = 640,
  maxHeightPx = 300,
  showUsageBar = true,
}: StockSheetProps) {
  const rawId = useId().replace(/:/g, "")
  const stockId = `ss-stock-${rawId}`
  const offcutId = `ss-offcut-${rawId}`
  const wasteId = `ss-waste-${rawId}`
  const usableId = `ss-usable-${rawId}`
  const markerId = `ss-marker-${rawId}`

  const layout = useMemo(
    () => computeLayout(width, length, remainingLength, maxWidthPx, maxHeightPx),
    [width, length, remainingLength, maxWidthPx, maxHeightPx]
  )

  const widthLabel = `${Number(width.toFixed(2))}″`
  const lengthLabel = `${Number(length.toFixed(2))}″`

  const consumedSqft =
    remainingLength !== undefined && width > 0 ? ((length - remainingLength) * width) / 144 : 0
  const reusableSqft = usage?.reusableSqft ?? 0
  const scrapSqft = usage?.scrapSqft ?? 0
  const reusableRatio = consumedSqft > 0 ? reusableSqft / consumedSqft : 0
  const scrapRatio = consumedSqft > 0 ? scrapSqft / consumedSqft : 0
  const showConsumed = layout.consumedW > 1
  const showBar = showUsageBar && remainingLength !== undefined && Number.isFinite(remainingLength)

  return (
    <div className={cn("flex w-full flex-col gap-3", className)}>
      <div className="rounded-md border bg-card p-2 shadow-sm dark:bg-stone-950">
        <svg
          viewBox={`0 0 ${layout.svgW} ${layout.svgH}`}
          role="img"
          aria-label={`Roll, ${widthLabel} by ${lengthLabel}`}
          className="block h-auto w-full"
        >
          <SimpleModePatternDefs
            stockPatternId={stockId}
            offcutPatternId={offcutId}
            wastePatternId={wasteId}
            usablePatternId={usableId}
            markerId={markerId}
          />

          {/* Base stock — whole sheet wears the stock pattern */}
          <rect
            x={layout.rectX}
            y={layout.rectY}
            width={layout.rectW}
            height={layout.rectH}
            fill={`url(#${stockId})`}
            stroke={FRAME_STROKE}
            strokeWidth="1.25"
            rx="3"
          />

          {showConsumed && (
            <ConsumedOverlay
              layout={layout}
              reusableRatio={reusableRatio}
              scrapRatio={scrapRatio}
              offcutId={offcutId}
              wasteId={wasteId}
            />
          )}

          {/* Chip takes ~34px vertical; hide it if the sheet
              rendered too thin to hold it without overlapping the
              grid. Consumers still show the material in their own
              chrome (drawer header, card title). */}
          {materialLabel && layout.rectH >= 36 && (
            <MaterialChip layout={layout} label={materialLabel} />
          )}
          <WidthCallout layout={layout} label={widthLabel} />
          <LengthCallout layout={layout} label={lengthLabel} />
        </svg>
      </div>
      {showBar && <UsageBar remainingLength={remainingLength as number} totalLength={length} />}
    </div>
  )
}
