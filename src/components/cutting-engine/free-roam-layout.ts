import type { PartTemplate } from "./PresetDimensionSelector"
import type { StockConfig } from "./stock-preview-configurator"
import type { LayoutModel, PlacedPart, RenderShape } from "./layout-model"
import type { ManualPlacement } from "./free-roam-collision"

function templateToRenderShape(template: PartTemplate): RenderShape {
  // Explicit override wins — shape-registry templates set this so
  // new shapes don't need a case in this switch.
  if (template.renderShape) return template.renderShape
  switch (template.partType) {
    case "cylinder":
      return "circle"
    case "cone":
      return "sector"
    case "trapezoid":
      return "trapezoid"
    default:
      return "rect"
  }
}

/**
 * Translate a template-local polygon (bbox anchored at 0, 0) into
 * sheet space at the placement's position + rotation. Mirrors the
 * math in `free-roam-collision.ts` + `free-roam-regions.ts` so all
 * three paths agree on where a part's vertices actually land.
 */
function templatePolygonToSheet(
  template: PartTemplate,
  placement: ManualPlacement,
  width: number,
  height: number
): Array<{ x: number; y: number }> | undefined {
  if (!template.polygon || template.polygon.length < 3) return undefined
  const cx = placement.x + width / 2
  const cy = placement.y + height / 2
  const cos = Math.cos(placement.rotationRad)
  const sin = Math.sin(placement.rotationRad)
  return template.polygon.map((p) => {
    const dx = p.x - width / 2
    const dy = p.y - height / 2
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
  })
}

/**
 * Build the LayoutModel the Konva renderer consumes from the current
 * parts queue + manual placements. Templates are looked up once;
 * placements missing a template (e.g. after template deletion) are
 * skipped rather than throwing — the operator doesn't need a stack
 * trace for a detached placement.
 */
export function buildFreeRoamLayout(
  placements: ManualPlacement[],
  parts: PartTemplate[],
  stock: StockConfig,
  tagByTemplateId: Map<string, string>
): LayoutModel {
  const byId = new Map(parts.map((p) => [p.id, p]))
  let specIndex = 0
  const indexByTemplate = new Map<string, number>()
  const mappedParts: PlacedPart[] = []
  for (const placement of placements) {
    const template = byId.get(placement.templateId)
    if (!template) continue
    if (!indexByTemplate.has(template.id)) {
      indexByTemplate.set(template.id, specIndex++)
    }
    const idx = indexByTemplate.get(template.id) ?? 0
    const width = template.width ?? template.diameter ?? 12
    const height = template.length ?? template.height ?? template.diameter ?? 12
    mappedParts.push({
      id: placement.id,
      shapeId: template.id,
      partNumber: template.partNumber,
      label: tagByTemplateId.get(template.id) ?? template.label,
      renderShape: templateToRenderShape(template),
      specIndex: idx,
      x: placement.x,
      y: placement.y,
      rotationRad: placement.rotationRad,
      width,
      height,
      diameter: template.diameter,
      topWidth: template.topWidth,
      bottomWidth: template.bottomWidth,
      innerRadius: template.innerRadius,
      outerRadius: template.outerRadius,
      arcDegrees: template.arcDegrees,
      polygon: templatePolygonToSheet(template, placement, width, height),
    })
  }
  return {
    sheetWidth: stock.width,
    sheetLength: stock.length,
    parts: mappedParts,
    offcuts: [],
    scrap: [],
    placedCount: mappedParts.length,
    overflowCount: 0,
    usedAreaSqFt: 0,
    reusableAreaSqFt: 0,
    scrapAreaSqFt: 0,
    fabScore: 0,
    source: "ts-nfp",
  }
}
