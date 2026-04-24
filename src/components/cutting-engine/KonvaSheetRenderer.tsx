import { useEffect, useRef, useState } from "react"
import type { KonvaEventObject } from "konva/lib/Node"
import { Stage, Layer, Rect, Circle, Ellipse, Ring, Line, Text, Group } from "react-konva"
import type { LayoutModel, PlacedPart, LayoutRegion } from "./layout-model"
import { useKonvaTheme, type KonvaThemeTokens } from "./konva-theme"

/**
 * Callback when a draggable part finishes moving. Coordinates are
 * in SHEET INCHES (not pixels) so callers don't need to know the
 * canvas scale. Only fires when `draggable` is enabled.
 */
type PartDragEnd = (partId: string, xIn: number, yIn: number) => void

/**
 * Callback fired continuously during drag. Coordinates are in SHEET
 * INCHES. Callers should throttle downstream work (e.g. via rAF) —
 * this fires at pointer-move rate.
 */
type PartDragMove = (partId: string, xIn: number, yIn: number) => void

/** Callback when a part is clicked. Fires before any drag. */
type PartClick = (partId: string) => void

// ── Shape renderers ──────────────────────────────────────────────────────────

function PartShape({
  part,
  scale,
  fill,
  theme,
  draggable,
  selected,
  realistic,
  onDragEnd,
  onDragMove,
  onClick,
}: {
  part: PlacedPart
  scale: number
  fill: string
  theme: KonvaThemeTokens
  draggable: boolean
  selected: boolean
  /**
   * When true, parts render with a drop shadow + rounded corners so
   * they read as physical chunks of material on the sheet. Enabled
   * on the Free-roam CAD surface; Auto-nest keeps the flat look so
   * the nest preview stays crisp at every scale.
   */
  realistic: boolean
  onDragEnd?: PartDragEnd
  onDragMove?: PartDragMove
  onClick?: PartClick
}) {
  const pw = part.width * scale
  const ph = part.height * scale

  // Outer Group pivots around the part's CENTER so rotation pivots
  // there too (users expect a part to spin in place, not swing around
  // its top-left corner). Using Konva's offset pattern: the group's
  // `x/y` represents the position of the pivot point in world space,
  // and `offsetX/Y` sets where that pivot sits in the group's local
  // frame. Children still render from local (0,0) = part top-left.
  //
  // On drag end, `e.target.x()` is the new pivot (= center) in world
  // pixels; subtract the offset to get the top-left back out.
  const handleDragEnd = (e: KonvaEventObject<DragEvent>) => {
    if (!onDragEnd) return
    onDragEnd(part.id, (e.target.x() - pw / 2) / scale, (e.target.y() - ph / 2) / scale)
  }
  const handleDragMove = (e: KonvaEventObject<DragEvent>) => {
    if (!onDragMove) return
    onDragMove(part.id, (e.target.x() - pw / 2) / scale, (e.target.y() - ph / 2) / scale)
  }
  const rotationDeg = (part.rotationRad * 180) / Math.PI

  const selectedStroke = "#3b82f6" // blue-500 — visible against any vibrant part fill
  const stroke = selected ? selectedStroke : theme.partStroke
  const strokeWidth = selected ? 2 : 1

  // Shared shadow props — dropped onto each body shape so the part
  // reads as a physical chunk of material lifted off the sheet.
  // Shadow follows the shape's outline (not the bbox), which is why
  // the props live on the body, not the wrapping Group.
  const shadowProps = realistic
    ? {
        shadowColor: "rgba(15, 23, 42, 0.35)", // slate-900 @ 35%
        shadowBlur: 6,
        shadowOffsetX: 0,
        shadowOffsetY: 2,
        shadowOpacity: 1,
      }
    : {}
  // Rounded corners only on the Rect fallback path — softens the
  // CAD sticker look without distorting shapes that carry their
  // own vertex list.
  const cornerRadius = realistic ? Math.min(pw, ph) * 0.03 : 0

  // Dispatch order:
  //   1. Konva native primitives when the shape has one (Circle,
  //      Ellipse, Ring) — exact geometry, crisp hit-testing, no
  //      polygon-approximation artifacts.
  //   2. Polygon-as-Line (closed) for any shape that carries a
  //      precomputed vertex array (trapezoid, sector, triangle,
  //      n-gon, star, custom polygon).
  //   3. Axis-aligned Rect as last-resort fallback so a broken
  //      template still renders something at the right bbox.
  let body: React.ReactNode
  if (part.renderShape === "circle" && part.diameter != null) {
    const r = (part.diameter / 2) * scale
    body = (
      <Circle
        x={pw / 2}
        y={ph / 2}
        radius={r}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        {...shadowProps}
      />
    )
  } else if (part.renderShape === "ellipse") {
    body = (
      <Ellipse
        x={pw / 2}
        y={ph / 2}
        radiusX={pw / 2}
        radiusY={ph / 2}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        {...shadowProps}
      />
    )
  } else if (part.renderShape === "ring" && part.innerRadius != null && part.outerRadius != null) {
    body = (
      <Ring
        x={pw / 2}
        y={ph / 2}
        innerRadius={part.innerRadius * scale}
        outerRadius={part.outerRadius * scale}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        {...shadowProps}
      />
    )
  } else if (part.polygon && part.polygon.length >= 3) {
    const points = part.polygon.flatMap((pt) => [(pt.x - part.x) * scale, (pt.y - part.y) * scale])
    body = (
      <Line
        points={points}
        closed
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        {...shadowProps}
      />
    )
  } else {
    body = (
      <Rect
        x={0}
        y={0}
        width={pw}
        height={ph}
        cornerRadius={cornerRadius}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        {...shadowProps}
      />
    )
  }

  const fontSize = Math.max(9, Math.min(14, Math.min(pw, ph) / 3))

  return (
    <Group
      x={part.x * scale + pw / 2}
      y={part.y * scale + ph / 2}
      offsetX={pw / 2}
      offsetY={ph / 2}
      rotation={rotationDeg}
      draggable={draggable}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onMouseDown={() => onClick?.(part.id)}
      onTap={() => onClick?.(part.id)}
    >
      {body}
      <Text
        x={0}
        y={ph / 2 - fontSize}
        width={pw}
        height={fontSize * 2}
        text={part.label}
        fontSize={fontSize}
        fill={theme.labelFill}
        stroke={theme.labelStroke}
        strokeWidth={2}
        fillAfterStrokeEnabled
        fontStyle="bold"
        align="center"
        verticalAlign="middle"
        listening={false}
      />
    </Group>
  )
}

function RegionShape({
  region,
  scale,
  fill,
  stroke,
}: {
  region: LayoutRegion
  scale: number
  fill: string
  stroke: string
}) {
  if (region.polygon && region.polygon.length >= 3) {
    const points = region.polygon.flatMap((pt) => [pt.x * scale, pt.y * scale])
    return <Line points={points} closed fill={fill} stroke={stroke} strokeWidth={0.5} />
  }
  return (
    <Rect
      x={region.x * scale}
      y={region.y * scale}
      width={region.width * scale}
      height={region.height * scale}
      fill={fill}
      stroke={stroke}
      strokeWidth={0.5}
    />
  )
}

// ── Grid lines (12" intervals) ───────────────────────────────────────────────

function GridLines({
  sheetW,
  sheetL,
  scale,
  stroke,
}: {
  sheetW: number
  sheetL: number
  scale: number
  stroke: string
}) {
  const vLines: number[] = []
  for (let x = 12; x < sheetW; x += 12) vLines.push(x)
  const hLines: number[] = []
  for (let y = 12; y < sheetL; y += 12) hLines.push(y)

  return (
    <>
      {vLines.map((x) => (
        <Line
          key={`v${x}`}
          points={[x * scale, 0, x * scale, sheetL * scale]}
          stroke={stroke}
          strokeWidth={0.5}
          listening={false}
        />
      ))}
      {hLines.map((y) => (
        <Line
          key={`h${y}`}
          points={[0, y * scale, sheetW * scale, y * scale]}
          stroke={stroke}
          strokeWidth={0.5}
          listening={false}
        />
      ))}
    </>
  )
}

// ── Main renderer ────────────────────────────────────────────────────────────

interface KonvaSheetRendererProps {
  layout: LayoutModel
  className?: string
  /**
   * When set, each rendered part is draggable; the callback fires on
   * drag end with the new position in sheet inches. Omitting the
   * prop leaves the canvas read-only (Auto-nest Graph surface).
   */
  onPartDragEnd?: PartDragEnd
  /**
   * Fires continuously during drag — pointer-move rate. Use for
   * adaptive offcut/waste recomputation; callers should rAF-throttle
   * anything expensive (e.g. Clipper polygon diffs).
   */
  onPartDragMove?: PartDragMove
  /** Currently-selected part id — renders with a highlight stroke. */
  selectedPartId?: string | null
  /** Fires when a part is clicked / tapped. */
  onPartClick?: PartClick
  /** Fires when the empty sheet (not a part) is clicked. Useful for clearing selection. */
  onSheetClick?: () => void
  /**
   * Controls the sheet's default background color. `"sheet"` (default)
   * uses the neutral sheet fill — the Auto-nest look where offcut /
   * scrap regions render on top as classified overlays. `"offcut"`
   * paints the sheet in the reusable amber color, so any area not
   * covered by a part or a scrap overlay is visually classified as
   * reusable by default — matches the Free-roam semantic where an
   * empty sheet IS one big reusable offcut.
   */
  defaultFill?: "sheet" | "offcut"
  /**
   * User zoom percentage applied on top of the auto-fit scale.
   * 100 = fit-to-container (default); 200 = 2× that fit. Values
   * outside [25, 400] are clamped by the toolbar before they reach
   * this prop. Content that overflows the stage at high zoom is
   * clipped — pan support lands with the Hand tool later.
   */
  zoomPct?: number
  /** Render the 12" grid. Default true. */
  showGrid?: boolean
}

export default function KonvaSheetRenderer({
  layout,
  className,
  onPartDragEnd,
  onPartDragMove,
  selectedPartId,
  onPartClick,
  onSheetClick,
  defaultFill = "sheet",
  zoomPct = 100,
  showGrid = true,
}: KonvaSheetRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const theme = useKonvaTheme()

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) setSize({ w: width, h: height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Auto-fit: the largest scale at which the sheet fits inside the
  // container (with a small inset so the sheet isn't flush with the
  // chrome). User zoom is applied on top — zoomPct=100 matches the
  // historical behavior, zoomPct=200 renders at 2× auto-fit, etc.
  const autoFitScale =
    size.w > 0 && size.h > 0
      ? Math.min(size.w / layout.sheetWidth, size.h / layout.sheetLength) * 0.96
      : 0
  const scale = autoFitScale * (zoomPct / 100)

  const stageW = Math.round(layout.sheetWidth * scale)
  const stageH = Math.round(layout.sheetLength * scale)
  const offsetX = Math.max(0, (size.w - stageW) / 2)
  const offsetY = Math.max(0, (size.h - stageH) / 2)

  return (
    <div ref={containerRef} className={className ?? "w-full h-full"}>
      {scale > 0 && (
        <Stage width={size.w} height={size.h} style={{ display: "block" }}>
          <Layer x={offsetX} y={offsetY}>
            {/* Sheet background — clicking clears selection. Fill
                tracks `defaultFill`: the Auto-nest surface stays
                neutral grey, the Free-roam surface paints amber so
                any uncovered area is visually reusable by default. */}
            <Rect
              x={0}
              y={0}
              width={stageW}
              height={stageH}
              fill={defaultFill === "offcut" ? theme.offcutFill : theme.sheetFill}
              stroke={theme.sheetStroke}
              strokeWidth={1}
              onMouseDown={() => onSheetClick?.()}
              onTap={() => onSheetClick?.()}
            />

            {/* Grid — hidden when the toolbar toggle is off */}
            {showGrid && (
              <GridLines
                sheetW={layout.sheetWidth}
                sheetL={layout.sheetLength}
                scale={scale}
                stroke={theme.grid}
              />
            )}

            {/* Reusable offcut — amber. When the sheet background
                is already amber (Free-roam surface), these would be
                amber on amber; their strokes would add visible
                rectangle outlines around every classified region,
                which reads as busy noise rather than information.
                Skip them — the background carries the semantic. */}
            {defaultFill !== "offcut" &&
              layout.offcuts.map((region, i) => (
                <RegionShape
                  key={`offcut-${i}`}
                  region={region}
                  scale={scale}
                  fill={theme.offcutFill}
                  stroke={theme.offcutStroke}
                />
              ))}

            {/* Scrap / waste — red */}
            {layout.scrap.map((region, i) => (
              <RegionShape
                key={`scrap-${i}`}
                region={region}
                scale={scale}
                fill={theme.scrapFill}
                stroke={theme.scrapStroke}
              />
            ))}

            {/* Parts */}
            {layout.parts.map((part) => (
              <PartShape
                key={part.id}
                part={part}
                scale={scale}
                fill={theme.partFills[part.specIndex % theme.partFills.length]}
                theme={theme}
                draggable={typeof onPartDragEnd === "function"}
                selected={selectedPartId === part.id}
                realistic={defaultFill === "offcut"}
                onDragEnd={onPartDragEnd}
                onDragMove={onPartDragMove}
                onClick={onPartClick}
              />
            ))}
          </Layer>
        </Stage>
      )}
    </div>
  )
}
