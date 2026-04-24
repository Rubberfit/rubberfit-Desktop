// Dimension label component for NestingVisualizer SVG
// Extracted from nesting-viz-simple-parts.tsx to stay under the max-lines limit

import { formatInches } from "./nesting-viz-simple-layout"
import type { SimpleModeLayout } from "./nesting-viz-simple-layout"

export function SimpleModeDimensionLabels({ layout }: { layout: SimpleModeLayout }) {
  // wasRotated means the layout was rotated 90° CW, so the original length
  // now runs horizontally and the original width runs vertically.
  const horzValue = layout.previewRollW
  const horzLabel = layout.wasRotated ? "length" : "width"
  const vertValue = layout.previewRollL
  const vertLabel = layout.wasRotated ? "width" : "length"

  return (
    <>
      <line
        x1={layout.shapeFirstView ? layout.localBlankX : layout.surfaceX}
        y1={layout.rowLabelY}
        x2={
          layout.shapeFirstView
            ? layout.localBlankX + layout.localBlankW
            : layout.surfaceX + layout.surfacePxW
        }
        y2={layout.rowLabelY}
        className="stroke-muted-foreground"
        strokeWidth="1.5"
        markerStart={`url(#${layout.markerId})`}
        markerEnd={`url(#${layout.markerId})`}
      />
      <text
        x={
          layout.shapeFirstView
            ? layout.localBlankX + layout.localBlankW / 2
            : layout.surfaceX + layout.surfacePxW / 2
        }
        y={layout.rowLabelY + 24}
        textAnchor="middle"
        className="fill-foreground"
        fontSize="14"
        fontWeight="600"
      >
        {`${formatInches(horzValue)}" ${horzLabel}`}
      </text>

      <line
        x1={layout.colLabelX}
        y1={layout.shapeFirstView ? layout.localBlankY : layout.surfaceY}
        x2={layout.colLabelX}
        y2={
          layout.shapeFirstView
            ? layout.localBlankY + layout.localBlankH
            : layout.surfaceY + layout.surfacePxH
        }
        className="stroke-muted-foreground"
        strokeWidth="1.5"
        markerStart={`url(#${layout.markerId})`}
        markerEnd={`url(#${layout.markerId})`}
      />
      <text
        x={layout.colLabelX + 26}
        y={
          layout.shapeFirstView
            ? layout.localBlankY + layout.localBlankH / 2
            : layout.surfaceY + layout.surfacePxH / 2
        }
        textAnchor="middle"
        className="fill-foreground"
        fontSize="14"
        fontWeight="600"
        transform={`rotate(90 ${layout.colLabelX + 26} ${layout.shapeFirstView ? layout.localBlankY + layout.localBlankH / 2 : layout.surfaceY + layout.surfacePxH / 2})`}
      >
        {`${formatInches(vertValue)}" ${vertLabel}`}
      </text>
    </>
  )
}
