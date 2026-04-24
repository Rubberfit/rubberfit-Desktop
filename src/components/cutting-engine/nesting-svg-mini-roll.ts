// Mini roll preview SVG renderer
// Split from nesting-svg-renderers.ts

import type { GrainDir, ScoredStrategy } from "./nesting-visualizer-types"
import { se, st } from "./nesting-layout-utils"

function drawMiniPieces(
  svg: SVGSVGElement,
  s: ScoredStrategy,
  P: number,
  sx: number,
  sy: number,
  doff: number
) {
  for (let r = 0; r < s.rows; r++)
    for (let c = 0; c < s.cols; c++) {
      const px = P + c * s.cutW * sx,
        py = P + r * s.cutH * sy
      const pw = s.cutW * sx,
        ph = s.cutH * sy
      if (s.method === "diag") {
        const op = Math.min(doff * sx, pw)
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
          { points: pA, fill: "rgba(74,222,128,0.28)", stroke: "#22c55e", "stroke-width": "0.7" },
          svg
        )
        se(
          "polygon",
          { points: pB, fill: "rgba(59,130,246,0.22)", stroke: "#3b82f6", "stroke-width": "0.7" },
          svg
        )
        const x1 = s.ddir === "ltr" ? px : px + pw,
          y1 = py + ph
        const x2 = s.ddir === "ltr" ? px + op : px + pw - op,
          y2 = py
        se("line", { x1, y1, x2, y2, stroke: "#facc15", "stroke-width": "1" }, svg)
      } else {
        se(
          "rect",
          {
            x: px + 0.5,
            y: py + 0.5,
            width: pw - 1,
            height: ph - 1,
            fill: "rgba(74,222,128,0.22)",
            stroke: "#22c55e",
            "stroke-width": "0.8",
            rx: "1",
          },
          svg
        )
      }
    }
}

function drawGrainLines(
  svg: SVGSVGElement,
  grain: GrainDir,
  P: number,
  RW: number,
  RH: number,
  uw: number,
  uh: number
) {
  if (grain === "width")
    for (let i = 1; i < 3; i++)
      se(
        "line",
        {
          x1: P,
          y1: P + (RH * i) / 3,
          x2: P + uw,
          y2: P + (RH * i) / 3,
          stroke: "rgba(251,191,36,0.3)",
          "stroke-width": "0.6",
          "stroke-dasharray": "2 2",
        },
        svg
      )
  if (grain === "length")
    for (let i = 1; i < 3; i++)
      se(
        "line",
        {
          x1: P + (RW * i) / 3,
          y1: P,
          x2: P + (RW * i) / 3,
          y2: P + uh,
          stroke: "rgba(251,191,36,0.3)",
          "stroke-width": "0.6",
          "stroke-dasharray": "2 2",
        },
        svg
      )
}

function drawDirectionArrows(
  svg: SVGSVGElement,
  s: ScoredStrategy,
  P: number,
  RW: number,
  RH: number
) {
  if (s.method !== "rect") return

  if (s.primaryDir === "horizontal") {
    const ay = P + RH * 0.5
    se(
      "line",
      {
        x1: P + 4,
        y1: ay,
        x2: P + RW - 4,
        y2: ay,
        stroke: "rgba(250,204,21,0.55)",
        "stroke-width": "1.2",
      },
      svg
    )
    se(
      "polygon",
      {
        points: `${P + RW - 4},${ay - 3} ${P + RW - 4},${ay + 3} ${P + RW},${ay}`,
        fill: "rgba(250,204,21,0.55)",
      },
      svg
    )
    se(
      "polygon",
      {
        points: `${P + 4},${ay - 3} ${P + 4},${ay + 3} ${P},${ay}`,
        fill: "rgba(250,204,21,0.55)",
      },
      svg
    )
  } else {
    const ax = P + RW * 0.5
    se(
      "line",
      {
        x1: ax,
        y1: P + 4,
        x2: ax,
        y2: P + RH - 4,
        stroke: "rgba(250,204,21,0.55)",
        "stroke-width": "1.2",
      },
      svg
    )
    se(
      "polygon",
      {
        points: `${ax - 3},${P + RH - 4} ${ax + 3},${P + RH - 4} ${ax},${P + RH}`,
        fill: "rgba(250,204,21,0.55)",
      },
      svg
    )
    se(
      "polygon",
      {
        points: `${ax - 3},${P + 4} ${ax + 3},${P + 4} ${ax},${P}`,
        fill: "rgba(250,204,21,0.55)",
      },
      svg
    )
  }
}

export function drawMiniRoll(
  svg: SVGSVGElement,
  s: ScoredStrategy,
  rollW: number,
  rollL: number,
  grain: GrainDir
) {
  const W = 200,
    H = 118,
    P = 12,
    RW = W - P * 2,
    RH = H - P * 2
  const sx = RW / rollW,
    sy = RH / rollL
  svg.innerHTML = ""
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`)

  se(
    "rect",
    {
      x: P,
      y: P,
      width: RW,
      height: RH,
      fill: "#12141a",
      stroke: "#6b7280",
      "stroke-width": "1",
      rx: "2",
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
        fill: "rgba(220,38,38,0.15)",
        stroke: "#ef4444",
        "stroke-width": "0.5",
        "stroke-dasharray": "3 2",
      },
      svg
    )
  if (uh < RH)
    se(
      "rect",
      {
        x: P,
        y: P + uh,
        width: uw || RW,
        height: RH - uh,
        fill: "rgba(220,38,38,0.15)",
        stroke: "#ef4444",
        "stroke-width": "0.5",
        "stroke-dasharray": "3 2",
      },
      svg
    )

  const diagAng =
    s.diagType === "corner" ? (Math.atan2(s.cutH, s.cutW) * 180) / Math.PI : (s.diagAngle ?? 45)
  const diagRad = (diagAng * Math.PI) / 180
  const tanVal = Math.tan(diagRad)
  const doff = Math.abs(tanVal) > 1e-9 ? Math.min(s.cutH / tanVal, s.cutW) : s.cutW

  drawMiniPieces(svg, s, P, sx, sy, doff)
  drawGrainLines(svg, grain, P, RW, RH, uw, uh)
  drawDirectionArrows(svg, s, P, RW, RH)

  st(`${rollW}"`, { x: P + RW / 2, y: H - 2, "text-anchor": "middle", "font-size": "7" }, svg)
}
