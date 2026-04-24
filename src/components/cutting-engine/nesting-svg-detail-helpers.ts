// Detail step SVG helper functions — cut lines, overlays, and step-specific rendering
// Split from nesting-svg-detail-step.ts to keep files under 500 lines

import type { ScoredStrategy } from "./nesting-visualizer-types"
import { se, st } from "./nesting-layout-utils"

export interface DetailStepLayout {
  W: number
  H: number
  P: number
  RW: number
  RH: number
  sx: number
  sy: number
}

export interface CutLineSizing {
  rowPx: number
  colPx: number
  hStrokeActive: number
  vStrokeActive: number
  showHLabels: boolean
  showVLabels: boolean
  hFontSize: string
  vFontSize: string
  hDash: string
  vDash: string
}

export function computeLayout(rollW: number, rollL: number): DetailStepLayout {
  const W = 600,
    H = 240,
    P = 34,
    RW = W - P * 2,
    RH = H - P * 2
  const sx = rollW > 0 ? RW / rollW : 0,
    sy = rollL > 0 ? RH / rollL : 0
  return { W, H, P, RW, RH, sx, sy }
}

export function computeCutLineSizing(s: ScoredStrategy, layout: DetailStepLayout): CutLineSizing {
  const rowPx = s.cutH * layout.sy
  const colPx = s.cutW * layout.sx
  const hStrokeActive = Math.min(1.5, Math.max(0.5, rowPx * 0.08))
  const vStrokeActive = Math.min(1.5, Math.max(0.5, colPx * 0.08))
  const showHLabels = rowPx >= 10
  const showVLabels = colPx >= 10
  const hFontSize = Math.min(8, Math.max(6, rowPx * 0.55)).toFixed(1)
  const vFontSize = Math.min(8, Math.max(6, colPx * 0.55)).toFixed(1)
  const hDash = rowPx < 6 ? "none" : rowPx < 12 ? "3 2" : "7 3"
  const vDash = colPx < 6 ? "none" : colPx < 12 ? "3 2" : "7 3"
  return {
    rowPx,
    colPx,
    hStrokeActive,
    vStrokeActive,
    showHLabels,
    showVLabels,
    hFontSize,
    vFontSize,
    hDash,
    vDash,
  }
}

export function drawVerticalCutLines(
  svg: SVGSVGElement,
  s: ScoredStrategy,
  layout: DetailStepLayout,
  sizing: CutLineSizing,
  isActive: boolean,
  showAllCuts: boolean
) {
  const { P, RH } = layout

  for (let c = 1; c <= s.vCuts; c++) {
    const x = P + c * s.cutW * layout.sx
    const active = isActive
    const ln = se(
      "line",
      {
        x1: x,
        y1: P,
        x2: x,
        y2: P + RH,
        stroke: active || showAllCuts ? "#facc15" : "rgba(250,204,21,0.2)",
        "stroke-width": active ? sizing.vStrokeActive : Math.min(0.5, sizing.vStrokeActive * 0.4),
        "stroke-dasharray": sizing.vDash,
      },
      svg
    )
    if (active) {
      ln.setAttribute("style", "stroke-dasharray:900;animation:dashIn .5s ease-out forwards")
      if (sizing.showVLabels) {
        const arrowSize = Math.min(4, sizing.colPx * 0.15)
        se(
          "polygon",
          {
            points: `${x - arrowSize},${P} ${x + arrowSize},${P} ${x},${P - arrowSize * 1.5}`,
            fill: "#facc15",
          },
          svg
        )
        const lt = se(
          "text",
          {
            x: x + arrowSize + 1,
            y: P + Math.min(11, sizing.rowPx * 0.5 + 4),
            fill: "#facc15",
            "font-size": sizing.vFontSize,
            "font-family": "'DM Mono',monospace",
            "font-weight": "700",
          },
          svg
        )
        lt.textContent = `V${c}`
      }
    }
  }
}

export function drawHorizontalCutLines(
  svg: SVGSVGElement,
  s: ScoredStrategy,
  layout: DetailStepLayout,
  sizing: CutLineSizing,
  isActive: boolean,
  showAllCuts: boolean
) {
  const { P, RW } = layout

  for (let r = 1; r <= s.hCuts; r++) {
    const y = P + r * s.cutH * layout.sy
    const active = isActive
    const ln = se(
      "line",
      {
        x1: P,
        y1: y,
        x2: P + RW,
        y2: y,
        stroke: active || showAllCuts ? "#facc15" : "rgba(250,204,21,0.2)",
        "stroke-width": active ? sizing.hStrokeActive : Math.min(0.5, sizing.hStrokeActive * 0.4),
        "stroke-dasharray": sizing.hDash,
      },
      svg
    )
    if (active) {
      ln.setAttribute("style", "stroke-dasharray:900;animation:dashIn .5s ease-out forwards")
      if (sizing.showHLabels) {
        const arrowSize = Math.min(4, sizing.rowPx * 0.15)
        se(
          "polygon",
          {
            points: `${P - arrowSize * 1.5},${y} ${P},${y - arrowSize} ${P},${y + arrowSize}`,
            fill: "#facc15",
          },
          svg
        )
        const labelY = y + Math.max(3, Math.min(sizing.rowPx * 0.35, 8))
        const lt = se(
          "text",
          {
            x: P + arrowSize + 2,
            y: labelY,
            fill: "#facc15",
            "font-size": sizing.hFontSize,
            "font-family": "'DM Mono',monospace",
            "font-weight": "700",
            "dominant-baseline": "hanging",
          },
          svg
        )
        lt.textContent = `H${r}`
      }
    }
  }
}

export function drawDirectionOverlay(
  svg: SVGSVGElement,
  s: ScoredStrategy,
  layout: DetailStepLayout
) {
  const { P, RW, RH } = layout
  const arrowY = P + RH / 2
  const arrowX = P + RW / 2
  if (s.primaryDir === "horizontal") {
    se(
      "line",
      {
        x1: P + 10,
        y1: arrowY,
        x2: P + RW - 10,
        y2: arrowY,
        stroke: "rgba(250,204,21,0.5)",
        "stroke-width": "1.5",
        "stroke-dasharray": "4 3",
      },
      svg
    )
    const lbl = se(
      "text",
      {
        x: arrowX,
        y: arrowY - 10,
        fill: "rgba(250,204,21,0.8)",
        "font-size": "10",
        "font-family": "'DM Mono',monospace",
        "text-anchor": "middle",
        "font-weight": "700",
      },
      svg
    )
    lbl.textContent = "\u2190 H-cuts run this way \u2192"
  } else {
    se(
      "line",
      {
        x1: arrowX,
        y1: P + 10,
        x2: arrowX,
        y2: P + RH - 10,
        stroke: "rgba(250,204,21,0.5)",
        "stroke-width": "1.5",
        "stroke-dasharray": "4 3",
      },
      svg
    )
    const lbl = se(
      "text",
      {
        x: arrowX + 10,
        y: arrowY,
        fill: "rgba(250,204,21,0.8)",
        "font-size": "10",
        "font-family": "'DM Mono',monospace",
        "text-anchor": "start",
        "font-weight": "700",
      },
      svg
    )
    lbl.textContent = "\u2195 V-cuts first"
  }
}

export function drawStraightCutsStep(
  svg: SVGSVGElement,
  s: ScoredStrategy,
  layout: DetailStepLayout,
  sizing: CutLineSizing
) {
  const { P, RW, RH } = layout
  for (let c = 1; c <= s.vCuts; c++) {
    const x = P + c * s.cutW * layout.sx
    se(
      "line",
      {
        x1: x,
        y1: P,
        x2: x,
        y2: P + RH,
        stroke: "#facc15",
        "stroke-width": sizing.vStrokeActive,
        "stroke-dasharray": sizing.vDash,
        style: "stroke-dasharray:900;animation:dashIn .5s ease-out forwards",
      },
      svg
    )
  }
  for (let r = 1; r <= s.hCuts; r++) {
    const y = P + r * s.cutH * layout.sy
    se(
      "line",
      {
        x1: P,
        y1: y,
        x2: P + RW,
        y2: y,
        stroke: "#facc15",
        "stroke-width": sizing.hStrokeActive,
        "stroke-dasharray": sizing.hDash,
        style: "stroke-dasharray:900;animation:dashIn .5s ease-out forwards",
      },
      svg
    )
  }
}

export function drawDiagonalCutsStep(
  svg: SVGSVGElement,
  s: ScoredStrategy,
  layout: DetailStepLayout,
  doff: number
) {
  const { P, sx, sy } = layout
  const diagPx = Math.sqrt((s.cutW * sx) ** 2 + (s.cutH * sy) ** 2)
  const diagStroke = Math.min(1.5, Math.max(0.4, diagPx * 0.025))
  const diagDash = diagPx < 20 ? "none" : diagPx < 40 ? "3 2" : "6 3"
  for (let r = 0; r < s.rows; r++)
    for (let c = 0; c < s.cols; c++) {
      const px = P + c * s.cutW * sx,
        py = P + r * s.cutH * sy
      const pw = s.cutW * sx,
        ph = s.cutH * sy
      const op = Math.min(doff * sx, pw)
      const x1 = s.ddir === "ltr" ? px : px + pw,
        y1 = py + ph
      const x2 = s.ddir === "ltr" ? px + op : px + pw - op,
        y2 = py
      const delay = (r * s.cols + c) * 0.05
      se(
        "line",
        {
          x1,
          y1,
          x2,
          y2,
          stroke: "#facc15",
          "stroke-width": diagStroke,
          "stroke-dasharray": diagDash,
          style: `stroke-dasharray:900;animation:dashIn .5s ${delay}s ease-out forwards`,
        },
        svg
      )
    }
}

export function drawDoneOverlay(svg: SVGSVGElement, s: ScoredStrategy, layout: DetailStepLayout) {
  const { W, H } = layout
  const cx = W / 2,
    cy = H / 2
  const label = `${s.pieces} pieces ready`
  const pillW = label.length * 8.5 + 28,
    pillH = 32
  se(
    "rect",
    {
      x: cx - pillW / 2,
      y: cy - pillH / 2,
      width: pillW,
      height: pillH,
      fill: "#0f172a",
      rx: "16",
      opacity: "0.92",
    },
    svg
  )
  se(
    "rect",
    {
      x: cx - pillW / 2,
      y: cy - pillH / 2,
      width: pillW,
      height: pillH,
      fill: "none",
      stroke: "#4ade80",
      "stroke-width": "1.5",
      rx: "16",
    },
    svg
  )
  const done = se(
    "text",
    {
      x: cx,
      y: cy,
      fill: "#4ade80",
      "font-size": "13",
      "font-family": "'DM Mono',monospace",
      "text-anchor": "middle",
      "dominant-baseline": "middle",
      "font-weight": "700",
    },
    svg
  )
  done.textContent = label
}

export function drawDimensionLabels(
  svg: SVGSVGElement,
  rollW: number,
  rollL: number,
  layout: DetailStepLayout
) {
  const { W, H, P, RW, RH } = layout
  st(`${rollW}" wide`, { x: P + RW / 2, y: H - 4, "text-anchor": "middle" }, svg)
  st(
    `${rollL}"`,
    {
      x: W - 4,
      y: P + RH / 2,
      "text-anchor": "middle",
      transform: `rotate(-90,${W - 4},${P + RH / 2})`,
    },
    svg
  )
}
