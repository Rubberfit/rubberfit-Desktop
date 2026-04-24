// engine/crates/rf-layout/src/infrastructure/search/terminator.rs
//
// Ported from sparrow's `src/util/terminator.rs` (MIT, Copyright 2025
// Jeroen Gardeyn, KU Leuven, ejor-snapshot tag c95454e3).
//
// `Terminator` is the abstract kill-switch for the GLS loop; Task 5's
// Separator already takes `&impl Terminator`. This file adds the
// `BasicTerminator` deadline impl that Task 8's `search::optimize`
// arms for the exploration phase (compression is identity per Task 7,
// so 100% of the budget goes to exploration).
//
// Task 14 will introduce an `AtomicBool`-backed cancel token that
// implements the same trait, so consumers (Separator, ExplorationPhase,
// CompressPhase) never change.
//
// Deviations from upstream:
//   - `jagua_rs::Instant` replaced with `std::time::Instant` — we do
//     not support wasm32 for pack-cli, so the jagua shim isn't needed.
//   - `Default` derive kept for parity.
//   - Inclusive boundary: `kill()` uses `now >= deadline` instead of
//     upstream's strict `now > deadline`. More defensive under coarse
//     system-clock resolution; within a nanosecond of the deadline the
//     behaviour is indistinguishable. Acceptable semantic drift.
//   - Trait surface trimmed: the `Terminator` trait in separator.rs
//     exposes only `kill()`, so upstream's `new_timeout` / `timeout_at`
//     are rendered dead code. They are available as inherent methods
//     on `BasicTerminator` (`set_timeout`, field access on `deadline`)
//     if callers ever need them, without polluting the trait.

use crate::infrastructure::search::gls::separator::Terminator;
use std::time::{Duration, Instant};

/// A deadline-backed `Terminator`. Constructed with a timeout; `kill()`
/// returns true once the timeout elapses. Used by the Task 8
/// orchestrator to cap the exploration phase at the full per-bin
/// budget (compression is identity per Task 7).
#[derive(Debug, Clone, Default)]
pub struct BasicTerminator {
    pub deadline: Option<Instant>,
}

impl BasicTerminator {
    /// Terminator with no deadline — never fires. Useful for tests.
    pub fn new() -> Self {
        Self { deadline: None }
    }

    /// Terminator that fires after the given duration has elapsed from
    /// *this call*.
    pub fn with_timeout(timeout: Duration) -> Self {
        Self {
            deadline: Some(Instant::now() + timeout),
        }
    }

    /// Replace or set the deadline, measured from now.
    pub fn set_timeout(&mut self, timeout: Duration) {
        self.deadline = Some(Instant::now() + timeout);
    }
}

impl Terminator for BasicTerminator {
    fn kill(&self) -> bool {
        self.deadline.is_some_and(|t| Instant::now() >= t)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;

    #[test]
    fn no_deadline_never_kills() {
        let t = BasicTerminator::new();
        assert!(!t.kill());
    }

    #[test]
    fn fires_after_deadline() {
        let t = BasicTerminator::with_timeout(Duration::from_millis(10));
        assert!(!t.kill(), "should not fire immediately");
        sleep(Duration::from_millis(25));
        assert!(t.kill(), "should fire after deadline");
    }

    #[test]
    fn set_timeout_rearms() {
        let mut t = BasicTerminator::with_timeout(Duration::from_nanos(1));
        sleep(Duration::from_millis(2));
        assert!(t.kill());
        t.set_timeout(Duration::from_secs(60));
        assert!(!t.kill(), "re-armed deadline should reset the kill state");
    }
}
