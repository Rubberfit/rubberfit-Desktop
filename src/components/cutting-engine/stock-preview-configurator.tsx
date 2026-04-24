import React, { useState } from "react"
import { Package } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { MaterialType } from "@/types/supabase-models"

export interface StockConfig {
  width: number
  length: number
  material: string
  thickness: number
  materialTypeId?: string
  costPerSqft?: number
}

export const STOCK_PRESETS = [
  { id: "24x24", label: '24" × 24"', width: 24, length: 24 },
  { id: "36x36", label: '36" × 36"', width: 36, length: 36 },
  { id: "48x48", label: '48" × 48"', width: 48, length: 48 },
  { id: "48x96", label: '48" × 96"', width: 48, length: 96 },
  { id: "60x96", label: '60" × 96"', width: 60, length: 96 },
  { id: "72x120", label: '72" × 120"', width: 72, length: 120 },
  { id: "96x48", label: '96" × 48"', width: 96, length: 48 },
  { id: "96x120", label: '96" × 120"', width: 96, length: 120 },
  { id: "18x14", label: '18" × 14"', width: 18, length: 14 },
  { id: "24x50", label: '24" × 50"', width: 24, length: 50 },
  { id: "11-5x50", label: '11½" × 50"', width: 11.5, length: 50 },
  { id: "24x14", label: '24" × 14"', width: 24, length: 14 },
  { id: "24x40", label: '24" × 40"', width: 24, length: 40 },
  { id: "11-5x40", label: '11½" × 40"', width: 11.5, length: 40 },
  { id: "12x24", label: '12" × 24"', width: 12, length: 24 },
  { id: "11-5x12", label: '11½" × 12"', width: 11.5, length: 12 },
  { id: "56x12", label: '56" × 12"', width: 56, length: 12 },
  { id: "12x11-5", label: '12" × 11½"', width: 12, length: 11.5 },
  { id: "72x12", label: '72" × 12"', width: 72, length: 12 },
  { id: "38x24", label: '38" × 24"', width: 38, length: 24 },
  { id: "11-5x38", label: '11½" × 38"', width: 11.5, length: 38 },
  { id: "48x24", label: '48" × 24"', width: 48, length: 24 },
  { id: "48x11-5", label: '48" × 11½"', width: 48, length: 11.5 },
  { id: "40x12", label: '40" × 12"', width: 40, length: 12 },
  { id: "38x12", label: '38" × 12"', width: 38, length: 12 },
  { id: "78x396", label: '78" × 396"', width: 78, length: 396 },
].sort((left, right) => {
  const leftArea = left.width * left.length
  const rightArea = right.width * right.length

  if (leftArea !== rightArea) {
    return leftArea - rightArea
  }

  const leftLongest = Math.max(left.width, left.length)
  const rightLongest = Math.max(right.width, right.length)
  if (leftLongest !== rightLongest) {
    return leftLongest - rightLongest
  }

  const leftShortest = Math.min(left.width, left.length)
  const rightShortest = Math.min(right.width, right.length)
  return leftShortest - rightShortest
})

import { formatInches } from "./nesting-layout-utils"

interface StockPreviewConfiguratorProps {
  activeStockPreset?: string
  stock: StockConfig
  onStockChange: React.Dispatch<React.SetStateAction<StockConfig>>
  materialTypes?: MaterialType[]
}

type StockField = "width" | "length" | "thickness"

function formatDraftValue(value: number) {
  return Number.isFinite(value) ? String(value) : ""
}

export function StockPreviewConfigurator({
  activeStockPreset,
  stock,
  onStockChange,
  materialTypes = [],
}: StockPreviewConfiguratorProps) {
  const [activeDraftField, setActiveDraftField] = useState<StockField | null>(null)
  const [drafts, setDrafts] = useState(() => ({
    width: formatDraftValue(stock.width),
    length: formatDraftValue(stock.length),
    thickness: formatDraftValue(stock.thickness),
  }))

  const updateDraft = (field: StockField, value: string) => {
    setDrafts((previous) => ({
      ...previous,
      [field]: value,
    }))
  }

  const commitDraft = (field: StockField, rawValue: string, minimum: number) => {
    const trimmed = rawValue.trim()
    const parsed = Number.parseFloat(trimmed)

    if (Number.isFinite(parsed) && parsed >= minimum) {
      const normalized = formatDraftValue(parsed)
      setDrafts((previous) => ({
        ...previous,
        [field]: normalized,
      }))
      onStockChange((previous) => ({
        ...previous,
        [field]: parsed,
      }))
      return
    }

    setDrafts((previous) => ({
      ...previous,
      [field]: formatDraftValue(stock[field]),
    }))
  }

  const getInputValue = (field: StockField) =>
    activeDraftField === field ? drafts[field] : formatDraftValue(stock[field])

  return (
    <Card className="border border-slate-200 shadow-sm">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Package className="h-4 w-4 text-slate-500 dark:text-slate-300" />
          Stock Preview
        </CardTitle>
        <CardDescription>
          Pick the stock sheet before choosing cuts so the graph scores yield against the sheet you
          actually want to demo. The quick sets include the shop&apos;s common rubber sizes, and the
          manual fields let you override them when a sheet is not listed.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
          {STOCK_PRESETS.map((preset) => {
            const isActive = activeStockPreset === preset.id
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() =>
                  onStockChange((previous) => ({
                    ...previous,
                    width: preset.width,
                    length: preset.length,
                  }))
                }
                className={`rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
                  isActive
                    ? "border-blue-500 bg-blue-50 text-blue-900 dark:border-blue-400 dark:bg-blue-900/10 dark:text-blue-300"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-700/50 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:bg-slate-700/70"
                }`}
              >
                {preset.label}
              </button>
            )
          })}
        </div>

        {materialTypes.length > 0 && (
          <div>
            <label
              htmlFor="material-type"
              className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500"
            >
              Material Type
            </label>
            <Select
              value={stock.materialTypeId ?? ""}
              onValueChange={(id) => {
                const mt = materialTypes.find((t) => t.id === id)
                if (mt) {
                  onStockChange((prev) => ({
                    ...prev,
                    material: mt.name,
                    materialTypeId: mt.id,
                    costPerSqft: mt.default_cost ?? undefined,
                  }))
                }
              }}
            >
              <SelectTrigger id="material-type" className="w-full sm:w-64">
                <SelectValue placeholder="Select material…" />
              </SelectTrigger>
              <SelectContent>
                {materialTypes.map((mt) => (
                  <SelectItem key={mt.id} value={mt.id}>
                    {mt.name}
                    {mt.default_cost != null ? ` — $${mt.default_cost.toFixed(2)}/sq ft` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label
              htmlFor="stock-width"
              className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500"
            >
              Width
            </label>
            <Input
              id="stock-width"
              min={1}
              step="0.5"
              type="number"
              value={getInputValue("width")}
              onFocus={() => {
                setActiveDraftField("width")
                setDrafts((previous) => ({
                  ...previous,
                  width: formatDraftValue(stock.width),
                }))
              }}
              onChange={(event) => updateDraft("width", event.target.value)}
              onBlur={(event) => {
                commitDraft("width", event.target.value, 1)
                setActiveDraftField((previous) => (previous === "width" ? null : previous))
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitDraft("width", event.currentTarget.value, 1)
                  event.currentTarget.blur()
                }
              }}
            />
          </div>
          <div>
            <label
              htmlFor="stock-length"
              className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500"
            >
              Length
            </label>
            <Input
              id="stock-length"
              min={1}
              step="0.5"
              type="number"
              value={getInputValue("length")}
              onFocus={() => {
                setActiveDraftField("length")
                setDrafts((previous) => ({
                  ...previous,
                  length: formatDraftValue(stock.length),
                }))
              }}
              onChange={(event) => updateDraft("length", event.target.value)}
              onBlur={(event) => {
                commitDraft("length", event.target.value, 1)
                setActiveDraftField((previous) => (previous === "length" ? null : previous))
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitDraft("length", event.currentTarget.value, 1)
                  event.currentTarget.blur()
                }
              }}
            />
          </div>
          <div>
            <label
              htmlFor="stock-thickness"
              className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500"
            >
              Thickness
            </label>
            <Input
              id="stock-thickness"
              min={0.0625}
              step="0.0625"
              type="number"
              value={getInputValue("thickness")}
              onFocus={() => {
                setActiveDraftField("thickness")
                setDrafts((previous) => ({
                  ...previous,
                  thickness: formatDraftValue(stock.thickness),
                }))
              }}
              onChange={(event) => updateDraft("thickness", event.target.value)}
              onBlur={(event) => {
                commitDraft("thickness", event.target.value, 0.0625)
                setActiveDraftField((previous) => (previous === "thickness" ? null : previous))
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitDraft("thickness", event.currentTarget.value, 0.0625)
                  event.currentTarget.blur()
                }
              }}
            />
          </div>
        </div>

        <div className="text-xs text-slate-600">
          {stock.material ? `${stock.material}` : "No material selected"}
          {stock.costPerSqft != null ? ` · $${stock.costPerSqft.toFixed(2)}/sq ft` : ""}
          {" · "}
          {formatInches(stock.width)}&quot; × {formatInches(stock.length)}&quot; preview sheet
        </div>
      </CardContent>
    </Card>
  )
}
