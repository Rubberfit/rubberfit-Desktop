// Layout, scoring, and strategy utilities for NestingVisualizer
// Offcut/placement utilities are in nesting-offcut-utils.ts
// Rect/circle layout calculators are in nesting-rect-layout.ts
// Packing algorithms are in nesting-packing-utils.ts
// Step builders are in nesting-step-builders.ts

import type {
  DiagDir,
  GrainDir,
  ScoredStrategy,
  SimpleCutDirection,
  Strategy,
  StratMethod,
} from "./nesting-visualizer-types"

// SVG helpers
export const NS = "http://www.w3.org/2000/svg"

export function se(tag: string, attrs: Record<string, string | number> = {}, parent?: Element) {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  if (parent) parent.appendChild(e)
  return e
}

export function st(txt: string, attrs: Record<string, string | number> = {}, parent?: Element) {
  const e = se(
    "text",
    {
      "font-size": "9",
      "font-family": "'DM Mono',monospace",
      fill: "#64748b",
      ...attrs,
    },
    parent
  )
  e.textContent = txt
  return e
}

// Layout / scoring helpers
export function calcLayout(rollW: number, rollL: number, cw: number, ch: number) {
  const cols = Math.floor(rollW / cw)
  const rows = Math.floor(rollL / ch)
  const rects = cols * rows
  const waste = rollW * rollL > 0 ? (1 - (rects * cw * ch) / (rollW * rollL)) * 100 : 100
  return { cols, rows, rects, waste, vCuts: cols - 1, hCuts: rows - 1 }
}

export function scoreStrat(
  s: Strategy,
  rollW: number,
  rollL: number,
  qty: number,
  grain: GrainDir
): ScoredStrategy {
  const L = calcLayout(rollW, rollL, s.cutW, s.cutH)
  const pieces = s.method === "diag" ? L.rects * 2 : L.rects
  let score = 100
  const reasons: { p: "p" | "w" | "f"; t: string }[] = []

  // grain
  if (grain === "width" && s.cutH > s.cutW) {
    score -= 45
    reasons.push({ p: "f", t: "Grain conflict — crosses roll width grain." })
  } else if (grain === "length" && s.cutW > s.cutH) {
    score -= 45
    reasons.push({ p: "f", t: "Grain conflict — crosses roll length grain." })
  } else if (grain !== "none") reasons.push({ p: "p", t: "Grain direction preserved." })

  // waste
  score += Math.max(0, 30 - L.waste)
  if (L.waste < 5)
    reasons.push({ p: "p", t: `${L.waste.toFixed(1)}% edge waste — excellent yield.` })
  else if (L.waste < 20) reasons.push({ p: "p", t: `${L.waste.toFixed(1)}% edge waste — good.` })
  else reasons.push({ p: "w", t: `${L.waste.toFixed(1)}% edge waste — consider resizing.` })

  // feed
  if (s.primaryDir === "horizontal") {
    score += 12
    reasons.push({ p: "p", t: "Primary cuts run parallel to roll feed — easier." })
  } else reasons.push({ p: "w", t: "Primary cuts run across the roll width." })

  // diagonal bonus
  if (s.method === "diag") {
    score += 8
    reasons.push({ p: "p", t: "Diagonal yields 2× pieces per rect — both triangles kept." })
    if (s.diagType === "corner") {
      const a = Math.atan2(s.cutH, s.cutW) * (180 / Math.PI)
      if (Math.abs(a - 45) < 5)
        reasons.push({ p: "p", t: `${a.toFixed(1)}° — equal right triangles.` })
      else reasons.push({ p: "w", t: `${a.toFixed(1)}° — unequal triangles, label A & B.` })
    }
  }

  // qty
  if (pieces < qty) {
    score -= 30
    reasons.push({ p: "f", t: `${pieces} pieces < ${qty} needed — second roll required.` })
  } else reasons.push({ p: "p", t: `${pieces} pieces — meets qty of ${qty}.` })

  return {
    ...s,
    ...L,
    pieces,
    score: Math.max(0, Math.min(100, score)),
    reasons,
  }
}

export function getStrategies(cw: number, ch: number, ang: number, ddir: DiagDir): Strategy[] {
  return [
    {
      id: "rows-first",
      name: "Horizontal strips",
      sub: "H-cuts first (\u2190\u2192), then V-cuts (\u2195)",
      method: "rect" as StratMethod,
      cutW: cw,
      cutH: ch,
      primaryDir: "horizontal",
      icon: "H",
      steps: ["Full roll", "H-cuts first", "V-cuts next", "Done"],
    },
    {
      id: "cols-first",
      name: "Vertical strips",
      sub: "V-cuts first (\u2195), then H-cuts (\u2190\u2192)",
      method: "rect" as StratMethod,
      cutW: cw,
      cutH: ch,
      primaryDir: "vertical",
      icon: "V",
      steps: ["Full roll", "V-cuts first", "H-cuts next", "Done"],
    },
    {
      id: "landscape",
      name: "Rotated 90\u00b0",
      sub: `Piece turned \u2014 ${ch}"\u00d7${cw}" on roll`,
      method: "rect" as StratMethod,
      cutW: ch,
      cutH: cw,
      primaryDir: "horizontal",
      icon: "R",
      steps: ["Full roll", "H-cuts first", "V-cuts next", "Done"],
    },
    {
      id: "diag-corner",
      name: "Corner diagonal",
      sub: `${Math.round((Math.atan2(ch, cw) * 180) / Math.PI)}\u00b0 corner-to-corner`,
      method: "diag" as StratMethod,
      cutW: cw,
      cutH: ch,
      primaryDir: "horizontal",
      diagType: "corner",
      ddir,
      icon: "\u2571",
      steps: ["Full roll", "Straight cuts", "Diagonal cuts", "Done"],
    },
    {
      id: "diag-custom",
      name: `Custom ${ang}\u00b0 diag`,
      sub: `${ddir === "ltr" ? "\u2571 left-to-right" : "\u2572 right-to-left"} at ${ang}\u00b0`,
      method: "diag" as StratMethod,
      cutW: cw,
      cutH: ch,
      primaryDir: "horizontal",
      diagType: "custom",
      diagAngle: ang,
      ddir,
      icon: "\u2220",
      steps: ["Full roll", "Straight cuts", "Diagonal cuts", "Done"],
    },
    {
      id: "diag-land",
      name: "Rotated + diagonal",
      sub: "90\u00b0 rotation then diagonal split",
      method: "diag" as StratMethod,
      cutW: ch,
      cutH: cw,
      primaryDir: "horizontal",
      diagType: "corner",
      ddir,
      icon: "\u2572",
      steps: ["Full roll", "Straight cuts", "Diagonal cuts", "Done"],
    },
  ]
}

export function formatInches(value: number) {
  if (Number.isInteger(value)) {
    return String(value)
  }

  return value
    .toFixed(4)
    .replace(/\.00$/, "")
    .replace(/(\.\d*[1-9])0+$/, "$1")
}

export function normalizeCutRatios(cutRatios: number[] | undefined, count: number) {
  if (count <= 0) {
    return []
  }

  const safeFallback = Array.from({ length: count }, () => 1 / count)
  if (!cutRatios || cutRatios.length !== count) {
    return safeFallback
  }

  const cleaned = cutRatios.map((value) => (Number.isFinite(value) && value > 0 ? value : 0))
  const total = cleaned.reduce((sum, value) => sum + value, 0)
  if (total <= 0) {
    return safeFallback
  }

  return cleaned.map((value) => value / total)
}

export function buildCutBreakpoints(ratios: number[]) {
  let running = 0
  return ratios.slice(0, -1).map((ratio) => {
    running += ratio
    return running
  })
}

export function lerp(start: number, end: number, t: number) {
  return start + (end - start) * t
}

export function isConeRadialSplit(direction?: SimpleCutDirection) {
  return direction !== "arc_bands" && direction !== "horizontal_split"
}

export function isCylinderPanelSplit(direction?: SimpleCutDirection) {
  return direction !== "wrap_bands" && direction !== "horizontal_split"
}

export function isTrapezoidVerticalSplit(direction?: SimpleCutDirection) {
  return direction !== "horizontal_split" && direction !== "arc_bands"
}

// Re-export offcut/placement utilities from their new module
export {
  buildRowCounts,
  buildRectPlacements,
  buildOriginRectOffcutBands,
  buildShelfGapBands,
  countPieceFitsInBand,
  isReusableOffcutBand,
  bandFitsAnyPreviewItem,
  computeIntraBlankWaste,
  getPlacementBounds,
  centerPlacements,
  buildOffcutBands,
} from "./nesting-offcut-utils"

// Re-export packing utilities from their new module
export {
  sortPreviewItems,
  packPreviewItemsOnShelves,
  packPreviewItemsInCenteredColumn,
  packRectItemsWithGuillotine,
  calculatePackedShapeLayout,
} from "./nesting-packing-utils"

// Re-export rect/circle layout utilities from their new module
export {
  buildRectLayoutCandidate,
  calculateSimpleRectLayout,
  _calculateSimpleCircleLayout,
  calculateDirectCircleProfileLayout,
} from "./nesting-rect-layout"

// Re-export step builders from their new module
export {
  buildRectangleSteps,
  buildCircleSteps,
  buildCylinderSteps,
  buildConeSteps,
  buildTrapezoidSteps,
} from "./nesting-step-builders"
