// Full detail step SVG renderer
// Split from nesting-svg-renderers.ts
// Sub-functions live in nesting-svg-detail-helpers.ts

import type { ScoredStrategy } from "./nesting-visualizer-types"
import { se } from "./nesting-layout-utils"
import {
  computeLayout,
  computeCutLineSizing,
  drawVerticalCutLines,
  drawHorizontalCutLines,
  drawDirectionOverlay,
  drawStraightCutsStep,
  drawDiagonalCutsStep,
  drawDoneOverlay,
  drawDimensionLabels,
} from "./nesting-svg-detail-helpers"

function drawRollBackground(
  svg: SVGSVGElement,
  s: ScoredStrategy,
  P: number,
  RW: number,
  RH: number,
  sx: number,
  sy: number
) {
  se(
    "rect",
    {
      x: P,
      y: P,
      width: RW,
      height: RH,
      fill: "#12141a",
      stroke: "#6b7280",
      "stroke-width": "1.5",
      rx: "3",
    },
    svg
  )
  const uw = s.cols * s.cutW * sx,
    uh = s.rows * s.cutH * sy
  if (uw < RW)
    se(
      "rect",
      {
        x: P + uw,
        y: P,
        width: RW - uw,
        height: RH,
        fill: "rgba(220,38,38,0.12)",
        stroke: "#ef4444",
        "stroke-width": "0.5",
        "stroke-dasharray": "5 3",
      },
      svg
    )
  if (uh < RH)
    se(
      "rect",
      {
        x: P,
        y: P + uh,
        width: RW,
        height: RH - uh,
        fill: "rgba(220,38,38,0.12)",
        stroke: "#ef4444",
        "stroke-width": "0.5",
        "stroke-dasharray": "5 3",
      },
      svg
    )
}

function drawDiagPiece(
  svg: SVGSVGElement,
  s: ScoredStrategy,
  px: number,
  py: number,
  pw: number,
  ph: number,
  opScaled: number,
  r: number,
  c: number
) {
  const op = Math.min(opScaled, pw)
  const pA =
    s.ddir === "ltr"
      ? `${px},${py + ph} ${px + pw},${py + ph} ${px + op},${py}`
      : `${px},${py + ph} ${px + pw},${py + ph} ${px + pw},${py} ${px + pw - op},${py}`
  const pB =
    s.ddir === "ltr"
      ? `${px},${py} ${px + pw},${py} ${px + op},${py} ${px},${py + ph}`
      : `${px},${py} ${px + pw - op},${py} ${px},${py + ph}`
  se(
    "polygon",
    { points: pA, fill: "rgba(74,222,128,0.3)", stroke: "#22c55e", "stroke-width": "1" },
    svg
  )
  se(
    "polygon",
    { points: pB, fill: "rgba(59,130,246,0.22)", stroke: "#3b82f6", "stroke-width": "1" },
    svg
  )
  if (pw > 50 && ph > 28) {
    const n = r * s.cols + c
    const la = se(
      "text",
      {
        fill: "#4ade80",
        "font-size": "9",
        "font-family": "'DM Mono',monospace",
        "text-anchor": "middle",
        "dominant-baseline": "middle",
      },
      svg
    )
    const lb = se(
      "text",
      {
        fill: "#93c5fd",
        "font-size": "9",
        "font-family": "'DM Mono',monospace",
        "text-anchor": "middle",
        "dominant-baseline": "middle",
      },
      svg
    )
    if (s.ddir === "ltr") {
      la.setAttribute("x", String(px + pw * 0.66))
      la.setAttribute("y", String(py + ph * 0.66))
      lb.setAttribute("x", String(px + op * 0.3))
      lb.setAttribute("y", String(py + ph * 0.3))
    } else {
      la.setAttribute("x", String(px + (pw + op) * 0.5))
      la.setAttribute("y", String(py + ph * 0.7))
      lb.setAttribute("x", String(px + (pw - op) * 0.3))
      lb.setAttribute("y", String(py + ph * 0.3))
    }
    la.textContent = `A${n * 2 + 1}`
    lb.textContent = `B${n * 2 + 2}`
  }
}

function drawRectPiece(
  svg: SVGSVGElement,
  s: ScoredStrategy,
  px: number,
  py: number,
  pw: number,
  ph: number,
  r: number,
  c: number
) {
  se(
    "rect",
    {
      x: px + 1,
      y: py + 1,
      width: pw - 2,
      height: ph - 2,
      fill: "rgba(74,222,128,0.18)",
      stroke: "#22c55e",
      "stroke-width": "1",
      rx: "2",
    },
    svg
  )
  if (pw > 44 && ph > 22) {
    const tn = se(
      "text",
      {
        x: px + pw / 2,
        y: py + ph / 2 - 5,
        fill: "#4ade80",
        "font-size": "9",
        "font-family": "'DM Mono',monospace",
        "text-anchor": "middle",
        "dominant-baseline": "middle",
      },
      svg
    )
    tn.textContent = String(r * s.cols + c + 1)
    const ts = se(
      "text",
      {
        x: px + pw / 2,
        y: py + ph / 2 + 6,
        fill: "#3d5a3d",
        "font-size": "8",
        "font-family": "'DM Mono',monospace",
        "text-anchor": "middle",
        "dominant-baseline": "middle",
      },
      svg
    )
    ts.textContent = `${s.cutW}"\u00D7${s.cutH}"`
  }
}

function drawPieces(
  svg: SVGSVGElement,
  s: ScoredStrategy,
  P: number,
  sx: number,
  sy: number,
  showDiag: boolean,
  doff: number
) {
  for (let r = 0; r < s.rows; r++)
    for (let c = 0; c < s.cols; c++) {
      const px = P + c * s.cutW * sx,
        py = P + r * s.cutH * sy
      const pw = s.cutW * sx,
        ph = s.cutH * sy
      if (showDiag) drawDiagPiece(svg, s, px, py, pw, ph, doff * sx, r, c)
      else drawRectPiece(svg, s, px, py, pw, ph, r, c)
    }
}

export function drawDetailStep(
  svg: SVGSVGElement,
  s: ScoredStrategy,
  rollW: number,
  rollL: number,
  stepIdx: number
) {
  const layout = computeLayout(rollW, rollL)
  svg.innerHTML = ""
  svg.setAttribute("viewBox", `0 0 ${layout.W} ${layout.H}`)

  const diagAng =
    s.diagType === "corner" ? (Math.atan2(s.cutH, s.cutW) * 180) / Math.PI : (s.diagAngle ?? 45)
  const diagRad = (diagAng * Math.PI) / 180
  const doff = Math.min(s.cutH / Math.tan(diagRad), s.cutW)
  const cur = s.steps[stepIdx] ?? s.steps[0]
  const showDiag = s.method === "diag" && (cur === "Diagonal cuts" || cur === "Done")

  drawRollBackground(svg, s, layout.P, layout.RW, layout.RH, layout.sx, layout.sy)
  drawPieces(svg, s, layout.P, layout.sx, layout.sy, showDiag, doff)

  const isActiveHCut = cur === "H-cuts first" || cur === "H-cuts next"
  const isActiveVCut = cur === "V-cuts first" || cur === "V-cuts next"
  const showAllCuts = cur === "Done"
  const sizing = computeCutLineSizing(s, layout)

  drawVerticalCutLines(svg, s, layout, sizing, isActiveVCut, showAllCuts)
  drawHorizontalCutLines(svg, s, layout, sizing, isActiveHCut, showAllCuts)

  if (cur === "Full roll" && s.method === "rect") drawDirectionOverlay(svg, s, layout)
  if (cur === "Straight cuts") drawStraightCutsStep(svg, s, layout, sizing)
  if (cur === "Diagonal cuts") drawDiagonalCutsStep(svg, s, layout, doff)
  if (cur === "Done") drawDoneOverlay(svg, s, layout)

  drawDimensionLabels(svg, rollW, rollL, layout)
}
