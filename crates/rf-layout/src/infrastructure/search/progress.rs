// engine/crates/rf-layout/src/infrastructure/search/progress.rs
//
// Task 14: progress streaming primitives.
//
// Codex-locked shape:
//   - Schema uses `best_active_stock_density` (NOT overall_density) â€”
//     the latter is invariant after FFD and produces dead-frame streams.
//   - Filter lives in optimize_multi, NOT SolutionListener. SolutionListener
//     only receives &LayoutSnapshot, which lacks global state.
//   - Callback invocation wrapped in catch_unwind; first panic sets
//     `callbacks_disabled = true` and all future emits are no-ops.
//
// See docs/superpowers/plans/2026-04-18-s2.5-task14-progress-cancel.md.

use crate::domain::{Bin, Part};
use crate::infrastructure::search::assignment::ffd::FfdAssignment;
use serde::Serialize;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;

/// User-provided progress callback. Called from the search thread on
/// each monotonic global incumbent change. Must be cheap (enqueue or
/// trivial write); blocking I/O will stall search.
pub type ProgressCallback = Arc<dyn Fn(PackProgress) + Send + Sync>;

/// One NDJSON-ready progress frame.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackProgress {
    /// Emission-sequence counter (NOT raw GLS iteration). Starts at 0
    /// for the baseline frame, increments by 1 per emitted frame.
    pub iteration: u64,
    /// Wall-clock elapsed since `pack_with_options` started.
    pub elapsed_ms: u64,
    /// Total placed copies across all bins.
    pub best_placed_count: u32,
    /// Active-stock density: sum_placed_area / sum_stock_area_of_non_empty_bins.
    /// Increases when operators close bins (denominator shrinks).
    pub best_active_stock_density: f64,
    /// Phase label. Wire-level string (NOT enum) for semver safety.
    /// Current values: "explore" | "compress". No "operator" per
    /// parent spec contract.
    pub phase: String,
}

/// Monotonic filter + callback wrapper. Owned by `optimize_multi`.
///
/// Codex sign-off Â§4: permanent-disable flag is load-bearing. After
/// the first callback panic, `callbacks_disabled=true` and every
/// future emit is a silent no-op.
pub struct ProgressEmitter {
    callback: Option<ProgressCallback>,
    started_at: std::time::Instant,
    emit_seq: u64,
    last: Option<(u32, f64)>,
    callbacks_disabled: bool,
}

impl ProgressEmitter {
    pub fn new(callback: Option<ProgressCallback>, started_at: std::time::Instant) -> Self {
        Self {
            callback,
            started_at,
            emit_seq: 0,
            last: None,
            callbacks_disabled: false,
        }
    }

    /// Emit the baseline frame. Called once at the start of
    /// `pack_with_options`. Always fires (first report exception).
    pub fn emit_baseline(
        &mut self,
        assignment: &FfdAssignment,
        bins: &[Bin],
        items: &[Part],
        phase: &str,
    ) {
        let (placed, density) = compute_progress_stats(assignment, bins, items);
        self.emit_unconditional(placed, density, phase);
    }

    /// Offer a new candidate frame. Emits only if strictly monotonic
    /// over `(placed_count, active_stock_density + 1e-6)`.
    pub fn offer(&mut self, assignment: &FfdAssignment, bins: &[Bin], items: &[Part], phase: &str) {
        if self.callback.is_none() || self.callbacks_disabled {
            return;
        }
        let (placed, density) = compute_progress_stats(assignment, bins, items);
        let emit = match self.last {
            None => true,
            Some((lp, ld)) => placed > lp || (placed == lp && density > ld + 1e-6),
        };
        if emit {
            self.emit_unconditional(placed, density, phase);
        }
    }

    fn emit_unconditional(&mut self, placed: u32, density: f64, phase: &str) {
        if self.callbacks_disabled {
            return;
        }
        let frame = PackProgress {
            iteration: self.emit_seq,
            elapsed_ms: self.started_at.elapsed().as_millis() as u64,
            best_placed_count: placed,
            best_active_stock_density: density,
            phase: phase.to_string(),
        };
        if let Some(cb) = self.callback.as_ref() {
            let cb = cb.clone();
            let result = catch_unwind(AssertUnwindSafe(|| cb(frame.clone())));
            if result.is_err() {
                // First panic â€” disable all future emits for this run.
                // Don't repeatedly pay the catch_unwind + callback cost
                // on a poisoned user callback.
                self.callbacks_disabled = true;
                log::warn!(
                    "pack_with_options: progress callback panicked on emit \
                     iteration={}; disabling further emits for this run",
                    self.emit_seq
                );
                return;
            }
        }
        self.last = Some((placed, density));
        self.emit_seq += 1;
    }

    /// For test inspection only.
    #[cfg(test)]
    pub fn emit_seq(&self) -> u64 {
        self.emit_seq
    }

    /// For test inspection only.
    #[cfg(test)]
    pub fn callbacks_disabled(&self) -> bool {
        self.callbacks_disabled
    }
}

/// Shoelace polygon area (absolute). Matches `pack.rs`'s private helper.
fn polygon_area(poly: &[rf_geom::domain::Point2D]) -> f64 {
    let mut s = 0.0;
    for i in 0..poly.len() {
        let a = poly[i];
        let b = poly[(i + 1) % poly.len()];
        s += a.x * b.y - b.x * a.y;
    }
    s.abs() / 2.0
}

/// Compute `(total_placed_count, active_stock_density)` for a given
/// assignment. `active_stock_density = sum_placed_area / sum_stock_of_
/// non_empty_bins`.
fn compute_progress_stats(assignment: &FfdAssignment, bins: &[Bin], items: &[Part]) -> (u32, f64) {
    // Pre-compute item area by shape_id for fast lookup.
    let mut area_by_shape: std::collections::HashMap<&str, f64> =
        std::collections::HashMap::with_capacity(items.len());
    for p in items {
        area_by_shape.insert(p.shape_id.as_str(), polygon_area(p.polygon_slice()));
    }

    let mut total_placed: u32 = 0;
    let mut total_placed_area = 0.0_f64;
    let mut total_active_stock = 0.0_f64;

    for (i, seed) in assignment.per_bin.iter().enumerate() {
        if seed.placements.is_empty() {
            continue;
        }
        total_placed += seed.placements.len() as u32;
        for placement in &seed.placements {
            total_placed_area += area_by_shape
                .get(placement.shape_id.as_str())
                .copied()
                .unwrap_or(0.0);
        }
        total_active_stock += bins[i].width * bins[i].height;
    }

    let density = if total_active_stock > 0.0 {
        total_placed_area / total_active_stock
    } else {
        0.0
    };
    (total_placed, density)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{BinKind, Part};
    use crate::infrastructure::warm_start::{SeedPlacement, SeedResult};
    use rf_geom::domain::Point2D;
    use std::sync::Mutex;
    use std::time::Instant;

    fn test_bin(id: &str, w: f64, h: f64) -> Bin {
        Bin {
            bin_id: id.into(),
            width: w,
            height: h,
            kind: BinKind::Fresh,
            priority: None,
        }
    }

    fn test_part(id: &str, qty: u32, w: f64, h: f64) -> Part {
        Part {
            shape_id: id.into(),
            quantity: qty,
            polygon: Some(vec![
                Point2D::new(0.0, 0.0),
                Point2D::new(w, 0.0),
                Point2D::new(w, h),
                Point2D::new(0.0, h),
            ]),
            shape_spec: None,
            allow_rotation: false,
            grain_axis: None,
            difficulty: None,
            tag: None,
        }
    }

    fn seed_with_one_placement(w: f64, h: f64) -> SeedResult {
        SeedResult {
            placements: vec![SeedPlacement {
                shape_id: "r".into(),
                instance_index: 0,
                bin_id: "b".into(),
                x: 0.0,
                y: 0.0,
                rotation_rad: 0.0,
                polygon: vec![
                    Point2D::new(0.0, 0.0),
                    Point2D::new(w, 0.0),
                    Point2D::new(w, h),
                    Point2D::new(0.0, h),
                ],
                width: w,
                height: h,
            }],
            overflow: 0,
        }
    }

    #[test]
    fn baseline_emits_once_and_advances_seq() {
        let calls: Arc<Mutex<Vec<PackProgress>>> = Arc::new(Mutex::new(vec![]));
        let calls_clone = calls.clone();
        let cb: ProgressCallback = Arc::new(move |p| calls_clone.lock().unwrap().push(p));

        let bins = vec![test_bin("b", 50.0, 50.0)];
        let items = vec![test_part("r", 1, 10.0, 10.0)];
        let assn = FfdAssignment {
            per_bin: vec![seed_with_one_placement(10.0, 10.0)],
            overflow: vec![],
        };

        let mut emitter = ProgressEmitter::new(Some(cb), Instant::now());
        emitter.emit_baseline(&assn, &bins, &items, "explore");

        let fired = calls.lock().unwrap();
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].iteration, 0);
        assert_eq!(fired[0].best_placed_count, 1);
        assert_eq!(emitter.emit_seq(), 1);
    }

    #[test]
    fn offer_filters_non_monotonic() {
        let calls: Arc<Mutex<Vec<PackProgress>>> = Arc::new(Mutex::new(vec![]));
        let calls_clone = calls.clone();
        let cb: ProgressCallback = Arc::new(move |p| calls_clone.lock().unwrap().push(p));

        let bins = vec![test_bin("b", 50.0, 50.0)];
        let items = vec![test_part("r", 1, 10.0, 10.0)];
        let assn = FfdAssignment {
            per_bin: vec![seed_with_one_placement(10.0, 10.0)],
            overflow: vec![],
        };

        let mut emitter = ProgressEmitter::new(Some(cb), Instant::now());
        emitter.emit_baseline(&assn, &bins, &items, "explore");
        // Same assignment offered again â€” filter should drop.
        emitter.offer(&assn, &bins, &items, "explore");
        emitter.offer(&assn, &bins, &items, "explore");

        let fired = calls.lock().unwrap();
        assert_eq!(
            fired.len(),
            1,
            "only baseline should emit on unchanged state"
        );
    }

    #[test]
    fn callback_panic_disables_subsequent_emits() {
        let cb: ProgressCallback = Arc::new(|_| panic!("boom"));

        let bins = vec![test_bin("b", 50.0, 50.0)];
        let items = vec![test_part("r", 1, 10.0, 10.0)];
        let assn = FfdAssignment {
            per_bin: vec![seed_with_one_placement(10.0, 10.0)],
            overflow: vec![],
        };

        let mut emitter = ProgressEmitter::new(Some(cb), Instant::now());
        emitter.emit_baseline(&assn, &bins, &items, "explore");
        assert!(
            emitter.callbacks_disabled(),
            "panic on first emit must set callbacks_disabled"
        );

        // Subsequent emits are no-ops, don't panic again.
        emitter.offer(&assn, &bins, &items, "explore");
    }

    #[test]
    fn serialization_matches_camelcase() {
        let frame = PackProgress {
            iteration: 5,
            elapsed_ms: 120,
            best_placed_count: 3,
            best_active_stock_density: 0.42,
            phase: "explore".into(),
        };
        let json = serde_json::to_string(&frame).unwrap();
        assert!(json.contains("\"iteration\":5"));
        assert!(json.contains("\"elapsedMs\":120"));
        assert!(json.contains("\"bestPlacedCount\":3"));
        assert!(json.contains("\"bestActiveStockDensity\":0.42"));
        assert!(json.contains("\"phase\":\"explore\""));
    }

    #[test]
    fn active_stock_density_excludes_empty_bins() {
        let bins = vec![
            test_bin("A", 10.0, 10.0),   // will have placement
            test_bin("B", 100.0, 100.0), // empty
        ];
        let items = vec![test_part("r", 1, 10.0, 10.0)];
        let assn = FfdAssignment {
            per_bin: vec![
                seed_with_one_placement(10.0, 10.0),
                SeedResult {
                    placements: vec![],
                    overflow: 0,
                },
            ],
            overflow: vec![],
        };
        let (placed, density) = compute_progress_stats(&assn, &bins, &items);
        assert_eq!(placed, 1);
        // active stock = only A's 100; placed_area = 100. density = 1.0.
        assert!(
            (density - 1.0).abs() < 1e-9,
            "empty bin B should be excluded from denominator; got density={density}"
        );
    }
}
