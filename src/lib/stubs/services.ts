// STUB: was @/src/infrastructure/services/* — desktop has no
// Supabase, no Edge Functions, no notification queue. The exported
// shapes match the symbols actually imported by the cutting-engine
// UI; every method throws at runtime.
//
// The wave-2 page agents (Auto Nest / Free Roam) decide whether to
// replace these with real desktop equivalents (e.g. Tauri-side
// vision extraction via `invoke("extract_from_image", ...)`) or to
// gate the calling UI behind a "Desktop only" notice.

import type { ExtractedPart, VisionExtractionResponse } from "@/types/vision"
import type { CutHistory } from "@/types/supabase-models"

const DESKTOP_NOT_IMPLEMENTED = "Not implemented on desktop"

// ── visionExtractionService ─────────────────────────────────────────
// Real implementation in rema posts the image to a Supabase Edge
// Function that calls Claude. On desktop the equivalent will likely
// run client-side or via a Tauri command — TBD by wave-2.

export async function extractFromImage(_file: File | Blob): Promise<VisionExtractionResponse> {
  throw new Error(DESKTOP_NOT_IMPLEMENTED)
}

export const visionExtractionService = {
  extractFromImage,
}

// Re-export the type so callers that pulled `ExtractedPart` from the
// service file (rather than the types file) keep compiling.
export type { ExtractedPart, VisionExtractionResponse }

// ── cutHistoryService ───────────────────────────────────────────────
// Rema uploads cut PDFs to Supabase Storage. Desktop will save to a
// local path via Tauri's dialog plugin — see the comment in
// cut-history-pdf.ts for the wave-2 wiring point.

export async function uploadCutPdf(_cutId: string, _userId: string, _pdfBlob: Blob): Promise<void> {
  throw new Error(DESKTOP_NOT_IMPLEMENTED)
}

export async function fetchCutHistory(_id: string): Promise<CutHistory | null> {
  throw new Error(DESKTOP_NOT_IMPLEMENTED)
}

export async function listCutHistory(_filters?: {
  source?: "auto" | "manual"
}): Promise<CutHistory[]> {
  throw new Error(DESKTOP_NOT_IMPLEMENTED)
}

export const cutHistoryService = {
  uploadCutPdf,
  fetchCutHistory,
  listCutHistory,
}

// ── notificationService / materialTypeService ──────────────────────
// Not currently imported by the components that survived the deletion
// pass, but stubs are listed here so wave-2 agents have a single file
// to extend rather than scattering throwers across the tree.

export const notificationService = {
  async sendLowStock(): Promise<void> {
    throw new Error(DESKTOP_NOT_IMPLEMENTED)
  },
  async sendCutCompleted(): Promise<void> {
    throw new Error(DESKTOP_NOT_IMPLEMENTED)
  },
}

export const materialTypeService = {
  async listAll(): Promise<unknown[]> {
    throw new Error(DESKTOP_NOT_IMPLEMENTED)
  },
}

// ── Supabase client placeholder ─────────────────────────────────────
// `supabase` was imported as the singleton client. Surviving call
// sites only used `supabase.auth.getUser()` (in cut-history-pdf —
// since rewritten). This stub exists so any leftover reference
// surfaces a clear runtime error rather than a TS-2305 at compile.

export const supabase = {
  auth: {
    async getUser(): Promise<{ data: { user: null }; error: Error }> {
      return { data: { user: null }, error: new Error(DESKTOP_NOT_IMPLEMENTED) }
    },
  },
}
