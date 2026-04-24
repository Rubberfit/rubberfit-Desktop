import React, { useState, useRef, useCallback } from "react"
import { Upload, FileSpreadsheet, Image, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import type { ExtractedPart } from "@/types/vision"
import type { UploadStatus } from "./upload-types"
import { isImageFile, isSpreadsheetFile, ACCEPTED_FILE_TYPES, MAX_FILE_SIZE } from "./upload-types"
import { parseSpreadsheet } from "./spreadsheet-parser"
import { extractFromImage } from "@/lib/stubs/services"
import UploadReviewDialog from "./upload-review-dialog"

const MAX_IMAGE_DIMENSION = 4096
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024 // 3.5MB target → ~4.7MB after base64 (under Anthropic 5MB limit)

function compressImage(file: File): Promise<File> {
  if (file.type === "application/pdf") return Promise.resolve(file)
  if (file.size <= MAX_IMAGE_BYTES) return Promise.resolve(file)

  return new Promise((resolve, reject) => {
    const img = new window.Image()
    const objectUrl = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      let { width, height } = img
      const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height))
      width = Math.round(width * scale)
      height = Math.round(height * scale)

      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext("2d")
      if (!ctx) return reject(new Error("Canvas not supported"))
      ctx.drawImage(img, 0, 0, width, height)

      const tryCompress = (quality: number) => {
        canvas.toBlob(
          (blob) => {
            if (!blob) return reject(new Error("Compression failed"))
            if (blob.size > MAX_IMAGE_BYTES && quality > 0.4) {
              tryCompress(quality - 0.1)
              return
            }
            resolve(new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" }))
          },
          "image/jpeg",
          quality
        )
      }
      tryCompress(0.92)
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error("Failed to load image for compression"))
    }
    img.src = objectUrl
  })
}

interface CutListUploadProps {
  onPartsConfirmed: (parts: ExtractedPart[], stockWidth?: number) => void
}

export default function CutListUpload({ onPartsConfirmed }: CutListUploadProps) {
  const [status, setStatus] = useState<UploadStatus>("idle")
  const [extractedParts, setExtractedParts] = useState<ExtractedPart[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [stockWidth, setStockWidth] = useState<number | undefined>()
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const processFile = useCallback(async (file: File) => {
    if (file.size > MAX_FILE_SIZE) {
      toast.error(`File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.`)
      return
    }

    setStatus("processing")
    try {
      if (isSpreadsheetFile(file)) {
        const parts = await parseSpreadsheet(file)
        if (parts.length === 0) {
          toast.error("No valid dimensions found in spreadsheet.")
          setStatus("idle")
          return
        }
        setExtractedParts(parts)
        setWarnings([])
        setStockWidth(undefined)
        setStatus("review")
      } else if (isImageFile(file)) {
        const compressed = await compressImage(file)
        // TODO: wire client-side vision or a Tauri command — currently throws on desktop.
        const result = await extractFromImage(compressed)
        if (!result.parts || result.parts.length === 0) {
          toast.error("No dimensions could be extracted from the image.")
          setStatus("idle")
          return
        }
        setExtractedParts(result.parts)
        setWarnings(result.warnings || [])
        setStockWidth(result.stockWidth)
        setStatus("review")
      } else {
        toast.error(
          "Unsupported file type. Use images (JPG, PNG, PDF) or spreadsheets (XLSX, CSV)."
        )
        setStatus("idle")
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to process file"
      toast.error(message)
      setStatus("error")
      setTimeout(() => setStatus("idle"), 2000)
    }
  }, [])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) processFile(file)
    if (inputRef.current) inputRef.current.value = ""
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) processFile(file)
  }

  const handleConfirm = (parts: ExtractedPart[]) => {
    onPartsConfirmed(parts, stockWidth)
    setStatus("idle")
    setExtractedParts([])
    toast.success(`${parts.length} part${parts.length !== 1 ? "s" : ""} added to cut planner.`)
  }

  const handleCancel = () => {
    setStatus("idle")
    setExtractedParts([])
  }

  const isProcessing = status === "processing"

  return (
    <>
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`rounded-lg border-2 border-dashed p-4 text-center transition-colors ${
          dragOver
            ? "border-blue-400 bg-blue-50 dark:bg-blue-900/10"
            : "border-border hover:border-slate-400 dark:hover:border-slate-600"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_FILE_TYPES}
          onChange={handleFileChange}
          className="sr-only"
          id="cut-list-upload"
          disabled={isProcessing}
        />

        {isProcessing ? (
          <div className="flex flex-col items-center gap-2 py-2">
            <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
            <span className="text-sm text-muted-foreground">Extracting dimensions...</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 py-1">
            <div className="flex items-center gap-3 text-muted-foreground">
              <Image className="h-5 w-5" />
              <Upload className="h-5 w-5" />
              <FileSpreadsheet className="h-5 w-5" />
            </div>
            <p className="text-sm text-muted-foreground">
              Drop a cut list image or spreadsheet here
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              className="mt-1"
            >
              Browse Files
            </Button>
            <p className="text-[11px] text-muted-foreground/70">
              JPG, PNG, PDF, XLSX, CSV - Max 10MB
            </p>
          </div>
        )}
      </div>

      <UploadReviewDialog
        open={status === "review"}
        parts={extractedParts}
        warnings={warnings}
        stockWidth={stockWidth}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </>
  )
}
