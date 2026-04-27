// Thin TypeScript client for the `pack_job` Tauri command.
//
// Mirrors the IPC shape of rema-portal's `RustPackingService` but
// without the subprocess plumbing — the desktop build links rf-layout
// in-process, so all we do here is marshal the request through
// Tauri's `invoke(...)`.
//
// Phase-2 additions (deferred, see src-tauri/src/commands/pack.rs):
//   - progress events via `listen("pack-progress", ...)`
//   - cancellation via a sibling `cancel_pack(jobId)` command

import { invoke } from "@tauri-apps/api/core"

import type { PackRequest, PackResult } from "./types"

/**
 * Pack a single job in-process via the `pack_job` Tauri command.
 *
 * Rejects with an `Error` whose message is the Rust-side error
 * (flattened to a string by the command — see `pack.rs`).
 */
export async function packJob(request: PackRequest): Promise<PackResult> {
  return invoke<PackResult>("pack_job", { request })
}
