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
  /**
   * Pre-built polygon vertices in part-local coords. Optional —
   * when omitted, the Rust pack pipeline materialises the polygon
   * from `shapeSpec` (currently only `kind: "sector"` cones are
   * spec-only; every other shape still ships its polygon from TS
   * via `buildPart`). See `crates/rf-layout/src/application/cone_strategy.rs`.
   */
  polygon?: Point2D[]
  shapeSpec?: ShapeSpec | null
  allowRotation: boolean
  grainAxis?: GrainAxis | null
  difficulty?: number | null
  /**
   * Caller-owned opaque label echoed verbatim onto every `Placement`
   * the Rust pipeline produces for this shape. AutoNest tags
   * placements with the part number ("G2") or a generated letter
   * ("A", "B", "C…"). Rust never inspects, mutates, or fabricates
   * the value — it round-trips a TypeScript-owned string per the
   * architectural decision recorded in the Phase A migration plan.
   */
  tag?: string | null
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

/**
 * Render strategy for cone (sector) shapes. Mirrors
 * `ConeStrategyKind` in `crates/rf-layout/src/application/cone_strategy.rs`.
 *
 * - `convexWedge`: cones display as solid wedges when the pack
 *   polygon is also the convex hull.
 * - `annularSector`: cones display as the real annular crescent
 *   (high-fidelity render of what the operator will cut).
 *
 * Absent -> Rust default (`annularSector`).
 */
export type ConeStrategy = "convexWedge" | "annularSector"

/**
 * Collision polygon for cone (sector) shapes. Mirrors
 * `ConePackingMode` in `crates/rf-layout/src/application/cone_strategy.rs`.
 *
 * - `convexHull`: conservative default; jagua collides against the
 *   convex hull and may expose it as `Placement.packPolygon`.
 * - `annularSector`: opt-in precise mode; jagua collides against the
 *   real concave annular sector so cones can nest into concavities.
 */
export type ConePackingMode = "convexHull" | "annularSector"

/**
 * Post-pack scrap-extraction pipeline. Mirrors `ScrapStrategyKind`
 * in `crates/rf-layout/src/application/scrap_strategy.rs`.
 *
 * - `legacy`: pre-fix behaviour — bin-level Clipper diff plus
 *   inscribed-rect classification only. A/B / rollback path.
 * - `twoSignal`: Free Roam parity — adds per-part
 *   `bbox(polygon) − polygon` shape-trapped crescents on top of the
 *   bin-level diff. Cones, ellipses, ngons, triangles, stars, and
 *   rings render their corner waste explicitly.
 *
 * Absent → Rust default (`twoSignal`).
 */
export type ScrapStrategy = "legacy" | "twoSignal"

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
  coneStrategy?: ConeStrategy
  conePackingMode?: ConePackingMode
  scrapStrategy?: ScrapStrategy
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
  /**
   * Echo of the source `Part.tag` for this `shapeId`. The Rust
   * `application::strategy::run_with_tag_echo` post-processor stamps
   * every produced placement with the source tag. Untagged parts
   * yield untagged placements (`undefined`).
   */
  tag?: string | null
  /**
   * Transformed pack polygon — the surface jagua actually collided
   * on. Populated only when it differs from `polygon` (today: the
   * cone convex-hull overlay in default packing). The visualizer
   * paints this as a translucent overlay so operators can see jagua's
   * "mental model" of the shape. Undefined for shapes where pack
   * polygon == render polygon, including annular-sector cone packing.
   */
  packPolygon?: Point2D[]
}

/**
 * Whether an offcut rectangle meets the reusable-stock thresholds.
 * Mirrors `rf_layout::domain::result::OffcutKind`.
 */
export type OffcutKind = "reusable" | "scrap"

/**
 * One axis-aligned offcut rectangle extracted from a `BinResult`'s
 * `freeRegions` polygons via the Rust inscribed-rect algorithm,
 * classified against the reusable-stock thresholds. AutoNest paints
 * `reusable` in amber and `scrap` in red.
 */
export interface ClassifiedOffcut {
  binId: string
  x: number
  y: number
  width: number
  height: number
  kind: OffcutKind
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
  /**
   * Boolean-difference output: bin polygon minus the union of placed
   * polygons in this bin. CCW-wound, in bin-local coords. AutoNest
   * paints these as scrap polygons for irregular waste regions
   * (cone/trapezoid mixes). Each polygon is a `Point2D[]` — the Rust
   * `Polygon` type serializes transparently as a flat array of
   * `{x, y}`. May be empty when the post-pack extractor hasn't run.
   */
  freeRegions: Point2D[][]
  /**
   * Axis-aligned reusable/scrap rectangles inscribed inside
   * `freeRegions`. May be empty when the post-pack extractor hasn't
   * run.
   */
  offcuts: ClassifiedOffcut[]
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
