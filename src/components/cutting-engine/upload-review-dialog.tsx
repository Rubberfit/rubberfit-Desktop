import { useState, useEffect, type ReactNode } from "react"
import { AlertTriangle, Trash2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { ExtractedPart, ExtractedShapeType } from "@/types/vision"

interface UploadReviewDialogProps {
  open: boolean
  parts: ExtractedPart[]
  warnings: string[]
  stockWidth?: number
  onConfirm: (parts: ExtractedPart[]) => void
  onCancel: () => void
}

const SHAPE_TITLES: Record<ExtractedShapeType, string> = {
  rectangle: "Rectangles",
  cylinder: "Cylinders",
  cone: "Cones",
  trapezoid: "Trapezoids",
}

function parsePositive(value: string, fallback: number): number {
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0) return fallback
  return num
}

function parseQty(value: string, fallback: number): number {
  const num = Number(value)
  if (!Number.isFinite(num) || num < 1) return fallback
  return Math.max(1, Math.round(num))
}

export default function UploadReviewDialog({
  open,
  parts: initialParts,
  warnings,
  stockWidth,
  onConfirm,
  onCancel,
}: UploadReviewDialogProps) {
  const [parts, setParts] = useState<ExtractedPart[]>(initialParts)

  useEffect(() => {
    setParts(initialParts)
  }, [initialParts])

  const updateRow = (index: number, fn: (p: ExtractedPart) => ExtractedPart) => {
    setParts((prev) => prev.map((p, i) => (i === index ? fn(p) : p)))
  }

  const removeRow = (index: number) => {
    setParts((prev) => prev.filter((_, i) => i !== index))
  }

  // Pair each part with its position in the master list so per-row
  // edits map back to the right entry after grouping.
  const indexed = parts.map((part, index) => ({ part, index }))
  function rowsOf<T extends ExtractedPart["shapeType"]>(shape: T) {
    return indexed.filter(
      (r): r is { part: Extract<ExtractedPart, { shapeType: T }>; index: number } =>
        r.part.shapeType === shape
    )
  }
  const rectangleRows = rowsOf("rectangle")
  const cylinderRows = rowsOf("cylinder")
  const coneRows = rowsOf("cone")
  const trapezoidRows = rowsOf("trapezoid")

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Review Extracted Dimensions</DialogTitle>
          <DialogDescription>
            {parts.length} part{parts.length !== 1 ? "s" : ""} extracted
            {stockWidth ? ` - Stock width: ${stockWidth}"` : ""}
          </DialogDescription>
        </DialogHeader>

        {warnings.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>
              {warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-auto space-y-4">
          {rectangleRows.length > 0 && (
            <SectionHeading shape="rectangle" count={rectangleRows.length}>
              <RectangleTable rows={rectangleRows} updateRow={updateRow} removeRow={removeRow} />
            </SectionHeading>
          )}
          {cylinderRows.length > 0 && (
            <SectionHeading shape="cylinder" count={cylinderRows.length}>
              <CylinderTable rows={cylinderRows} updateRow={updateRow} removeRow={removeRow} />
            </SectionHeading>
          )}
          {coneRows.length > 0 && (
            <SectionHeading shape="cone" count={coneRows.length}>
              <ConeTable rows={coneRows} updateRow={updateRow} removeRow={removeRow} />
            </SectionHeading>
          )}
          {trapezoidRows.length > 0 && (
            <SectionHeading shape="trapezoid" count={trapezoidRows.length}>
              <TrapezoidTable rows={trapezoidRows} updateRow={updateRow} removeRow={removeRow} />
            </SectionHeading>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(parts)} disabled={parts.length === 0}>
            Add {parts.length} Part{parts.length !== 1 ? "s" : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SectionHeading({
  shape,
  count,
  children,
}: {
  shape: ExtractedShapeType
  count: number
  children: ReactNode
}) {
  return (
    <section>
      <h4 className="mb-2 text-sm font-semibold text-foreground">
        {SHAPE_TITLES[shape]}
        <span className="ml-2 text-xs font-normal text-muted-foreground">({count})</span>
      </h4>
      {children}
    </section>
  )
}

// ── Per-shape table sections ─────────────────────────────────────────

interface SectionProps<T extends ExtractedPart> {
  rows: Array<{ part: T; index: number }>
  updateRow: (index: number, fn: (p: ExtractedPart) => ExtractedPart) => void
  removeRow: (index: number) => void
}

const inputCls = "w-full rounded border border-border bg-transparent px-1.5 py-1 text-sm"

function PartNumberCell({
  value,
  onChange,
}: {
  value: string | undefined
  onChange: (v: string) => void
}) {
  return (
    <TableCell>
      <input
        className={inputCls}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder="—"
      />
    </TableCell>
  )
}

function NumberCell({
  value,
  onChange,
  min = "0",
  step = "0.125",
}: {
  value: number
  onChange: (v: string) => void
  min?: string
  step?: string
}) {
  return (
    <TableCell>
      <input
        type="number"
        className={inputCls}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        min={min}
        step={step}
      />
    </TableCell>
  )
}

function DeleteCell({ onClick }: { onClick: () => void }) {
  return (
    <TableCell>
      <button
        type="button"
        onClick={onClick}
        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        aria-label="Remove row"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </TableCell>
  )
}

function RectangleTable({
  rows,
  updateRow,
  removeRow,
}: SectionProps<Extract<ExtractedPart, { shapeType: "rectangle" }>>) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[100px]">Part #</TableHead>
          <TableHead className="w-[100px]">Width</TableHead>
          <TableHead className="w-[100px]">Length</TableHead>
          <TableHead className="w-[70px]">Qty</TableHead>
          <TableHead className="w-[40px]" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ part, index }) => (
          <TableRow key={index}>
            <PartNumberCell
              value={part.partNumber}
              onChange={(v) => updateRow(index, (p) => ({ ...p, partNumber: v }))}
            />
            <NumberCell
              value={part.width}
              onChange={(v) =>
                updateRow(index, (p) =>
                  p.shapeType === "rectangle" ? { ...p, width: parsePositive(v, p.width) } : p
                )
              }
            />
            <NumberCell
              value={part.length}
              onChange={(v) =>
                updateRow(index, (p) =>
                  p.shapeType === "rectangle" ? { ...p, length: parsePositive(v, p.length) } : p
                )
              }
            />
            <NumberCell
              value={part.quantity}
              onChange={(v) =>
                updateRow(index, (p) => ({ ...p, quantity: parseQty(v, p.quantity) }))
              }
              min="1"
              step="1"
            />
            <DeleteCell onClick={() => removeRow(index)} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function CylinderTable({
  rows,
  updateRow,
  removeRow,
}: SectionProps<Extract<ExtractedPart, { shapeType: "cylinder" }>>) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[100px]">Part #</TableHead>
          <TableHead className="w-[100px]">Diameter</TableHead>
          <TableHead className="w-[100px]">Height</TableHead>
          <TableHead className="w-[70px]">Qty</TableHead>
          <TableHead className="w-[40px]" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ part, index }) => (
          <TableRow key={index}>
            <PartNumberCell
              value={part.partNumber}
              onChange={(v) => updateRow(index, (p) => ({ ...p, partNumber: v }))}
            />
            <NumberCell
              value={part.diameter}
              onChange={(v) =>
                updateRow(index, (p) =>
                  p.shapeType === "cylinder" ? { ...p, diameter: parsePositive(v, p.diameter) } : p
                )
              }
            />
            <NumberCell
              value={part.height}
              onChange={(v) =>
                updateRow(index, (p) =>
                  p.shapeType === "cylinder" ? { ...p, height: parsePositive(v, p.height) } : p
                )
              }
            />
            <NumberCell
              value={part.quantity}
              onChange={(v) =>
                updateRow(index, (p) => ({ ...p, quantity: parseQty(v, p.quantity) }))
              }
              min="1"
              step="1"
            />
            <DeleteCell onClick={() => removeRow(index)} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function ConeTable({
  rows,
  updateRow,
  removeRow,
}: SectionProps<Extract<ExtractedPart, { shapeType: "cone" }>>) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[90px]">Part #</TableHead>
          <TableHead className="w-[100px]">Inner R</TableHead>
          <TableHead className="w-[100px]">Outer R</TableHead>
          <TableHead className="w-[100px]">Arc°</TableHead>
          <TableHead className="w-[70px]">Qty</TableHead>
          <TableHead className="w-[40px]" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ part, index }) => (
          <TableRow key={index}>
            <PartNumberCell
              value={part.partNumber}
              onChange={(v) => updateRow(index, (p) => ({ ...p, partNumber: v }))}
            />
            <NumberCell
              value={part.innerRadius}
              onChange={(v) =>
                updateRow(index, (p) =>
                  p.shapeType === "cone"
                    ? { ...p, innerRadius: parsePositive(v, p.innerRadius) }
                    : p
                )
              }
            />
            <NumberCell
              value={part.outerRadius}
              onChange={(v) =>
                updateRow(index, (p) =>
                  p.shapeType === "cone"
                    ? { ...p, outerRadius: parsePositive(v, p.outerRadius) }
                    : p
                )
              }
            />
            <NumberCell
              value={part.arcDegrees}
              onChange={(v) =>
                updateRow(index, (p) =>
                  p.shapeType === "cone" ? { ...p, arcDegrees: parsePositive(v, p.arcDegrees) } : p
                )
              }
              step="1"
            />
            <NumberCell
              value={part.quantity}
              onChange={(v) =>
                updateRow(index, (p) => ({ ...p, quantity: parseQty(v, p.quantity) }))
              }
              min="1"
              step="1"
            />
            <DeleteCell onClick={() => removeRow(index)} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function TrapezoidTable({
  rows,
  updateRow,
  removeRow,
}: SectionProps<Extract<ExtractedPart, { shapeType: "trapezoid" }>>) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[90px]">Part #</TableHead>
          <TableHead className="w-[100px]">Top W</TableHead>
          <TableHead className="w-[100px]">Bottom W</TableHead>
          <TableHead className="w-[100px]">Height</TableHead>
          <TableHead className="w-[70px]">Qty</TableHead>
          <TableHead className="w-[40px]" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ part, index }) => (
          <TableRow key={index}>
            <PartNumberCell
              value={part.partNumber}
              onChange={(v) => updateRow(index, (p) => ({ ...p, partNumber: v }))}
            />
            <NumberCell
              value={part.topWidth}
              onChange={(v) =>
                updateRow(index, (p) =>
                  p.shapeType === "trapezoid" ? { ...p, topWidth: parsePositive(v, p.topWidth) } : p
                )
              }
            />
            <NumberCell
              value={part.bottomWidth}
              onChange={(v) =>
                updateRow(index, (p) =>
                  p.shapeType === "trapezoid"
                    ? { ...p, bottomWidth: parsePositive(v, p.bottomWidth) }
                    : p
                )
              }
            />
            <NumberCell
              value={part.height}
              onChange={(v) =>
                updateRow(index, (p) =>
                  p.shapeType === "trapezoid" ? { ...p, height: parsePositive(v, p.height) } : p
                )
              }
            />
            <NumberCell
              value={part.quantity}
              onChange={(v) =>
                updateRow(index, (p) => ({ ...p, quantity: parseQty(v, p.quantity) }))
              }
              min="1"
              step="1"
            />
            <DeleteCell onClick={() => removeRow(index)} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
