import { PART_OPTIONS, type SupportedPartType } from "./preset-template-data"
import { getPartIcon } from "./preset-utils"

interface PartTypeSelectorProps {
  selectedPart: SupportedPartType
  onPartChange: (partType: SupportedPartType) => void
  selectionCounts?: Map<string, number>
}

export function PartTypeSelector({
  selectedPart,
  onPartChange,
  selectionCounts,
}: PartTypeSelectorProps) {
  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        1. Choose Part Type
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {PART_OPTIONS.map((part) => {
          const Icon = getPartIcon(part.partType)
          const isSelected = part.partType === selectedPart
          const count = selectionCounts?.get(part.partType) ?? 0

          return (
            <button
              key={part.partType}
              type="button"
              aria-pressed={isSelected}
              aria-label={count > 0 ? `${part.label}, ${count} selected` : part.label}
              onClick={() => onPartChange(part.partType)}
              className={`relative rounded-lg border p-3 text-left transition-all ${
                isSelected
                  ? "border-blue-500 bg-blue-50 text-blue-900 ring-1 ring-blue-200 dark:bg-white/5 dark:text-slate-100"
                  : "border-slate-300 bg-white hover:bg-slate-50 dark:bg-card dark:border-slate-700 dark:hover:bg-slate-700"
              }`}
            >
              {count > 0 && (
                <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-bold text-white">
                  {count}
                </span>
              )}
              <div className="flex items-center gap-2">
                <span
                  className={`flex h-8 w-8 items-center justify-center rounded-full border ${
                    isSelected
                      ? "border-blue-200 bg-blue-200 dark:text-slate-100 dark:bg-card"
                      : "border-slate-100 bg-slate-50 dark:text-slate-100 dark:bg-card"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="font-semibold text-slate-700 dark:text-slate-200">
                  {part.label}
                </span>
              </div>
              <div
                className={`mt-2 text-xs ${isSelected ? "text-blue-700 dark:text-slate-300" : "text-slate-500 dark:text-slate-400 "}`}
              >
                {part.description}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
