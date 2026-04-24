// Ported verbatim from rema-portal src/application/vision/types.ts.
// Pure TS types — no runtime deps. Used by cut-list-upload.tsx and
// upload-review-dialog.tsx to describe the shape of parts extracted
// from a cut-list image or spreadsheet upload.

export interface ExtractedPart {
  width: number
  length: number
  quantity: number
  partNumber?: string
  confidence: number
  stockWidth?: number
}

export interface VisionExtractionResponse {
  parts: ExtractedPart[]
  warnings: string[]
  stockWidth?: number
}
