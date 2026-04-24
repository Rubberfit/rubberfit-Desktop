// Ported from rema-portal src/application/packing/buildPlacementView.ts.
// Pure TS — no DB, no DI.

import type { Bin, PackRequest, PackResult, ShapeSpec } from "./types"
import type {
  PlacementView,
  PlacementViewItem,
  PlacementViewBin,
  RenderShape,
} from "./placementView"

export function buildPlacementView(result: PackResult, request: PackRequest): PlacementView {
  const partsById = new Map(request.items.map((p) => [p.shapeId, p]))
  const binsFromRequest = new Map<string, Bin>(request.bins.map((b) => [b.binId, b]))
  const binsById = new Map<string, PlacementViewBin>()

  for (const br of result.perBin) {
    const src = binsFromRequest.get(br.binId)
    const dims = src ?? { width: 0, height: 0 }
    binsById.set(br.binId, {
      binId: br.binId,
      width: dims.width,
      height: dims.height,
      items: [],
      usedArea: br.usedArea,
      wasteArea: br.wasteArea,
      occupiedWidth: br.occupiedWidth,
      occupiedHeight: br.occupiedHeight,
      efficiency: br.efficiency,
    })
  }

  const items: PlacementViewItem[] = result.placements.map((p) => {
    const src = partsById.get(p.shapeId)
    const renderShape: RenderShape = renderShapeFor(src?.shapeSpec?.kind)
    const item: PlacementViewItem = {
      shapeId: p.shapeId,
      instanceIndex: p.instanceIndex,
      binId: p.binId,
      x: p.x,
      y: p.y,
      rotationRad: p.rotationRad,
      width: p.width,
      height: p.height,
      polygon: p.polygon,
      shapeSpec: src?.shapeSpec ?? undefined,
      renderShape,
      difficulty: p.difficulty ?? undefined,
    }
    const bin = binsById.get(p.binId)
    if (bin) bin.items.push(item)
    return item
  })

  return {
    items,
    bins: Object.fromEntries(binsById),
    placedCount: result.placedCount,
    overflowCount: result.overflowCount,
    totalUsedArea: result.totalUsedArea,
    totalWasteArea: result.totalWasteArea,
  }
}

function renderShapeFor(kind: ShapeSpec["kind"] | undefined): RenderShape {
  switch (kind) {
    case "rect":
      return "rect"
    case "circle":
      return "circle"
    case "trapezoid":
      return "trapezoid"
    case "sector":
      return "sector"
    case "ngon":
      return "ngon"
    default:
      return "polygon"
  }
}
