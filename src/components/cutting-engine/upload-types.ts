export type UploadStatus = "idle" | "uploading" | "processing" | "review" | "error"

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"])

const SPREADSHEET_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
])

export function isImageFile(file: File): boolean {
  return IMAGE_MIMES.has(file.type) || /\.(jpe?g|png|webp|pdf)$/i.test(file.name)
}

export function isSpreadsheetFile(file: File): boolean {
  return SPREADSHEET_MIMES.has(file.type) || /\.(xlsx?|csv)$/i.test(file.name)
}

export const ACCEPTED_FILE_TYPES = [...IMAGE_MIMES, ...SPREADSHEET_MIMES].join(",")

export const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
