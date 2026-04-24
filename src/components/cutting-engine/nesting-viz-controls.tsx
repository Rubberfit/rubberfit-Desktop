// Interactive mode form controls for NestingVisualizer
// Extracted from NestingVisualizer.tsx

import type { ShapeType, GrainDir, DiagDir } from "./nesting-visualizer-types"

const inp =
  "w-full bg-[var(--color-background-secondary)] border border-[var(--color-border-secondary)] text-[var(--color-text-primary)] rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-[var(--color-border-primary)] transition-colors"
const lbl =
  "block text-[9px] font-semibold uppercase tracking-widest text-[var(--color-text-tertiary)] mb-1"

function parseInputValue(
  value: string,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY,
  integerOnly = false
) {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  const parsed = Number.parseFloat(trimmed)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    return null
  }

  if (integerOnly && !Number.isInteger(parsed)) {
    return null
  }

  return parsed
}

function applyParsedValue(
  value: string,
  minimum: number,
  setter: (n: number) => void,
  options?: {
    maximum?: number
    integerOnly?: boolean
    validate?: (value: number) => boolean
  }
) {
  const parsed = parseInputValue(value, minimum, options?.maximum, options?.integerOnly)
  if (parsed !== null && (options?.validate ? options.validate(parsed) : true)) {
    setter(parsed)
  }
}

interface ControlsProps {
  shape: ShapeType
  rollW: number
  rollL: number
  cutW: number
  cutH: number
  qty: number
  diagAng: number
  grain: GrainDir
  ddir: DiagDir
  diam: number
  innerR: number
  outerR: number
  arcDeg: number
  setShape: (s: ShapeType) => void
  setRollW: (n: number) => void
  setRollL: (n: number) => void
  setCutW: (n: number) => void
  setCutH: (n: number) => void
  setQty: (n: number) => void
  setDiagAng: (n: number) => void
  setGrain: (g: GrainDir) => void
  setDdir: (d: DiagDir) => void
  setDiam: (n: number) => void
  setInnerR: (n: number) => void
  setOuterR: (n: number) => void
  setArcDeg: (n: number) => void
  setActiveStep: (n: number) => void
}

export default function NestingVizControls({
  shape,
  rollW,
  rollL,
  cutW,
  cutH,
  qty,
  diagAng,
  grain,
  ddir,
  diam,
  innerR,
  outerR,
  arcDeg,
  setShape,
  setRollW,
  setRollL,
  setCutW,
  setCutH,
  setQty,
  setDiagAng,
  setGrain,
  setDdir,
  setDiam,
  setInnerR,
  setOuterR,
  setArcDeg,
  setActiveStep,
}: ControlsProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-8 gap-3 px-4 py-3 border-b border-border bg-background">
      <div className="col-span-2 sm:col-span-1">
        <label className={lbl}>Shape</label>
        <select
          value={shape}
          onChange={(e) => {
            setShape(e.target.value as ShapeType)
            setActiveStep(0)
          }}
          className={inp + " cursor-pointer"}
        >
          <option value="rect">Rectangle / Square</option>
          <option value="circle">Circle / Round</option>
          <option value="cone">Cone / Arc</option>
        </select>
      </div>
      <div>
        <label className={lbl}>Roll Width (in)</label>
        <input
          type="number"
          min="1"
          value={rollW}
          onChange={(e) => applyParsedValue(e.target.value, 1, setRollW)}
          className={inp}
        />
      </div>
      <div>
        <label className={lbl}>Roll Length (in)</label>
        <input
          type="number"
          min="1"
          value={rollL}
          onChange={(e) => applyParsedValue(e.target.value, 1, setRollL)}
          className={inp}
        />
      </div>

      {shape === "rect" && (
        <RectControls
          cutW={cutW}
          cutH={cutH}
          qty={qty}
          diagAng={diagAng}
          grain={grain}
          ddir={ddir}
          setCutW={setCutW}
          setCutH={setCutH}
          setQty={setQty}
          setDiagAng={setDiagAng}
          setGrain={setGrain}
          setDdir={setDdir}
        />
      )}
      {shape === "circle" && (
        <div className="col-span-2">
          <label className={lbl}>Diameter (in)</label>
          <input
            type="number"
            min="1"
            step="0.5"
            value={diam}
            onChange={(e) => applyParsedValue(e.target.value, 1, setDiam)}
            className={inp}
          />
        </div>
      )}
      {shape === "cone" && (
        <ConeControls
          innerR={innerR}
          outerR={outerR}
          arcDeg={arcDeg}
          setInnerR={setInnerR}
          setOuterR={setOuterR}
          setArcDeg={setArcDeg}
        />
      )}
    </div>
  )
}

function RectControls({
  cutW,
  cutH,
  qty,
  diagAng,
  grain,
  ddir,
  setCutW,
  setCutH,
  setQty,
  setDiagAng,
  setGrain,
  setDdir,
}: {
  cutW: number
  cutH: number
  qty: number
  diagAng: number
  grain: GrainDir
  ddir: DiagDir
  setCutW: (n: number) => void
  setCutH: (n: number) => void
  setQty: (n: number) => void
  setDiagAng: (n: number) => void
  setGrain: (g: GrainDir) => void
  setDdir: (d: DiagDir) => void
}) {
  return (
    <>
      <div>
        <label className={lbl}>Cut Width (in)</label>
        <input
          type="number"
          min="0.5"
          step="0.5"
          value={cutW}
          onChange={(e) => applyParsedValue(e.target.value, 0.5, setCutW)}
          className={inp}
        />
      </div>
      <div>
        <label className={lbl}>Cut Height (in)</label>
        <input
          type="number"
          min="0.5"
          step="0.5"
          value={cutH}
          onChange={(e) => applyParsedValue(e.target.value, 0.5, setCutH)}
          className={inp}
        />
      </div>
      <div>
        <label className={lbl}>Qty Needed</label>
        <input
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          value={qty}
          onChange={(e) => applyParsedValue(e.target.value, 1, setQty, { integerOnly: true })}
          className={inp}
        />
      </div>
      <div>
        <label className={lbl}>Diag Angle (deg)</label>
        <input
          type="number"
          min="10"
          max="80"
          step="1"
          value={diagAng}
          onChange={(e) => applyParsedValue(e.target.value, 10, setDiagAng, { maximum: 80 })}
          className={inp}
        />
      </div>
      <div className="col-span-2 sm:col-span-1">
        <label className={lbl}>Grain Direction</label>
        <select
          value={grain}
          onChange={(e) => setGrain(e.target.value as GrainDir)}
          className={inp + " cursor-pointer"}
        >
          <option value="none">No grain</option>
          <option value="width">Along width</option>
          <option value="length">Along length</option>
        </select>
      </div>
      <div className="col-span-2 sm:col-span-1">
        <label className={lbl}>Diag Direction</label>
        <select
          value={ddir}
          onChange={(e) => setDdir(e.target.value as DiagDir)}
          className={inp + " cursor-pointer"}
        >
          <option value="ltr">Left-to-right /</option>
          <option value="rtl">Right-to-left \</option>
        </select>
      </div>
    </>
  )
}

function ConeControls({
  innerR,
  outerR,
  arcDeg,
  setInnerR,
  setOuterR,
  setArcDeg,
}: {
  innerR: number
  outerR: number
  arcDeg: number
  setInnerR: (n: number) => void
  setOuterR: (n: number) => void
  setArcDeg: (n: number) => void
}) {
  return (
    <>
      <div>
        <label className={lbl}>Inner R (in)</label>
        <input
          type="number"
          min="0"
          step="0.5"
          value={innerR}
          onChange={(e) =>
            applyParsedValue(e.target.value, 0, setInnerR, {
              validate: (value) => value < outerR,
            })
          }
          className={inp}
        />
      </div>
      <div>
        <label className={lbl}>Outer R (in)</label>
        <input
          type="number"
          min="2"
          step="0.5"
          value={outerR}
          onChange={(e) =>
            applyParsedValue(e.target.value, 2, setOuterR, {
              validate: (value) => value > innerR,
            })
          }
          className={inp}
        />
      </div>
      <div>
        <label className={lbl}>Arc Sweep (deg)</label>
        <input
          type="number"
          min="10"
          max="359"
          step="5"
          value={arcDeg}
          onChange={(e) => applyParsedValue(e.target.value, 10, setArcDeg, { maximum: 359 })}
          className={inp}
        />
      </div>
    </>
  )
}
