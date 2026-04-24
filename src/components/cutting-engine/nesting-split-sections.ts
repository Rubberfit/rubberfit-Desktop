// Cone and trapezoid split section builders
// Split from nesting-preview-builders.ts to stay under the max-lines limit

import type { PreviewItem, PreviewSection, SimpleCutDirection } from "./nesting-visualizer-types"
import {
  formatInches,
  normalizeCutRatios,
  buildCutBreakpoints,
  lerp,
  isConeRadialSplit,
  isTrapezoidVerticalSplit,
} from "./nesting-layout-utils"

export function buildConeSplitSections(
  innerRadius: number,
  outerRadius: number,
  arcDegrees: number,
  cutDirection: SimpleCutDirection,
  cutRatios: number[] | undefined,
  requestedCutSections: number
): {
  profileItem: PreviewItem
  sections: PreviewSection[]
  cutBreakpoints: number[]
  cutLabels: string[]
} {
  const ratios = normalizeCutRatios(cutRatios, requestedCutSections)
  const cutBreakpoints = buildCutBreakpoints(ratios)
  const bounds = [0, ...cutBreakpoints, 1]
  const safeInnerRadius = Math.max(0, innerRadius)
  const safeOuterRadius = Math.max(safeInnerRadius, outerRadius)
  const safeArcDegrees = Math.min(320, Math.max(20, arcDegrees))
  const fullHalfArcRad = (safeArcDegrees * Math.PI) / 360
  const profileItem: PreviewItem = {
    x: 0,
    y: 0,
    width: Math.max(2, 2 * safeOuterRadius * Math.sin(fullHalfArcRad)),
    height: Math.max(2, safeOuterRadius - safeInnerRadius * Math.cos(fullHalfArcRad)),
    renderShape: "sector",
    label: `${Math.round(safeArcDegrees)}\u00b0 \u2022 R${formatInches(safeInnerRadius)}"-R${formatInches(safeOuterRadius)}"`,
    cutDirection,
    innerRadius: safeInnerRadius,
    outerRadius: safeOuterRadius,
    arcDegrees: safeArcDegrees,
  }

  const sections: PreviewSection[] = bounds.slice(0, -1).map((start, index) => {
    const end = bounds[index + 1]
    if (isConeRadialSplit(cutDirection)) {
      const sectionArcDegrees = Math.max(8, safeArcDegrees * (end - start))
      const sectionHalfArcRad = (sectionArcDegrees * Math.PI) / 360
      const label = `${Math.round(sectionArcDegrees)}\u00b0 \u2022 R${formatInches(safeInnerRadius)}"-R${formatInches(safeOuterRadius)}"`
      const item = {
        x: 0,
        y: 0,
        width: Math.max(2, 2 * safeOuterRadius * Math.sin(sectionHalfArcRad)),
        height: Math.max(2, safeOuterRadius - safeInnerRadius * Math.cos(sectionHalfArcRad)),
        renderShape: "sector" as const,
        label,
        cutDirection,
        innerRadius: safeInnerRadius,
        outerRadius: safeOuterRadius,
        arcDegrees: sectionArcDegrees,
        usedArea:
          (sectionArcDegrees / 360) * Math.PI * (safeOuterRadius ** 2 - safeInnerRadius ** 2),
      }
      return { start, end, label, item }
    }

    const bandInnerRadius = lerp(safeInnerRadius, safeOuterRadius, start)
    const bandOuterRadius = lerp(safeInnerRadius, safeOuterRadius, end)
    const label = `R${formatInches(bandInnerRadius)}"-R${formatInches(bandOuterRadius)}"`
    const item = {
      x: 0,
      y: 0,
      width: Math.max(2, 2 * bandOuterRadius * Math.sin(fullHalfArcRad)),
      height: Math.max(2, bandOuterRadius - bandInnerRadius * Math.cos(fullHalfArcRad)),
      renderShape: "sector" as const,
      label,
      cutDirection,
      innerRadius: bandInnerRadius,
      outerRadius: bandOuterRadius,
      arcDegrees: safeArcDegrees,
      usedArea: (safeArcDegrees / 360) * Math.PI * (bandOuterRadius ** 2 - bandInnerRadius ** 2),
    }
    return { start, end, label, item }
  })

  return {
    profileItem,
    sections,
    cutBreakpoints,
    cutLabels: sections.map((section) => section.label),
  }
}

export function buildTrapezoidSplitSections(
  topWidth: number,
  bottomWidth: number,
  height: number,
  cutDirection: SimpleCutDirection,
  cutRatios: number[] | undefined,
  requestedCutSections: number
): {
  profileItem: PreviewItem
  sections: PreviewSection[]
  cutBreakpoints: number[]
  cutLabels: string[]
} {
  const ratios = normalizeCutRatios(cutRatios, requestedCutSections)
  const cutBreakpoints = buildCutBreakpoints(ratios)
  const bounds = [0, ...cutBreakpoints, 1]
  const safeTopWidth = Math.max(1, topWidth)
  const safeBottomWidth = Math.max(1, bottomWidth)
  const safeHeight = Math.max(1, height)
  const profileItem: PreviewItem = {
    x: 0,
    y: 0,
    width: Math.max(safeTopWidth, safeBottomWidth),
    height: safeHeight,
    renderShape: "trapezoid",
    label: `${formatInches(safeTopWidth)}" / ${formatInches(safeBottomWidth)}" \u00d7 ${formatInches(safeHeight)}"`,
    cutDirection,
    topWidth: safeTopWidth,
    bottomWidth: safeBottomWidth,
  }

  const sections: PreviewSection[] = bounds.slice(0, -1).map((start, index) => {
    const end = bounds[index + 1]
    if (isTrapezoidVerticalSplit(cutDirection)) {
      const pieceTopWidth = safeTopWidth * (end - start)
      const pieceBottomWidth = safeBottomWidth * (end - start)
      const label = `${formatInches(pieceTopWidth)}" / ${formatInches(pieceBottomWidth)}" \u00d7 ${formatInches(safeHeight)}"`
      const item = {
        x: 0,
        y: 0,
        width: Math.max(pieceTopWidth, pieceBottomWidth),
        height: safeHeight,
        renderShape: "trapezoid" as const,
        label,
        cutDirection,
        topWidth: pieceTopWidth,
        bottomWidth: pieceBottomWidth,
        usedArea: ((pieceTopWidth + pieceBottomWidth) / 2) * safeHeight,
      }
      return { start, end, label, item }
    }

    const bandTopWidth = lerp(safeTopWidth, safeBottomWidth, start)
    const bandBottomWidth = lerp(safeTopWidth, safeBottomWidth, end)
    const bandHeight = safeHeight * (end - start)
    const label = `${formatInches(bandTopWidth)}" / ${formatInches(bandBottomWidth)}" \u00d7 ${formatInches(bandHeight)}"`
    const item = {
      x: 0,
      y: 0,
      width: Math.max(bandTopWidth, bandBottomWidth),
      height: bandHeight,
      renderShape: "trapezoid" as const,
      label,
      cutDirection,
      topWidth: bandTopWidth,
      bottomWidth: bandBottomWidth,
      usedArea: ((bandTopWidth + bandBottomWidth) / 2) * bandHeight,
    }
    return { start, end, label, item }
  })

  return {
    profileItem,
    sections,
    cutBreakpoints,
    cutLabels: sections.map((section) => section.label),
  }
}
