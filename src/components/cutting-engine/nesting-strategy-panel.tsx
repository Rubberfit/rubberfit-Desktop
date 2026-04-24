// Strategy panel for rect mode — shows 6 strategy cards + step-by-step detail
// Split from NestingVisualizer.tsx to keep the main component as a thin shell

import React from "react"
import type { ScoredStrategy } from "./nesting-visualizer-types"

interface NestingStrategyPanelProps {
  scored: ScoredStrategy[]
  activeId: string
  setActiveId: (id: string) => void
  activeStep: number
  setActiveStep: (step: number) => void
  qty: number
  rollW: number
  rollL: number
  miniRefs: React.MutableRefObject<Record<string, SVGSVGElement>>
  detailRef: React.Ref<SVGSVGElement>
}

function getStepNote(
  activeStrat: ScoredStrategy,
  activeStep: number,
  rollW: number,
  rollL: number
) {
  if (!activeStrat) return ""
  const cur = activeStrat.steps[activeStep]
  const diagAn =
    activeStrat.diagType === "corner"
      ? (Math.atan2(activeStrat.cutH, activeStrat.cutW) * 180) / Math.PI
      : (activeStrat.diagAngle ?? 45)
  const map: Record<string, string> = {
    "Full roll": `Roll is ${rollW}"\u00d7${rollL}". ${activeStrat.cols} cols \u00d7 ${activeStrat.rows} rows = ${activeStrat.method === "diag" ? activeStrat.rects * 2 + " triangles" : activeStrat.rects + " rectangles"} of ${activeStrat.cutW}"\u00d7${activeStrat.cutH}".`,
    "H-cuts first": `Make ${activeStrat.hCuts} horizontal cut${activeStrat.hCuts !== 1 ? "s" : ""} every ${activeStrat.cutH}" \u2014 runs \u2190\u2192 across roll width. This is the primary cut direction.`,
    "V-cuts next": `Make ${activeStrat.vCuts} vertical cut${activeStrat.vCuts !== 1 ? "s" : ""} every ${activeStrat.cutW}" \u2014 runs \u2195 down the roll.`,
    "V-cuts first": `Make ${activeStrat.vCuts} vertical cut${activeStrat.vCuts !== 1 ? "s" : ""} every ${activeStrat.cutW}" \u2014 runs \u2195 down roll length. This is the primary cut direction.`,
    "H-cuts next": `Make ${activeStrat.hCuts} horizontal cut${activeStrat.hCuts !== 1 ? "s" : ""} every ${activeStrat.cutH}" \u2014 runs \u2190\u2192 across the roll width.`,
    "Straight cuts": `${activeStrat.hCuts} horizontal + ${activeStrat.vCuts} vertical cuts to create ${activeStrat.rects} rectangles before the diagonal.`,
    "Diagonal cuts": `Diagonal cut each rectangle ${activeStrat.ddir === "ltr" ? "\u2571 left-to-right" : "\u2572 right-to-left"} at ${diagAn.toFixed(1)}\u00b0. Yields triangle A (green) + B (blue) \u2014 both kept.`,
    Done: `All cuts done. ${activeStrat.pieces} pieces ready.${activeStrat.pieces < activeStrat.rects ? " Note: second roll needed." : ""}`,
  }
  return map[cur] ?? ""
}

 
export default function NestingStrategyPanel({
  scored,
  activeId,
  setActiveId,
  activeStep,
  setActiveStep,
  qty,
  rollW,
  rollL,
  miniRefs,
  detailRef,
}: NestingStrategyPanelProps) {
  const maxScore = Math.max(...scored.map((s) => s.score), 1)
  const activeStrat = scored.find((s) => s.id === activeId)
  const stepNote = activeStrat ? getStepNote(activeStrat, activeStep, rollW, rollL) : ""

  const scoreBarColor = (s: ScoredStrategy) =>
    s.id === scored[0]?.id
      ? "var(--color-border-success)"
      : s.score > 55
        ? "var(--color-border-info)"
        : "var(--color-border-tertiary)"

  const badgeStyle = (s: ScoredStrategy, rank: number): React.CSSProperties => {
    if (rank === 0)
      return {
        background: "var(--color-background-success)",
        color: "var(--color-text-success)",
        border: "1px solid var(--color-border-success)",
      }
    if (s.score > 75)
      return {
        background: "var(--color-background-info)",
        color: "var(--color-text-info)",
        border: "1px solid var(--color-border-info)",
      }
    if (s.score > 45)
      return {
        background: "var(--color-background-secondary)",
        color: "var(--color-text-secondary)",
        border: "0.5px solid var(--color-border-tertiary)",
      }
    return {
      background: "var(--color-background-danger)",
      color: "var(--color-text-danger)",
      border: "1px solid var(--color-border-danger)",
    }
  }

  const badgeText = (rank: number, score: number) =>
    rank === 0 ? "Best" : score > 75 ? "Good" : score > 45 ? "OK" : "Poor"

  return (
    <>
      <div className="px-4 pt-3 pb-1">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          All cut strategies -- click to see step-by-step
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 px-4 pb-3">
        {scored.map((s, rank) => (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              setActiveId(s.id)
              setActiveStep(0)
            }}
            aria-pressed={s.id === activeId}
            className="w-full rounded-lg overflow-hidden bg-card text-left transition-transform hover:-translate-y-px"
            style={{
              border:
                s.id === activeId
                  ? "2px solid var(--color-border-info)"
                  : rank === 0
                    ? "2px solid var(--color-border-success)"
                    : "0.5px solid var(--color-border-tertiary)",
            }}
          >
            <div className="flex items-start justify-between gap-1 px-2.5 pt-2 pb-1">
              <div>
                <div className="text-[13.8px] font-semibold text-foreground">{s.name}</div>
                <div className="text-[13.375px] text-muted-foreground mt-0.5">{s.sub}</div>
              </div>
              <span
                className="text-[8px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0 mt-0.5"
                style={badgeStyle(s, rank)}
              >
                {badgeText(rank, s.score)}
              </span>
            </div>

            <svg
              ref={(el) => {
                if (el) miniRefs.current[s.id] = el
              }}
              width="100%"
              style={{ display: "block" }}
            />

            <div className="grid grid-cols-3 border-t border-border">
              {[
                { l: "Pieces", v: String(s.pieces), good: s.pieces >= qty },
                { l: "Waste", v: `${s.waste.toFixed(1)}%`, good: s.waste < 15 },
                { l: "Score", v: String(Math.round(s.score)), good: rank === 0 },
              ].map((stat) => (
                <div
                  key={stat.l}
                  className="text-center py-1.5 border-r border-border last:border-r-0"
                >
                  <div className="text-[8px] text-muted-foreground uppercase tracking-wide">
                    {stat.l}
                  </div>
                  <div
                    className="text-[11px] font-semibold"
                    style={{
                      color: stat.good
                        ? "var(--color-text-success)"
                        : stat.v.endsWith("%") && parseFloat(stat.v) > 25
                          ? "var(--color-text-danger)"
                          : "var(--color-text-secondary)",
                    }}
                  >
                    {stat.v}
                  </div>
                </div>
              ))}
            </div>

            <div className="mx-2 mb-2 mt-1 h-[3px] rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${((s.score / maxScore) * 100).toFixed(0)}%`,
                  background: scoreBarColor(s),
                }}
              />
            </div>
          </button>
        ))}
      </div>

      {activeStrat && (
        <div className="mx-4 mb-4 rounded-lg border border-border overflow-hidden bg-muted/30">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-background">
            <span className="text-[11px] font-semibold text-foreground">
              {activeStrat.name} -- step-by-step
            </span>
            <div className="flex gap-3 text-[10px] text-muted-foreground">
              <span>{activeStrat.pieces} pcs</span>
              <span>{activeStrat.waste.toFixed(1)}% waste</span>
              <span>score {Math.round(activeStrat.score)}</span>
            </div>
          </div>

          <div className="flex gap-2 flex-wrap px-3 pt-2">
            {activeStrat.steps.map((step, i) => (
              <button
                key={step}
                onClick={() => setActiveStep(i)}
                className="text-[10px] px-2.5 py-1 rounded-full border transition-all"
                style={{
                  background: i === activeStep ? "var(--color-background-info)" : "transparent",
                  color:
                    i === activeStep ? "var(--color-text-info)" : "var(--color-text-secondary)",
                  borderColor:
                    i === activeStep ? "var(--color-border-info)" : "var(--color-border-tertiary)",
                }}
              >
                {step}
              </button>
            ))}
          </div>

          <div className="px-3 pt-2">
            <style>{`@keyframes dashIn{from{stroke-dashoffset:900}to{stroke-dashoffset:0}}`}</style>
            <svg
              ref={detailRef}
              width="100%"
              style={{ display: "block", borderRadius: "6px", background: "var(--svg-bg)" }}
            />
          </div>

          <div
            className="mx-3 my-2 px-3 py-2 rounded-md bg-muted text-[11px] text-muted-foreground"
            style={{ lineHeight: 1.55 }}
          >
            {stepNote}
          </div>

          <div className="flex flex-col gap-1 px-3 pb-3 border-t border-border pt-2">
            {activeStrat.reasons.map((r, i) => (
              <div
                key={i}
                className="flex items-start gap-2 text-[10px] text-muted-foreground"
                style={{ lineHeight: 1.45 }}
              >
                <div
                  className="w-3.5 h-3.5 rounded-full flex-shrink-0 flex items-center justify-center text-[7px] font-bold mt-px"
                  style={{
                    background:
                      r.p === "p"
                        ? "var(--color-background-success)"
                        : r.p === "w"
                          ? "var(--color-background-warning)"
                          : "var(--color-background-danger)",
                    color:
                      r.p === "p"
                        ? "var(--color-text-success)"
                        : r.p === "w"
                          ? "var(--color-text-warning)"
                          : "var(--color-text-danger)",
                  }}
                >
                  {r.p === "p" ? "\u2713" : r.p === "w" ? "!" : "\u2715"}
                </div>
                <span>{r.t}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
