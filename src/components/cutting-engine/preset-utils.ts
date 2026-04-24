import type { SimplePartType } from "./NestingVisualizer"
import type { CustomPartDrafts, PartTemplate, SupportedPartType } from "./preset-template-data"
import { Shapes, Triangle } from "lucide-react"

import { formatInches } from "./nesting-layout-utils"
export { formatInches }

export function parsePositiveMeasurement(value: string) {
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }

  const parsed = Number.parseFloat(trimmed)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function buildCustomTemplate(
  partType: SupportedPartType,
  drafts: CustomPartDrafts
): PartTemplate | null {
  switch (partType) {
    case "rectangle": {
      const width = parsePositiveMeasurement(drafts.rectangle.width)
      const length = parsePositiveMeasurement(drafts.rectangle.length)
      if (!width || !length) {
        return null
      }

      return {
        id: `custom-rectangle-${width}-${length}`,
        partType,
        label: `${formatInches(width)}" \u00d7 ${formatInches(length)}"`,
        summary: "Custom rectangular cut",
        quantity: 1,
        category: "custom",
        width,
        length,
        isCustom: true,
      }
    }
    case "cylinder": {
      const diameter = parsePositiveMeasurement(drafts.cylinder.diameter)
      const height = parsePositiveMeasurement(drafts.cylinder.height)
      if (!diameter || !height) {
        return null
      }

      return {
        id: `custom-cylinder-${diameter}-${height}`,
        partType,
        label: `\u00d8${formatInches(diameter)}" \u00d7 ${formatInches(height)}"`,
        summary: "Custom cylinder wrap",
        quantity: 1,
        category: "custom",
        diameter,
        height,
        isCustom: true,
      }
    }
    case "cone": {
      const innerRadius = parsePositiveMeasurement(drafts.cone.innerRadius)
      const outerRadius = parsePositiveMeasurement(drafts.cone.outerRadius)
      const arcDegrees = parsePositiveMeasurement(drafts.cone.arcDegrees)
      if (
        !innerRadius ||
        !outerRadius ||
        !arcDegrees ||
        arcDegrees > 320 ||
        outerRadius <= innerRadius
      ) {
        return null
      }

      return {
        id: `custom-cone-${innerRadius}-${outerRadius}-${arcDegrees}`,
        partType,
        label: `${formatInches(arcDegrees)}\u00b0 \u2022 R${formatInches(innerRadius)}" to R${formatInches(outerRadius)}"`,
        summary: "Custom cone/frustum spread",
        quantity: 1,
        category: "custom",
        innerRadius,
        outerRadius,
        arcDegrees,
        isCustom: true,
      }
    }
    case "trapezoid": {
      const topWidth = parsePositiveMeasurement(drafts.trapezoid.topWidth)
      const bottomWidth = parsePositiveMeasurement(drafts.trapezoid.bottomWidth)
      const height = parsePositiveMeasurement(drafts.trapezoid.height)
      if (!topWidth || !bottomWidth || !height) {
        return null
      }

      return {
        id: `custom-trapezoid-${topWidth}-${bottomWidth}-${height}`,
        partType,
        label: `${formatInches(topWidth)}" / ${formatInches(bottomWidth)}" \u00d7 ${formatInches(height)}"`,
        summary: "Custom hopper / transition panel",
        quantity: 1,
        category: "custom",
        topWidth,
        bottomWidth,
        height,
        isCustom: true,
      }
    }
    default:
      return null
  }
}

export function templateToDraft(template: PartTemplate): CustomPartDrafts[SupportedPartType] {
  switch (template.partType) {
    case "cylinder":
      return {
        diameter: template.diameter ? formatInches(template.diameter) : "",
        height: template.height ? formatInches(template.height) : "",
      }
    case "cone":
      return {
        innerRadius: template.innerRadius ? formatInches(template.innerRadius) : "",
        outerRadius: template.outerRadius ? formatInches(template.outerRadius) : "",
        arcDegrees: template.arcDegrees ? formatInches(template.arcDegrees) : "",
      }
    case "trapezoid":
      return {
        topWidth: template.topWidth ? formatInches(template.topWidth) : "",
        bottomWidth: template.bottomWidth ? formatInches(template.bottomWidth) : "",
        height: template.height ? formatInches(template.height) : "",
      }
    case "rectangle":
    default:
      return {
        width: template.width ? formatInches(template.width) : "",
        length: template.length ? formatInches(template.length) : "",
      }
  }
}

export function getPartIcon(partType: SimplePartType) {
  if (partType === "cone" || partType === "trapezoid") return Triangle
  return Shapes
}

/**
 * Compute the axis-aligned bounding box (in inches) of any PartTemplate at
 * its natural orientation. Used to detect shapes that won't fit on the stock
 * before they're added — prevents creating layouts where the part is bigger
 * than the sheet (which would otherwise produce blank previews).
 */
export function getTemplateBoundingBox(template: PartTemplate): { width: number; height: number } {
  switch (template.partType) {
    case "circle": {
      const diameter = template.diameter ?? 0
      return { width: diameter, height: diameter }
    }
    case "cylinder": {
      const diameter = template.diameter ?? 0
      const height = template.height ?? 0
      return { width: Math.PI * diameter, height }
    }
    case "cone": {
      const innerRadius = template.innerRadius ?? 0
      const outerRadius = template.outerRadius ?? 0
      const arcDegrees = template.arcDegrees ?? 0
      const halfArcRad = (arcDegrees * Math.PI) / 360
      // Mirrors the bounds computed in buildPartPreviewItem for sector parts
      const width =
        halfArcRad <= Math.PI / 2 ? 2 * outerRadius * Math.sin(halfArcRad) : 2 * outerRadius
      const height = Math.max(
        outerRadius * (1 - Math.cos(halfArcRad)),
        outerRadius - innerRadius * Math.cos(halfArcRad)
      )
      return { width, height }
    }
    case "trapezoid": {
      const topWidth = template.topWidth ?? 0
      const bottomWidth = template.bottomWidth ?? 0
      const height = template.height ?? 0
      return { width: Math.max(topWidth, bottomWidth), height }
    }
    case "rectangle":
    default:
      return { width: template.width ?? 0, height: template.length ?? 0 }
  }
}

/**
 * Returns true when the template's bounding box fits on the stock in either
 * orientation (axis-aligned or 90° rotated). Small float tolerance accounts
 * for shapes that match stock dimensions exactly.
 */
export function templateFitsStock(
  template: PartTemplate,
  rollWidth: number,
  rollLength: number
): boolean {
  const { width, height } = getTemplateBoundingBox(template)
  const tol = 0.001
  const fitsAsIs = width <= rollWidth + tol && height <= rollLength + tol
  const fitsRotated = height <= rollWidth + tol && width <= rollLength + tol
  return fitsAsIs || fitsRotated
}

export function getTemplateAreaSqFt(template: PartTemplate) {
  switch (template.partType) {
    case "circle": {
      const radius = (template.diameter ?? 0) / 2
      return (Math.PI * radius * radius * template.quantity) / 144
    }
    case "cylinder": {
      const diameter = template.diameter ?? 0
      const height = template.height ?? 0
      return (Math.PI * diameter * height * template.quantity) / 144
    }
    case "cone": {
      const innerRadius = template.innerRadius ?? 0
      const outerRadius = template.outerRadius ?? 0
      const arcDegrees = template.arcDegrees ?? 0
      return (
        ((arcDegrees / 360) * Math.PI * (outerRadius ** 2 - innerRadius ** 2) * template.quantity) /
        144
      )
    }
    case "trapezoid": {
      const topWidth = template.topWidth ?? 0
      const bottomWidth = template.bottomWidth ?? 0
      const height = template.height ?? 0
      return (((topWidth + bottomWidth) / 2) * height * template.quantity) / 144
    }
    case "rectangle":
    default:
      return ((template.width ?? 0) * (template.length ?? 0) * template.quantity) / 144
  }
}
