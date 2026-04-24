// Non-rect shape render callback for NestingVisualizer
// Extracted from NestingVisualizer.tsx — draws circle / cone on the bgSvg canvas

import type { ShapeType } from "./nesting-visualizer-types"
import { se, st } from "./nesting-layout-utils"

export interface NonRectStats {
  count: number
  used: number
  waste: number
}

export function renderNonRectBg(
  svg: SVGSVGElement,
  shape: ShapeType,
  rollW: number,
  rollL: number,
  diam: number,
  innerR: number,
  outerR: number,
  arcDeg: number
): NonRectStats {
  const SVG_W = 680,
    SVG_H = 310,
    PAD = 44
  const RW2 = SVG_W - PAD * 2,
    RH2 = SVG_H - PAD * 2
  svg.innerHTML = ""

  const defs = se("defs")
  const p1 = se("pattern", {
    id: "ph2",
    width: "14",
    height: "14",
    patternUnits: "userSpaceOnUse",
    patternTransform: "rotate(45)",
  })
  p1.appendChild(
    se("line", { x1: "0", y1: "0", x2: "0", y2: "14", stroke: "#1e2230", "stroke-width": "1" })
  )
  const p2 = se("pattern", {
    id: "pu2",
    width: "10",
    height: "10",
    patternUnits: "userSpaceOnUse",
    patternTransform: "rotate(45)",
  })
  p2.appendChild(
    se("line", {
      x1: "0",
      y1: "0",
      x2: "0",
      y2: "10",
      stroke: "rgba(74,222,128,0.4)",
      "stroke-width": "1.3",
    })
  )
  const p3 = se("pattern", {
    id: "ps2",
    width: "10",
    height: "10",
    patternUnits: "userSpaceOnUse",
    patternTransform: "rotate(45)",
  })
  p3.appendChild(
    se("line", {
      x1: "0",
      y1: "0",
      x2: "0",
      y2: "10",
      stroke: "rgba(220,38,38,0.5)",
      "stroke-width": "1.3",
    })
  )
  const clip = se("clipPath", { id: "rollClip2" })
  clip.appendChild(se("rect", { x: PAD, y: PAD, width: RW2, height: RH2, rx: "4" }))
  ;[p1, p2, p3, clip].forEach((e) => defs.appendChild(e))
  svg.appendChild(defs)

  const g = se("g")
  svg.appendChild(g)
  g.appendChild(se("rect", { x: PAD, y: PAD, width: RW2, height: RH2, fill: "url(#ph2)", rx: "4" }))
  g.appendChild(
    se("rect", {
      x: PAD,
      y: PAD,
      width: RW2,
      height: RH2,
      fill: "none",
      stroke: "#6b7280",
      "stroke-width": "1.5",
      rx: "4",
    })
  )

  if (shape === "circle") {
    return renderCircleBg(g, rollW, rollL, diam, PAD, RW2, RH2)
  }

  return renderConeBg(g, rollW, rollL, innerR, outerR, arcDeg, PAD, RW2, RH2)
}

function renderCircleBg(
  g: SVGElement,
  rollW: number,
  rollL: number,
  diam: number,
  PAD: number,
  RW2: number,
  RH2: number
): NonRectStats {
  const scale = Math.min(RW2 / rollW, RH2 / rollL)
  const r = (diam / 2) * scale
  if (r <= 0) return { count: 0, used: 0, waste: 100 }

  const D = r * 2
  const circles: { cx: number; cy: number }[] = []
  for (let row = 0; ; row++) {
    const off = row % 2 === 1 ? r * 0.866 : 0,
      cy2 = PAD + r + row * D * 0.866
    if (cy2 - r > PAD + RH2) break
    for (let c = 0; ; c++) {
      const cx2 = PAD + r + c * D + off
      if (cx2 - r > PAD + RW2) break
      if (cx2 + r <= PAD + RW2 + 2 && cy2 + r <= PAD + RH2 + 2) circles.push({ cx: cx2, cy: cy2 })
    }
  }
  const clipG = se("g", { "clip-path": "url(#rollClip2)" })
  circles.forEach(({ cx, cy }, i) => {
    clipG.appendChild(
      se("circle", {
        cx,
        cy,
        r: r - 1,
        fill: "url(#pu2)",
        stroke: "#22c55e",
        "stroke-width": "1.5",
      })
    )
    if (r > 18)
      st(
        `\u2300${diam}"`,
        {
          x: cx,
          y: cy,
          fill: i === 0 ? "#e2e8f0" : "#7dd3a8",
          "font-size": "9",
          "text-anchor": "middle",
          "dominant-baseline": "middle",
        },
        clipG
      )
  })
  g.appendChild(clipG)
  st(
    "Hex packing \u00B7 interstitial gaps = scrap",
    {
      x: PAD + RW2 / 2,
      y: PAD + RH2 - 6,
      fill: "#f87171",
      "font-size": "9",
      "text-anchor": "middle",
    },
    g
  )
  st(
    `${circles.length} circles \u00B7 \u2300${diam}" each`,
    {
      x: PAD + RW2,
      y: PAD - 8,
      fill: "#4ade80",
      "font-size": "10",
      "text-anchor": "end",
      "font-weight": "700",
    },
    g
  )
  const rollArea = rollW * rollL
  const usedArea = circles.length * Math.PI * (diam / 2) ** 2
  const used = rollArea > 0 ? Math.max(0, Math.min(100, (usedArea / rollArea) * 100)) : 0

  return {
    count: circles.length,
    used,
    waste: Math.max(0, 100 - used),
  }
}

function renderConeBg(
  g: SVGElement,
  rollW: number,
  rollL: number,
  innerR: number,
  outerR: number,
  arcDeg: number,
  PAD: number,
  RW2: number,
  RH2: number
): NonRectStats {
  const arcRad = (arcDeg * Math.PI) / 180
  const scale = Math.min(RW2 / (outerR * 2), RH2 / (outerR * 2)) * 0.85
  const sIn = innerR * scale,
    sOut = outerR * scale
  const pieceW = sOut * 2,
    pieceH = sOut
  const arcPath = (cx: number, cy: number, flipped: boolean) => {
    const base = flipped ? Math.PI / 2 : -Math.PI / 2,
      a1 = base - arcRad / 2,
      a2 = base + arcRad / 2
    const x1o = cx + sOut * Math.cos(a1),
      y1o = cy + sOut * Math.sin(a1)
    const x2o = cx + sOut * Math.cos(a2),
      y2o = cy + sOut * Math.sin(a2)
    const x1i = cx + sIn * Math.cos(a2),
      y1i = cy + sIn * Math.sin(a2)
    const x2i = cx + sIn * Math.cos(a1),
      y2i = cy + sIn * Math.sin(a1)
    const lg = arcDeg > 180 ? 1 : 0
    return `M${x1o} ${y1o} A${sOut} ${sOut} 0 ${lg} 1 ${x2o} ${y2o} L${x1i} ${y1i} A${sIn} ${sIn} 0 ${lg} 0 ${x2i} ${y2i} Z`
  }
  const cols2 = Math.max(1, Math.floor(RW2 / (pieceW * 0.7)))
  const rows2 = Math.max(1, Math.floor(RH2 / (pieceH * 0.88)))
  const pieces: { cx: number; cy: number; flipped: boolean }[] = []
  for (let row = 0; row < rows2; row++)
    for (let col = 0; col < cols2; col++) {
      const flipped = (row + col) % 2 === 1,
        cx = PAD + col * (pieceW * 0.7) + sOut,
        cy = PAD + row * (pieceH * 0.88) + sOut * 0.55
      if (cx + sOut < PAD + RW2 + 12 && cy + sOut < PAD + RH2 + 12) pieces.push({ cx, cy, flipped })
    }
  const clipG = se("g", { "clip-path": "url(#rollClip2)" })
  pieces.forEach(({ cx, cy, flipped }, i) =>
    clipG.appendChild(
      se("path", {
        d: arcPath(cx, cy, flipped),
        fill: "url(#pu2)",
        stroke: "#22c55e",
        "stroke-width": "1.5",
        opacity: i === 0 ? "1" : "0.85",
      })
    )
  )
  g.appendChild(clipG)
  if (pieces.length > 0) {
    const { cx, cy } = pieces[0]
    g.appendChild(
      se("line", {
        x1: cx,
        y1: cy,
        x2: cx + sIn * 0.72,
        y2: cy - sIn * 0.72,
        stroke: "#64748b",
        "stroke-width": "1",
        "stroke-dasharray": "3 2",
      })
    )
    st(
      `R${innerR}"`,
      { x: cx + sIn * 0.78, y: cy - sIn * 0.76, fill: "#64748b", "font-size": "9" },
      g
    )
    g.appendChild(
      se("line", {
        x1: cx,
        y1: cy,
        x2: cx + sOut * 0.72,
        y2: cy - sOut * 0.72,
        stroke: "#4ade80",
        "stroke-width": "1",
        "stroke-dasharray": "3 2",
      })
    )
    st(
      `R${outerR}"`,
      { x: cx + sOut * 0.78, y: cy - sOut * 0.76, fill: "#4ade80", "font-size": "9" },
      g
    )
  }
  st(
    "Alternating orientation packing \u00B7 corner gaps = scrap",
    {
      x: PAD + RW2 / 2,
      y: PAD + RH2 - 6,
      fill: "#f87171",
      "font-size": "9",
      "text-anchor": "middle",
    },
    g
  )
  st(
    `${pieces.length} arcs \u00B7 ${arcDeg}\u00B0 sweep`,
    {
      x: PAD + RW2,
      y: PAD - 8,
      fill: "#4ade80",
      "font-size": "10",
      "text-anchor": "end",
      "font-weight": "700",
    },
    g
  )
  const arcArea = (arcDeg / 360) * Math.PI * (outerR ** 2 - innerR ** 2),
    rollArea = rollW * rollL
  const used = Math.min(99, ((pieces.length * arcArea) / rollArea) * 100)
  return {
    count: pieces.length,
    used,
    waste: 100 - used,
  }
}
