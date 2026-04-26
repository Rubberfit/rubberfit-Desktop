// React hook that owns the AutoNest packing call.
//
// Replaces `useNfpOptimizer` (and the synchronous TS NFP greedy
// preview that fed the Konva renderer alongside it). Builds a single
// `PackRequest` from the AutoNest inputs, sends it to the Rust
// `pack_job` Tauri command via `getPackingService()`, and exposes
// the result as a `LayoutModel[]` ready for the visualizer.
//
// Issue #12 — Phase B4 of the AutoNest TS→Rust migration.

import { useEffect, useMemo, useRef, useState } from "react"
import { getPackingService } from "@/lib/packing/service-compat"
import { buildPackRequest } from "@/lib/packing/buildPackRequest"
import type { Bin, ConePackingMode, ConeStrategy, PackRequest, Part } from "@/lib/packing/types"
import type { PartTemplate } from "./preset-template-data"
import type { LayoutModel } from "./layout-model"
import { packResultToLayoutModel } from "./pack-result-to-layout-model"

/**
 * Resolve the cone render strategy from the `?cone=` URL param.
 *
 * Accepted values: `convex-wedge` / `convexWedge` →
 * `"convexWedge"`; `annular-sector` / `annularSector` →
 * `"annularSector"`. Anything else (or no window) → undefined,
 * which the Rust side treats as `AnnularSector` (the default
 * high-fidelity render). See
 * `crates/rf-layout/src/application/cone_strategy.rs`.
 */
function getConeStrategyFromUrl(): ConeStrategy | undefined {
  if (typeof window === "undefined") return undefined
  const v = new URLSearchParams(window.location.search).get("cone")
  if (v === "convex-wedge" || v === "convexWedge") return "convexWedge"
  if (v === "annular-sector" || v === "annularSector") return "annularSector"
  return undefined
}

/**
 * Resolve the cone collision polygon from the `?conePacking=` URL param.
 *
 * Accepted values: `convex-hull` / `convexHull` -> `"convexHull"`;
 * `annular-sector` / `annularSector` -> `"annularSector"`.
 * Anything else (or no window) -> undefined, which Rust treats as
 * `convexHull` to preserve current production behavior.
 */
function getConePackingModeFromUrl(): ConePackingMode | undefined {
  if (typeof window === "undefined") return undefined
  const v = new URLSearchParams(window.location.search).get("conePacking")
  if (v === "convex-hull" || v === "convexHull") return "convexHull"
  if (v === "annular-sector" || v === "annularSector") return "annularSector"
  return undefined
}

export interface UsePackJobInput {
  /** Stock sheet(s) to pack into. Issue multiple bins for multi-sheet. */
  bins: Bin[]
  /** Already-built canonical Parts (output of `buildPart`), with `tag`. */
  parts: Part[]
  /** Kerf / spacing in inches. */
  clearance: number
  /** Templates lookup (by `id` === `Part.shapeId`) for renderShape + part-number metadata. */
  templates: PartTemplate[]
  /** Optional shapeId → tag map (legacy fallback when `Part.tag` isn't set). */
  tagByShapeId?: Map<string, string>
  /**
   * Whether the hook is allowed to run. AutoNest passes `false`
   * before the operator presses Pack so we don't fire the Rust
   * pipeline on every input edit while staging 100+ parts.
   */
  enabled: boolean
  /**
   * Render strategy for cone (sector) shapes. Forwarded to the Rust
   * pack pipeline as `PackRequest.coneStrategy`. When omitted, falls
   * back to the `?cone=convex-wedge|annular-sector` URL param (dev /
   * power-user override), and finally to the Rust default
   * (`annularSector`). See
   * `crates/rf-layout/src/application/cone_strategy.rs`.
   */
  coneStrategy?: ConeStrategy
  /**
   * Collision polygon for cone (sector) shapes. Forwarded as
   * `PackRequest.conePackingMode`; when omitted, falls back to the
   * `?conePacking=convex-hull|annular-sector` URL param, then Rust's
   * default (`convexHull`).
   */
  conePackingMode?: ConePackingMode
}

export interface UsePackJobOutput {
  /** One `LayoutModel` per stock sheet, in request-bin order. `null` until the first successful pack. */
  layouts: LayoutModel[] | null
  isPacking: boolean
  packError: string | null
}

/**
 * Run the Rust `pack_job` against the supplied AutoNest inputs and
 * map the result into `LayoutModel[]` for the Konva renderer.
 *
 * The hook re-runs whenever the canonical request shape changes
 * (bin dims / kind, part list, clearance) AND `enabled` is true.
 * Pending in-flight runs are abandoned (state writes guarded by a
 * mounted flag) when inputs change mid-run.
 */
export function usePackJob({
  bins,
  parts,
  clearance,
  templates,
  tagByShapeId,
  enabled,
  coneStrategy,
  conePackingMode,
}: UsePackJobInput): UsePackJobOutput {
  const [layouts, setLayouts] = useState<LayoutModel[] | null>(null)
  const [isPacking, setIsPacking] = useState(false)
  const [packError, setPackError] = useState<string | null>(null)

  // Stringified key over the canonical request shape — re-runs only
  // when something the Rust side actually cares about changes.
  const requestKey = useMemo(
    () =>
      JSON.stringify({
        bins: bins.map((b) => ({
          id: b.binId,
          w: b.width,
          h: b.height,
          k: b.kind,
        })),
        parts: parts.map((p) => ({
          s: p.shapeId,
          q: p.quantity,
          // Cones ship spec-only (polygon constructed Rust-side); use
          // the spec params as the cache key signal so dimension edits
          // re-run the pack.
          n: p.polygon?.length ?? 0,
          k: p.shapeSpec?.kind ?? null,
          ps: p.shapeSpec?.params ?? null,
          t: p.tag ?? null,
          r: p.allowRotation,
        })),
        clearance,
        coneStrategy: coneStrategy ?? null,
        conePackingMode: conePackingMode ?? null,
      }),
    [bins, parts, clearance, coneStrategy, conePackingMode]
  )

  // Track latest run so a stale resolve doesn't clobber a newer run's
  // result.
  const runIdRef = useRef(0)

  useEffect(() => {
    // Drop any prior pack's state whenever we're disabled or have
    // nothing to pack — without this, AutoNest briefly re-shows the
    // previous shape's layout on the next pack while the Rust call
    // is still in flight.
    if (!enabled || bins.length === 0 || parts.length === 0) {
      runIdRef.current++ // any in-flight resolve becomes stale
      setLayouts(null)
      setIsPacking(false)
      setPackError(null)
      return
    }

    const runId = ++runIdRef.current
    // Clear stale layouts on the LEADING edge so the visualizer
    // shows the "Packing…" header instead of the previous result
    // until the new pack resolves.
    setLayouts(null)
    setIsPacking(true)
    setPackError(null)

    const run = async () => {
      let request: PackRequest
      try {
        request = buildPackRequest({ bins, items: parts, clearance })
      } catch (err) {
        if (runIdRef.current !== runId) return
        setIsPacking(false)
        setPackError((err as Error).message)
        return
      }

      // UI-selected strategy wins; URL param is the dev / power-user
      // override when no UI value is supplied.
      const resolvedConePackingMode = conePackingMode ?? getConePackingModeFromUrl()
      if (resolvedConePackingMode) request.conePackingMode = resolvedConePackingMode

      // Precise annular packing must render the same annular polygon
      // jagua collides on. Otherwise the render-strategy URL remains
      // the dev / power-user override.
      const resolvedConeStrategy =
        resolvedConePackingMode === "annularSector"
          ? "annularSector"
          : (coneStrategy ?? getConeStrategyFromUrl())
      if (resolvedConeStrategy) request.coneStrategy = resolvedConeStrategy

      try {
        const result = await getPackingService().pack(request)
        if (runIdRef.current !== runId) return
        const next = packResultToLayoutModel(result, request, templates, {
          tagByShapeId,
        })
        setLayouts(next)
        setIsPacking(false)
      } catch (err) {
        if (runIdRef.current !== runId) return
        // PackingServerOnlyError is a browser-only short-circuit
        // from the legacy compat shim — treat it as a non-event so
        // the dev overlay stays clean while the Tauri runtime is
        // booting up. Any other error gets surfaced.
        const isServerOnly = err instanceof Error && err.name === "PackingServerOnlyError"
        setPackError(isServerOnly ? null : (err as Error).message)
        setIsPacking(false)
      }
    }

    void run()

    return () => {
      // Bump runId on cleanup so any in-flight resolve is treated
      // as stale.
      runIdRef.current = runId + 1
    }
    // requestKey collapses bins/parts/clearance into one stable
    // dependency; the destructured arrays would change identity on
    // every render even when content is equal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, enabled])

  return { layouts, isPacking, packError }
}
