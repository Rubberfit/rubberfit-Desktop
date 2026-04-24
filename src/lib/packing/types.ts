// TypeScript mirror of `rf_layout::domain::{PackRequest, PackResult}`
// plus their transitively-referenced types.
//
// These structs are `#[serde(rename_all = "camelCase")]` on the Rust
// side, so the wire format is already camelCase — no serde aliases
// are relied upon here (the Rust types accept a few aliases like
// `kerf`/`spacing` for `clearance` and `demand` for `quantity`, but
// the TypeScript side always emits the canonical camelCase names).
//
// Source of truth: C:/Users/Bing/Documents/GitHub/rema-portal/engine/
// crates/rf-layout/src/domain/{request,result}.rs. When those change,
// these types need to move in lockstep.
//
// Anything marked `unknown` is a field the Rust side passes through
// as `HashMap<String, serde_json::Value>` — refine once the frontend
// UI settles on a specific schema.

export interface Point2D {
  x: number
  y: number
}

export type BinKind = "fresh" | "remnant"

export type UnitSystem = "inch" | "mm"

export interface Bin {
  binId: string
  width: number
  height: number
  kind: BinKind
  priority?: number | null
}

export interface ShapeSpec {
  kind: string
  // Rust side: `HashMap<String, serde_json::Value>`. Frontend agents
  // can refine once individual shape kinds (rectangle / trapezoid /
  // custom polygon) gain typed schemas.
  params: Record<string, unknown>
}

export type GrainAxis = "width" | "length" | "none"

export interface Part {
  shapeId: string
  quantity: number
  polygon: Point2D[]
  shapeSpec?: ShapeSpec | null
  allowRotation: boolean
  grainAxis?: GrainAxis | null
  difficulty?: number | null
}

export interface OperatorProfile {
  skills: string[]
  maxDifficulty: number
}

export type PackMode = "fast" | "balanced" | "thorough"

// See `PackEngine` in rf-layout/src/domain/request.rs. Phase 1 of the
// desktop migration ignores this field (always runs `pack(...)`); kept
// in the wire type so the Rust side still deserialises cleanly if a
// caller sends it.
export type PackEngine = "default" | "lbf" | "legacy"

export interface PackRequest {
  bins: Bin[]
  clearance: number
  items: Part[]
  operatorProfile?: OperatorProfile | null
  mode?: PackMode | null
  engine?: PackEngine | null
  timeBudgetMs?: number | null
  improvementBudgetMs?: number | null
  seed?: number | null
  units?: UnitSystem
}

export interface Placement {
  shapeId: string
  instanceIndex: number
  binId: string
  x: number
  y: number
  rotationRad: number
  polygon: Point2D[]
  width: number
  height: number
  difficulty?: number | null
}

export interface BinResult {
  binId: string
  usedArea: number
  wasteArea: number
  occupiedWidth: number
  occupiedHeight: number
  // Ratio of placed item area to bin stock area, 0..1.
  efficiency: number
  // Invariant: scrapRatio == 1.0 - efficiency (within f64 epsilon).
  scrapRatio: number
}

export interface PackResult {
  placements: Placement[]
  placedCount: number
  overflowCount: number
  perBin: BinResult[]
  totalUsedArea: number
  totalWasteArea: number
  // Workspace-wide utilization, 0..1.
  overallDensity: number
  // Wall-clock time spent packing. Populated by the pack() orchestrator.
  runTimeMs?: number | null
  // True if a caller-provided cancel token flipped mid-run. The Rust
  // side omits this when false (`skip_serializing_if = not`), so
  // undefined is a valid, common case.
  wasCancelled?: boolean
}

/**
 * Progress frame emitted by the Rust engine during streaming mode.
 * Ported from rema-portal's `src/application/packing/types.ts`.
 * Phase-2 desktop: not yet wired to Tauri events, but the type exists
 * so UI code that listens for progress compiles.
 */
export interface PackProgress {
  iteration: number
  elapsedMs: number
  bestPlacedCount: number
  bestActiveStockDensity: number
  phase: "explore" | "compress"
}

/**
 * Thrown when the caller aborts a pack via `AbortSignal`. Ported
 * from rema-portal.
 */
export class PackingAbortedError extends Error {
  constructor(message = "Packing operation was aborted") {
    super(message)
    this.name = "PackingAbortedError"
  }
}

export const PACK_MODE_BUDGETS_MS = {
  fast: 2_000,
  balanced: 10_000,
  thorough: 30_000,
} as const
