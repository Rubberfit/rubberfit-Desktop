import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { CheckSquare, LayoutGrid, Square } from "lucide-react"

import PresetCustomTemplateForm from "./preset-custom-template-form"
import PresetSelectionSummary from "./preset-selection-summary"
import { PresetTemplateGrid } from "./preset-template-grid"
import { PartTypeSelector } from "./preset-part-type-selector"
import { usePresetState } from "./use-preset-state"
import type { LoadedSelection } from "./use-preset-state"

import type { PartTemplate } from "./preset-template-data"

export type { PartTemplate } from "./preset-template-data"
export { PART_TEMPLATES } from "./preset-template-data"
export type { LoadedSelection } from "./use-preset-state"

interface PresetDimensionSelectorProps {
  onApply?: (templates: PartTemplate[]) => void
  rollWidth?: number
  rollLength?: number
  tagMap?: Map<string, string>
  loadedSelection?: LoadedSelection | null
}

export default function PresetDimensionSelector({
  onApply,
  rollWidth = 96,
  rollLength = 48,
  tagMap,
  loadedSelection,
}: PresetDimensionSelectorProps) {
  const {
    selectedPart,
    checked,
    filter,
    setFilter,
    customDrafts,
    setCustomDrafts,
    editingCustomId,
    setEditingCustomId,
    availableCategories,
    visible,
    selectedTemplates,
    pendingCustomTemplate,
    customTemplateError,
    fitsStock,
    totalArea,
    customDraft,
    selectedPartLabel,
    savedCustomCount,
    quantities,
    selectionCounts,
    handlePartChange,
    handleToggle,
    handleQuantityChange,
    handleSelectAll,
    handleClearAll,
    handleAddCustomSize,
    editCustomTemplate,
    removeCustomTemplate,
  } = usePresetState(onApply, rollWidth, rollLength, loadedSelection)

  return (
    <Card className="w-full shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <LayoutGrid className="h-4 w-4 text-slate-500" />
            Part Selection
          </CardTitle>
          <div className="text-xs text-slate-500">
            Preview stock: {rollWidth}&quot; x {rollLength}&quot;
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        <PartTypeSelector
          selectedPart={selectedPart}
          onPartChange={handlePartChange}
          selectionCounts={selectionCounts}
        />

        <div className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              2. Choose Standard Size
            </div>

            <div className="flex gap-1.5 flex-wrap ">
              {availableCategories.map((category) => (
                <button
                  key={category}
                  type="button"
                  onClick={() => setFilter(category)}
                  className={`px-2.5 py-0.5 rounded-full text-xs font-medium border transition-colors ${
                    filter === category
                      ? "bg-slate-800 text-white border-slate-800 dark:bg-slate-100 dark:text-slate-800 dark:border-slate-100"
                      : "bg-white text-slate-500 border-slate-200 hover:border-slate-400 dark:bg-card dark:text-slate-400 dark:border-slate-700 dark:hover:border-slate-500"
                  }`}
                >
                  {category.charAt(0).toUpperCase() + category.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={handleSelectAll}
              className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
            >
              <CheckSquare className="h-3 w-3" /> Select all
            </button>
            <span className="text-slate-300">|</span>
            <button
              type="button"
              onClick={handleClearAll}
              className="flex items-center gap-1 text-xs text-slate-500 hover:underline"
            >
              <Square className="h-3 w-3" /> Clear
            </button>
          </div>

          <PresetTemplateGrid
            visible={visible}
            checked={checked}
            quantities={quantities}
            editingCustomId={editingCustomId}
            onToggle={handleToggle}
            onQuantityChange={handleQuantityChange}
            onEditCustom={editCustomTemplate}
            onRemoveCustom={removeCustomTemplate}
            tagMap={tagMap}
            fitsStock={fitsStock}
          />

          <PresetCustomTemplateForm
            selectedPart={selectedPart}
            selectedPartLabel={selectedPartLabel}
            customDraft={customDraft as Record<string, string>}
            customDrafts={customDrafts}
            setCustomDrafts={setCustomDrafts}
            savedCustomCount={savedCustomCount}
            editingCustomId={editingCustomId}
            setEditingCustomId={setEditingCustomId}
            pendingCustomTemplate={pendingCustomTemplate}
            customTemplateError={customTemplateError}
            onAddCustomSize={handleAddCustomSize}
          />
        </div>

        <PresetSelectionSummary
          selectedTemplates={selectedTemplates}
          totalArea={totalArea}
          onToggle={handleToggle}
          onRemoveCustom={removeCustomTemplate}
        />
      </CardContent>
    </Card>
  )
}
