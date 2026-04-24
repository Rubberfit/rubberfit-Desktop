import React from "react"
import { Input } from "@/components/ui/input"

import type { PartTemplate, SupportedPartType, CustomPartDrafts } from "./preset-template-data"
import { DEFAULT_CUSTOM_DRAFTS } from "./preset-template-data"

interface CustomFieldDef {
  key: string
  label: string
  placeholder: string
}

function getCustomFields(partType: SupportedPartType): CustomFieldDef[] {
  switch (partType) {
    case "cylinder":
      return [
        { key: "diameter", label: "Diameter", placeholder: "24" },
        { key: "height", label: "Height", placeholder: "40" },
      ]
    case "cone":
      return [
        { key: "innerRadius", label: "Inner Radius", placeholder: "10" },
        { key: "outerRadius", label: "Outer Radius", placeholder: "24" },
        { key: "arcDegrees", label: "Arc Degrees", placeholder: "100" },
      ]
    case "trapezoid":
      return [
        { key: "topWidth", label: "Top Width", placeholder: "24" },
        { key: "bottomWidth", label: "Bottom Width", placeholder: "36" },
        { key: "height", label: "Height", placeholder: "56" },
      ]
    case "rectangle":
    default:
      return [
        { key: "width", label: "Width", placeholder: "24" },
        { key: "length", label: "Length", placeholder: "50" },
      ]
  }
}

interface PresetCustomTemplateFormProps {
  selectedPart: SupportedPartType
  selectedPartLabel: string
  customDraft: Record<string, string>
  customDrafts: CustomPartDrafts
  setCustomDrafts: React.Dispatch<React.SetStateAction<CustomPartDrafts>>
  savedCustomCount: number
  editingCustomId: string | null
  setEditingCustomId: React.Dispatch<React.SetStateAction<string | null>>
  pendingCustomTemplate: PartTemplate | null
  customTemplateError: string | null
  onAddCustomSize: () => void
}

export default function PresetCustomTemplateForm({
  selectedPart,
  selectedPartLabel,
  customDraft,
  customDrafts: _customDrafts,
  setCustomDrafts,
  savedCustomCount,
  editingCustomId,
  setEditingCustomId,
  pendingCustomTemplate,
  customTemplateError,
  onAddCustomSize,
}: PresetCustomTemplateFormProps) {
  const customFields = getCustomFields(selectedPart)

  const updateCustomDraft = (key: string, value: string) => {
    setCustomDrafts((previous) => ({
      ...previous,
      [selectedPart]: {
        ...previous[selectedPart],
        [key]: value,
      },
    }))
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-3 dark:bg-card">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Custom Size
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-300">
            If the standard list does not match the rubber on hand, enter a custom{" "}
            {selectedPartLabel.toLowerCase()} size.
          </div>
          {savedCustomCount > 0 && (
            <div className="mt-1 text-xs text-emerald-700">
              {savedCustomCount} saved custom size{savedCustomCount > 1 ? "s" : ""} for this part
              type.
            </div>
          )}
          {editingCustomId && (
            <div className="mt-1 text-xs text-blue-700">Editing saved custom size.</div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {editingCustomId && (
            <button
              type="button"
              onClick={() => {
                setEditingCustomId(null)
                setCustomDrafts((previous) => ({
                  ...previous,
                  [selectedPart]: DEFAULT_CUSTOM_DRAFTS[selectedPart],
                }))
              }}
              className="rounded-md border px-3 py-1.5 text-xs font-medium transition-colors border-slate-200 bg-white text-slate-600 enabled:hover:border-slate-300 dark:border-slate-700 dark:bg-slate-700/50 dark:text-slate-300"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={onAddCustomSize}
            disabled={!pendingCustomTemplate || customTemplateError !== null}
            className="rounded-md border px-3 py-1.5 text-xs font-medium transition-colors border-slate-200 bg-white text-slate-600 enabled:hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-700/50 dark:text-slate-300"
          >
            {editingCustomId ? "Save Changes" : "Add Custom Size"}
          </button>
        </div>
      </div>

      <div
        className={`grid gap-3 ${customFields.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}
      >
        {customFields.map((field) => (
          <div key={field.key}>
            <label
              htmlFor={`${selectedPart}-${field.key}`}
              className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500"
            >
              {field.label}
            </label>
            <Input
              id={`${selectedPart}-${field.key}`}
              min={0}
              step="0.5"
              type="number"
              value={customDraft[field.key] ?? ""}
              onChange={(event) => updateCustomDraft(field.key, event.target.value)}
              placeholder={field.placeholder}
            />
          </div>
        ))}
      </div>

      {customTemplateError ? (
        <div className="text-xs font-medium text-red-600 dark:text-red-400">
          {customTemplateError}
        </div>
      ) : (
        <div className="text-xs text-slate-500 dark:text-slate-300">
          {pendingCustomTemplate
            ? `${editingCustomId ? "Ready to save" : "Custom size ready to add"}: ${pendingCustomTemplate.label}`
            : selectedPart === "cone"
              ? "Enter inner radius, outer radius, and sweep in degrees. Outer radius must be larger than inner radius."
              : "Enter the part dimensions to add a custom size to the graph."}
        </div>
      )}
    </div>
  )
}
