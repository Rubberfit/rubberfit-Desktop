// Card #5 on the AutoNest page. Renders every reusable offcut from the
// pack as its own scaled tile so operators can see the leftover stock
// inventory at a glance, with a tag legend at the top mirroring the
// Graph card's part legend.

import { useMemo } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { LayoutModel } from "./layout-model"
import { buildTaggedReusableOffcuts } from "./reusable-offcut-tags"
import { formatInches } from "./format-inches"

const AMBER_BG = "#fef3c7"
const AMBER_LINE = "rgba(245, 158, 11, 0.55)"
const AMBER_OUTLINE = "rgba(245, 158, 11, 0.85)"
const TILE_MAX_PX = 140

export function ReusableOffcutsCard({ layouts }: { layouts: LayoutModel[] }) {
  const tagged = useMemo(() => buildTaggedReusableOffcuts(layouts), [layouts])
  if (tagged.length === 0) return null

  const maxDim = Math.max(...tagged.map((t) => Math.max(t.region.width, t.region.height)))

  return (
    <Card className="border border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded border border-amber-500/40 bg-amber-500/10 text-[10px] font-bold leading-none text-amber-700">
            R
          </span>
          5. Reusable Offcuts
        </CardTitle>
        <CardDescription>
          Leftover stock pieces from the pack, ranked largest first. Tags here are independent of
          part tags above.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
          {tagged.map((t) => (
            <span key={t.tag} className="flex items-center gap-1.5 text-muted-foreground">
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[10px] font-bold leading-none text-amber-700">
                {t.tag}
              </span>
              <span className="text-foreground">
                {`${formatInches(t.region.width)}" × ${formatInches(t.region.height)}"`}
              </span>
              <span>·</span>
              <span>{t.areaSqFt.toFixed(2)} ft²</span>
              <span>·</span>
              <span>from Sheet {t.sourceSheetNumber}</span>
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-4">
          {tagged.map((t) => (
            <OffcutTile
              key={t.tag}
              tag={t.tag}
              widthIn={t.region.width}
              heightIn={t.region.height}
              areaSqFt={t.areaSqFt}
              sourceSheetNumber={t.sourceSheetNumber}
              maxDim={maxDim}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function OffcutTile({
  tag,
  widthIn,
  heightIn,
  areaSqFt,
  sourceSheetNumber,
  maxDim,
}: {
  tag: string
  widthIn: number
  heightIn: number
  areaSqFt: number
  sourceSheetNumber: number
  maxDim: number
}) {
  const scale = TILE_MAX_PX / Math.max(maxDim, 0.0001)
  const w = Math.max(8, widthIn * scale)
  const h = Math.max(8, heightIn * scale)
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <div
        className="relative"
        style={{
          width: TILE_MAX_PX,
          height: TILE_MAX_PX,
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
        }}
      >
        <svg width={w} height={h} style={{ display: "block" }}>
          <defs>
            <pattern
              id={`offcut-tile-${tag}`}
              width="10"
              height="10"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="10" height="10" fill={AMBER_BG} />
              <line x1="0" y1="0" x2="0" y2="10" stroke={AMBER_LINE} strokeWidth="1.5" />
            </pattern>
          </defs>
          <rect
            x="0.75"
            y="0.75"
            width={w - 1.5}
            height={h - 1.5}
            fill={`url(#offcut-tile-${tag})`}
            stroke={AMBER_OUTLINE}
            strokeWidth="1.5"
            strokeDasharray="6 4"
          />
          <text
            x={w / 2}
            y={h / 2 + 4}
            textAnchor="middle"
            fontSize="11"
            fontWeight="700"
            fill="#92400e"
          >
            {tag}
          </text>
        </svg>
      </div>
      <span className="text-xs font-medium text-foreground">
        {`${formatInches(widthIn)}" × ${formatInches(heightIn)}"`}
      </span>
      <span className="text-[11px] text-muted-foreground">
        {areaSqFt.toFixed(2)} ft² · Sheet {sourceSheetNumber}
      </span>
    </div>
  )
}

