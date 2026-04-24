import { useCallback, useEffect, useRef, useState } from "react"

export interface DragSnapshot {
  partId: string
  x: number
  y: number
}

/**
 * rAF-throttled drag snapshot for the Free-roam canvas.
 *
 * Konva moves the dragged <Group> itself, so the VISUAL position is
 * correct without any React re-render. We still need the live position
 * for downstream reactive computation (amber / red region classification),
 * but pointer-move events can fire up to the display refresh rate. A
 * Clipper diff every frame would burn CPU on long drags.
 *
 * Contract:
 *   - `onDragMove(id, x, y)` — call on every pointer-move. The latest
 *     value lands in a ref; a single rAF handle reads it, commits to
 *     state, and yields. Multiple moves within a frame coalesce into
 *     one state update.
 *   - `onDragEnd()` — call on drop to cancel any pending rAF and
 *     clear the snapshot, so `regions` falls back to the authoritative
 *     `maximal` recompute on the next render.
 *   - `snapshot` — null when no drag is in flight.
 */
export function useDragSnapshot(): {
  snapshot: DragSnapshot | null
  onDragMove: (partId: string, x: number, y: number) => void
  onDragEnd: () => void
} {
  const [snapshot, setSnapshot] = useState<DragSnapshot | null>(null)
  const pendingRef = useRef<DragSnapshot | null>(null)
  const rafRef = useRef<number | null>(null)

  const onDragMove = useCallback((partId: string, x: number, y: number) => {
    pendingRef.current = { partId, x, y }
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      if (pendingRef.current) setSnapshot(pendingRef.current)
    })
  }, [])

  const onDragEnd = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    pendingRef.current = null
    setSnapshot(null)
  }, [])

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  return { snapshot, onDragMove, onDragEnd }
}
