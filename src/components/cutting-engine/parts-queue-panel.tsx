import { Circle, Plus, Square, Triangle, Minus } from "lucide-react"
import { cn } from "@/lib/utils"
import type { PartTemplate } from "./PresetDimensionSelector"

export type PartsFilter = "all" | "unplaced" | "rect" | "curved"

interface PartsQueuePanelProps {
  parts: PartTemplate[]
  activeFilter: PartsFilter
  onFilterChange: (f: PartsFilter) => void
  /** Per-template placed count, keyed by `template.id`. Defaults to 0. */
  placedCounts?: Record<string, number>
  /**
   * Click handler that adds one instance of the given template to
   * the canvas. When set, each row becomes a clickable button with
   * a + icon. When omitted, rows are non-interactive (Auto-nest
   * surface uses the panel read-only).
   */
  onAddInstance?: (part: PartTemplate) => void
  /**
   * Click handler for the "+ Shape" button in the panel header. When
   * set, the button renders and the operator can pick a shape from
   * the registry (Free-roam). When omitted, the button is hidden
   * (Auto-nest doesn't support ad-hoc shape addition yet).
   */
  onAddShape?: () => void
}

const FILTERS: Array<{ key: PartsFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "unplaced", label: "Unplaced" },
  { key: "rect", label: "Rect" },
  { key: "curved", label: "Curved" },
]

function shapeIcon(partType: string) {
  switch (partType) {
    case "cylinder":
      return <Circle className="h-4 w-4 shrink-0" />
    case "cone":
      return <Triangle className="h-4 w-4 shrink-0" />
    case "trapezoid":
      return <Minus className="h-4 w-4 shrink-0 rotate-12" />
    default:
      return <Square className="h-4 w-4 shrink-0" />
  }
}

function partDims(part: PartTemplate): string {
  if (part.width !== undefined && part.length !== undefined)
    return `${part.width}" × ${part.length}"`
  if (part.diameter !== undefined) return `⌀ ${part.diameter}"`
  if (part.width !== undefined) return `${part.width}" wide`
  return part.label
}

function isCurved(partType: string) {
  return partType === "cylinder" || partType === "cone"
}

function filterParts(parts: PartTemplate[], filter: PartsFilter): PartTemplate[] {
  switch (filter) {
    case "rect":
      return parts.filter((p) => p.partType === "rectangle" || p.partType === "trapezoid")
    case "curved":
      return parts.filter((p) => isCurved(p.partType))
    case "unplaced":
    case "all":
    default:
      return parts
  }
}

export function PartsQueuePanel({
  parts,
  activeFilter,
  onFilterChange,
  placedCounts,
  onAddInstance,
  onAddShape,
}: PartsQueuePanelProps) {
  const totalCount = parts.reduce((sum, p) => sum + p.quantity, 0)
  const visible = filterParts(parts, activeFilter)
  const interactive = typeof onAddInstance === "function"

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 pt-4 pb-2 border-b border-border/40">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold text-foreground">Parts queue</span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground tabular-nums">
              {totalCount} part{totalCount !== 1 ? "s" : ""}
            </span>
            {onAddShape && (
              <button
                type="button"
                onClick={onAddShape}
                className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted/60"
                aria-label="Add shape"
              >
                <Plus className="h-3 w-3" />
                Shape
              </button>
            )}
          </div>
        </div>

        {/* Filter chips */}
        <div className="flex gap-1.5 flex-wrap">
          {FILTERS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => onFilterChange(key)}
              className={cn(
                "rounded-full px-3 py-0.5 text-xs font-medium transition-colors",
                activeFilter === key
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Parts list */}
      <div className="flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            {parts.length === 0
              ? "No parts added yet. Use the selector below to add parts."
              : "No parts match this filter."}
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {visible.map((part) => {
              const placed = placedCounts?.[part.id] ?? 0
              const total = part.quantity
              const allPlaced = placed >= total
              const anyPlaced = placed > 0

              const body = (
                <>
                  <span className="text-muted-foreground">{shapeIcon(part.partType)}</span>
                  <div className="flex-1 min-w-0 text-left">
                    <p className="text-xs font-medium text-foreground truncate">{part.label}</p>
                    <p className="text-[11px] text-muted-foreground truncate">{partDims(part)}</p>
                  </div>
                  <span
                    className={cn(
                      "text-xs tabular-nums font-medium shrink-0",
                      allPlaced
                        ? "text-emerald-600 dark:text-emerald-400"
                        : anyPlaced
                          ? "text-amber-500"
                          : "text-muted-foreground"
                    )}
                  >
                    {placed}/{total}
                  </span>
                  {interactive && (
                    <Plus
                      aria-hidden
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                    />
                  )}
                </>
              )

              return (
                <li key={part.id} className="divide-y-0">
                  {interactive ? (
                    <button
                      type="button"
                      onClick={() => onAddInstance?.(part)}
                      className="group flex w-full items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:outline-none"
                      aria-label={`Add instance of ${part.label}`}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40 transition-colors">
                      {body}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
