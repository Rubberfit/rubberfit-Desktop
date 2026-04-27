import jsPDF from "jspdf"
import { format } from "date-fns"

import { ARC_ANCHOR_LOGO_BASE64 } from "./arc-anchor-logo"
import type { SimpleCutMetrics } from "./nesting-visualizer-types"
import type { PartTemplate } from "./PresetDimensionSelector"
import type { StockConfig } from "./stock-preview-configurator"
import { PART_OPTIONS } from "./preset-template-data"
import type { LayoutModel, PlacedPart, LayoutRegion } from "./layout-model"
import { buildTaggedReusableOffcuts } from "./reusable-offcut-tags"
import { formatInches } from "./format-inches"

// ── Types ────────────────────────────────────────────────────────────────────

export interface CutPdfData {
  cutId: string
  stockWidth: number
  stockLength: number
  stockThickness: number
  materialName: string
  profileTitle: string
  tagMap: Map<string, string>
  partsCompleted: number
  cutPieces: number
  rollCount: number
  materialUsedSqFt: number
  reusableOffcutSqFt: number
  reusableOffcutPct: number
  scrapSqFt: number
  scrapPct: number
  fabScore: number
  cutDate: string
}

// ── Constants ────────────────────────────────────────────────────────────────

type RGB = readonly [number, number, number]

const MARGIN = 15
const PAGE_W = 210
const PAGE_H = 297
const CONTENT_W = PAGE_W - MARGIN * 2

const BRAND: RGB = [37, 99, 235]
const GRAY_900: RGB = [17, 24, 39]
const GRAY_700: RGB = [55, 65, 81]
const GRAY_500: RGB = [107, 114, 128]
const GRAY_200: RGB = [229, 231, 235]
const GRAY_50: RGB = [249, 250, 251]
const WHITE: RGB = [255, 255, 255]

// Must stay in sync with KonvaSheetRenderer's PART_FILLS so screen and PDF match.
const PART_FILLS_RGB: RGB[] = [
  [59, 130, 246], // blue-500
  [239, 68, 68], // red-500
  [34, 197, 94], // green-500
  [245, 158, 11], // amber-500
  [139, 92, 246], // violet-500
  [236, 72, 153], // pink-500
  [20, 184, 166], // teal-500
  [249, 115, 22], // orange-500
]
// Paper-friendly semantic palette: amber for reusable offcut, red for scrap.
// Matches the Konva on-screen convention (which uses darker background).
const OFFCUT_RGB: RGB = [254, 243, 199] // amber-100
const OFFCUT_STROKE_RGB: RGB = [245, 158, 11] // amber-500
const SCRAP_RGB: RGB = [254, 226, 226] // red-100
const SCRAP_STROKE_RGB: RGB = [239, 68, 68] // red-500
const SHEET_FILL_RGB: RGB = [245, 245, 244] // stone-100
const SHEET_STROKE_RGB: RGB = [168, 162, 158] // stone-400

// ── Logo Loader ──────────────────────────────────────────────────────────────

let cachedLogo: string | null = null

function getLogo(): string {
  if (!cachedLogo) {
    cachedLogo = `data:image/jpeg;base64,${ARC_ANCHOR_LOGO_BASE64}`
  }
  return cachedLogo
}

// ── SVG Print-Color Swaps ────────────────────────────────────────────────────

const PRINT_SWAPS: Array<{ sel: string; attr: string; from: string; to: string }> = [
  { sel: "line[stroke='#d6d3d1']", attr: "stroke", from: "#d6d3d1", to: "#1f2937" },
  { sel: "path[fill='#d6d3d1']", attr: "fill", from: "#d6d3d1", to: "#1f2937" },
  { sel: "text[fill='#ffffff']", attr: "fill", from: "#ffffff", to: "#1f2937" },
  { sel: "text[fill='#f5f5f4']", attr: "fill", from: "#f5f5f4", to: "#374151" },
  { sel: "rect[stroke='#d6d3d1']", attr: "stroke", from: "#d6d3d1", to: "#1f2937" },
]

// ── SVG Rasterisation (4x, print-friendly colors) ───────────────────────────

async function rasterizeSvg(svg: SVGSVGElement): Promise<string> {
  const originalViewBox = svg.getAttribute("viewBox")
  const vw = svg.viewBox.baseVal.width || svg.clientWidth
  const vh = svg.viewBox.baseVal.height || svg.clientHeight
  svg.setAttribute("viewBox", `0 0 ${vw} ${vh}`)

  // Swap dark-mode colors to print-friendly
  const originals: Array<{ el: Element; attr: string; value: string }> = []
  for (const swap of PRINT_SWAPS) {
    svg.querySelectorAll(swap.sel).forEach((el) => {
      const cur = el.getAttribute(swap.attr)
      if (cur === swap.from) {
        originals.push({ el, attr: swap.attr, value: cur })
        el.setAttribute(swap.attr, swap.to)
      }
    })
  }

  // Dimension labels contain inch marks (") — tag letters inside shapes don't
  svg.querySelectorAll("text[fill='#e7e5e4']").forEach((el) => {
    const text = el.textContent ?? ""
    if (text.includes('"')) {
      originals.push({ el, attr: "fill", value: "#e7e5e4" })
      el.setAttribute("fill", "#1f2937")
    }
  })

  const serializer = new XMLSerializer()
  const svgString = serializer.serializeToString(svg)
  const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const img = new Image()
  img.src = url
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error("SVG rasterization failed"))
  })

  const scale = 4
  const canvas = document.createElement("canvas")
  canvas.width = img.naturalWidth * scale
  canvas.height = img.naturalHeight * scale
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Canvas context unavailable")
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0)
  URL.revokeObjectURL(url)

  // Restore originals
  for (const o of originals) o.el.setAttribute(o.attr, o.value)
  if (originalViewBox) svg.setAttribute("viewBox", originalViewBox)

  return canvas.toDataURL("image/png")
}

// ── Page Break Helper ────────────────────────────────────────────────────────

function checkNewPage(doc: jsPDF, y: number, needed: number): number {
  if (y + needed > PAGE_H - 20) {
    doc.addPage()
    return 20
  }
  return y
}

// ── Section Renderers ────────────────────────────────────────────────────────

function addHeader(doc: jsPDF, data: CutPdfData, logo: string): number {
  let y = 15

  doc.addImage(logo, "JPEG", MARGIN, y - 3, 10, 10)
  doc.setFontSize(14)
  doc.setTextColor(...BRAND)
  doc.setFont("helvetica", "bold")
  doc.text("Rubberfit Pro", MARGIN + 13, y + 3)
  y += 13

  doc.setFontSize(20)
  doc.setTextColor(...GRAY_900)
  doc.text("Cut Report", MARGIN, y)
  y += 8

  doc.setFontSize(10)
  doc.setTextColor(...GRAY_500)
  doc.setFont("helvetica", "normal")
  doc.text(format(new Date(data.cutDate), "MMMM dd, yyyy  HH:mm"), MARGIN, y)
  y += 4

  doc.setDrawColor(...BRAND)
  doc.setLineWidth(0.6)
  doc.line(MARGIN, y, MARGIN + CONTENT_W, y)
  y += 5

  return y
}

function addSummaryCards(doc: jsPDF, data: CutPdfData, y: number): number {
  y = checkNewPage(doc, y, 32)
  const cardW = (CONTENT_W - 4 * 3) / 5
  const cardH = 20
  const gap = 3

  const cards = [
    { label: "Cut Pieces", value: `${data.cutPieces}` },
    { label: "Material Used", value: `${data.materialUsedSqFt.toFixed(1)} sqft` },
    { label: "Reusable Offcut", value: `${data.reusableOffcutPct.toFixed(1)}%` },
    { label: "Waste", value: `${data.scrapPct.toFixed(1)}%` },
    { label: "Fab Score", value: `${Math.round(data.fabScore * 100)}/100` },
  ]

  for (let i = 0; i < cards.length; i++) {
    const x = MARGIN + i * (cardW + gap)
    doc.setFillColor(...GRAY_50)
    doc.setDrawColor(...GRAY_200)
    doc.roundedRect(x, y, cardW, cardH, 2, 2, "FD")
    doc.setFontSize(7)
    doc.setTextColor(...GRAY_500)
    doc.setFont("helvetica", "normal")
    doc.text(cards[i].label.toUpperCase(), x + cardW / 2, y + 7, { align: "center" })
    doc.setFontSize(13)
    doc.setTextColor(...GRAY_900)
    doc.setFont("helvetica", "bold")
    doc.text(cards[i].value, x + cardW / 2, y + 15, { align: "center" })
  }

  y += cardH + 6
  doc.setFontSize(9)
  doc.setTextColor(...GRAY_700)
  doc.setFont("helvetica", "normal")
  const rollLabel = data.rollCount > 1 ? `${data.rollCount} rolls` : "1 roll"
  doc.text(
    `${data.profileTitle}  |  Stock: ${data.stockWidth}" \u00D7 ${data.stockLength}" \u00D7 ${data.stockThickness}"  |  ${data.materialName}  |  ${rollLabel}`,
    MARGIN,
    y
  )
  y += 10

  return y
}

function addCutLegend(doc: jsPDF, tagMap: Map<string, string>, y: number): number {
  if (tagMap.size === 0) return y
  const entries = Array.from(tagMap.entries())
    .map(([tag, label]) => ({ tag, label }))
    .sort((a, b) => a.tag.localeCompare(b.tag))
  const cols = 3
  const colW = CONTENT_W / cols
  const rowH = 4.5
  const rows = Math.ceil(entries.length / cols)
  const needed = 12 + rows * rowH
  y = checkNewPage(doc, y, needed)

  doc.setFontSize(11)
  doc.setTextColor(...GRAY_900)
  doc.setFont("helvetica", "bold")
  doc.text("Cut Legend", MARGIN, y)
  y += 6

  // Column headers
  doc.setFillColor(...GRAY_50)
  doc.rect(MARGIN, y - 3.5, CONTENT_W, 5, "F")
  doc.setFontSize(7)
  doc.setTextColor(...GRAY_500)
  doc.setFont("helvetica", "normal")
  for (let c = 0; c < cols; c++) {
    const cx = MARGIN + c * colW
    doc.text("TAG", cx + 2, y)
    doc.text("DIMENSIONS", cx + 12, y)
  }
  y += 4

  // Entries in column-major order
  doc.setFontSize(8)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = c * rows + r
      if (idx >= entries.length) continue
      const cx = MARGIN + c * colW
      doc.setTextColor(...GRAY_900)
      doc.setFont("helvetica", "bold")
      doc.text(entries[idx].tag, cx + 3, y)
      doc.setTextColor(...GRAY_700)
      doc.setFont("helvetica", "normal")
      doc.text(entries[idx].label, cx + 12, y)
    }
    y += rowH
  }

  y += 4
  return y
}

// ── Vector Layout Rendering ──────────────────────────────────────────────────

/**
 * Draw a single LayoutModel into a rectangle on the PDF page using jsPDF
 * vector primitives (rect / ellipse / lines). Coordinates on `layout` are in
 * inches; this function scales them to fit within `w × h` mm on the page.
 */
function renderLayoutToDoc(
  doc: jsPDF,
  layout: LayoutModel,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const sheetW = layout.sheetWidth
  const sheetL = layout.sheetLength
  if (sheetW <= 0 || sheetL <= 0) return
  const scale = Math.min(w / sheetW, h / sheetL)
  const drawW = sheetW * scale
  const drawH = sheetL * scale
  const ox = x + (w - drawW) / 2
  const oy = y + (h - drawH) / 2

  // Sheet background
  doc.setFillColor(...SHEET_FILL_RGB)
  doc.setDrawColor(...SHEET_STROKE_RGB)
  doc.setLineWidth(0.3)
  doc.rect(ox, oy, drawW, drawH, "FD")

  // Grid (12" intervals)
  doc.setDrawColor(...GRAY_200)
  doc.setLineWidth(0.1)
  for (let gx = 12; gx < sheetW; gx += 12) {
    doc.line(ox + gx * scale, oy, ox + gx * scale, oy + drawH)
  }
  for (let gy = 12; gy < sheetL; gy += 12) {
    doc.line(ox, oy + gy * scale, ox + drawW, oy + gy * scale)
  }

  // Reusable offcut (amber)
  for (const region of layout.offcuts) {
    drawRegion(doc, region, ox, oy, scale, OFFCUT_RGB, OFFCUT_STROKE_RGB)
  }

  // Scrap / waste (red)
  for (const region of layout.scrap) {
    drawRegion(doc, region, ox, oy, scale, SCRAP_RGB, SCRAP_STROKE_RGB)
  }

  // Parts
  for (const part of layout.parts) {
    const fill = PART_FILLS_RGB[part.specIndex % PART_FILLS_RGB.length]
    drawPart(doc, part, ox, oy, scale, fill)
  }
}

function drawRegion(
  doc: jsPDF,
  region: LayoutRegion,
  ox: number,
  oy: number,
  scale: number,
  fill: RGB,
  stroke: RGB
): void {
  doc.setFillColor(...fill)
  doc.setDrawColor(...stroke)
  doc.setLineWidth(0.15)
  if (region.polygon && region.polygon.length >= 3) {
    drawPolygon(doc, region.polygon, ox, oy, scale, "FD")
    return
  }
  doc.rect(
    ox + region.x * scale,
    oy + region.y * scale,
    region.width * scale,
    region.height * scale,
    "FD"
  )
}

function drawPart(
  doc: jsPDF,
  part: PlacedPart,
  ox: number,
  oy: number,
  scale: number,
  fill: RGB
): void {
  doc.setFillColor(...fill)
  doc.setDrawColor(255, 255, 255)
  doc.setLineWidth(0.2)

  const px = ox + part.x * scale
  const py = oy + part.y * scale
  const pw = part.width * scale
  const ph = part.height * scale
  const cx = px + pw / 2
  const cy = py + ph / 2

  if (part.renderShape === "circle" && part.diameter != null) {
    const r = (part.diameter / 2) * scale
    doc.ellipse(cx, cy, r, r, "FD")
  } else if (part.polygon && part.polygon.length >= 3) {
    drawPolygon(doc, part.polygon, ox, oy, scale, "FD")
  } else {
    doc.rect(px, py, pw, ph, "FD")
  }

  // Label
  const labelFontPt = Math.max(5, Math.min(10, Math.min(pw, ph) / 3))
  doc.setFontSize(labelFontPt)
  doc.setTextColor(255, 255, 255)
  doc.setFont("helvetica", "bold")
  doc.text(part.label, cx, cy + labelFontPt / 4, { align: "center" })
}

function drawPolygon(
  doc: jsPDF,
  polygon: Array<{ x: number; y: number }>,
  ox: number,
  oy: number,
  scale: number,
  style: "F" | "FD" | "S"
): void {
  if (polygon.length < 3) return
  const first = polygon[0]
  const segments = polygon.slice(1).map((pt, i) => {
    const prev = polygon[i]
    return [(pt.x - prev.x) * scale, (pt.y - prev.y) * scale] as [number, number]
  })
  doc.lines(segments, ox + first.x * scale, oy + first.y * scale, [1, 1], style, true)
}

async function addLayoutDiagrams(doc: jsPDF, layouts: LayoutModel[], y: number): Promise<number> {
  // Match the aspect ratio of the legacy SVG path: CONTENT_W wide, scaled proportionally.
  for (let i = 0; i < layouts.length; i++) {
    const layout = layouts[i]
    const sheetAspect = layout.sheetLength / layout.sheetWidth
    const imgW = CONTENT_W
    const imgH = imgW * sheetAspect

    y = checkNewPage(doc, y, imgH + 12)

    if (layouts.length > 1) {
      doc.setFillColor(...BRAND)
      doc.rect(MARGIN, y - 1, 2, 6, "F")
      doc.setFontSize(10)
      doc.setTextColor(...GRAY_900)
      doc.setFont("helvetica", "bold")
      doc.text(`Roll ${i + 1} of ${layouts.length}`, MARGIN + 5, y + 3)
      y += 8
    }

    renderLayoutToDoc(doc, layout, MARGIN, y, imgW, imgH)
    y += imgH + 6
  }
  return y
}

async function addDiagrams(doc: jsPDF, svgElements: SVGSVGElement[], y: number): Promise<number> {
  for (let i = 0; i < svgElements.length; i++) {
    const svg = svgElements[i]
    const vw = svg.viewBox.baseVal.width || svg.clientWidth || 980
    const vh = svg.viewBox.baseVal.height || svg.clientHeight || 560
    const aspectRatio = vh / vw
    const imgW = CONTENT_W
    const imgH = imgW * aspectRatio

    y = checkNewPage(doc, y, imgH + 12)

    if (svgElements.length > 1) {
      doc.setFillColor(...BRAND)
      doc.rect(MARGIN, y - 1, 2, 6, "F")
      doc.setFontSize(10)
      doc.setTextColor(...GRAY_900)
      doc.setFont("helvetica", "bold")
      doc.text(`Roll ${i + 1} of ${svgElements.length}`, MARGIN + 5, y + 3)
      y += 8
    }

    const imgData = await rasterizeSvg(svg)
    doc.addImage(imgData, "PNG", MARGIN, y, imgW, imgH)
    y += imgH + 6
  }
  return y
}

function addReusableOffcuts(doc: jsPDF, layouts: LayoutModel[], y: number): number {
  const tagged = buildTaggedReusableOffcuts(layouts)
  if (tagged.length === 0) return y

  const headerH = 6
  const rowH = 5.5
  const needed = 12 + headerH + tagged.length * rowH
  y = checkNewPage(doc, y, needed)

  doc.setFontSize(11)
  doc.setTextColor(...GRAY_900)
  doc.setFont("helvetica", "bold")
  doc.text("Reusable Offcuts", MARGIN, y)
  y += 6

  doc.setFillColor(...BRAND)
  doc.rect(MARGIN, y - 3.5, CONTENT_W, headerH, "F")
  doc.setFontSize(8)
  doc.setTextColor(...WHITE)
  doc.setFont("helvetica", "bold")
  const colTagX = MARGIN + 3
  const colDimsX = MARGIN + 25
  const colAreaX = MARGIN + 90
  const colSourceX = MARGIN + 130
  doc.text("TAG", colTagX, y)
  doc.text("DIMENSIONS", colDimsX, y)
  doc.text("AREA", colAreaX, y)
  doc.text("SOURCE SHEET", colSourceX, y)
  y += 5

  doc.setFontSize(9)
  for (let i = 0; i < tagged.length; i++) {
    y = checkNewPage(doc, y, rowH)
    if (i % 2 === 0) {
      doc.setFillColor(...GRAY_50)
      doc.rect(MARGIN, y - 3.5, CONTENT_W, 5.5, "F")
    }
    const t = tagged[i]
    doc.setTextColor(...OFFCUT_STROKE_RGB)
    doc.setFont("helvetica", "bold")
    doc.text(t.tag, colTagX, y)
    doc.setTextColor(...GRAY_900)
    doc.setFont("helvetica", "normal")
    doc.text(`${formatInches(t.region.width)}" × ${formatInches(t.region.height)}"`, colDimsX, y)
    doc.text(`${t.areaSqFt.toFixed(2)} sq ft`, colAreaX, y)
    doc.setTextColor(...GRAY_700)
    doc.text(`Sheet ${t.sourceSheetNumber}`, colSourceX, y)
    y += rowH
  }

  y += 4
  return y
}

function addMetrics(doc: jsPDF, data: CutPdfData, y: number): number {
  y = checkNewPage(doc, y, 50)
  doc.setFontSize(11)
  doc.setTextColor(...GRAY_900)
  doc.setFont("helvetica", "bold")
  doc.text("Metrics", MARGIN, y)
  y += 6

  const rollNote = data.rollCount > 1 ? ` across ${data.rollCount} rolls` : ""
  const metrics = [
    ["Parts Completed", `${data.partsCompleted}${rollNote}`],
    ["Material Used", `${data.materialUsedSqFt.toFixed(2)} sq ft`],
    ["Reusable Offcut", `${data.reusableOffcutSqFt.toFixed(2)} sq ft`],
    ["Scrap / Waste", `${data.scrapSqFt.toFixed(2)} sq ft`],
    ["Cut Pieces", `${data.cutPieces}`],
    ["Fab Score", `${Math.round(data.fabScore * 100)} / 100`],
  ]

  // Header row
  doc.setFillColor(...BRAND)
  doc.rect(MARGIN, y - 3.5, CONTENT_W, 6, "F")
  doc.setFontSize(8)
  doc.setTextColor(...WHITE)
  doc.setFont("helvetica", "bold")
  doc.text("METRIC", MARGIN + 3, y)
  doc.text("VALUE", MARGIN + CONTENT_W / 2, y)
  y += 5

  doc.setFontSize(9)
  for (let i = 0; i < metrics.length; i++) {
    y = checkNewPage(doc, y, 6)
    if (i % 2 === 0) {
      doc.setFillColor(...GRAY_50)
      doc.rect(MARGIN, y - 3.5, CONTENT_W, 5.5, "F")
    }
    doc.setTextColor(...GRAY_700)
    doc.setFont("helvetica", "normal")
    doc.text(metrics[i][0], MARGIN + 3, y)
    doc.setTextColor(...GRAY_900)
    doc.setFont("helvetica", "bold")
    doc.text(metrics[i][1], MARGIN + CONTENT_W / 2, y)
    y += 5.5
  }

  y += 4
  return y
}

function addFooter(doc: jsPDF): void {
  const totalPages = doc.internal.pages.length - 1
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i)
    doc.setDrawColor(...GRAY_200)
    doc.setLineWidth(0.3)
    doc.line(MARGIN, PAGE_H - 15, MARGIN + CONTENT_W, PAGE_H - 15)
    doc.setFontSize(7)
    doc.setTextColor(...GRAY_500)
    doc.setFont("helvetica", "normal")
    const mainFooter = "Rubberfit Pro \u2014 Material Optimization System "
    doc.text(mainFooter, MARGIN, PAGE_H - 10)
    const mainW = doc.getTextWidth(mainFooter)
    doc.setFont("helvetica", "italic")
    doc.text("by Arc and Anchor", MARGIN + mainW, PAGE_H - 10)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    doc.text(`Page ${i} of ${totalPages}`, PAGE_W - MARGIN, PAGE_H - 10, { align: "right" })
  }
}

// ── Main Exports ─────────────────────────────────────────────────────────────

// Desktop variant: generation only. The Auto Nest page wires this up to
// Tauri's save dialog (@tauri-apps/plugin-dialog) in the page-level code.
// The original `buildAndUploadCutPdf` (rema-portal) also POSTed the blob
// to Supabase Storage; that side-effect is gone here — callers are
// responsible for persisting / saving the returned Blob.
//

export async function buildCutPdf(
  cutId: string,
  stock: StockConfig,
  cutMetrics: SimpleCutMetrics | null,
  selectedTemplate: PartTemplate | undefined,
  selectedTemplates: PartTemplate[],
  tags: Map<string, string>,
  layouts?: LayoutModel[]
): Promise<Blob | null> {
  // Prefer vector layout diagrams when available — fall back to legacy DOM SVG
  // scraping only when called without layouts (e.g. very old call sites).
  const useVector = layouts && layouts.length > 0
  const svgElements = useVector
    ? []
    : Array.from(document.querySelectorAll<SVGSVGElement>("[data-sheet-svg]"))
  const rollCount = useVector ? layouts.length : svgElements.length
  if (rollCount === 0) return null

  const totalStockSqFt = ((stock.width * stock.length) / 144) * rollCount
  const reusablePct =
    totalStockSqFt > 0 ? ((cutMetrics?.reusableOffsetSqFt ?? 0) / totalStockSqFt) * 100 : 0
  const scrapPct = totalStockSqFt > 0 ? ((cutMetrics?.scrapSqFt ?? 0) / totalStockSqFt) * 100 : 0
  const partLabel =
    PART_OPTIONS.find((p) => p.partType === selectedTemplate?.partType)?.label ?? "Custom"

  const pdfData: CutPdfData = {
    cutId,
    stockWidth: stock.width,
    stockLength: stock.length,
    stockThickness: stock.thickness,
    materialName: stock.material,
    profileTitle: `${partLabel} ${selectedTemplates.length > 1 ? "mixed-size layout" : "layout"}`,
    tagMap: tags,
    partsCompleted: cutMetrics?.partsCompleted ?? 0,
    cutPieces: cutMetrics?.cutPieces ?? 0,
    rollCount,
    materialUsedSqFt: cutMetrics?.materialUsedSqFt ?? 0,
    reusableOffcutSqFt: cutMetrics?.reusableOffsetSqFt ?? 0,
    reusableOffcutPct: reusablePct,
    scrapSqFt: cutMetrics?.scrapSqFt ?? 0,
    scrapPct,
    fabScore: cutMetrics?.fabScore ?? 0,
    cutDate: new Date().toISOString(),
  }

  return generateCutPdf({ svgElements, layouts: layouts ?? [], data: pdfData })
}

export async function generateCutPdf(args: {
  svgElements: SVGSVGElement[]
  layouts: LayoutModel[]
  data: CutPdfData
}): Promise<Blob> {
  const { svgElements, layouts, data } = args
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" })

  doc.setProperties({
    title: `Cut Report #${data.cutId}`,
    subject: "Rubberfit Pro Cut Report",
    author: "Rubberfit Pro",
    creator: "Rubberfit Pro",
  })

  const logo = getLogo()
  let y = addHeader(doc, data, logo)
  y = addSummaryCards(doc, data, y)
  y = addCutLegend(doc, data.tagMap, y)
  // Vector path when layouts are provided, raster fallback otherwise.
  if (layouts.length > 0) {
    y = await addLayoutDiagrams(doc, layouts, y)
  } else {
    y = await addDiagrams(doc, svgElements, y)
  }
  y = addReusableOffcuts(doc, layouts, y)
  addMetrics(doc, data, y)
  addFooter(doc)

  return doc.output("blob")
}
