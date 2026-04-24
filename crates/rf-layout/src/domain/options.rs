// engine/crates/rf-layout/src/domain/options.rs
//
// Task 14: public `SearchOptions` struct.
//
// Carries out-of-band runtime hooks (progress callback + cancel token)
// that can't live on `PackRequest` because that type is Serialize +
// Deserialize, and Arc<dyn Fn> / Arc<AtomicBool> aren't serializable.
//
// Codex sign-off §2 / plan §2: `SearchOptions` is the new public seam
// above `OptimizerConfig`. pack-cli (Task 15) attaches hooks via this.
// Internal crates never store SearchOptions on request objects — the
// hooks are threaded separately.

use crate::infrastructure::search::cancel::CancelToken;
use crate::infrastructure::search::progress::ProgressCallback;

/// Runtime hooks for a single `pack_with_options` invocation.
///
/// `Default::default()` = no callback, no cancel — equivalent to
/// today's `pack()` behavior. pack-cli's `--stream` mode constructs
/// a non-default `SearchOptions` with a `ProgressCallback` that
/// serializes `PackProgress` frames to NDJSON stdout.
#[derive(Clone, Default)]
pub struct SearchOptions {
    /// Called once per monotonic global incumbent change. Must be
    /// cheap (enqueue or trivial write). Panics caught via
    /// `catch_unwind`; on first panic, further emits are silently
    /// dropped for the rest of the run.
    pub progress_callback: Option<ProgressCallback>,
    /// Flipping this to `true` signals cooperative cancellation.
    /// `pack_with_options` returns `Ok(PackResult { was_cancelled:
    /// true, .. })` with best-so-far placements preserved.
    pub cancel_token: Option<CancelToken>,
}

impl std::fmt::Debug for SearchOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SearchOptions")
            .field(
                "progress_callback",
                &self.progress_callback.as_ref().map(|_| "<callback>"),
            )
            .field("cancel_token", &self.cancel_token.is_some())
            .finish()
    }
}
