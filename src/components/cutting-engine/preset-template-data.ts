import type { SimplePartType } from "./NestingVisualizer"
import type { RenderShape } from "./layout-model"
import type { Point2D } from "@/nesting/types"
import {
  CYLINDER_TEMPLATES,
  CONE_TEMPLATES,
  TRAPEZOID_TEMPLATES,
} from "./preset-template-data-shapes"

type TemplateCategory = "standard" | "large" | "narrow" | "custom"
type SupportedPartType = Exclude<SimplePartType, "circle">

export type { TemplateCategory, SupportedPartType }

export interface PartTemplate {
  id: string
  partType: SimplePartType
  label: string
  summary: string
  quantity: number
  category: TemplateCategory
  width?: number
  length?: number
  diameter?: number
  height?: number
  topWidth?: number
  bottomWidth?: number
  innerRadius?: number
  outerRadius?: number
  arcDegrees?: number
  isCustom?: boolean
  partNumber?: string
  /**
   * Optional renderer override, used by Free-roam's shape library.
   * When present, the canvas uses this instead of deriving a shape
   * family from `partType`. Existing Auto-nest templates leave this
   * undefined and continue to dispatch off `partType`.
   */
  renderShape?: RenderShape
  /**
   * Optional local-coords polygon (bbox anchored at 0, 0). Shape
   * library templates (triangle, n-gon, star, ring, ellipse, etc.)
   * populate this so Free-roam's collision / waste / render paths
   * don't need a partType case for every new shape. Ignored by the
   * Auto-nest pipeline.
   */
  polygon?: Point2D[]
}

export type RectangleDraft = { width: string; length: string }
export type CylinderDraft = { diameter: string; height: string }
export type ConeDraft = { innerRadius: string; outerRadius: string; arcDegrees: string }
export type TrapezoidDraft = { topWidth: string; bottomWidth: string; height: string }

export type CustomPartDrafts = {
  rectangle: RectangleDraft
  cylinder: CylinderDraft
  cone: ConeDraft
  trapezoid: TrapezoidDraft
}

export type CustomTemplateMap = Record<SupportedPartType, PartTemplate[]>

export const PART_OPTIONS: Array<{
  partType: SupportedPartType
  label: string
  description: string
}> = [
  {
    partType: "rectangle",
    label: "Rectangles / Strips",
    description: "Flat pads, strips, and standard rectangular cuts.",
  },
  {
    partType: "cylinder",
    label: "Cylinder Wraps",
    description: "Cylindrical wraps and liner bodies.",
  },
  {
    partType: "cone",
    label: "Cone Spreads",
    description: "Flattened cone/frustum profiles.",
  },
  {
    partType: "trapezoid",
    label: "Hopper / Transition Panels",
    description: "Trapezoids and transition-panel layouts.",
  },
]

const RECTANGLE_TEMPLATES: PartTemplate[] = [
  {
    id: "rect-18x14",
    partType: "rectangle",
    label: '18" \u00d7 14"',
    summary: "Standard cut preset",
    quantity: 1,
    category: "standard",
    width: 18,
    length: 14,
  },
  {
    id: "rect-24x50",
    partType: "rectangle",
    label: '24" \u00d7 50"',
    summary: "Large cut preset",
    quantity: 1,
    category: "large",
    width: 24,
    length: 50,
  },
  {
    id: "rect-11-5x50",
    partType: "rectangle",
    label: '11\u00bd" \u00d7 50"',
    summary: "Narrow cut preset",
    quantity: 1,
    category: "narrow",
    width: 11.5,
    length: 50,
  },
  {
    id: "rect-24x14",
    partType: "rectangle",
    label: '24" \u00d7 14"',
    summary: "Standard cut preset",
    quantity: 1,
    category: "standard",
    width: 24,
    length: 14,
  },
  {
    id: "rect-24x40",
    partType: "rectangle",
    label: '24" \u00d7 40"',
    summary: "Large cut preset",
    quantity: 1,
    category: "large",
    width: 24,
    length: 40,
  },
  {
    id: "rect-12x24",
    partType: "rectangle",
    label: '12" \u00d7 24"',
    summary: "Standard cut preset",
    quantity: 1,
    category: "standard",
    width: 12,
    length: 24,
  },
  {
    id: "rect-11-5x40",
    partType: "rectangle",
    label: '11\u00bd" \u00d7 40"',
    summary: "Narrow cut preset",
    quantity: 1,
    category: "narrow",
    width: 11.5,
    length: 40,
  },
  {
    id: "rect-11-5x12",
    partType: "rectangle",
    label: '11\u00bd" \u00d7 12"',
    summary: "Narrow cut preset",
    quantity: 1,
    category: "narrow",
    width: 11.5,
    length: 12,
  },
  {
    id: "rect-56x12",
    partType: "rectangle",
    label: '56" \u00d7 12"',
    summary: "Large cut preset",
    quantity: 1,
    category: "large",
    width: 56,
    length: 12,
  },
  {
    id: "rect-12x11-5",
    partType: "rectangle",
    label: '12" \u00d7 11\u00bd"',
    summary: "Narrow cut preset",
    quantity: 1,
    category: "narrow",
    width: 12,
    length: 11.5,
  },
  {
    id: "rect-72x12",
    partType: "rectangle",
    label: '72" \u00d7 12"',
    summary: "Large cut preset",
    quantity: 1,
    category: "large",
    width: 72,
    length: 12,
  },
  {
    id: "rect-38x24",
    partType: "rectangle",
    label: '38" \u00d7 24"',
    summary: "Large cut preset",
    quantity: 1,
    category: "large",
    width: 38,
    length: 24,
  },
  {
    id: "rect-11-5x38",
    partType: "rectangle",
    label: '11\u00bd" \u00d7 38"',
    summary: "Narrow cut preset",
    quantity: 1,
    category: "narrow",
    width: 11.5,
    length: 38,
  },
  {
    id: "rect-48x24",
    partType: "rectangle",
    label: '48" \u00d7 24"',
    summary: "Large cut preset",
    quantity: 1,
    category: "large",
    width: 48,
    length: 24,
  },
  {
    id: "rect-40x12",
    partType: "rectangle",
    label: '40" \u00d7 12"',
    summary: "Large cut preset",
    quantity: 1,
    category: "large",
    width: 40,
    length: 12,
  },
  {
    id: "rect-48x11-5",
    partType: "rectangle",
    label: '48" \u00d7 11\u00bd"',
    summary: "Narrow cut preset",
    quantity: 1,
    category: "narrow",
    width: 48,
    length: 11.5,
  },
  {
    id: "rect-38x12",
    partType: "rectangle",
    label: '38" \u00d7 12"',
    summary: "Large cut preset",
    quantity: 1,
    category: "large",
    width: 38,
    length: 12,
  },
]

export const PART_TEMPLATES: PartTemplate[] = [
  ...RECTANGLE_TEMPLATES,
  ...CYLINDER_TEMPLATES,
  ...CONE_TEMPLATES,
  ...TRAPEZOID_TEMPLATES,
]

export const CAT_CARD: Record<TemplateCategory, string> = {
  standard: "bg-blue-50 border-blue-200 text-blue-800",
  large: "bg-purple-50 border-purple-200 text-purple-800",
  narrow: "bg-amber-50 border-amber-200 text-amber-800",
  custom: "bg-emerald-50 border-emerald-200 text-emerald-800",
}

export const CAT_BADGE: Record<TemplateCategory, string> = {
  standard: "bg-blue-100 text-blue-700",
  large: "bg-purple-100 text-purple-700",
  narrow: "bg-amber-100 text-amber-700",
  custom: "bg-emerald-100 text-emerald-700",
}

export const DEFAULT_CUSTOM_DRAFTS: CustomPartDrafts = {
  rectangle: { width: "", length: "" },
  cylinder: { diameter: "", height: "" },
  cone: { innerRadius: "", outerRadius: "", arcDegrees: "" },
  trapezoid: { topWidth: "", bottomWidth: "", height: "" },
}

export const EMPTY_CUSTOM_TEMPLATES: CustomTemplateMap = {
  rectangle: [],
  cylinder: [],
  cone: [],
  trapezoid: [],
}

export const CUSTOM_TEMPLATE_STORAGE_KEY = "rubberfit.cut-planner.custom-templates.v1"
export const LEGACY_CUSTOM_TEMPLATE_STORAGE_KEY = "rema-portal.cut-planner.custom-templates.v1"
