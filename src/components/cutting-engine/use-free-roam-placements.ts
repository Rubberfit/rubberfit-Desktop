import { useCallback, useEffect, useMemo, useState } from "react"
import type { PartTemplate } from "./PresetDimensionSelector"
import type { StockConfig } from "./stock-preview-configurator"
import { type ManualPlacement, wouldCollide } from "./free-roam-collision"

interface UseFreeRoamPlacementsOptions {
  /**
   * Fires when R is pressed while NO part is selected. Expected to
   * swap stock.width ↔ stock.length so the operator can flip the
   * sheet in place. Placements keep their absolute coordinates — a
   * part that ends up outside the new bounds is the operator's to
   * drag back.
   */
  onRotateSheet?: () => void
}

/**
 * Owns the Free-roam canvas state: placements, selection, and the
 * keyboard shortcuts that operate on the selected placement (R to
 * rotate, Delete/Backspace to remove). Exposed as a hook so the
 * parent shell component stays under the 500-line file cap.
 *
 * When R is pressed with no part selected, falls through to
 * `options.onRotateSheet` so the same key doubles as sheet-rotate.
 */
export function useFreeRoamPlacements(
  parts: PartTemplate[],
  stock: StockConfig,
  options: UseFreeRoamPlacementsOptions = {}
) {
  const { onRotateSheet } = options
  const [placements, setPlacements] = useState<ManualPlacement[]>([])
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null)

  const placedCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const p of placements) {
      counts[p.templateId] = (counts[p.templateId] ?? 0) + 1
    }
    return counts
  }, [placements])

  const handleAddInstance = useCallback(
    (part: PartTemplate) => {
      setPlacements((prev) => [
        ...prev,
        {
          id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          templateId: part.id,
          // Small rightward offset per new instance so back-to-back
          // clicks don't stack invisibly on top of each other.
          x: Math.min(stock.width - 1, prev.length * 2),
          y: 0,
          rotationRad: 0,
        },
      ])
    },
    [stock.width]
  )

  const handlePartDragEnd = useCallback(
    (partId: string, xIn: number, yIn: number) => {
      setPlacements((prev) => {
        const placement = prev.find((p) => p.id === partId)
        if (!placement) return prev
        const template = parts.find((t) => t.id === placement.templateId)
        const rawW = template?.width ?? template?.diameter ?? 12
        const rawH = template?.length ?? template?.height ?? template?.diameter ?? 12

        // Rotation-aware bbox clamp. A 24"×12" rect rotated 90° has a
        // 12"×24" world-axis bbox — using raw template dims would let
        // the rotated part slide past the sheet edge. For a disc
        // (rotation-invariant) cos/sin terms collapse back to
        // (diameter, diameter), so the formula is correct there too.
        const cos = Math.abs(Math.cos(placement.rotationRad))
        const sin = Math.abs(Math.sin(placement.rotationRad))
        const partW = cos * rawW + sin * rawH
        const partH = sin * rawW + cos * rawH

        const SNAP_STEP = 1
        const SNAP_EDGE = 0.25
        const maxX = stock.width - partW
        const maxY = stock.length - partH
        const snapAxis = (v: number, max: number) => {
          if (v < SNAP_EDGE) return 0
          if (v > max - SNAP_EDGE) return Math.max(0, max)
          return Math.round(v / SNAP_STEP) * SNAP_STEP
        }
        const snappedX = Math.max(0, Math.min(maxX, snapAxis(xIn, maxX)))
        const snappedY = Math.max(0, Math.min(maxY, snapAxis(yIn, maxY)))

        if (wouldCollide(placement, snappedX, snappedY, prev, parts)) {
          return prev
        }
        return prev.map((p) => (p.id === partId ? { ...p, x: snappedX, y: snappedY } : p))
      })
    },
    [parts, stock.width, stock.length]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const editable = t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable
      if (editable) return

      // R with a selected part → rotate the part 90° in place.
      // R with nothing selected → rotate the SHEET (swap W ↔ L),
      // delegated to the parent so stock state stays single-source.
      if (e.key === "r" || e.key === "R") {
        e.preventDefault()
        if (selectedPartId != null) {
          setPlacements((prev) =>
            prev.map((p) =>
              p.id === selectedPartId
                ? { ...p, rotationRad: (p.rotationRad + Math.PI / 2) % (Math.PI * 2) }
                : p
            )
          )
        } else {
          onRotateSheet?.()
        }
        return
      }

      // Delete / Backspace remain part-scoped — destructive sheet
      // clears need a deliberate button, not a stray keystroke.
      if (selectedPartId == null) return
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault()
        setPlacements((prev) => prev.filter((p) => p.id !== selectedPartId))
        setSelectedPartId(null)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [selectedPartId, onRotateSheet])

  return {
    placements,
    setPlacements,
    placedCounts,
    selectedPartId,
    setSelectedPartId,
    handleAddInstance,
    handlePartDragEnd,
  }
}
