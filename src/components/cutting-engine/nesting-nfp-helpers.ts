// NFP integration helpers for NestingVisualizer

import {
  rectToPolygon,
  circleToPolygon,
  trapezoidToPolygon,
  sectorToPolygon,
} from "@/nesting/shape-to-polygon"
import type { NestingPart, NestingResult, Placement2D } from "@/nesting/types"
import type { SimplePartSpec, SimpleCutDirection, PreviewItem } from "./nesting-visualizer-types"
import { formatInches, normalizeCutRatios, isCylinderPanelSplit } from "./nesting-layout-utils"
import { buildConeSplitSections, buildTrapezoidSplitSections } from "./nesting-preview-builders"

function buildCircleParts(
  spec: SimplePartSpec,
  id: string,
  qty: number,
  fallbackW: number,
  index: number
): NestingPart[] {
  const d = spec.diameter ?? fallbackW
  return [
    {
      id,
      polygon: { id, points: circleToPolygon(d) },
      quantity: qty,
      sourceSpecIndex: index,
      pieceIndex: 0,
      piecesPerUnit: 1,
      renderShape: "circle",
      originalSpec: { diameter: d, label: `\u00D8${formatInches(d)}"` },
    },
  ]
}

function buildCylinderParts(
  spec: SimplePartSpec,
  id: string,
  qty: number,
  fallbackW: number,
  fallbackH: number,
  index: number
): NestingPart[] {
  const circumference = spec.diameter ? Math.PI * spec.diameter : fallbackW
  const h = spec.height ?? fallbackH
  if (qty > 1) {
    const ratios = normalizeCutRatios(spec.cutRatios, qty)
    return ratios.map((ratio, pieceIndex) => {
      const pieceWidth = isCylinderPanelSplit(spec.cutDirection)
        ? circumference * ratio
        : circumference
      const pieceHeight = isCylinderPanelSplit(spec.cutDirection) ? h : h * ratio
      const pieceId = `${id}-piece-${pieceIndex}`
      return {
        id: pieceId,
        polygon: { id: pieceId, points: rectToPolygon(pieceWidth, pieceHeight) },
        quantity: 1,
        sourceSpecIndex: index,
        pieceIndex,
        piecesPerUnit: qty,
        renderShape: "rect",
        originalSpec: {
          width: pieceWidth,
          height: pieceHeight,
          cutDirection: spec.cutDirection,
          label: `${formatInches(pieceWidth)}" \u00D7 ${formatInches(pieceHeight)}"`,
        },
      }
    })
  }

  return [
    {
      id,
      polygon: { id, points: rectToPolygon(circumference, h) },
      quantity: qty,
      sourceSpecIndex: index,
      pieceIndex: 0,
      piecesPerUnit: 1,
      renderShape: "rect",
      originalSpec: {
        width: circumference,
        height: h,
        label: `${formatInches(circumference)}" \u00D7 ${formatInches(h)}"`,
      },
    },
  ]
}

function buildConeParts(
  spec: SimplePartSpec,
  id: string,
  qty: number,
  fallbackW: number,
  fallbackH: number,
  index: number
): NestingPart[] {
  const innerR = spec.innerRadius ?? Math.max(1, fallbackW / 2)
  const outerR = spec.outerRadius ?? Math.max(2, fallbackH)
  const arc = spec.arcDegrees ?? 120
  if (qty > 1) {
    const split = buildConeSplitSections(
      innerR,
      outerR,
      arc,
      spec.cutDirection ?? "radial_split",
      spec.cutRatios,
      qty
    )
    return split.sections.map((section, pieceIndex) => {
      const pieceId = `${id}-piece-${pieceIndex}`
      return {
        id: pieceId,
        polygon: {
          id: pieceId,
          points: sectorToPolygon(
            section.item.innerRadius ?? innerR,
            section.item.outerRadius ?? outerR,
            section.item.arcDegrees ?? arc
          ),
        },
        quantity: 1,
        sourceSpecIndex: index,
        pieceIndex,
        piecesPerUnit: qty,
        renderShape: "sector",
        originalSpec: {
          innerRadius: section.item.innerRadius ?? innerR,
          outerRadius: section.item.outerRadius ?? outerR,
          arcDegrees: section.item.arcDegrees ?? arc,
          cutDirection: section.item.cutDirection,
          label: section.label,
        },
      }
    })
  }

  return [
    {
      id,
      polygon: { id, points: sectorToPolygon(innerR, outerR, arc) },
      quantity: qty,
      sourceSpecIndex: index,
      pieceIndex: 0,
      piecesPerUnit: 1,
      renderShape: "sector",
      originalSpec: {
        innerRadius: innerR,
        outerRadius: outerR,
        arcDegrees: arc,
        label: `${Math.round(arc)}\u00B0 sector`,
      },
    },
  ]
}

function buildTrapezoidParts(
  spec: SimplePartSpec,
  id: string,
  qty: number,
  fallbackW: number,
  fallbackH: number,
  index: number
): NestingPart[] {
  const topW = spec.topWidth ?? fallbackW
  const botW = spec.bottomWidth ?? fallbackW
  const h = spec.height ?? fallbackH
  if (qty > 1) {
    const split = buildTrapezoidSplitSections(
      topW,
      botW,
      h,
      spec.cutDirection ?? "vertical_split",
      spec.cutRatios,
      qty
    )
    return split.sections.map((section, pieceIndex) => {
      const pieceId = `${id}-piece-${pieceIndex}`
      return {
        id: pieceId,
        polygon: {
          id: pieceId,
          points: trapezoidToPolygon(
            section.item.topWidth ?? topW,
            section.item.bottomWidth ?? botW,
            section.item.height
          ),
        },
        quantity: 1,
        sourceSpecIndex: index,
        pieceIndex,
        piecesPerUnit: qty,
        renderShape: "trapezoid",
        originalSpec: {
          topWidth: section.item.topWidth ?? topW,
          bottomWidth: section.item.bottomWidth ?? botW,
          height: section.item.height,
          cutDirection: section.item.cutDirection,
          label: section.label,
        },
      }
    })
  }

  return [
    {
      id,
      polygon: { id, points: trapezoidToPolygon(topW, botW, h) },
      quantity: qty,
      sourceSpecIndex: index,
      pieceIndex: 0,
      piecesPerUnit: 1,
      renderShape: "trapezoid",
      originalSpec: {
        topWidth: topW,
        bottomWidth: botW,
        height: h,
        label: `${formatInches(topW)}"/${formatInches(botW)}"`,
      },
    },
  ]
}

function buildRectParts(
  spec: SimplePartSpec,
  id: string,
  qty: number,
  fallbackW: number,
  fallbackH: number,
  index: number
): NestingPart[] {
  const w = spec.width ?? fallbackW
  const h = spec.length ?? fallbackH
  return [
    {
      id,
      polygon: { id, points: rectToPolygon(w, h) },
      quantity: qty,
      sourceSpecIndex: index,
      pieceIndex: 0,
      piecesPerUnit: 1,
      renderShape: "rect",
      originalSpec: { width: w, height: h, label: `${formatInches(w)}"\u00D7${formatInches(h)}"` },
    },
  ]
}

export function simplePartToNestingParts(
  spec: SimplePartSpec,
  fallbackW: number,
  fallbackH: number,
  index: number
): NestingPart[] {
  const id = `part-${index}`
  const qty = Math.max(1, spec.quantity || 1)

  switch (spec.partType) {
    case "circle":
      return buildCircleParts(spec, id, qty, fallbackW, index)
    case "cylinder":
      return buildCylinderParts(spec, id, qty, fallbackW, fallbackH, index)
    case "cone":
      return buildConeParts(spec, id, qty, fallbackW, fallbackH, index)
    case "trapezoid":
      return buildTrapezoidParts(spec, id, qty, fallbackW, fallbackH, index)
    case "rectangle":
    default:
      return buildRectParts(spec, id, qty, fallbackW, fallbackH, index)
  }
}

function applyCircleFields(
  base: PreviewItem,
  np: NestingPart,
  spec: SimplePartSpec,
  fallbackW: number
) {
  base.diameter = spec?.diameter ?? fallbackW
  base.label = (np?.originalSpec.label as string) ?? `\u00D8${formatInches(base.diameter)}"`
}

function applySectorFields(base: PreviewItem, np: NestingPart) {
  base.innerRadius = (np.originalSpec.innerRadius as number) ?? 0
  base.outerRadius = (np.originalSpec.outerRadius as number) ?? 0
  base.arcDegrees = (np.originalSpec.arcDegrees as number) ?? 120
  base.cutDirection = np.originalSpec.cutDirection as SimpleCutDirection | undefined
  base.label = (np.originalSpec.label as string) ?? `${base.arcDegrees}\u00B0 sector`
}

function applyRectFields(base: PreviewItem, np: NestingPart, p: Placement2D) {
  base.cutDirection = np.originalSpec.cutDirection as SimpleCutDirection | undefined
  base.label =
    (np.originalSpec.label as string) ?? `${formatInches(p.width)}"\u00D7${formatInches(p.height)}"`
}

export function nestingResultToPreviewItems(
  result: NestingResult,
  parts: NestingPart[],
  specs: SimplePartSpec[],
  fallbackW: number,
  _fallbackH: number
): PreviewItem[] {
  const partsById = new Map(parts.map((part) => [part.id, part]))
  return result.placements.map((p) => {
    const partIdBase = p.partId.replace(/-\d+$/, "")
    const np = partsById.get(p.partId) ?? partsById.get(partIdBase) ?? parts[0]
    const safeIndex = np?.sourceSpecIndex ?? 0
    const spec = specs[safeIndex] ?? specs[0]
    const rs = np?.renderShape ?? "rect"

    const base: PreviewItem = {
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      flipped: p.flipped,
      rotation: p.rotation,
      placedPolygon: p.placedPolygon,
      renderShape:
        rs === "circle"
          ? "circle"
          : rs === "sector"
            ? "sector"
            : rs === "trapezoid"
              ? "trapezoid"
              : "rect",
      label: "",
    }

    if (rs === "circle") {
      applyCircleFields(base, np, spec, fallbackW)
    } else if (rs === "sector") {
      applySectorFields(base, np)
    } else if (rs !== "trapezoid") {
      applyRectFields(base, np, p)
    }

    return base
  })
}
