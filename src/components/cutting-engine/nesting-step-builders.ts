// Cut step builders for each shape type
// Split from nesting-layout-utils.ts to stay under the max-lines limit

import type { SimpleRectLayout } from "./nesting-visualizer-types"
import { formatInches } from "./nesting-layout-utils"

export function buildRectangleSteps(layout: SimpleRectLayout) {
  const width = formatInches(layout.pieceW)
  const height = formatInches(layout.pieceH)
  const stripCount = Math.max(layout.cols, 1)

  if (layout.orientation === "rotated") {
    return {
      title: "Rectangle cut sequence",
      steps: [
        {
          title: `Rip ${stripCount} strip${stripCount === 1 ? "" : "s"} at ${width}"`,
          detail:
            "The part was rotated to fit the sheet more efficiently, so the first cuts follow the rotated width.",
        },
        {
          title: `Cross-cut each strip at ${height}"`,
          detail: `Finish the rotated blanks into ${width}" × ${height}" parts.`,
        },
      ],
    }
  }

  return {
    title: "Rectangle cut sequence",
    steps: [
      {
        title: `Rip ${stripCount} strip${stripCount === 1 ? "" : "s"} at ${width}"`,
        detail: "Straight strip cuts keep the rectangle workflow simple for the cutter.",
      },
      {
        title: `Cross-cut each strip at ${height}"`,
        detail: `Finish the blanks into ${width}" × ${height}" parts.`,
      },
    ],
  }
}

export function buildCircleSteps(diameter: number, piecesPerUnit: number) {
  const size = formatInches(diameter)
  if (piecesPerUnit <= 1) {
    return {
      title: "Circle cut sequence",
      steps: [
        {
          title: `Strike the \u00d8${size}" circle`,
          detail: "Lay out the full outside diameter directly on stock or on the selected blank.",
        },
        {
          title: `Finish the \u00d8${size}" outside cut`,
          detail: "Follow the full circular profile to complete the finished part.",
        },
      ],
    }
  }

  return {
    title: "Circle cut sequence",
    steps: [
      {
        title: `Strike the \u00d8${size}" profile`,
        detail:
          "Use the full finished diameter as the master layout for the part before dividing it into cut sections.",
      },
      {
        title: `Split the profile into ${piecesPerUnit} radial sections`,
        detail:
          piecesPerUnit === 2
            ? "A single centerline creates two semicircle panels for a simpler low-waste cut."
            : `Mark ${piecesPerUnit} equal sectors from the center so the circle can be cut as smaller wedge panels with lower waste.`,
      },
      {
        title: "Cut and match the section edges",
        detail:
          "The stock layout packs the smaller section pieces more tightly than a full-circle cut, then those sections reconstruct the finished round profile.",
      },
    ],
  }
}

export function buildCylinderSteps(width: number, height: number, piecesPerUnit: number) {
  const panelWidth = formatInches(width)
  const panelHeight = formatInches(height)
  return {
    title: "Cylinder cut sequence",
    steps: [
      {
        title: `Rip ${panelWidth}" \u00d7 ${panelHeight}" wrap panel${piecesPerUnit > 1 ? "s" : ""}`,
        detail:
          piecesPerUnit > 1
            ? "This strategy splits the wrap into multiple panels so the stock fits more cleanly."
            : "This strategy keeps the full wrap as one rectangle per finished cylinder.",
      },
      {
        title: piecesPerUnit > 1 ? "Match and seam the wrap panels" : "Roll and seam the wrap",
        detail: "After cutting, the wrap is ready for fit-up around the cylindrical part.",
      },
    ],
  }
}

export function buildConeSteps(
  innerRadius: number,
  outerRadius: number,
  arcDegrees: number,
  piecesPerUnit: number
) {
  const inner = formatInches(innerRadius)
  const outer = formatInches(outerRadius)
  const sweep = Math.round(arcDegrees)
  return {
    title: "Cone spread cut sequence",
    steps: [
      {
        title: `Strike the outer arc at R${outer}"`,
        detail: `Use the same center point for the full ${sweep}\u00b0 sweep so the spread stays consistent.`,
      },
      {
        title: `Strike the inner arc at R${inner}"`,
        detail: "This defines the open throat of the frustum before the side cuts are made.",
      },
      {
        title:
          piecesPerUnit > 1
            ? "Cut the sector panels and match the seam edges"
            : "Cut both radial side edges",
        detail:
          piecesPerUnit > 1
            ? "This strategy splits the spread into smaller panels to reduce waste and improve fit on stock."
            : "The radial cuts complete the full spread profile.",
      },
    ],
  }
}

export function buildTrapezoidSteps(
  topWidth: number,
  bottomWidth: number,
  height: number,
  piecesPerUnit = 1
) {
  const top = formatInches(topWidth)
  const bottom = formatInches(bottomWidth)
  const tall = formatInches(height)
  if (piecesPerUnit > 1) {
    return {
      title: "Trapezoid cut sequence",
      steps: [
        {
          title: `Lay out the full ${top}" / ${bottom}" \u00d7 ${tall}" profile`,
          detail:
            "Mark the finished hopper or transition panel at full size before breaking it into smaller cut sections.",
        },
        {
          title: `Split the profile into ${piecesPerUnit} tapered panels`,
          detail: `Use evenly spaced section lines so the final trapezoid is built from ${piecesPerUnit} tapered cuts instead of repeating the whole profile.`,
        },
        {
          title: "Cut the section edges and match the seams",
          detail:
            "The smaller tapered pieces pack more cleanly on stock, then assemble back into the full hopper panel.",
        },
      ],
    }
  }
  return {
    title: "Trapezoid cut sequence",
    steps: [
      {
        title: `Rip a ${bottom}" \u00d7 ${tall}" blank`,
        detail:
          "The larger base width is used for the first straight cut so the blank stays easy to register.",
      },
      {
        title: `Mark the centered ${top}" top width`,
        detail: "Lay out the taper from the top corners down to the full bottom width.",
      },
      {
        title: "Cut both taper edges",
        detail: "Finishing the angled sides last gives the cleanest trapezoid panel.",
      },
    ],
  }
}
