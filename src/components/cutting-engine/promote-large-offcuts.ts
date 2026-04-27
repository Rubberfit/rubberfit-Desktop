// Post-pack pass that promotes large reusable offcuts into their own
// rendered sheets so operators can see the leftover stock as a discrete
// piece rather than an amber rect cramped next to placed parts.
//
// Issue #23. Pure presentation layer — runs over `LayoutModel[]` after
// `packResultToLayoutModel` and before `setLayouts`, with no Rust
// changes. The synthetic ("offcut-extract") layouts are tagged via
// `LayoutModel.sheetKind` so the visualizer header / totals can branch.

import type { LayoutModel, LayoutRegion } from "./layout-model"

/** Promote any reusable offcut whose bbox area ≥ 40% of its source sheet's area. */
export const OFFCUT_PROMOTION_RATIO = 0.4

/** Cap promotions per source sheet so a fragmented bin can't spawn 10+ extra cards. */
export const MAX_PROMOTIONS_PER_SHEET = 3

export function promoteLargeOffcutsToSheets(
  layouts: LayoutModel[],
  thresholdRatio = OFFCUT_PROMOTION_RATIO
): LayoutModel[] {
  const out: LayoutModel[] = []
  let standardIndex = 0

  for (const layout of layouts) {
    if (layout.sheetKind === "offcut-extract") {
      // Defensive: if a synthetic somehow re-enters, pass it through
      // unchanged so a double-call is idempotent on tagged input.
      out.push(layout)
      continue
    }

    const sheetAreaSqIn = layout.sheetWidth * layout.sheetLength
    const thresholdSqIn = thresholdRatio * sheetAreaSqIn
    // Trust the parent's already-capped reusableAreaSqFt as the
    // ceiling — `pack-result-to-layout-model.ts` clamps the raw bbox
    // sum at the bin's `wasteArea`, so individual offcuts can over-
    // report (0.25" grid sampler) but the parent total cannot. If the
    // total can't even fit one threshold-sized offcut, skip the whole
    // pass for this sheet.
    const reusableSqIn = layout.reusableAreaSqFt * 144
    if (reusableSqIn < thresholdSqIn) {
      out.push(layout)
      standardIndex++
      continue
    }

    const candidates = layout.offcuts
      .map((region, originalIndex) => ({
        region,
        originalIndex,
        area: region.width * region.height,
      }))
      .filter((c) => c.area >= thresholdSqIn)
      .sort((a, b) => b.area - a.area)
      .slice(0, MAX_PROMOTIONS_PER_SHEET)

    if (candidates.length === 0) {
      out.push(layout)
      standardIndex++
      continue
    }

    const promotedIndexes = new Set(candidates.map((c) => c.originalIndex))
    const remainingOffcuts = layout.offcuts.filter((_, i) => !promotedIndexes.has(i))
    const promotedAreaSqFt = candidates.reduce((s, c) => s + c.area, 0) / 144

    const adjustedParent: LayoutModel = {
      ...layout,
      offcuts: remainingOffcuts,
      reusableAreaSqFt: Math.max(0, layout.reusableAreaSqFt - promotedAreaSqFt),
    }

    out.push(adjustedParent)

    for (const c of candidates) {
      out.push(buildSyntheticSheet(c.region, layout, standardIndex))
    }

    standardIndex++
  }

  return out
}

function buildSyntheticSheet(
  offcut: LayoutRegion,
  parent: LayoutModel,
  parentStandardIndex: number
): LayoutModel {
  return {
    sheetWidth: offcut.width,
    sheetLength: offcut.height,
    parts: [],
    offcuts: [{ x: 0, y: 0, width: offcut.width, height: offcut.height }],
    scrap: [],
    debugScrapRects: [],
    placedCount: 0,
    overflowCount: 0,
    usedAreaSqFt: 0,
    reusableAreaSqFt: (offcut.width * offcut.height) / 144,
    scrapAreaSqFt: 0,
    fabScore: 0,
    source: parent.source,
    sheetKind: "offcut-extract",
    parentSheetIndex: parentStandardIndex,
  }
}
