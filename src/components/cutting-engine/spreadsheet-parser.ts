import * as XLSX from "xlsx"
import type { ExtractedPart } from "@/types/vision"

const WIDTH_ALIASES = ["width", "w", "wid", "wide"]
const LENGTH_ALIASES = ["length", "len", "l", "height", "h", "long"]
const QTY_ALIASES = ["quantity", "qty", "count", "pcs", "pieces", "ea", "amount", "amt", "#"]
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
const SIZE_ALIASES = ["size", "sizes", "dimension", "dimensions", "dim", "dims", "cut", "cut size"]

function matchColumn(header: string, aliases: string[]): boolean {
  const h = header.toLowerCase().trim()
  if (!h) return false
  return aliases.some((a) => {
    if (h === a) return true
    // Short aliases (1-2 chars) must be exact match only to avoid false positives
    if (a.length <= 2) return false
    return h.startsWith(a + " ") || h.startsWith(a + "(") || h.includes(a)
  })
}

/**
 * Parse fractional inch strings like "11-1/2", "½", "11.5", "11 1/2"
 */
export function parseFractionalInches(raw: string | number): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0
  const s = raw
    .trim()
    .replace(/\u00bd/g, ".5") // ½
    .replace(/\u00bc/g, ".25") // ¼
    .replace(/\u00be/g, ".75") // ¾
    .replace(/\u2153/g, ".333") // ⅓
    .replace(/\u2154/g, ".667") // ⅔
    .replace(/\u215b/g, ".125") // ⅛
    .replace(/\u215c/g, ".375") // ⅜
    .replace(/\u215d/g, ".625") // ⅝
    .replace(/\u215e/g, ".875") // ⅞
    .replace(/"/g, "")
    .replace(/'/g, "")
    .trim()

  // "11-1/2" or "11 1/2"
  const mixedMatch = s.match(/^(\d+)[\s-]+(\d+)\/(\d+)$/)
  if (mixedMatch) {
    const denom = Number(mixedMatch[3])
    if (denom === 0) return 0
    const result = Number(mixedMatch[1]) + Number(mixedMatch[2]) / denom
    return Number.isFinite(result) ? result : 0
  }

  // "1/2"
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
 * Parse a combined dimension string like "18 x 14", "18x14", "11-1/2 x 40"
 * Returns [width, length] or null if not a dimension pattern
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

interface ColumnMap {
  width: number
  length: number
  qty: number
  partNumber: number
  combined: number // single column with "WxL" dimensions
}

function detectColumns(headers: string[]): ColumnMap | null {
  let width = -1
  let length = -1
  let qty = -1
  let partNumber = -1
  let combined = -1

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]
    if (!h || !String(h).trim()) continue

    if (width < 0 && matchColumn(h, WIDTH_ALIASES)) width = i
    else if (length < 0 && matchColumn(h, LENGTH_ALIASES)) length = i
    else if (qty < 0 && matchColumn(h, QTY_ALIASES)) qty = i
    else if (partNumber < 0 && matchColumn(h, PART_ALIASES)) partNumber = i
    else if (combined < 0 && matchColumn(h, SIZE_ALIASES)) combined = i
  }

  // If we found separate width + length columns, use those
  if (width >= 0 && length >= 0) return { width, length, qty, partNumber, combined: -1 }

  // If we found a combined size/dimension column, use that
  if (combined >= 0) return { width: -1, length: -1, qty, partNumber, combined }

  return null
}

/**
 * Fallback: scan all columns in the first data row looking for numeric pairs
 * that could be width/length
 */
function detectColumnsFromData(headers: string[], firstDataRow: string[]): ColumnMap | null {
  const numericCols: number[] = []
  const dimCols: number[] = []

  for (let i = 0; i < firstDataRow.length; i++) {
    const val = String(firstDataRow[i]).trim()
    if (!val) continue

    if (parseCombinedDimension(val)) {
      dimCols.push(i)
    } else if (parseFractionalInches(val) > 0) {
      numericCols.push(i)
    }
  }

  // Combined dimension column found in data
  if (dimCols.length > 0) {
    let qty = -1
    let partNumber = -1
    for (let i = 0; i < headers.length; i++) {
      if (i === dimCols[0]) continue
      if (qty < 0 && matchColumn(String(headers[i]), QTY_ALIASES)) qty = i
      else if (partNumber < 0 && matchColumn(String(headers[i]), PART_ALIASES)) partNumber = i
    }
    return { width: -1, length: -1, qty, partNumber, combined: dimCols[0] }
  }

  // Two numeric columns could be width + length
  if (numericCols.length >= 2) {
    let qty = -1
    let partNumber = -1
    for (let i = 0; i < headers.length; i++) {
      if (i === numericCols[0] || i === numericCols[1]) continue
      if (qty < 0 && matchColumn(String(headers[i]), QTY_ALIASES)) qty = i
      else if (partNumber < 0 && matchColumn(String(headers[i]), PART_ALIASES)) partNumber = i
    }
    return { width: numericCols[0], length: numericCols[1], qty, partNumber, combined: -1 }
  }

  return null
}

/**
 * Scan the first rows to find the actual header row.
 * Spreadsheets often have title rows, blank rows, or unit labels before the real headers.
 */
function findHeaderRow(
  rows: string[][],
  maxScan: number = 10
): { headerIndex: number; cols: ColumnMap } | null {
  const limit = Math.min(maxScan, rows.length - 1)
  for (let r = 0; r < limit; r++) {
    const candidate = rows[r].map(String)
    const cols = detectColumns(candidate)
    if (cols) return { headerIndex: r, cols }
  }

  // Fallback: infer from data rows
  for (let r = 0; r < limit; r++) {
    const nextRow = rows[r + 1]
    if (!nextRow) continue
    const cols = detectColumnsFromData(rows[r].map(String), nextRow.map(String))
    if (cols) return { headerIndex: r, cols }
  }

  return null
}

export async function parseSpreadsheet(file: File): Promise<ExtractedPart[]> {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: "array" })
  if (workbook.SheetNames.length === 0) {
    throw new Error("Spreadsheet contains no sheets.")
  }
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  const rows: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" })

  if (rows.length < 2) return []

  const found = findHeaderRow(rows)
  if (!found) {
    throw new Error(
      "Could not detect dimension columns. " +
        "Expected headers like: Width, Length, Size, or columns with dimension data (e.g. 18 x 14)."
    )
  }

  const { headerIndex, cols } = found
  const parts: ExtractedPart[] = []

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i]
    let w: number
    let l: number

    if (cols.combined >= 0) {
      const dim = parseCombinedDimension(row[cols.combined])
      if (!dim) continue
      ;[w, l] = dim
    } else {
      w = parseFractionalInches(row[cols.width])
      l = parseFractionalInches(row[cols.length])
    }

    if (w <= 0 || l <= 0) continue

    const q = cols.qty >= 0 ? Math.max(1, Math.round(parseFractionalInches(row[cols.qty]))) : 1
    const pn = cols.partNumber >= 0 ? String(row[cols.partNumber]).trim() : undefined

    parts.push({
      width: w,
      length: l,
      quantity: q,
      partNumber: pn || undefined,
      confidence: 1.0,
    })
  }

  return parts
}
