// Compat shim that lets cutting-engine code that was written against
// rema-portal's IPackingService (resolved via TSyringe DI) keep its
// existing call shape — `svc.pack(request).then(...)` — without
// pulling reflect-metadata / tsyringe / @/di/* on the desktop side.
//
// On desktop there is no DI container and there is only one packing
// implementation (`packJob` over Tauri IPC), so this module exposes a
// single `getPackingService()` factory that returns the same shape.
//
// The `signal`/`onProgress` plumbing is staged: the desktop pack_job
// command does not stream progress yet (see src-tauri/src/commands/
// pack.rs TODO), so callers can pass them but they're ignored. When
// progress events land on the Rust side, this is the file to update.

import { packJob } from "./client"
import type { PackProgress, PackRequest, PackResult } from "./types"

export interface PackOptions {
  onProgress?: (progress: PackProgress) => void
  signal?: AbortSignal
}

export interface IPackingService {
  pack(
    request: PackRequest,
    options?: PackOptions | ((progress: PackProgress) => void)
  ): Promise<PackResult>
  cancel(jobId: string): Promise<void>
}

export const PACKING_TOKENS = {
  IPackingService: Symbol.for("IPackingService"),
} as const

const desktopPackingService: IPackingService = {
  async pack(request: PackRequest, _options?: unknown): Promise<PackResult> {
    return packJob(request)
  },
  async cancel(_jobId: string): Promise<void> {
    // Cancellation is wave-2 — depends on a sibling Tauri command.
  },
}

export function getPackingService(): IPackingService {
  return desktopPackingService
}
