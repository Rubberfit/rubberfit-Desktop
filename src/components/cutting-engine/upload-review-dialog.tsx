import { useState, useEffect } from "react"
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
import type { ExtractedPart } from "@/types/vision"

interface UploadReviewDialogProps {
  open: boolean
  parts: ExtractedPart[]
  warnings: string[]
  stockWidth?: number
  onConfirm: (parts: ExtractedPart[]) => void
  onCancel: () => void
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

  const updateField = (index: number, field: keyof ExtractedPart, value: string) => {
    setParts((prev) =>
      prev.map((p, i) => {
        if (i !== index) return p
        const num = Number(value)
        if (field === "partNumber") return { ...p, partNumber: value }
        if (!Number.isFinite(num) || num < 0) return p
        return { ...p, [field]: field === "quantity" ? Math.max(1, Math.round(num)) : num }
      })
    )
  }

  const removeRow = (index: number) => {
    setParts((prev) => prev.filter((_, i) => i !== index))
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
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

        <div className="flex-1 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[100px]">Part #</TableHead>
                <TableHead className="w-[90px]">Width</TableHead>
                <TableHead className="w-[90px]">Length</TableHead>
                <TableHead className="w-[70px]">Qty</TableHead>
                <TableHead className="w-[40px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {parts.map((part, index) => (
                <TableRow key={index}>
                  <TableCell>
                    <input
                      className="w-full rounded border border-border bg-transparent px-1.5 py-1 text-sm"
                      value={part.partNumber ?? ""}
                      onChange={(e) => updateField(index, "partNumber", e.target.value)}
                      placeholder="\u2014"
                    />
                  </TableCell>
                  <TableCell>
                    <input
                      type="number"
                      className="w-full rounded border border-border bg-transparent px-1.5 py-1 text-sm"
                      value={part.width}
                      onChange={(e) => updateField(index, "width", e.target.value)}
                      min="0"
                      step="0.125"
                    />
                  </TableCell>
                  <TableCell>
                    <input
                      type="number"
                      className="w-full rounded border border-border bg-transparent px-1.5 py-1 text-sm"
                      value={part.length}
                      onChange={(e) => updateField(index, "length", e.target.value)}
                      min="0"
                      step="0.125"
                    />
                  </TableCell>
                  <TableCell>
                    <input
                      type="number"
                      className="w-full rounded border border-border bg-transparent px-1.5 py-1 text-sm"
                      value={part.quantity}
                      onChange={(e) => updateField(index, "quantity", e.target.value)}
                      min="1"
                      step="1"
                    />
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => removeRow(index)}
                      className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label="Remove row"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
