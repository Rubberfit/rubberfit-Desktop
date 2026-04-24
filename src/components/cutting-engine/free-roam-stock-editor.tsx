import { useEffect, useState } from "react"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { StockConfig } from "./stock-preview-configurator"

interface FreeRoamStockEditorProps {
  stock: StockConfig
  onChange: (stock: StockConfig) => void
}

type DimField = "width" | "length" | "thickness"

const MIN_BY_FIELD: Record<DimField, number> = {
  width: 1,
  length: 1,
  thickness: 0.0625,
}

/**
 * W × L × T inputs for the Free-roam stock. Inches only.
 *
 * Uses a local string-draft pattern per field so intermediate states
 * like `""`, `"0"`, `"0."` don't snap back mid-edit — a number input
 * that validates on every keystroke makes values like `0.125`
 * unreachable. We commit on blur / Enter and clamp to the field's
 * minimum. The canonical stock shape stays numeric in the parent.
 */
export function FreeRoamStockEditor({ stock, onChange }: FreeRoamStockEditorProps) {
  const [drafts, setDrafts] = useState({
    width: String(stock.width),
    length: String(stock.length),
    thickness: String(stock.thickness),
  })
  const [active, setActive] = useState<DimField | null>(null)

  // Sync drafts when the parent-owned value changes while the user
  // isn't editing that specific field (e.g. "R" flips W ↔ L, or a
  // saved layout loads).
  useEffect(() => {
    setDrafts((prev) => ({
      width: active === "width" ? prev.width : String(stock.width),
      length: active === "length" ? prev.length : String(stock.length),
      thickness: active === "thickness" ? prev.thickness : String(stock.thickness),
    }))
  }, [stock.width, stock.length, stock.thickness, active])

  const commitField = (field: DimField, raw: string) => {
    const parsed = Number(raw)
    const min = MIN_BY_FIELD[field]
    if (!Number.isFinite(parsed) || parsed < min) {
      // Restore the last committed value so the field never shows a
      // garbage state after blur.
      setDrafts((prev) => ({ ...prev, [field]: String(stock[field]) }))
      return
    }
    onChange({ ...stock, [field]: parsed })
  }

  const renderField = (field: DimField, labelText: string) => {
    const id = `free-roam-stock-${field}`
    return (
      <div className="space-y-1">
        <Label htmlFor={id} className="text-[11px] text-muted-foreground">
          {labelText}
        </Label>
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={MIN_BY_FIELD[field]}
          step={field === "thickness" ? 0.0625 : 0.25}
          value={drafts[field]}
          onFocus={() => setActive(field)}
          onChange={(e) => setDrafts((prev) => ({ ...prev, [field]: e.target.value }))}
          onBlur={(e) => {
            setActive(null)
            commitField(field, e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur()
            }
          }}
          className="h-8 text-xs"
        />
      </div>
    )
  }

  return (
    <div className="grid grid-cols-3 gap-2">
      {renderField("width", "Width (in)")}
      {renderField("length", "Length (in)")}
      {renderField("thickness", "Thk (in)")}
    </div>
  )
}
