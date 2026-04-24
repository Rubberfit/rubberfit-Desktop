// Tauri command layer. Each submodule exposes `#[tauri::command]`
// functions that bridge the TypeScript frontend (`invoke(...)`) to
// in-process Rust services. Phase 1 ships `pack` only; future
// phases add progress streaming, cancellation tokens, and additional
// engine selection knobs.
pub mod pack;
