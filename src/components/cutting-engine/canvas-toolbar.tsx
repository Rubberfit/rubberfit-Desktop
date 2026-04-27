import { useState } from "react"
import { Grid3x3, Hand, Minus, MousePointer2, Plus, RotateCcw, Ruler } from "lucide-react"
import { cn } from "@/lib/utils"

export type CanvasTool = "select" | "pan" | "measure"
type ToolKey = CanvasTool | "reset"

/** Zoom range + step — matches most CAD surfaces (25 % to 400 %). */
export const ZOOM_MIN = 25
export const ZOOM_MAX = 400
export const ZOOM_STEP = 10

interface CanvasToolbarProps {
  /** Current zoom percentage. Parent owns the state so the renderer
   *  can read the same value. Range: ZOOM_MIN..ZOOM_MAX. */
  zoom: number
  onZoomChange: (zoomPct: number) => void
  /** Reset zoom (+ eventually pan) to the default fit. */
  onResetView?: () => void
  /** Fires when the "+" sheet button is clicked. Wire to a real
   *  multi-sheet handler, or pass an informational callback (e.g.
   *  toast "coming soon") when multi-sheet isn't implemented yet. */
  onAddSheet?: () => void
  /** Current grid visibility. Parent owns the state so the renderer
   *  can read the same value. */
  showGrid: boolean
  onShowGridChange: (visible: boolean) => void
  /** Controlled tool prop. If provided, the toolbar reflects this value
   *  and emits `onToolChange`. Otherwise the toolbar manages its own
   *  local state (uncontrolled). Without wiring the renderer can't
   *  react to Select/Pan/Measure — the buttons would be pure theatre. */
  tool?: CanvasTool
  onToolChange?: (tool: CanvasTool) => void
}

export function CanvasToolbar({
  zoom,
  onZoomChange,
  onResetView,
  onAddSheet,
  showGrid,
  onShowGridChange,
  tool,
  onToolChange,
}: CanvasToolbarProps) {
  const [localTool, setLocalTool] = useState<CanvasTool>("select")
  const activeTool = tool ?? localTool

  const tools: Array<{ key: ToolKey; icon: React.ReactNode; label: string }> = [
    { key: "select", icon: <MousePointer2 className="h-4 w-4" />, label: "Select" },
    { key: "pan", icon: <Hand className="h-4 w-4" />, label: "Pan" },
    { key: "measure", icon: <Ruler className="h-4 w-4" />, label: "Measure" },
    { key: "reset", icon: <RotateCcw className="h-4 w-4" />, label: "Reset view" },
  ]

  const selectTool = (next: CanvasTool) => {
    if (tool === undefined) setLocalTool(next)
    onToolChange?.(next)
  }

  const handleToolClick = (key: ToolKey) => {
    // Reset is a momentary action, not a persistent mode — fire the
    // view reset and revert the active tool to Select.
    if (key === "reset") {
      onResetView?.()
      selectTool("select")
      return
    }
    selectTool(key)
  }

  const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z))
  const handleZoomOut = () => onZoomChange(clampZoom(zoom - ZOOM_STEP))
  const handleZoomIn = () => onZoomChange(clampZoom(zoom + ZOOM_STEP))

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/40 bg-background/80 backdrop-blur-sm">
      {/* Left tool cluster */}
      <div className="flex items-center gap-0.5 rounded-md border border-border/60 p-0.5 bg-muted/40">
        {tools.map(({ key, icon, label }) => (
          <button
            key={key}
            type="button"
            aria-label={label}
            title={label}
            onClick={() => handleToolClick(key)}
            className={cn(
              "rounded p-1.5 transition-colors",
              activeTool === key
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-background/60"
            )}
          >
            {icon}
          </button>
        ))}
      </div>

      {/* Grid toggle */}
      <button
        type="button"
        aria-label="Toggle grid"
        title="Toggle grid"
        onClick={() => onShowGridChange(!showGrid)}
        className={cn(
          "rounded p-1.5 transition-colors border border-border/60",
          showGrid
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:text-foreground bg-muted/40"
        )}
      >
        <Grid3x3 className="h-4 w-4" />
      </button>

      {/* Sheet tabs */}
      <div className="flex items-center gap-0.5 flex-1 overflow-x-auto">
        {["Sheet 01"].map((tab) => (
          <button
            key={tab}
            type="button"
            className="shrink-0 rounded px-2.5 py-1 text-xs font-medium bg-background border border-border/60 text-foreground shadow-sm"
          >
            {tab}
          </button>
        ))}
        <button
          type="button"
          aria-label="Add sheet"
          title="Add sheet"
          onClick={() => onAddSheet?.()}
          className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Zoom cluster */}
      <div className="flex items-center gap-0.5 rounded-md border border-border/60 p-0.5 bg-muted/40 shrink-0">
        <button
          type="button"
          aria-label="Zoom out"
          onClick={handleZoomOut}
          disabled={zoom <= ZOOM_MIN}
          className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <span className="px-2 text-xs tabular-nums text-foreground min-w-[3rem] text-center">
          {Math.round(zoom)}%
        </span>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={handleZoomIn}
          disabled={zoom >= ZOOM_MAX}
          className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
