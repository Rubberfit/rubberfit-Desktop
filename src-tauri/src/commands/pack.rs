// Tauri `pack_job` command — Phase 1 in-process bridge to the
// rf-layout packing engine.
//
// Architecture notes:
//
//   - rema-portal spawns `pack-cli` as a subprocess and talks to it
//     over JSON stdin/stdout (see `src/infrastructure/services/
//     RustPackingService.ts` in that repo). The desktop app links
//     rf-layout directly — no subprocess, no stdio framing, no
//     serialization round-trip beyond Tauri's own IPC.
//
//   - `rf_layout::application::pack::pack` is synchronous and
//     CPU-bound. We offload it to `tokio::task::spawn_blocking`
//     so long-running packs don't starve the Tauri runtime's
//     worker pool (UI messages, plugin events, etc.).
//
//   - Errors are flattened to `String` because `tauri::command`
//     requires `Serialize` on the Err branch. `PackError` is not
//     Serialize (it wraps foreign `thiserror::Error` types), so
//     `.to_string()` is the cleanest cross-IPC shape.
//
// Engine selection lives in `rf_layout::application::strategy`, not
// here. This command resolves a `NestingStrategy` from
// `request.engine` and delegates — adding a new pipeline never
// requires editing this file. Default (when `engine` is `None`) is
// LBF + LNS.
//
// Phase-2 TODOs (deferred):
//
//   - Progress streaming. rf-layout's `pack_with_options` takes a
//     `ProgressCallback`; pack-cli pipes those to NDJSON on stdout.
//     The Tauri equivalent is `app_handle.emit("pack-progress",
//     frame)`, but that requires threading an `AppHandle` through
//     the command + building a `ProgressCallback` that captures it.
//     Only the Legacy strategy exposes hooks today; LBF/LNS will
//     gain them in a follow-up.
//
//   - Cancellation. `SearchOptions::cancel_token` is an
//     `Arc<AtomicBool>`. To expose it to the frontend we'd either
//     (a) register a separate `cancel_pack(job_id)` command that
//     flips a token stored in app state keyed by `job_id`, or
//     (b) hand the frontend a Tauri channel and flip on drop.

use rf_layout::application::strategy_for;
use rf_layout::domain::{PackRequest, PackResult};

/// Pack a single job in-process. Returns the full `PackResult`
/// (placements + per-bin stats + free regions + classified offcuts)
/// on success, or a string error message on any failure (invalid
/// polygon, timeout, no bins, etc.).
#[tauri::command]
pub async fn pack_job(request: PackRequest) -> Result<PackResult, String> {
    let strategy = strategy_for(request.engine);

    // The pipeline is sync + CPU-bound — `spawn_blocking` keeps the
    // tokio runtime responsive while it runs. The outer `.await`
    // yields a `JoinError` if the blocking task panics; we surface
    // that as a readable string too.
    tokio::task::spawn_blocking(move || strategy.pack(request))
        .await
        .map_err(|join_err| format!("pack task panicked: {join_err}"))?
        .map_err(|pack_err| pack_err.to_string())
}
