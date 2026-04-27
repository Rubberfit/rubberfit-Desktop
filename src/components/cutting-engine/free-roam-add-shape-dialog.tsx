import { useCallback, useMemo, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import type { PartTemplate } from "./preset-template-data"
import { SHAPE_REGISTRY, type ShapeDefinition, validateDimensions } from "./shape-registry"

interface AddShapeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Fires when the operator submits a valid shape. The parent appends
   * the template to the Free-roam parts queue. The dialog closes
   * itself on submit — parents don't need to flip `open`.
   */
  onAdd: (template: PartTemplate) => void
  /** Initial quantity for the created template. Defaults to 1. */
  defaultQuantity?: number
}

/**
 * Two-step shape picker: pick a shape from the grid, enter its
 * dimensions, submit. Matches the CAD-surface add-shape flow —
 * a dialog rather than a side panel so it works identically on
 * touch and desktop without competing with the parts-queue layout.
 */
export function FreeRoamAddShapeDialog({
  open,
  onOpenChange,
  onAdd,
  defaultQuantity = 1,
}: AddShapeDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = useMemo(
    () => SHAPE_REGISTRY.find((s) => s.id === selectedId) ?? null,
    [selectedId]
  )

  // Seed dimension values from each shape's declared defaults the
  // first time a shape is picked. Switching shapes resets the form.
  const [values, setValues] = useState<Record<string, number>>({})
  const handleSelect = useCallback((shape: ShapeDefinition) => {
    setSelectedId(shape.id)
    const seeded: Record<string, number> = {}
    for (const f of shape.fields) seeded[f.key] = f.defaultValue
    setValues(seeded)
  }, [])

  const errors = useMemo(
    () => (selected ? validateDimensions(selected, values) : []),
    [selected, values]
  )
  const errorByField = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of errors) if (!m.has(e.field)) m.set(e.field, e.message)
    return m
  }, [errors])

  const handleClose = useCallback(() => {
    onOpenChange(false)
    // Delay reset so the fade-out animation doesn't show blank fields.
    setTimeout(() => {
      setSelectedId(null)
      setValues({})
    }, 200)
  }, [onOpenChange])

  const handleSubmit = useCallback(() => {
    if (!selected || errors.length > 0) return
    const partial = selected.build(values)
    const template: PartTemplate = {
      ...partial,
      id: `shape-${selected.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      quantity: defaultQuantity,
      isCustom: true,
    }
    onAdd(template)
    handleClose()
  }, [defaultQuantity, errors.length, handleClose, onAdd, selected, values])

  // Route every close path (overlay click, Escape, X button) through
  // handleClose so the delayed form reset always runs. Passing
  // `onOpenChange` directly bypasses handleClose on overlay / escape.
  const handleDialogOpenChange = (next: boolean) => {
    if (next) onOpenChange(true)
    else handleClose()
  }

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Add shape</DialogTitle>
          <DialogDescription>
            {selected
              ? `Configure dimensions for ${selected.label.toLowerCase()}.`
              : "Pick a shape, then enter dimensions in inches."}
          </DialogDescription>
        </DialogHeader>

        {!selected ? (
          <div className="grid grid-cols-4 gap-2 py-2">
            {SHAPE_REGISTRY.map((shape) => {
              const Icon = shape.icon
              return (
                <button
                  key={shape.id}
                  type="button"
                  onClick={() => handleSelect(shape)}
                  className="flex flex-col items-center gap-1.5 rounded-md border border-border p-3 text-left transition-colors hover:border-foreground/40 hover:bg-muted/40"
                >
                  <Icon className="h-6 w-6 text-foreground" />
                  <span className="text-xs font-medium text-foreground">{shape.label}</span>
                  <span className="text-[10px] leading-tight text-muted-foreground text-center line-clamp-2">
                    {shape.summary}
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              ← Back to shapes
            </button>
            <div className="grid grid-cols-2 gap-3">
              {selected.fields.map((field) => {
                const err = errorByField.get(field.key)
                const id = `add-shape-${field.key}`
                return (
                  <div key={field.key} className="space-y-1">
                    <Label htmlFor={id} className="text-xs">
                      {field.label}
                      {field.unit ? ` (${field.unit})` : " (in)"}
                    </Label>
                    <Input
                      id={id}
                      type="number"
                      inputMode="decimal"
                      min={field.min}
                      max={field.max}
                      step={field.step ?? 0.25}
                      value={values[field.key] ?? ""}
                      onChange={(e) => {
                        const parsed = Number(e.target.value)
                        setValues((prev) => ({
                          ...prev,
                          [field.key]: Number.isFinite(parsed) ? parsed : NaN,
                        }))
                      }}
                      className={cn("h-8 text-sm", err && "border-destructive")}
                    />
                    {field.hint && !err && (
                      <p className="text-[10px] text-muted-foreground">{field.hint}</p>
                    )}
                    {err && <p className="text-[10px] text-destructive">{err}</p>}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          {selected && (
            <Button type="button" onClick={handleSubmit} disabled={errors.length > 0}>
              Add to queue
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
