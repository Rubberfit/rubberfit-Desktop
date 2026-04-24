import { Badge } from "@/components/ui/badge"
import { Scissors } from "lucide-react"

import type { PartTemplate } from "./preset-template-data"
import { CAT_CARD, CAT_BADGE } from "./preset-template-data"
import { getTemplateAreaSqFt } from "./preset-utils"

interface PresetSelectionSummaryProps {
  selectedTemplates: PartTemplate[]
  totalArea: number
  onToggle: (templateId: string) => void
  onRemoveCustom: (templateId: string) => void
}

export default function PresetSelectionSummary({
  selectedTemplates,
  totalArea,
  onToggle,
  onRemoveCustom,
}: PresetSelectionSummaryProps) {
  if (selectedTemplates.length === 0) {
    return null
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-3 dark:bg-card">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Scissors className="h-4 w-4 text-slate-500 dark:text-slate-200" />
          <span className="text-sm font-medium text-slate-700 dark:text-slate-100">
            {selectedTemplates.length} size{selectedTemplates.length > 1 ? "s" : ""} selected
          </span>
          <Badge variant="outline" className="text-xs">
            {totalArea.toFixed(2)} sq ft total
          </Badge>
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-100">
          The graph stacks the selected sizes in the preview.
        </div>
      </div>

      <div className="flex gap-1.5 flex-wrap">
        {selectedTemplates.map((template) => (
          <button
            type="button"
            key={template.id}
            onClick={() => {
              if (template.isCustom) {
                onRemoveCustom(template.id)
              } else {
                onToggle(template.id)
              }
            }}
            aria-label={`Remove ${template.label}`}
            className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-mono font-medium cursor-pointer border transition-colors hover:opacity-75 ${CAT_CARD[template.category]}`}
          >
            {template.label}
            <span className="ml-0.5 opacity-50">&times;</span>
          </button>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="text-left py-1 pr-3 font-semibold text-slate-600 dark:text-slate-100">
                Dimensions
              </th>
              <th className="text-right py-1 font-semibold text-slate-600 dark:text-slate-100">
                Sq ft each
              </th>
            </tr>
          </thead>
          <tbody>
            {selectedTemplates.map((template) => (
              <tr key={template.id} className="border-b border-slate-100 last:border-0">
                <td className="py-1 pr-3 font-mono font-semibold text-slate-800 dark:text-slate-200">
                  <span className="inline-flex items-center gap-1.5">
                    {template.label}
                    {template.isCustom && (
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${CAT_BADGE.custom}`}
                      >
                        custom
                      </span>
                    )}
                  </span>
                </td>
                <td className="py-1 text-right text-slate-600 dark:text-slate-100">
                  {getTemplateAreaSqFt(template).toFixed(2)}
                </td>
              </tr>
            ))}
            <tr className="bg-slate-100 dark:bg-slate-950">
              <td className="py-1 pr-3 font-semibold text-slate-700 dark:text-slate-100">Total</td>
              <td className="py-1 text-right font-semibold text-slate-700 dark:text-slate-100">
                {totalArea.toFixed(2)} sq ft
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
