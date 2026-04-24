import type { ComponentType } from "react"
import {
  Circle as CircleIcon,
  CircleDot,
  Hexagon,
  Square,
  Star as StarIcon,
  Triangle as TriangleIcon,
} from "lucide-react"

import {
  circleToPolygon,
  ellipseToPolygon,
  ngonToPolygon,
  rectToPolygon,
  ringOuterOnlyPolygon,
  starToPolygon,
  triangleToPolygon,
} from "@/nesting/shape-to-polygon"

import type { PartTemplate } from "./preset-template-data"

/**
 * A single shape in the Free-roam shape library. Each definition
 * declares how to prompt for dimensions, how to render an icon in
 * the picker, and how to produce a `PartTemplate` from the collected
 * dimension values.
 *
 * Design decisions:
 *   - One definition per shape, all listed in `SHAPE_REGISTRY`. No
 *     subclassing / inheritance — tldraw-style tagged registry keeps
 *     new shape authoring to a single-file change.
 *   - The `build` function owns the local-coords polygon generation
 *     and sets `renderShape` so the Konva dispatch doesn't need a
 *     case per shape. Shape authors just call the polygon generator
 *     in `nesting/shape-to-polygon.ts`.
 *   - Values are validated at submit time (min 0.25", max 240" per
 *     dimension). Anything outside returns a `FieldError`.
 */
export interface DimensionField {
  /** Key used in the form's dimension-values map. */
  key: string
  /** User-visible label (e.g. "Width", "Outer diameter"). */
  label: string
  /** Unit suffix to render after the input (always "in" today). */
  unit?: string
  /** Default value in inches. */
  defaultValue: number
  /** Minimum allowed value (inclusive). */
  min?: number
  /** Maximum allowed value (inclusive). */
  max?: number
  /** Step for the number input's spinner + keyboard arrows. */
  step?: number
  /** One-line hint shown below the label (optional). */
  hint?: string
}

export interface ShapeDefinition {
  id: string
  label: string
  /** Shown on the picker tile under the icon. One short phrase. */
  summary: string
  icon: ComponentType<{ className?: string }>
  fields: DimensionField[]
  /**
   * Build a ready-to-insert `PartTemplate` from the validated
   * dimension map. The returned template is missing `id`,
   * `quantity`, and `isCustom`; the dialog fills those in.
   */
  build: (dims: Record<string, number>) => Omit<PartTemplate, "id" | "quantity" | "isCustom">
}

// ── Definitions ──────────────────────────────────────────────────────────────

const rectangle: ShapeDefinition = {
  id: "rectangle",
  label: "Rectangle",
  summary: "4-sided, 90° corners",
  icon: Square,
  fields: [
    { key: "width", label: "Width", defaultValue: 24, min: 0.25, max: 240, step: 0.25 },
    { key: "length", label: "Length", defaultValue: 12, min: 0.25, max: 240, step: 0.25 },
  ],
  build: ({ width, length }) => ({
    partType: "rectangle",
    label: `${width}" × ${length}"`,
    summary: "Rectangle",
    category: "custom",
    width,
    length,
    renderShape: "rect",
    polygon: rectToPolygon(width, length),
  }),
}

const square: ShapeDefinition = {
  id: "square",
  label: "Square",
  summary: "Equal-sided rectangle",
  icon: Square,
  fields: [
    { key: "side", label: "Side length", defaultValue: 12, min: 0.25, max: 240, step: 0.25 },
  ],
  build: ({ side }) => ({
    partType: "rectangle",
    label: `${side}" × ${side}"`,
    summary: "Square",
    category: "custom",
    width: side,
    length: side,
    renderShape: "rect",
    polygon: rectToPolygon(side, side),
  }),
}

const circle: ShapeDefinition = {
  id: "circle",
  label: "Circle",
  summary: "Solid disc",
  icon: CircleIcon,
  fields: [
    { key: "diameter", label: "Diameter", defaultValue: 12, min: 0.25, max: 240, step: 0.25 },
  ],
  build: ({ diameter }) => ({
    partType: "cylinder",
    label: `⌀ ${diameter}"`,
    summary: "Disc",
    category: "custom",
    diameter,
    width: diameter,
    length: diameter,
    renderShape: "circle",
    polygon: circleToPolygon(diameter, 24),
  }),
}

const ring: ShapeDefinition = {
  id: "ring",
  label: "Ring",
  summary: "Disc with a hole (annulus)",
  icon: CircleDot,
  fields: [
    {
      key: "outerDiameter",
      label: "Outer diameter",
      defaultValue: 20,
      min: 1,
      max: 240,
      step: 0.25,
    },
    {
      key: "innerDiameter",
      label: "Inner diameter",
      defaultValue: 10,
      min: 0.25,
      max: 239,
      step: 0.25,
      hint: "Must be less than the outer diameter",
    },
  ],
  build: ({ outerDiameter, innerDiameter }) => ({
    partType: "cylinder",
    label: `⌀ ${outerDiameter}" / ${innerDiameter}"`,
    summary: "Ring",
    category: "custom",
    diameter: outerDiameter,
    width: outerDiameter,
    length: outerDiameter,
    innerRadius: innerDiameter / 2,
    outerRadius: outerDiameter / 2,
    renderShape: "ring",
    // Konva's <Ring> primitive renders natively from innerRadius +
    // outerRadius, so the polygon is only used for collision / waste
    // math. Outer boundary alone is sufficient — a hit inside the
    // inner hole still overlaps the part for drag-collision purposes.
    polygon: ringOuterOnlyPolygon(outerDiameter, 48),
  }),
}

const ellipse: ShapeDefinition = {
  id: "ellipse",
  label: "Ellipse",
  summary: "Oval / stretched disc",
  icon: CircleIcon,
  fields: [
    { key: "width", label: "Width", defaultValue: 24, min: 0.5, max: 240, step: 0.25 },
    { key: "length", label: "Length", defaultValue: 12, min: 0.5, max: 240, step: 0.25 },
  ],
  build: ({ width, length }) => ({
    partType: "rectangle",
    label: `Ellipse ${width}" × ${length}"`,
    summary: "Ellipse",
    category: "custom",
    width,
    length,
    renderShape: "ellipse",
    polygon: ellipseToPolygon(width, length, 48),
  }),
}

const triangle: ShapeDefinition = {
  id: "triangle",
  label: "Triangle",
  summary: "Isoceles, apex on top",
  icon: TriangleIcon,
  fields: [
    { key: "baseWidth", label: "Base width", defaultValue: 16, min: 0.5, max: 240, step: 0.25 },
    { key: "height", label: "Height", defaultValue: 14, min: 0.5, max: 240, step: 0.25 },
  ],
  build: ({ baseWidth, height }) => ({
    partType: "rectangle",
    label: `Triangle ${baseWidth}" × ${height}"`,
    summary: "Triangle",
    category: "custom",
    width: baseWidth,
    length: height,
    renderShape: "triangle",
    polygon: triangleToPolygon(baseWidth, height),
  }),
}

const ngon: ShapeDefinition = {
  id: "ngon",
  label: "N-gon",
  summary: "Regular polygon (hex, octagon, …)",
  icon: Hexagon,
  fields: [
    {
      key: "sides",
      label: "Number of sides",
      defaultValue: 6,
      min: 3,
      max: 32,
      step: 1,
      hint: "3 = triangle, 6 = hex, 8 = octagon",
    },
    {
      key: "radius",
      label: "Circumscribed radius",
      defaultValue: 8,
      min: 0.5,
      max: 120,
      step: 0.25,
    },
  ],
  build: ({ sides, radius }) => {
    const poly = ngonToPolygon(sides, radius)
    return {
      partType: "rectangle",
      label: `${Math.round(sides)}-gon ⌀ ${radius * 2}"`,
      summary: "Polygon",
      category: "custom",
      width: radius * 2,
      length: radius * 2,
      renderShape: "ngon",
      polygon: poly,
    }
  },
}

const star: ShapeDefinition = {
  id: "star",
  label: "Star",
  summary: "N-pointed star",
  icon: StarIcon,
  fields: [
    {
      key: "points",
      label: "Points",
      defaultValue: 5,
      min: 3,
      max: 20,
      step: 1,
      hint: "5 = pentagram, 6 = Star of David",
    },
    { key: "outerRadius", label: "Outer radius", defaultValue: 8, min: 0.5, max: 120, step: 0.25 },
    {
      key: "innerRadius",
      label: "Inner radius",
      defaultValue: 3.5,
      min: 0.25,
      max: 120,
      step: 0.25,
      hint: "Must be less than the outer radius",
    },
  ],
  build: ({ points, outerRadius, innerRadius }) => {
    const poly = starToPolygon(points, outerRadius, innerRadius)
    return {
      partType: "rectangle",
      label: `${Math.round(points)}-pt star ⌀ ${outerRadius * 2}"`,
      summary: "Star",
      category: "custom",
      width: outerRadius * 2,
      length: outerRadius * 2,
      renderShape: "star",
      polygon: poly,
    }
  },
}

export const SHAPE_REGISTRY: ReadonlyArray<ShapeDefinition> = [
  rectangle,
  square,
  circle,
  ring,
  ellipse,
  triangle,
  ngon,
  star,
]

export const SHAPE_REGISTRY_BY_ID: ReadonlyMap<string, ShapeDefinition> = new Map(
  SHAPE_REGISTRY.map((s) => [s.id, s])
)

// ── Validation ────────────────────────────────────────────────────────────────

export interface DimensionValidationError {
  field: string
  message: string
}

/**
 * Validate a dimension map against a shape's field schema. Returns
 * the collected errors; an empty array means the values are safe to
 * pass to `shape.build`. Cross-field rules (inner < outer) are
 * checked per-shape after the generic range checks.
 */
export function validateDimensions(
  shape: ShapeDefinition,
  values: Record<string, number>
): DimensionValidationError[] {
  const errs: DimensionValidationError[] = []
  for (const f of shape.fields) {
    const v = values[f.key]
    if (!Number.isFinite(v)) {
      errs.push({ field: f.key, message: `${f.label} is required` })
      continue
    }
    if (f.min != null && v < f.min) {
      errs.push({ field: f.key, message: `${f.label} must be at least ${f.min}"` })
    }
    if (f.max != null && v > f.max) {
      errs.push({ field: f.key, message: `${f.label} must be at most ${f.max}"` })
    }
  }
  // Cross-field constraints — kept concise; grow as needed.
  if (shape.id === "ring") {
    const outer = values.outerDiameter
    const inner = values.innerDiameter
    if (Number.isFinite(outer) && Number.isFinite(inner) && inner >= outer) {
      errs.push({
        field: "innerDiameter",
        message: "Inner diameter must be less than outer diameter",
      })
    }
  }
  if (shape.id === "star") {
    const outer = values.outerRadius
    const inner = values.innerRadius
    if (Number.isFinite(outer) && Number.isFinite(inner) && inner >= outer) {
      errs.push({
        field: "innerRadius",
        message: "Inner radius must be less than outer radius",
      })
    }
  }
  return errs
}
