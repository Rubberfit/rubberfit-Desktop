import { SimpleCutDirection, SimplePartType } from "./nesting-visualizer-types"
import { PartTemplate } from "./preset-template-data"

function getPartLabel(partType: PartTemplate["partType"]) {
  switch (partType) {
    case "circle":
      return "Circle"
    case "cylinder":
      return "Cylinder Wrap"
    case "cone":
      return "Cone Spread"
    case "trapezoid":
      return "Hopper / Transition Panel"
    case "rectangle":
    default:
      return "Rectangle / Strip"
  }
}

function getCutDirectionOptions(partType: PartTemplate["partType"]) {
  switch (partType) {
    case "cone":
      return [
        { value: "radial_split" as const, label: "Radial Panels" },
        { value: "arc_bands" as const, label: "Concentric Bands" },
      ]
    case "cylinder":
      return [
        { value: "wrap_panels" as const, label: "Wrap Panels" },
        { value: "wrap_bands" as const, label: "Horizontal Bands" },
      ]
    case "trapezoid":
      return [
        { value: "vertical_split" as const, label: "Vertical Panels" },
        { value: "horizontal_split" as const, label: "Horizontal Bands" },
      ]
    default:
      return [
        { value: "vertical_split" as const, label: "Vertical Split" },
        { value: "horizontal_split" as const, label: "Horizontal Split" },
      ]
  }
}

function getCutModeTitle(partType: PartTemplate["partType"]) {
  switch (partType) {
    case "cone":
      return "Cone Split Mode"
    case "cylinder":
      return "Wrap Split Mode"
    case "trapezoid":
      return "Panel Split Mode"
    default:
      return "Split Mode"
  }
}

function getCutModeDescription(partType: PartTemplate["partType"]) {
  switch (partType) {
    case "cone":
      return "Choose whether the cone spread is divided into radial panels or concentric arc bands."
    case "cylinder":
      return "Choose whether the wrap is split into vertical wrap panels or horizontal bands."
    case "trapezoid":
      return "Choose whether the tapered panel is split into vertical panels or horizontal bands."
    default:
      return "Choose how the finished profile is broken into smaller cut sections."
  }
}

function getRequestedSqFt(templates: PartTemplate[]) {
  if (templates.length === 0) {
    return 0
  }

  return templates.reduce((total, template) => {
    const qty = template.partType === "rectangle" ? Math.max(1, template.quantity) : 1
    switch (template.partType) {
      case "circle": {
        const radius = (template.diameter ?? 0) / 2
        return total + (Math.PI * radius * radius * qty) / 144
      }
      case "cylinder": {
        const diameter = template.diameter ?? 0
        const height = template.height ?? 0
        return total + (Math.PI * diameter * height * qty) / 144
      }
      case "cone": {
        const innerRadius = template.innerRadius ?? 0
        const outerRadius = template.outerRadius ?? 0
        const arcDegrees = template.arcDegrees ?? 0
        return (
          total + ((arcDegrees / 360) * Math.PI * (outerRadius ** 2 - innerRadius ** 2) * qty) / 144
        )
      }
      case "trapezoid": {
        const topWidth = template.topWidth ?? 0
        const bottomWidth = template.bottomWidth ?? 0
        const height = template.height ?? 0
        return total + (((topWidth + bottomWidth) / 2) * height * qty) / 144
      }
      case "rectangle":
      default:
        return total + ((template.width ?? 0) * (template.length ?? 0) * qty) / 144
    }
  }, 0)
}

function getDefaultCutDirection(partType: PartTemplate["partType"]): SimpleCutDirection {
  switch (partType) {
    case "cone":
      return "radial_split"
    case "cylinder":
      return "wrap_panels"
    case "trapezoid":
      return "vertical_split"
    default:
      return "vertical_split"
  }
}

function parseCutRatios(input: string, count: number) {
  if (count <= 1) {
    return undefined
  }

  const trimmed = input.trim()
  if (!trimmed) {
    return undefined
  }

  const values = trimmed.split(",").map((value) => Number.parseFloat(value.trim()))
  if (values.length !== count || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    return undefined
  }

  return values
}

function parseDimsFromLabel(
  partType: SimplePartType,
  label: string,
  customWidth: number | null,
  customHeight: number | null
): Partial<PartTemplate> {
  if (customWidth != null && customHeight != null) {
    if (partType === "rectangle") return { width: customWidth, length: customHeight }
    if (partType === "cylinder") return { diameter: customWidth, height: customHeight }
    return { width: customWidth, height: customHeight }
  }

  const n = "(\\d+(?:\\.\\d+)?)"

  if (partType === "rectangle") {
    const m = label.match(new RegExp(`${n}["\u2033]?\\s*[×x]\\s*${n}`))
    if (m) return { width: parseFloat(m[1]), length: parseFloat(m[2]) }
  }

  if (partType === "cylinder") {
    const m = label.match(new RegExp(`[Øø]?\\s*${n}["\u2033]?\\s*[×x]\\s*${n}`))
    if (m) return { diameter: parseFloat(m[1]), height: parseFloat(m[2]) }
  }

  if (partType === "cone") {
    const m = label.match(new RegExp(`${n}°.*R${n}["\u2033]?\\s+to\\s+R${n}`))
    if (m)
      return {
        arcDegrees: parseFloat(m[1]),
        innerRadius: parseFloat(m[2]),
        outerRadius: parseFloat(m[3]),
      }
  }

  if (partType === "trapezoid") {
    const m = label.match(new RegExp(`${n}["\u2033]?\\s*/\\s*${n}["\u2033]?\\s*[×x]\\s*${n}`))
    if (m)
      return { topWidth: parseFloat(m[1]), bottomWidth: parseFloat(m[2]), height: parseFloat(m[3]) }
  }

  return {}
}

export {
  getRequestedSqFt,
  getDefaultCutDirection,
  parseCutRatios,
  parseDimsFromLabel,
  getPartLabel,
  getCutDirectionOptions,
  getCutModeTitle,
  getCutModeDescription,
}
