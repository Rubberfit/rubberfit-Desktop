import { useState, useEffect, useId, useMemo, useRef } from "react"

// Re-export types needed by external consumers
export type { SimplePartType, SimpleCutDirection } from "./nesting-visualizer-types"

import { fromPreviewToLayoutModel, type LayoutModel } from "./layout-model"

import type {
  NestingVisualizerProps,
  SimplePartPreview,
  RectLikePreview,
  MultiSheetResult,
  PreviewItem,
  SimpleCutMetrics,
} from "./nesting-visualizer-types"

import {
  generateSimplePartPreview,
  generateSimplePartPreviewAsync,
  generateMultiPartPreview,
  generateMultiPartPreviewAsync,
  computeMultiSheetPreviews,
  globalMultiSheetPack,
} from "./nesting-shape-previews"
import { computeFabricationScore } from "./nesting-preview-builders"

import { useNfpOptimizer } from "./use-nfp-optimizer"
import NestingVizSimpleMode from "./nesting-viz-simple-mode"

// ── 90° CW rotation utilities ───────────────────────────────────────────────

function rotateItem90CW<T extends { x: number; y: number; width: number; height: number }>(
  item: T,
  rollL: number
): T {
  return {
    ...item,
    x: rollL - item.y - item.height,
    y: item.x,
    width: item.height,
    height: item.width,
  }
}

function rotatePreviewItem(item: PreviewItem, rollL: number): PreviewItem {
  const rotatePt = (pt: { x: number; y: number }) => ({ x: rollL - pt.y, y: pt.x })
  // Existing NFP polygon — rotate vertices only
  if (item.placedPolygon && item.placedPolygon.length > 0) {
    return { ...rotateItem90CW(item, rollL), placedPolygon: item.placedPolygon.map(rotatePt) }
  }
  // Trapezoid — tessellate 4 corners then rotate
  if (item.renderShape === "trapezoid") {
    const topW = item.topWidth ?? item.width
    const botW = item.bottomWidth ?? item.width
    const pts = item.flipped
      ? [
          { x: item.x + (item.width - botW) / 2, y: item.y },
          { x: item.x + (item.width + botW) / 2, y: item.y },
          { x: item.x + (item.width + topW) / 2, y: item.y + item.height },
          { x: item.x + (item.width - topW) / 2, y: item.y + item.height },
        ]
      : [
          { x: item.x + (item.width - topW) / 2, y: item.y },
          { x: item.x + (item.width + topW) / 2, y: item.y },
          { x: item.x + (item.width + botW) / 2, y: item.y + item.height },
          { x: item.x + (item.width - botW) / 2, y: item.y + item.height },
        ]
    return { ...rotateItem90CW(item, rollL), placedPolygon: pts.map(rotatePt) }
  }
  // Sector (cone) — tessellate arcs then rotate
  if (item.renderShape === "sector") {
    const innerR = item.innerRadius ?? 0
    const outerR = item.outerRadius ?? 0
    const arcDeg = item.arcDegrees ?? 120
    const halfArc = (arcDeg * Math.PI) / 360
    const flipSign = item.flipped ? -1 : 1
    const arcAngleOffset = item.rotated90 ? Math.PI / 2 : 0
    // Rotated 90° CW: dome points right → apex at right edge, center = right_edge − outerR
    const cx = item.rotated90 ? item.x + item.width - outerR : item.x + item.width / 2
    const cy = item.rotated90 ? item.y + item.height / 2 : item.y + outerR
    const a1 = -Math.PI / 2 - halfArc * flipSign + arcAngleOffset
    const a2 = -Math.PI / 2 + halfArc * flipSign + arcAngleOffset
    const segments = 32
    const pts: Array<{ x: number; y: number }> = []
    for (let i = 0; i <= segments; i++) {
      const a = a1 + (i / segments) * (a2 - a1)
      pts.push({ x: cx + outerR * Math.cos(a), y: cy + outerR * Math.sin(a) })
    }
    for (let i = 0; i <= segments; i++) {
      const a = a2 + (i / segments) * (a1 - a2)
      pts.push({ x: cx + innerR * Math.cos(a), y: cy + innerR * Math.sin(a) })
    }
    return { ...rotateItem90CW(item, rollL), placedPolygon: pts.map(rotatePt) }
  }
  return rotateItem90CW(item, rollL)
}

function rotateSimplePartPreview(preview: SimplePartPreview, rollL: number): SimplePartPreview {
  const rotBand = (b: { x: number; y: number; width: number; height: number }) =>
    rotateItem90CW(b, rollL)
  return {
    ...preview,
    items: preview.items.map((item) => rotatePreviewItem(item, rollL)),
    offcutBands: preview.offcutBands.map(rotBand),
    scrapBands: preview.scrapBands.map(rotBand),
  }
}

function rotateMultiSheetResult(result: MultiSheetResult, rollL: number): MultiSheetResult {
  return {
    ...result,
    sheets: result.sheets.map((sheet) => ({
      ...sheet,
      preview: rotateSimplePartPreview(sheet.preview, rollL),
    })),
  }
}

// ────────────────────────────────────────────────────────────────────────────

function buildMultiSheet(
  basePreview: SimplePartPreview | null,
  specs: NestingVisualizerProps["simpleParts"] & object,
  rollW: number,
  rollL: number,
  cutW: number,
  cutH: number
): MultiSheetResult | null {
  if (!basePreview) return null

  const allTrapezoids = specs.length > 1 && specs.every((s) => s.partType === "trapezoid")
  // Mixed cone/trapezoid (with at least one cone) uses the mixed-NFP path
  // via generateMultiPartPreview — overflow sheets regenerate through the same
  // function so each sheet's layout uses NFP rotation, not AABB shelf packing.
  const isMixedConeOrTrapezoid =
    specs.length > 1 &&
    specs.every((s) => s.partType === "cone" || s.partType === "trapezoid") &&
    specs.some((s) => s.partType === "cone")
  // Trapezoid + any non-trapezoid spec uses the trapezoid hybrid path so
  // trapezoids keep their interlocked layout; overflow sheets regenerate
  // through the same path. Includes trapezoid+cone (which would otherwise be
  // isMixedConeOrTrapezoid) — the hybrid takes precedence in that case.
  const isTrapezoidPlusOther =
    specs.length > 1 &&
    specs.some((s) => s.partType === "trapezoid") &&
    specs.some((s) => s.partType !== "trapezoid")
  const needsNfpRegenerate = isMixedConeOrTrapezoid || isTrapezoidPlusOther
  const shouldUseGlobalPacker =
    (specs.length > 1 && !allTrapezoids && !needsNfpRegenerate) ||
    (specs.length === 1 && specs[0]?.partType === "rectangle" && basePreview.overflowUnits > 0)

  if (shouldUseGlobalPacker) {
    return globalMultiSheetPack(specs, rollW, rollL, 4, cutW, cutH)
  }

  if (allTrapezoids || needsNfpRegenerate) {
    // For mixed cone/trapezoid and trapezoid+other, overflow sheets need to
    // run NFP / hybrid layout (sync) so they match the first sheet's
    // async-optimized layout. Pure-trapezoid path doesn't use NFP regardless
    // (it goes through packInterleavedTrapezoids).
    const regenerate = (_qty: number, remainingSpecs?: typeof specs) =>
      generateMultiPartPreview(
        rollW,
        rollL,
        remainingSpecs ?? specs,
        cutW,
        cutH,
        !needsNfpRegenerate
      )
    return computeMultiSheetPreviews(basePreview, rollW, rollL, 4, regenerate, specs)
  }

  // Single-part: use existing sequential overflow packing.
  // skipNfpPacking=false so overflow sheets run NFP and match sheet 1's layout
  // (the first sheet uses the async NFP-optimized basePreview).
  const regenerate = (qty: number) => {
    const partWithQty = { ...specs[0], quantity: qty }
    return generateSimplePartPreview(rollW, rollL, partWithQty, cutW, cutH, qty, false)
  }
  return computeMultiSheetPreviews(basePreview, rollW, rollL, 4, regenerate)
}

function indexToTag(i: number): string {
  let tag = ""
  let n = i
  do {
    tag = String.fromCharCode(65 + (n % 26)) + tag
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return tag
}

/**
 * Build a tag map keyed by `specIndex` (string) → tag value.
 * Uses part numbers (e.g. "G2") when available, falls back to generated letters (A, B, C…).
 */
function buildTagMap(basePreview: SimplePartPreview | null, multiSheet: MultiSheetResult | null) {
  if (!basePreview) return new Map<string, string>()

  // Collect unique specIndex values and their associated partNumbers.
  const seenIndices: number[] = []
  const specPartNumbers = new Map<number, string>()
  const collectItem = (item: PreviewItem) => {
    const idx = item.specIndex
    if (idx != null && !seenIndices.includes(idx)) {
      seenIndices.push(idx)
      if (item.partNumber) specPartNumbers.set(idx, item.partNumber)
    }
  }

  if (multiSheet) {
    multiSheet.sheets.forEach((sheet) => sheet.preview.items.forEach(collectItem))
  } else {
    basePreview.items.forEach(collectItem)
  }

  // Sort by specIndex so tag order matches the user's selection order
  seenIndices.sort((a, b) => a - b)

  // Assign tags: use partNumber when available, otherwise generate A/B/C letters
  let fallbackCounter = 0
  return new Map(
    seenIndices.map((idx) => {
      const partNumber = specPartNumbers.get(idx)
      const tag = partNumber ?? indexToTag(fallbackCounter++)
      return [String(idx), tag]
    })
  )
}

export default function NestingVisualizer({
  defaultRollWidth = 48,
  defaultRollLength = 96,
  defaultCutWidth = 24,
  defaultCutHeight = 12,
  defaultQty = 6,
  simplePart,
  simpleParts,
  onMetricsChange,
  onTagMapChange,
  onLayoutChange,
}: NestingVisualizerProps & { onLayoutChange?: (layouts: LayoutModel[]) => void }) {
  const patternSeed = useId().replace(/:/g, "")

  const [viewMode, setViewMode] = useState<"stock" | "profile">("stock")

  // Caller explicitly passed an empty `simpleParts` array — i.e.
  // "render the sheet chrome but nothing's placed yet". We short-
  // circuit the preview pipeline with a synthetic empty preview so
  // the same downstream renderer is used whether cuts are placed
  // or not. Keeps the engine layout identical in both states.
  const isEmptySheet = simpleParts !== undefined && simpleParts.length === 0

  const activeSimpleSpecs = useMemo(() => {
    if (simpleParts && simpleParts.length > 0) return simpleParts
    if (simplePart) return [simplePart]
    return [
      {
        partType: "rectangle" as const,
        quantity: defaultQty,
        width: defaultCutWidth,
        length: defaultCutHeight,
      },
    ]
  }, [simpleParts, simplePart, defaultQty, defaultCutWidth, defaultCutHeight])

  const emptyPreview = useMemo<RectLikePreview | null>(() => {
    if (!isEmptySheet) return null
    const stockArea = defaultRollWidth * defaultRollLength
    return {
      renderShape: "rect",
      strategyName: "Empty sheet",
      strategyNote: "No cuts placed yet",
      placementMode: "origin",
      wasteMode: "bands",
      cutPlanTitle: "",
      cutSteps: [],
      requestedUnits: 0,
      unitsCompleted: 0,
      overflowUnits: 0,
      piecesShown: 0,
      piecesPerUnit: 0,
      usedArea: 0,
      wasteArea: stockArea,
      wastePct: 100,
      reusableArea: stockArea,
      scrapArea: 0,
      occupiedWidth: 0,
      occupiedHeight: 0,
      items: [],
      offcutBands: [{ x: 0, y: 0, width: defaultRollWidth, height: defaultRollLength }],
      scrapBands: [],
      placements: [],
      label: "",
      fabricationScore: 0,
    }
  }, [isEmptySheet, defaultRollWidth, defaultRollLength])

  // First paint runs the sync generator so the UI is never empty while workers warm up.
  // For cone/trapezoid specs an async refinement runs on the worker pool and replaces
  // this value when ready (effect below).
  const syncBasePreview = useMemo<SimplePartPreview | null>(() => {
    if (isEmptySheet) return emptyPreview
    return activeSimpleSpecs.length > 1
      ? generateMultiPartPreview(
          defaultRollWidth,
          defaultRollLength,
          activeSimpleSpecs,
          defaultCutWidth,
          defaultCutHeight
        )
      : generateSimplePartPreview(
          defaultRollWidth,
          defaultRollLength,
          activeSimpleSpecs[0],
          defaultCutWidth,
          defaultCutHeight,
          defaultQty
        )
  }, [
    isEmptySheet,
    emptyPreview,
    activeSimpleSpecs,
    defaultRollWidth,
    defaultRollLength,
    defaultCutWidth,
    defaultCutHeight,
    defaultQty,
  ])

  // Key-based invalidation so a stale async preview from a previous spec
  // doesn't leak through when the user switches shapes or sizes.
  const asyncPreviewKey = useMemo(
    () =>
      JSON.stringify({
        specs: activeSimpleSpecs,
        rw: defaultRollWidth,
        rl: defaultRollLength,
        cw: defaultCutWidth,
        ch: defaultCutHeight,
        q: defaultQty,
      }),
    [
      activeSimpleSpecs,
      defaultRollWidth,
      defaultRollLength,
      defaultCutWidth,
      defaultCutHeight,
      defaultQty,
    ]
  )
  const [asyncBasePreview, setAsyncBasePreview] = useState<{
    key: string
    preview: SimplePartPreview
  } | null>(null)

  useEffect(() => {
    if (isEmptySheet) return // nothing to refine on a blank sheet
    const key = asyncPreviewKey
    let cancelled = false

    // Single-spec cone/trapezoid: refine via greedyNfpPackAsync (worker pool)
    if (activeSimpleSpecs.length === 1) {
      const spec = activeSimpleSpecs[0]
      if (spec.partType !== "cone" && spec.partType !== "trapezoid") return
      generateSimplePartPreviewAsync(
        defaultRollWidth,
        defaultRollLength,
        spec,
        defaultCutWidth,
        defaultCutHeight,
        defaultQty
      )
        .then((preview) => {
          if (!cancelled) setAsyncBasePreview({ key, preview })
        })
        .catch((err) => {
          console.error("[NestingVisualizer] async preview failed", err)
        })
      return () => {
        cancelled = true
      }
    }

    // Multi-spec layouts that can benefit from worker-pool refinement:
    //   • all-cone-or-trapezoid with at least one cone → mixed-NFP path
    //   • any trapezoid + any non-trapezoid → trapezoid hybrid path
    // Both run inside generateMultiPartPreviewAsync; the routing there picks
    // the right algorithm. Anything else (rect/circle mixes) doesn't benefit
    // from the async refinement and is handled by the global packer.
    const allConeOrTrapezoid = activeSimpleSpecs.every(
      (s) => s.partType === "cone" || s.partType === "trapezoid"
    )
    const hasCone = activeSimpleSpecs.some((s) => s.partType === "cone")
    const hasTrapezoid = activeSimpleSpecs.some((s) => s.partType === "trapezoid")
    const hasNonTrapezoid = activeSimpleSpecs.some((s) => s.partType !== "trapezoid")
    const isTrapezoidPlusOther = hasTrapezoid && hasNonTrapezoid
    const eligibleForAsync = (allConeOrTrapezoid && hasCone) || isTrapezoidPlusOther
    if (!eligibleForAsync) return

    generateMultiPartPreviewAsync(
      defaultRollWidth,
      defaultRollLength,
      [...activeSimpleSpecs],
      defaultCutWidth,
      defaultCutHeight
    )
      .then((preview) => {
        if (!cancelled) setAsyncBasePreview({ key, preview })
      })
      .catch((err) => {
        console.error("[NestingVisualizer] async multi-part preview failed", err)
      })
    return () => {
      cancelled = true
    }
  }, [
    asyncPreviewKey,
    activeSimpleSpecs,
    defaultRollWidth,
    defaultRollLength,
    defaultCutWidth,
    defaultCutHeight,
    defaultQty,
    isEmptySheet,
  ])

  const baseSimplePreview =
    asyncBasePreview && asyncBasePreview.key === asyncPreviewKey
      ? asyncBasePreview.preview
      : syncBasePreview

  useEffect(() => {
    if (activeSimpleSpecs.some((spec) => spec.partType !== "rectangle"))
      queueMicrotask(() => setViewMode("stock"))
  }, [activeSimpleSpecs])

  // Calls useNfpOptimizer to attempt to optimize the UI for long running generations
  const { optimizedResult, optimizedItems, isOptimizing, nfpError } = useNfpOptimizer(
    true,
    activeSimpleSpecs,
    defaultCutWidth,
    defaultCutHeight,
    defaultQty,
    defaultRollWidth,
    defaultRollLength
  )

  const multiSheet = useMemo(
    () =>
      buildMultiSheet(
        baseSimplePreview,
        activeSimpleSpecs,
        defaultRollWidth,
        defaultRollLength,
        defaultCutWidth,
        defaultCutHeight
      ),
    [
      baseSimplePreview,
      activeSimpleSpecs,
      defaultRollWidth,
      defaultRollLength,
      defaultCutWidth,
      defaultCutHeight,
    ]
  )

  const tagMap = useMemo(
    () => buildTagMap(baseSimplePreview, multiSheet),
    [baseSimplePreview, multiSheet]
  )

  // Dedup same-signature metrics emits (see `lastEmittedLayoutsSigRef`
  // above for the full rationale — same pattern, same loop-avoidance).
  const lastEmittedMetricsSigRef = useRef<string | null>(null)
  useEffect(() => {
    if (!onMetricsChange || !baseSimplePreview) return
    try {
      // Per-piece offcut geometry. Both the single-sheet preview
      // and multi-sheet aggregator expose `offcutBands` already,
      // filtered to only the *reusable* rectangles (scrap bands
      // are partitioned out upstream). We project them into the
      // metrics contract so the cut-recording route can spawn one
      // inventory row per piece.
      const bandToPiece = (band: { width: number; height: number }) => ({
        widthIn: Number(band.width.toFixed(4)),
        lengthIn: Number(band.height.toFixed(4)),
        areaSqft: Number(((band.width * band.height) / 144).toFixed(4)),
      })

      let metrics: SimpleCutMetrics
      if (multiSheet && multiSheet.sheets.length > 1) {
        const totalPieces = multiSheet.sheets.reduce((sum, s) => sum + s.preview.piecesShown, 0)
        const offcutPieces = multiSheet.sheets.flatMap((s) =>
          s.preview.offcutBands.map(bandToPiece)
        )
        metrics = {
          partsCompleted: multiSheet.totalUnitsCompleted,
          cutPieces: totalPieces,
          materialUsedSqFt: multiSheet.totalUsedArea / 144,
          reusableOffsetSqFt: multiSheet.totalReusableArea / 144,
          scrapSqFt: multiSheet.totalScrapArea / 144,
          fabScore: multiSheet.avgFabScore / 100,
          offcutPieces,
        }
      } else {
        const rawScore =
          baseSimplePreview.fabricationScore ??
          computeFabricationScore(baseSimplePreview, defaultRollWidth, defaultRollLength).score
        metrics = {
          partsCompleted: baseSimplePreview.unitsCompleted,
          cutPieces: baseSimplePreview.piecesShown,
          materialUsedSqFt: baseSimplePreview.usedArea / 144,
          reusableOffsetSqFt: baseSimplePreview.reusableArea / 144,
          scrapSqFt: baseSimplePreview.scrapArea / 144,
          fabScore: rawScore / 100,
          offcutPieces: baseSimplePreview.offcutBands.map(bandToPiece),
        }
      }
      const sig = JSON.stringify(metrics)
      if (sig === lastEmittedMetricsSigRef.current) return
      lastEmittedMetricsSigRef.current = sig
      onMetricsChange(metrics)
    } catch (_error) {
      // metrics computation failure must not break the visualizer
    }
  }, [baseSimplePreview, multiSheet, onMetricsChange, defaultRollWidth, defaultRollLength])

  useEffect(() => {
    if (onTagMapChange && tagMap.size > 0) onTagMapChange(tagMap)
  }, [tagMap, onTagMapChange])

  // Rotate the entire result once after nesting so the display layer never needs to transform.
  const shouldRotate = defaultRollLength > defaultRollWidth

  const rotatedMultiSheet = useMemo(
    () =>
      shouldRotate && multiSheet
        ? rotateMultiSheetResult(multiSheet, defaultRollLength)
        : multiSheet,
    [shouldRotate, multiSheet, defaultRollLength]
  )

  const rotatedOptimizedItems = useMemo(
    () =>
      shouldRotate && optimizedItems
        ? optimizedItems.map((item) => rotatePreviewItem(item, defaultRollLength))
        : optimizedItems,
    [shouldRotate, optimizedItems, defaultRollLength]
  )

  const rawPreview =
    baseSimplePreview ??
    generateSimplePartPreview(
      defaultRollWidth,
      defaultRollLength,
      activeSimpleSpecs[0],
      defaultCutWidth,
      defaultCutHeight,
      defaultQty
    )

  const preview = shouldRotate ? rotateSimplePartPreview(rawPreview, defaultRollLength) : rawPreview

  // Emit LayoutModel[] after each layout update so Konva renderer and PDF
  // can use post-rotation coordinates without re-deriving them.
  //
  // Dedup by serialised signature — one of the deps in this array
  // churns identity on some render cycles (e.g. `tagMap` rebuilds
  // when `selectedTemplates` identity cascades from a load), which
  // with the unconditional `onLayoutChange(...)` below would schedule
  // a setState in the parent every render → parent re-renders →
  // effect re-fires → infinite loop. The ref holds the last-emitted
  // JSON so structurally-identical emits are skipped even when the
  // memoised inputs got new references.
  const lastEmittedLayoutsSigRef = useRef<string | null>(null)
  useEffect(() => {
    if (!onLayoutChange) return
    const displayW = shouldRotate ? defaultRollLength : defaultRollWidth
    const displayL = shouldRotate ? defaultRollWidth : defaultRollLength
    const next =
      rotatedMultiSheet && rotatedMultiSheet.sheets.length > 1
        ? rotatedMultiSheet.sheets.map((sheet) =>
            fromPreviewToLayoutModel(sheet.preview, displayW, displayL, tagMap)
          )
        : [fromPreviewToLayoutModel(preview, displayW, displayL, tagMap)]
    const sig = JSON.stringify(next)
    if (sig === lastEmittedLayoutsSigRef.current) return
    lastEmittedLayoutsSigRef.current = sig
    onLayoutChange(next)
  }, [
    onLayoutChange,
    preview,
    rotatedMultiSheet,
    shouldRotate,
    defaultRollWidth,
    defaultRollLength,
    tagMap,
  ])

  return (
    <NestingVizSimpleMode
      preview={preview}
      previewRollW={shouldRotate ? defaultRollLength : defaultRollWidth}
      previewRollL={shouldRotate ? defaultRollWidth : defaultRollLength}
      wasRotated={shouldRotate}
      patternSeed={patternSeed}
      viewMode={viewMode}
      optimizedResult={optimizedResult}
      optimizedItems={rotatedOptimizedItems}
      isOptimizing={isOptimizing}
      nfpError={nfpError}
      multiSheet={rotatedMultiSheet}
      tagMap={tagMap}
    />
  )
}
