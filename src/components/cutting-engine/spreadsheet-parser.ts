import * as XLSX from "xlsx"
import type {
  ExtractedPart,
  ExtractedShapeType,
  ExtractedRectangle,
  ExtractedCylinder,
  ExtractedCone,
  ExtractedTrapezoid,
} from "@/types/vision"

// ── Column aliases (case-insensitive, matched via `contains`) ────────

const PART_ALIASES = [
  "part number",
  "part #",
  "part no",
  "part",
  "item",
  "description",
  "desc",
  "name",
  "label",
  "sku",
]
const QTY_ALIASES = ["quantity", "qty", "count", "pcs", "pieces", "ea", "amount", "amt"]

// Rectangle
const WIDTH_ALIASES = ["width", "wid", "wide"]
const LENGTH_ALIASES = ["length", "len", "long"]
const SIZE_ALIASES = ["size", "dimension", "dim", "cut size"]

// Cylinder
const DIAMETER_ALIASES = ["diameter", "dia", "ø", "o.d.", "od"]
// Cylinder height shares aliases with rectangle length — handled in
// per-shape detector which knows the column it's looking for.
const HEIGHT_ALIASES = ["height", "ht"]

// Cone
const INNER_RADIUS_ALIASES = ["inner radius", "inner r", "r1", "ir"]
const OUTER_RADIUS_ALIASES = ["outer radius", "outer r", "r2", "or"]
const ARC_DEGREES_ALIASES = ["arc degrees", "arc deg", "arc", "degrees", "deg", "angle"]

// Trapezoid
const TOP_WIDTH_ALIASES = ["top width", "top w", "top"]
const BOTTOM_WIDTH_ALIASES = ["bottom width", "bottom w", "bottom", "base width", "base"]

// ── Helpers ──────────────────────────────────────────────────────────

function norm(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .trim()
}

function findCol(headers: string[], aliases: string[]): number {
  // Exact match wins; otherwise prefer the longest alias that's
  // contained in the header so "outer radius" is preferred over the
  // shorter "r" against the same header.
  const normHeaders = headers.map(norm)
  for (let i = 0; i < normHeaders.length; i++) {
    if (aliases.some((a) => normHeaders[i] === a)) return i
  }
  const sortedAliases = [...aliases].sort((a, b) => b.length - a.length)
  for (let i = 0; i < normHeaders.length; i++) {
    const h = normHeaders[i]
    if (!h) continue
    if (sortedAliases.some((a) => a.length > 1 && h.includes(a))) return i
  }
  return -1
}

/**
 * Parse fractional inch strings like "11-1/2", "½", "11.5", "11 1/2"
 */
export function parseFractionalInches(raw: string | number | null | undefined): number {
  if (raw == null) return 0
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0
  const s = String(raw)
    .trim()
    .replace(/½/g, ".5") // ½
    .replace(/¼/g, ".25") // ¼
    .replace(/¾/g, ".75") // ¾
    .replace(/⅓/g, ".333") // ⅓
    .replace(/⅔/g, ".667") // ⅔
    .replace(/⅛/g, ".125") // ⅛
    .replace(/⅜/g, ".375") // ⅜
    .replace(/⅝/g, ".625") // ⅝
    .replace(/⅞/g, ".875") // ⅞
    .replace(/"/g, "")
    .replace(/'/g, "")
    .trim()

  const mixedMatch = s.match(/^(\d+)[\s-]+(\d+)\/(\d+)$/)
  if (mixedMatch) {
    const denom = Number(mixedMatch[3])
    if (denom === 0) return 0
    const result = Number(mixedMatch[1]) + Number(mixedMatch[2]) / denom
    return Number.isFinite(result) ? result : 0
  }

  const fracMatch = s.match(/^(\d+)\/(\d+)$/)
  if (fracMatch) {
    const denom = Number(fracMatch[2])
    if (denom === 0) return 0
    const result = Number(fracMatch[1]) / denom
    return Number.isFinite(result) ? result : 0
  }

  const num = Number(s)
  return Number.isFinite(num) ? num : 0
}

/**
 * Parse a combined dimension string like "18 x 14", "18x14", "11-1/2 x 40".
 * Returns [width, length] or null if not a dimension pattern.
 * Used by the rectangle path so legacy spreadsheets with a single
 * "Size" column still parse.
 */
function parseCombinedDimension(raw: string | number): [number, number] | null {
  if (typeof raw === "number") return null
  const s = String(raw).trim()
  const match = s.match(/^(.+?)\s*[xX×]\s*(.+)$/)
  if (!match) return null
  const w = parseFractionalInches(match[1])
  const l = parseFractionalInches(match[2])
  if (w > 0 && l > 0) return [w, l]
  return null
}

// ── Shape detection ──────────────────────────────────────────────────

/**
 * Recognize shape from sheet name. Handles plurals and synonyms (the
 * sample workbook ships sheets named "Rectangles" / "Cylinders" /
 * "Cones" / "Trapezoids", but we also accept singular forms and a few
 * domain synonyms used by older job sheets).
 */
function detectShapeFromSheetName(name: string): ExtractedShapeType | null {
  const n = norm(name)
  if (!n) return null
  if (/(^|[\s_-])rect|strip|panel/.test(n)) return "rectangle"
  if (/cylinder|cyl|wrap|liner/.test(n)) return "cylinder"
  if (/cone|frustum/.test(n)) return "cone"
  if (/trap|hopper|transition/.test(n)) return "trapezoid"
  return null
}

/**
 * Recognize shape from column headers. Used when the sheet name is
 * generic (e.g., a CSV's only sheet, or "Sheet1") so the importer can
 * still figure out what's in the rows. The order matters — cone is
 * checked first because it has the most specific column set, then
 * trapezoid, cylinder, and rectangle as the catch-all.
 */
function detectShapeFromHeaders(headers: string[]): ExtractedShapeType | null {
  const h = headers.map(norm)

  const hasInnerR = h.some((x) => x.includes("inner") && x.includes("radius"))
  const hasOuterR = h.some((x) => x.includes("outer") && x.includes("radius"))
  if (hasInnerR && hasOuterR) return "cone"

  const hasTop = h.some((x) => x.includes("top") && x.includes("width"))
  const hasBottom = h.some((x) => x.includes("bottom") && x.includes("width"))
  if (hasTop && hasBottom) return "trapezoid"

  const hasDiameter = h.some(
    (x) => x.includes("diameter") || x === "dia" || x.startsWith("dia ") || x === "ø"
  )
  if (hasDiameter) return "cylinder"

  const hasW = h.some((x) => x === "width" || x.startsWith("width ") || x.includes("width"))
  const hasL = h.some(
    (x) => x === "length" || x.startsWith("length ") || x.includes("length") || x === "len"
  )
  if (hasW && hasL) return "rectangle"

  // Legacy single-column "Size" sheets — treat as rectangle.
  if (h.some((x) => SIZE_ALIASES.some((a) => x.includes(a)))) return "rectangle"

  return null
}

// ── Header-row finder ────────────────────────────────────────────────

/**
 * Spreadsheets often have title rows or unit labels above the real
 * header row. Scan the first ~10 rows for the first one whose cells
 * look like headers for the expected shape.
 */
function findHeaderRow(
  rows: string[][],
  maxScan: number = 10
): {
  headerIndex: number
  shape: ExtractedShapeType
} | null {
  const limit = Math.min(maxScan, rows.length - 1)
  for (let r = 0; r < limit; r++) {
    const candidate = rows[r].map((x) => String(x ?? ""))
    const shape = detectShapeFromHeaders(candidate)
    if (shape) return { headerIndex: r, shape }
  }
  return null
}

// ── Per-shape row extractors ─────────────────────────────────────────

function extractQuantity(row: string[], qtyCol: number): number {
  if (qtyCol < 0) return 1
  const q = Math.round(parseFractionalInches(row[qtyCol]))
  return q > 0 ? q : 1
}

function extractPartNumber(row: string[], partCol: number): string | undefined {
  if (partCol < 0) return undefined
  const v = String(row[partCol] ?? "").trim()
  return v ? v : undefined
}

function parseRectangleRows(rows: string[][], headerIndex: number): ExtractedRectangle[] {
  const headers = rows[headerIndex].map((x) => String(x ?? ""))
  const widthCol = findCol(headers, WIDTH_ALIASES)
  const lengthCol = findCol(headers, LENGTH_ALIASES)
  const sizeCol = widthCol < 0 || lengthCol < 0 ? findCol(headers, SIZE_ALIASES) : -1
  const qtyCol = findCol(headers, QTY_ALIASES)
  const partCol = findCol(headers, PART_ALIASES)

  const out: ExtractedRectangle[] = []
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    let w = 0
    let l = 0
    if (widthCol >= 0 && lengthCol >= 0) {
      w = parseFractionalInches(row[widthCol])
      l = parseFractionalInches(row[lengthCol])
    } else if (sizeCol >= 0) {
      const dim = parseCombinedDimension(row[sizeCol])
      if (dim) {
        w = dim[0]
        l = dim[1]
      }
    }
    if (w <= 0 || l <= 0) continue
    out.push({
      shapeType: "rectangle",
      width: w,
      length: l,
      quantity: extractQuantity(row, qtyCol),
      partNumber: extractPartNumber(row, partCol),
      confidence: 1.0,
    })
  }
  return out
}

function parseCylinderRows(rows: string[][], headerIndex: number): ExtractedCylinder[] {
  const headers = rows[headerIndex].map((x) => String(x ?? ""))
  const diaCol = findCol(headers, DIAMETER_ALIASES)
  // Cylinder "height" lives in either a Height column (sample sheet)
  // or a generic Length column on older sheets.
  const heightCol = (() => {
    const h = findCol(headers, HEIGHT_ALIASES)
    if (h >= 0) return h
    return findCol(headers, LENGTH_ALIASES)
  })()
  const qtyCol = findCol(headers, QTY_ALIASES)
  const partCol = findCol(headers, PART_ALIASES)

  if (diaCol < 0 || heightCol < 0) return []

  const out: ExtractedCylinder[] = []
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    const d = parseFractionalInches(row[diaCol])
    const h = parseFractionalInches(row[heightCol])
    if (d <= 0 || h <= 0) continue
    out.push({
      shapeType: "cylinder",
      diameter: d,
      height: h,
      quantity: extractQuantity(row, qtyCol),
      partNumber: extractPartNumber(row, partCol),
      confidence: 1.0,
    })
  }
  return out
}

function parseConeRows(rows: string[][], headerIndex: number): ExtractedCone[] {
  const headers = rows[headerIndex].map((x) => String(x ?? ""))
  const innerCol = findCol(headers, INNER_RADIUS_ALIASES)
  const outerCol = findCol(headers, OUTER_RADIUS_ALIASES)
  const arcCol = findCol(headers, ARC_DEGREES_ALIASES)
  const qtyCol = findCol(headers, QTY_ALIASES)
  const partCol = findCol(headers, PART_ALIASES)

  if (innerCol < 0 || outerCol < 0 || arcCol < 0) return []

  const out: ExtractedCone[] = []
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    const ir = parseFractionalInches(row[innerCol])
    const or = parseFractionalInches(row[outerCol])
    const arc = parseFractionalInches(row[arcCol])
    if (ir < 0 || or <= 0 || arc <= 0) continue
    if (or <= ir) continue
    out.push({
      shapeType: "cone",
      innerRadius: ir,
      outerRadius: or,
      arcDegrees: arc,
      quantity: extractQuantity(row, qtyCol),
      partNumber: extractPartNumber(row, partCol),
      confidence: 1.0,
    })
  }
  return out
}

function parseTrapezoidRows(rows: string[][], headerIndex: number): ExtractedTrapezoid[] {
  const headers = rows[headerIndex].map((x) => String(x ?? ""))
  const topCol = findCol(headers, TOP_WIDTH_ALIASES)
  const bottomCol = findCol(headers, BOTTOM_WIDTH_ALIASES)
  const heightCol = findCol(headers, HEIGHT_ALIASES)
  const qtyCol = findCol(headers, QTY_ALIASES)
  const partCol = findCol(headers, PART_ALIASES)

  if (topCol < 0 || bottomCol < 0 || heightCol < 0) return []

  const out: ExtractedTrapezoid[] = []
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    const t = parseFractionalInches(row[topCol])
    const b = parseFractionalInches(row[bottomCol])
    const h = parseFractionalInches(row[heightCol])
    if (t <= 0 || b <= 0 || h <= 0) continue
    out.push({
      shapeType: "trapezoid",
      topWidth: t,
      bottomWidth: b,
      height: h,
      quantity: extractQuantity(row, qtyCol),
      partNumber: extractPartNumber(row, partCol),
      confidence: 1.0,
    })
  }
  return out
}

function parseSheetRows(
  rows: string[][],
  shape: ExtractedShapeType,
  headerIndex: number
): ExtractedPart[] {
  switch (shape) {
    case "rectangle":
      return parseRectangleRows(rows, headerIndex)
    case "cylinder":
      return parseCylinderRows(rows, headerIndex)
    case "cone":
      return parseConeRows(rows, headerIndex)
    case "trapezoid":
      return parseTrapezoidRows(rows, headerIndex)
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Parse a CSV/XLSX cut list into a list of `ExtractedPart`s. Each
 * sheet in the workbook is treated as a single shape type; the shape
 * is inferred from the sheet name first (e.g. "Cones") and, if that
 * fails, from the column headers (e.g. "Inner Radius" + "Outer
 * Radius" + "Arc Degrees" → cone). CSV uploads have one anonymous
 * sheet, so the header-based fallback covers them.
 */
export async function parseSpreadsheet(file: File): Promise<ExtractedPart[]> {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: "array" })
  if (workbook.SheetNames.length === 0) {
    throw new Error("Spreadsheet contains no sheets.")
  }

  const allParts: ExtractedPart[] = []
  const skipped: string[] = []

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const rows: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" })
    if (rows.length < 2) continue

    // Try the sheet-name signal first; fall back to scanning the top
    // ~10 rows for a header that matches a known shape.
    const sheetShape = detectShapeFromSheetName(sheetName)
    if (sheetShape) {
      // Find the header row inside this sheet (skip any title rows).
      let headerIndex = -1
      for (let r = 0; r < Math.min(10, rows.length); r++) {
        const candidate = rows[r].map((x) => String(x ?? ""))
        if (detectShapeFromHeaders(candidate) === sheetShape) {
          headerIndex = r
          break
        }
        // Permissive: if the sheet name says cone/trapezoid/etc. and
        // we hit a row with at least one matching column, accept it.
        if (
          (sheetShape === "rectangle" && findCol(candidate, WIDTH_ALIASES) >= 0) ||
          (sheetShape === "cylinder" && findCol(candidate, DIAMETER_ALIASES) >= 0) ||
          (sheetShape === "cone" && findCol(candidate, INNER_RADIUS_ALIASES) >= 0) ||
          (sheetShape === "trapezoid" && findCol(candidate, TOP_WIDTH_ALIASES) >= 0)
        ) {
          headerIndex = r
          break
        }
      }
      if (headerIndex < 0) {
        skipped.push(sheetName)
        continue
      }
      allParts.push(...parseSheetRows(rows, sheetShape, headerIndex))
      continue
    }

    const found = findHeaderRow(rows)
    if (!found) {
      skipped.push(sheetName)
      continue
    }
    allParts.push(...parseSheetRows(rows, found.shape, found.headerIndex))
  }

  if (allParts.length === 0) {
    throw new Error(
      "Could not detect dimension columns. Expected sheets named " +
        "Rectangles / Cylinders / Cones / Trapezoids, or columns like " +
        "Width, Length, Diameter, Inner Radius, Top Width, etc."
    )
  }

  return allParts
}
