// STUB: was @/src/infrastructure/models/supabase — desktop has no DB,
// these types are kept so the UI compiles. Field coverage is based on
// what the cutting-engine components actually dereference. If a wave-2
// page agent needs a property that's missing, add it here (and bump
// the comment to reflect the new usage).
//
// Upstream source for reference (snapshot at migration time):
//   C:/Users/Bing/Documents/GitHub/rema-portal/src/infrastructure/
//   models/supabase.ts (re-export of generated DB types).

/**
 * Row from the `cut_history` table. Both auto-nest cuts and manual
 * free-roam cuts get persisted into this table in rema-portal; the
 * desktop app stores cut records locally (json file or sqlite, not
 * yet decided) but the TS shape is the same so the UI stays portable.
 */
export interface CutHistory {
  id: string
  user_id?: string | null
  created_at?: string | null
  updated_at?: string | null
  source?: "auto" | "manual" | null
  // Stock snapshot at the time of the cut.
  stock_width?: number | null
  stock_length?: number | null
  stock_thickness?: number | null
  material?: string | null
  material_type?: string | null
  // Parts/layout blob. Schema loosely mirrors what free-roam-content
  // and the auto-nest visualizer produce; wave-2 agents will pin it
  // down when they wire the persistence surface.
  parts?: unknown
  placements?: unknown
  layouts?: unknown
  metrics?: unknown
  // Aggregate numbers kept alongside the layout for list-view display.
  parts_completed?: number | null
  cut_pieces?: number | null
  material_used_sq_ft?: number | null
  reusable_offcut_sq_ft?: number | null
  scrap_sq_ft?: number | null
  fab_score?: number | null
  // Optional operator profile / notes.
  operator?: string | null
  notes?: string | null
  // PDF URL (rema uploaded to Supabase Storage; desktop will point at
  // a local file path instead).
  pdf_url?: string | null
}

/**
 * Row from the `material_types` table. Used by the stock-preview
 * configurator to populate the material dropdown.
 */
export interface MaterialType {
  id: string
  name: string
  thickness?: number | null
  default_clearance_in?: number | null
  // Default $/sq ft used to seed `costPerSqft` in the stock preview
  // configurator. Optional on the frontend; nullable on the DB side.
  default_cost?: number | null
  // Arbitrary cost / weight / grain metadata — not accessed by the
  // current cutting-engine UI, left as `unknown` for forward compat.
  metadata?: unknown
}

/**
 * Row from the `rolls` table. Referenced indirectly through the
 * deleted roll-loader / cut-loader — kept here for any surviving
 * type references the wave-2 agents may add.
 */
export interface Roll {
  id: string
  material_type_id?: string | null
  width_in?: number | null
  length_in?: number | null
  remaining_length_in?: number | null
  status?: "active" | "depleted" | "reserved" | null
  created_at?: string | null
}

/**
 * Row from the `jobs` / `job_parts` / `job_part_custom_dimensions`
 * family. Only the cosmetic union shape is preserved — desktop has
 * no job queue yet, so this is a forward-compat shim.
 */
export interface JobFullDetail {
  id: string
  name?: string | null
  parts?: Array<{
    id: string
    width_in?: number | null
    length_in?: number | null
    quantity?: number | null
    custom_dimensions?: PartCustomDimensions | null
  }>
}

export interface PartCustomDimensions {
  width_in?: number | null
  length_in?: number | null
  notes?: string | null
}
