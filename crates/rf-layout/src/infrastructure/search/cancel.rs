// engine/crates/rf-layout/src/infrastructure/search/cancel.rs
//
// Task 14: cooperative cancellation primitives.
//
// Cancel token is an Arc<AtomicBool>. Hot-loop polls use
// `load(Ordering::Relaxed)` — no paired memory publication is needed,
// so Relaxed is the correct ordering (Codex sign-off §8).
//
// CompositeTerminator composes BasicTerminator (deadline) with the
// cancel token. Separator's outer-strike-loop kill() path uses this
// composite. Inner-loop polls (inside move_items, per-worker, per-
// candidate search_placement) load the cancel AtomicBool directly
// for speed — they bypass the terminator trait entirely.
//
// See docs/superpowers/plans/2026-04-18-s2.5-task14-progress-cancel.md.

use crate::infrastructure::search::gls::separator::Terminator;
use crate::infrastructure::search::terminator::BasicTerminator;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// User-provided cancel token. Flipping `true` signals the search to
/// stop at the next polling site and return the best-so-far assignment.
pub type CancelToken = Arc<AtomicBool>;

/// Combined deadline + cancel `Terminator`. Outer strike-loop kill
/// path. Keeping BasicTerminator unchanged (Codex sign-off §2) means
/// deadline-only callers don't pay cancel-load cost.
pub struct CompositeTerminator {
    pub deadline: BasicTerminator,
    pub cancel: Option<CancelToken>,
}

impl CompositeTerminator {
    pub fn new(deadline: BasicTerminator, cancel: Option<CancelToken>) -> Self {
        Self { deadline, cancel }
    }
}

impl Terminator for CompositeTerminator {
    fn kill(&self) -> bool {
        self.deadline.kill()
            || self
                .cancel
                .as_ref()
                .is_some_and(|c| c.load(Ordering::Relaxed))
    }
}

/// Fast path for inner-loop polling sites that need to check cancel
/// without going through the `Terminator` trait (saves the deadline
/// `Instant::now()` cost on every iteration).
#[inline(always)]
pub fn is_cancelled(token: Option<&CancelToken>) -> bool {
    token.is_some_and(|t| t.load(Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn composite_kills_on_cancel_when_deadline_untriggered() {
        let deadline = BasicTerminator::with_timeout(Duration::from_secs(3600));
        let cancel = Arc::new(AtomicBool::new(false));
        let term = CompositeTerminator::new(deadline, Some(cancel.clone()));
        assert!(!term.kill());
        cancel.store(true, Ordering::Relaxed);
        assert!(term.kill());
    }

    #[test]
    fn composite_kills_on_deadline_when_cancel_none() {
        let deadline = BasicTerminator::with_timeout(Duration::from_nanos(1));
        std::thread::sleep(Duration::from_millis(1));
        let term = CompositeTerminator::new(deadline, None);
        assert!(term.kill());
    }

    #[test]
    fn is_cancelled_shortcuts_for_none() {
        assert!(!is_cancelled(None));
        let t = Arc::new(AtomicBool::new(false));
        assert!(!is_cancelled(Some(&t)));
        t.store(true, Ordering::Relaxed);
        assert!(is_cancelled(Some(&t)));
    }
}
