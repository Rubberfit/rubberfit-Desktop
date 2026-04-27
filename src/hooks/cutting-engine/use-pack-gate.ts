/**
 * Pack-gate state for the cut-planner UI.
 *
 * Before this hook landed, `NestingVisualizer` ran the nesting
 * pipeline on every change to parts / stock / cut-direction. That
 * live-preview feedback loop produced noisy intermediate layouts
 * and tempted operators to commit a cut before the inputs had
 * settled — leading to wasted material.
 *
 * New behavior (ported from the `103-remove-live-loading` branch
 * on main, adapted for rf-engine's Rust packer):
 *
 *   1. On page load + every meaningful input change, the gate is
 *      `idle`. The Graph card shows a "Ready to pack" prompt.
 *   2. Operator presses **Pack**. Gate flips to `packing` for a
 *      minimum display window so the loader is perceivable
 *      (the Rust packer is fast — sometimes too fast for a loader
 *      to register as progress instead of a flash).
 *   3. After the min-display window elapses, gate flips to
 *      `done`. `NestingVisualizer` mounts and computes the
 *      layout from the frozen inputs.
 *   4. Any subsequent change to the tracked inputs invalidates
 *      the gate back to `idle`.
 *
 * The gate intentionally does NOT reach into the packer. It's a
 * purely UI-level concept — the downstream solver is still the
 * same `IPackingService` (Rust via `pack-cli`). We're just
 * deciding **when** to let it run.
 */

import { useCallback, useEffect, useRef, useState } from "react"

export type PackGateStatus = "idle" | "packing" | "done"

/**
 * How long the loader stays on screen after the operator presses
 * Pack, before flipping to `done`. 450ms is long enough to register
 * as a deliberate state change (roughly the eye's motion-
 * detection threshold for a distinct event) but short enough that
 * operators don't feel the UI is artificially slow. Tune here if
 * user testing suggests otherwise.
 */
const MIN_LOADER_MS = 450

export interface UsePackGate {
  status: PackGateStatus
  /** Operator pressed the Pack button — flip to packing → done. */
  requestPack: () => void
  /** An input changed — reset to idle so operator must re-pack. */
  invalidate: () => void
}

export function usePackGate(): UsePackGate {
  const [status, setStatus] = useState<PackGateStatus>("idle")
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Always clear the pending timer on unmount so a navigation
  // during the loader window doesn't try to setState on a dead
  // component.
  useEffect(() => clearTimer, [clearTimer])

  const requestPack = useCallback(() => {
    clearTimer()
    setStatus("packing")
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setStatus("done")
    }, MIN_LOADER_MS)
  }, [clearTimer])

  const invalidate = useCallback(() => {
    clearTimer()
    setStatus("idle")
  }, [clearTimer])

  return { status, requestPack, invalidate }
}
