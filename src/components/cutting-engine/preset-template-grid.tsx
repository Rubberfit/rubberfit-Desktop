import { useEffect, useState } from "react"
import { Minus, Pencil, Plus } from "lucide-react"
import type { PartTemplate } from "./preset-template-data"
import { CAT_BADGE } from "./preset-template-data"
import { getTemplateAreaSqFt } from "./preset-utils"

const MAX_TEMPLATE_QUANTITY = 1000

interface PresetTemplateGridProps {
  visible: PartTemplate[]
  checked: Set<string>
  quantities: Map<string, number>
  editingCustomId: string | null
  onToggle: (templateId: string) => void
  onQuantityChange: (templateId: string, qty: number) => void
  onEditCustom: (template: PartTemplate) => void
  onRemoveCustom: (templateId: string) => void
  tagMap?: Map<string, string>
  fitsStock?: (template: PartTemplate) => boolean
}

export function PresetTemplateGrid({
  visible,
  checked,
  quantities,
  editingCustomId,
  onToggle,
  onQuantityChange,
  onEditCustom,
  onRemoveCustom,
  tagMap,
  fitsStock,
}: PresetTemplateGridProps) {
  const [quantityDrafts, setQuantityDrafts] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    setQuantityDrafts((previous) => {
      let changed = false
      const next = new Map(previous)
      for (const templateId of previous.keys()) {
        if (!checked.has(templateId)) {
          next.delete(templateId)
          changed = true
        }
      }
      return changed ? next : previous
    })
  }, [checked])

  const clearQuantityDraft = (templateId: string) => {
    setQuantityDrafts((previous) => {
      if (!previous.has(templateId)) return previous
      const next = new Map(previous)
      next.delete(templateId)
      return next
    })
  }

  const handleQuantityInputChange = (templateId: string, value: string) => {
    if (!/^\d*$/.test(value)) return

    const normalizedDraft =
      value === "" ? "" : String(Math.min(MAX_TEMPLATE_QUANTITY, Number.parseInt(value, 10)))

    setQuantityDrafts((previous) => {
      const next = new Map(previous)
      next.set(templateId, normalizedDraft)
      return next
    })

    if (normalizedDraft !== "") {
      onQuantityChange(templateId, Number.parseInt(normalizedDraft, 10))
    }
  }

  const handleQuantityInputBlur = (templateId: string, value: string) => {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) {
      onQuantityChange(templateId, Math.max(1, Math.min(MAX_TEMPLATE_QUANTITY, parsed)))
    }
    clearQuantityDraft(templateId)
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {visible.map((template) => {
        const isChecked = checked.has(template.id)
        const fits = fitsStock ? fitsStock(template) : true
        const disabled = !fits
        const currentQuantity = quantities.get(template.id) ?? 1
        const quantityValue = quantityDrafts.get(template.id) ?? String(currentQuantity)
        return (
          <label
            key={template.id}
            className={`flex items-start gap-2.5 p-2.5 rounded-lg border transition-all duration-150 select-none ${
              disabled
                ? "cursor-not-allowed opacity-50 bg-slate-50 border-slate-200 dark:bg-slate-800 dark:border-slate-700"
                : isChecked
                  ? `cursor-pointer  border-blue-400 text-blue-900 shadow-sm ring-1 ring-inset ring-blue-200`
                  : "cursor-pointer bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:bg-card dark:text-slate-100 dark:border-slate-700 dark:hover:bg-slate-700"
            }`}
            title={
              disabled ? "This shape's bounding box is larger than the stock sheet." : undefined
            }
          >
            <input
              type="checkbox"
              checked={isChecked}
              disabled={disabled}
              onChange={() => onToggle(template.id)}
              className="sr-only"
            />

            <span
              className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${
                isChecked
                  ? "border-blue-600 bg-blue-600"
                  : "border-slate-100 bg-white dark:border-slate-700 dark:bg-slate-700"
              }`}
            >
              {isChecked && (
                <svg viewBox="0 0 12 12" className="w-2.5 h-2.5 text-white fill-white">
                  <path
                    d="M2 6l3 3 5-5"
                    stroke="white"
                    strokeWidth="2"
                    fill="none"
                    strokeLinecap="round"
                  />
                </svg>
              )}
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-1.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {isChecked && tagMap?.has(template.id) && (
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-stone-700 text-[10px] font-bold text-stone-50">
                        {tagMap.get(template.id)}
                      </span>
                    )}
                    <span className="font-mono text-sm font-semibold leading-tight">
                      {template.label}
                    </span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${CAT_BADGE[template.category]}`}
                    >
                      {template.category}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5  dark:text-slate-100">
                    {getTemplateAreaSqFt(template).toFixed(1)} sq ft
                  </div>
                  {disabled && (
                    <div className="mt-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
                      Too large for stock
                    </div>
                  )}
                  {editingCustomId === template.id && (
                    <div className="mt-1 text-[10px] font-medium text-blue-700">Editing</div>
                  )}
                </div>
                <div className="ml-auto flex flex-col items-end gap-1">
                  {isChecked && (
                    <div className="inline-flex items-center gap-1">
                      <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400">
                        Qty
                      </span>
                      <div className="inline-flex items-center rounded border border-slate-200 dark:border-slate-600">
                        <button
                          type="button"
                          aria-label="Decrease quantity"
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            clearQuantityDraft(template.id)
                            onQuantityChange(template.id, Math.max(1, currentQuantity - 1))
                          }}
                          className="flex h-5 w-5 items-center justify-center text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          aria-label={`Quantity for ${template.label}`}
                          value={quantityValue}
                          onClick={(event) => event.stopPropagation()}
                          onFocus={(event) => {
                            event.stopPropagation()
                            event.currentTarget.select()
                          }}
                          onChange={(event) => {
                            event.stopPropagation()
                            handleQuantityInputChange(template.id, event.currentTarget.value)
                          }}
                          onBlur={(event) => {
                            handleQuantityInputBlur(template.id, event.currentTarget.value)
                          }}
                          onKeyDown={(event) => {
                            event.stopPropagation()
                            if (event.key === "Enter") {
                              event.preventDefault()
                              event.currentTarget.blur()
                            }
                          }}
                          className="h-5 w-11 border-x border-slate-200 bg-transparent p-0 text-center text-xs font-semibold tabular-nums outline-none focus:bg-white focus:ring-1 focus:ring-blue-400 dark:border-slate-600 dark:focus:bg-slate-800"
                        />
                        <button
                          type="button"
                          aria-label="Increase quantity"
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            clearQuantityDraft(template.id)
                            onQuantityChange(
                              template.id,
                              Math.min(MAX_TEMPLATE_QUANTITY, currentQuantity + 1)
                            )
                          }}
                          className="flex h-5 w-5 items-center justify-center text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  )}
                  {template.isCustom && (
                    <>
                      <button
                        type="button"
                        aria-label={`Edit ${template.label}`}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          onEditCustom(template)
                        }}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${template.label}`}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          onRemoveCustom(template.id)
                        }}
                        className="text-[10px] px-1.5 py-0.5 rounded-full font-medium border border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                      >
                        remove
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </label>
        )
      })}
    </div>
  )
}
