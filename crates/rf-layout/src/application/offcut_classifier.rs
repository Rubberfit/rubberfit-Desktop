// engine/crates/rf-layout/src/application/offcut_classifier.rs
//
// Single source of truth for the reusable-offcut thresholds. Both
// `polish.rs` (internal Fab-Score proxy used during placement
// optimization) and `free_space.rs` (post-pack extractor that
// populates `BinResult.offcuts`) classify rectangles against the
// same dimensional rules.
//
// Thresholds are a direct port of `nesting/free-space.ts`:
//   - 11.5″ × 12″ qualifies as a reusable offcut (in either orientation)
//   - 6″ × 24″ qualifies as a reusable strip   (in either orientation)
//
// Anything below both thresholds in either orientation is `Scrap`.

use crate::domain::OffcutKind;

/// Minimum reusable offcut: 11.5″ × 12″ in either orientation.
pub const MIN_REUSABLE_OFFCUT_W: f64 = 11.5;
pub const MIN_REUSABLE_OFFCUT_H: f64 = 12.0;

/// Minimum reusable strip: 6″ × 24″ in either orientation.
pub const MIN_REUSABLE_STRIP_W: f64 = 6.0;
pub const MIN_REUSABLE_STRIP_H: f64 = 24.0;

/// Classify a rectangle of `width × height` into `Reusable` or `Scrap`
/// using the production thresholds. Orientation-agnostic: a 12 × 11.5
/// rect classifies the same as an 11.5 × 12 rect.
pub fn classify_rect(width: f64, height: f64) -> OffcutKind {
    let fits = |w: f64, h: f64| (width >= w && height >= h) || (width >= h && height >= w);
    if fits(MIN_REUSABLE_OFFCUT_W, MIN_REUSABLE_OFFCUT_H)
        || fits(MIN_REUSABLE_STRIP_W, MIN_REUSABLE_STRIP_H)
    {
        OffcutKind::Reusable
    } else {
        OffcutKind::Scrap
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meets_offcut_threshold() {
        assert_eq!(classify_rect(12.0, 12.0), OffcutKind::Reusable);
        assert_eq!(classify_rect(20.0, 11.5), OffcutKind::Reusable);
    }

    #[test]
    fn meets_strip_threshold_in_either_orientation() {
        assert_eq!(classify_rect(6.0, 24.0), OffcutKind::Reusable);
        assert_eq!(classify_rect(24.0, 6.0), OffcutKind::Reusable);
    }

    #[test]
    fn below_all_thresholds_is_scrap() {
        assert_eq!(classify_rect(5.0, 5.0), OffcutKind::Scrap);
        assert_eq!(classify_rect(11.0, 11.0), OffcutKind::Scrap);
        assert_eq!(classify_rect(5.99, 23.99), OffcutKind::Scrap);
    }

    #[test]
    fn zero_or_negative_is_scrap() {
        assert_eq!(classify_rect(0.0, 0.0), OffcutKind::Scrap);
        assert_eq!(classify_rect(-1.0, 100.0), OffcutKind::Scrap);
    }
}
