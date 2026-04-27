// Derives a flat, area-ranked list of every reusable offcut across the
// pack's sheets, tagged R1, R2, R3, … in descending area order. Shared
// by the on-screen "Reusable Offcuts" card and the PDF report so both
// surfaces use the same labelling.

import type { LayoutModel, LayoutRegion } from "./layout-model"

export interface TaggedOffcut {
  tag: string
  region: LayoutRegion
  /** 1-indexed standard-sheet number this piece was extracted from. */
  sourceSheetNumber: number
  areaSqIn: number
  areaSqFt: number
}

/**
 * Walk `layouts` once collecting every reusable offcut alongside the
 * standard-sheet number it came from. Promoted offcut-extract sheets
 * carry a single offcut whose source is `parentSheetIndex`; standard
 * sheets carry their remaining (non-promoted) offcuts and report
 * themselves as the source.
 *
 * Returns the list sorted by area descending, tagged R1..Rn.
 */
export function buildTaggedReusableOffcuts(layouts: LayoutModel[]): TaggedOffcut[] {
  const collected: Array<{ region: LayoutRegion; sourceSheetNumber: number }> = []
  let standardCounter = 0

  for (const layout of layouts) {
    if (layout.sheetKind === "offcut-extract") {
      const sourceNumber = (layout.parentSheetIndex ?? 0) + 1
      for (const region of layout.offcuts) {
        collected.push({ region, sourceSheetNumber: sourceNumber })
      }
      continue
    }
    standardCounter++
    for (const region of layout.offcuts) {
      collected.push({ region, sourceSheetNumber: standardCounter })
    }
  }

  return collected
    .map((c) => {
      const areaSqIn = c.region.width * c.region.height
      return {
        region: c.region,
        sourceSheetNumber: c.sourceSheetNumber,
        areaSqIn,
        areaSqFt: areaSqIn / 144,
      }
    })
    .sort((a, b) => b.areaSqIn - a.areaSqIn)
    .map((entry, i) => ({
      tag: `R${i + 1}`,
      ...entry,
    }))
}
