// engine/crates/rf-layout/src/infrastructure/warm_start.rs
use crate::domain::{Bin, PackError, Part};
use rf_geom::domain::Point2D;

/// Greedy bottom-left seeding: for each item, stack vertically starting at y=0.
/// Simple but produces a valid starting layout for sparrow's LNS.
/// This is the S2 MVP packer â€” sparrow integration lands in S2.5.
#[derive(Clone, Debug, PartialEq)]
pub struct SeedPlacement {
    pub shape_id: String,
    pub instance_index: u32,
    pub bin_id: String,
    pub x: f64,
    pub y: f64,
    pub rotation_rad: f64,
    pub polygon: Vec<Point2D>,
    pub width: f64,
    pub height: f64,
}

/// Result of greedy bottom-left seeding.
///
/// Carries the per-instance placements and the count of requested item
/// instances that did not fit on the bin. Overflow handling is Task 18's
/// responsibility (placing leftover instances on subsequent bins).
#[derive(Clone, Debug, PartialEq)]
pub struct SeedResult {
    pub placements: Vec<SeedPlacement>,
    /// Number of requested item instances that did not fit on this bin.
    pub overflow: u32,
}

/// Greedy bottom-left probe.
///
/// Used both as a warm-start seed for GLS and as a fit oracle for
/// assignment heuristics (Task 10 FFD, Task 11 cross-bin swap).
///
/// Clearance handling (Task 11 hardening):
///   - Width gate: items whose bbox width + 2*clearance exceeds
///     `bin.width` are rejected wholesale (all copies to overflow).
///   - Vertical stacking: each copy consumes `h + 2*clearance` of
///     vertical space. The emitted `y` coordinate is `cursor_y`
///     (the halo's bottom edge); the item's visible bottom sits at
///     `y + clearance`.
///
/// This is CONSERVATIVE vs jagua's exact `min_item_separation = c`
/// semantics (real stack of k copies needs `k*h + (k+1)*c`; we
/// reserve `k*h + 2*k*c`). The probe over-rejects by `(k-1)*c` on
/// deep stacks â€” acceptable for an assignment-time oracle; downstream
/// CDE in jagua handles exact clearance during placement.
///
/// See `docs/superpowers/plans/2026-04-18-s2.5-task11-cross-bin-swap.md`
/// Â§2 for the derivation + Codex sign-off at
/// `.claude/research/task11/codex-signoff.md`.
pub fn greedy_bottom_left(
    bin: &Bin,
    items: &[Part],
    clearance: f64,
) -> Result<SeedResult, PackError> {
    // Task 19a/19c/19d dispatcher:
    //   - Homogeneous single-shape inputs: 2D grid packer (Task 19a).
    //   - Heterogeneous inputs: `bin-packing` MaxRects BSSF (Task 19d) â€”
    //     replaces Task 19c's `rectangle-pack` which hit a single-bin
    //     ceiling at 12/37 parts on the production diagnostic. BSSF
    //     (JylÃ¤nki 2010) preserves larger reusable offcuts by biasing
    //     placement toward corner-tight fits, which closed the
    //     legacy-vs-Rust Fab Score gap on the single-bin bench
    //     (Rust 71 vs legacy 57).
    //   - Pathological inputs: vertical-stacker fallback keeps overflow
    //     accounting deterministic if the primary packer errors.
    //
    // Rotation: disabled (can_rotate=false on every demand) â€” matches
    // the rectangle-pack integration's effective behavior. Enabling
    // rotation requires validating jagua_adapter polygon + rotation_rad
    // round-trip, deferred to a follow-up.
    if items.len() == 1 {
        return greedy_2d_grid(bin, &items[0], clearance);
    }
    match greedy_rectangle_pack(bin, items, clearance) {
        Ok(result) => Ok(result),
        Err(_) => {
            // Fallback to vertical stacker on any packer error. Keeps
            // overflow accounting deterministic even if bin-packing
            // returns Infeasible2D.
            greedy_vertical_stack(bin, items, clearance)
        }
    }
}

/// Task 19d: heterogeneous 2D packer backed by `bin-packing` v0.3.0.
///
/// Replaces Task 19c's `rectangle-pack` integration, which fit only 12/37
/// parts on a 78Ã—396 single-bin production diagnostic. `bin-packing`'s
/// `Auto` strategy runs MaxRects (4 variants), Skyline (2), Guillotine
/// BSSF + shorter-leftover-axis, BFDH, Multistart, and RotationSearch in
/// one sweep and returns the best result ranked lexicographically on
/// `(unplaced, sheet_count, total_waste_area, total_cost, max_usable_drop_areaâ†‘, total_sum_sq_usable_drop_areasâ†‘)`.
/// The two consolidation tiebreakers directly reward reusable-offcut
/// preservation, which is REMA's top business metric.
///
/// Scales f64 coordinates to u32 via a fixed 10000x factor (1e4 â€” keeps
/// 78Ã—396 inputs well within u32::MAX while preserving 0.0001" precision).
/// SCALE is pinned across Task 19c/19d; changing it would invalidate
/// parity snapshots.
///
/// Rotation: disabled for v1 (`can_rotate = false` on every demand). The
/// prior rectangle-pack integration was also effectively no-rotation.
/// Rotation requires a polygon-rotation pass on the SeedPlacement output
/// â€” deferred until we have rotation-aware downstream tests.
///
/// Determinism: honors a fixed seed so `Multistart` + `RotationSearch`
/// produce bit-identical output. Seed is derived from a stable hash of
/// the inputs (bin + sorted (shape_id, qty) multiset) so the same probe
/// state always yields the same seed.
fn greedy_rectangle_pack(
    bin: &Bin,
    items: &[Part],
    clearance: f64,
) -> Result<SeedResult, PackError> {
    greedy_rectangle_pack_with_strategy(bin, items, clearance, PackerStrategy::Bssf)
}

/// Task 19d/Tier 6 strategy seam: per-bin packer family selector.
///
/// `Bssf` is the default used by the warm-start dispatcher (JylÃ¤nki BSSF â€”
/// biased toward corner-tight fits + large leftover rectangles, see
/// `greedy_rectangle_pack` docs). Tier 6's `consolidate_tail_bin`
/// operator uses `BottomLeft` as a secondary repack strategy because
/// it's directly biased toward lower occupied height â€” exactly what
/// tail preservation wants on the receiver bin.
#[derive(Clone, Copy, Debug)]
pub enum PackerStrategy {
    /// MaxRects BSSF â€” default warm-start + FFD probe.
    Bssf,
    /// MaxRects bottom-left â€” prefers low occupied height.
    BottomLeft,
    /// Auto + Multistart â€” full sweep of MaxRects variants + Skyline +
    /// Guillotine + randomized restarts. Expensive (~10Ã— BSSF runtime)
    /// but explores layouts the single heuristics miss. Reserved for
    /// Tier 6 tail-preservation receiver repack where the extra cost
    /// is worth one-shot-per-move.
    Auto,
}

/// Strategy-parameterized variant of `greedy_rectangle_pack`. Tier 6
/// operators call this with alternate strategies when repacking a
/// receiver bin from scratch. Keeping `greedy_rectangle_pack` as a thin
/// wrapper preserves the Task 19d dispatcher contract unchanged â€” FFD
/// + GLS + existing cross-bin operators never observe the new param.
pub fn greedy_rectangle_pack_with_strategy(
    bin: &Bin,
    items: &[Part],
    clearance: f64,
    strategy: PackerStrategy,
) -> Result<SeedResult, PackError> {
    use bin_packing::two_d::{
        solve_2d, RectDemand2D, Sheet2D, TwoDAlgorithm, TwoDOptions, TwoDProblem,
    };

    const SCALE: f64 = 10_000.0;

    let bin_w_scaled = (bin.width * SCALE).round() as u32;
    let bin_h_scaled = (bin.height * SCALE).round() as u32;

    // Quantize clearance into a kerf gap. bin-packing applies kerf as the
    // minimum separation between adjacent placements, which matches our
    // Task 11 conservative clearance semantics (each copy consumes an
    // h + 2c / w + 2c cell). Kerf-as-clearance is exactly right here
    // because edge-adjacent factory boundaries are already free.
    let kerf_scaled = ((clearance * 2.0) * SCALE).round() as u32;

    // Per-part metadata: bbox, visible dims, canonical polygon (at origin).
    // Used both for (a) building RectDemand2D inputs and (b) materializing
    // SeedPlacements after solve_2d returns.
    struct PartMeta {
        w_visible: f64,
        h_visible: f64,
        w_scaled: u32,
        h_scaled: u32,
        quantity: u32,
        polygon_canonical: Vec<Point2D>,
    }
    let mut part_meta: std::collections::BTreeMap<String, PartMeta> =
        std::collections::BTreeMap::new();
    let mut rejected_overflow: u32 = 0;

    for part in items {
        let bbox = rf_geom::application::bbox_of(part.polygon_slice()).map_err(|source| {
            PackError::InvalidPolygon {
                shape_id: part.shape_id.clone(),
                source,
            }
        })?;
        let w = bbox.1.x - bbox.0.x;
        let h = bbox.1.y - bbox.0.y;
        let w_eff = w + 2.0 * clearance;
        let h_eff = h + 2.0 * clearance;

        // Width/height gate: parts whose (w+2c,h+2c) exceeds the bin are
        // counted as overflow up-front â€” `solve_2d` would return
        // `Infeasible2D` otherwise.
        if w_eff > bin.width || h_eff > bin.height {
            rejected_overflow = rejected_overflow.saturating_add(part.quantity);
            continue;
        }

        part_meta.insert(
            part.shape_id.clone(),
            PartMeta {
                w_visible: w,
                h_visible: h,
                w_scaled: (w * SCALE).round() as u32,
                h_scaled: (h * SCALE).round() as u32,
                quantity: part.quantity,
                polygon_canonical: part
                    .polygon_slice()
                    .iter()
                    .map(|p| Point2D::new(p.x - bbox.0.x, p.y - bbox.0.y))
                    .collect(),
            },
        );
    }

    if part_meta.is_empty() {
        let total: u32 = items.iter().map(|p| p.quantity).sum();
        return Ok(SeedResult {
            placements: vec![],
            overflow: total,
        });
    }

    // Build TwoDProblem with one sheet + one demand per shape.
    let sheet = Sheet2D {
        name: bin.bin_id.clone(),
        width: bin_w_scaled,
        height: bin_h_scaled,
        cost: 1.0,
        quantity: Some(1),
        kerf: kerf_scaled,
        edge_kerf_relief: false,
    };
    let demands: Vec<RectDemand2D> = part_meta
        .iter()
        .map(|(shape_id, meta)| RectDemand2D {
            name: shape_id.clone(),
            width: meta.w_scaled,
            height: meta.h_scaled,
            quantity: meta.quantity as usize,
            // Rotation disabled for v1. Enabling it made the packer
            // return 11 placements instead of 12 on the production
            // fixture â€” Auto's RotationSearch sampling apparently can't
            // beat no-rotation MaxRects here. Revisit once we have
            // rotation-aware downstream validation (jagua round-trip
            // via PI/2 rotation_rad was not exercised in v1).
            can_rotate: false,
        })
        .collect();

    // Deterministic seed: hash the (bin_id, sorted demands) so identical
    // problems always produce identical output across runs. This also
    // means FFD probe calls with the same partial state get the same
    // layout â€” critical for the probe's fit oracle semantics.
    let seed: u64 = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        bin.bin_id.hash(&mut h);
        bin_w_scaled.hash(&mut h);
        bin_h_scaled.hash(&mut h);
        kerf_scaled.hash(&mut h);
        for d in &demands {
            d.name.hash(&mut h);
            d.width.hash(&mut h);
            d.height.hash(&mut h);
            d.quantity.hash(&mut h);
        }
        h.finish()
    };

    // RF thresholds for reusable offcut: 11.5Ã—12" and 6Ã—24". Use the
    // smaller of the two (6" = 60000 scaled) as min_usable_side so that
    // narrower strips don't contribute to the consolidation tiebreakers.
    // See CLAUDE.md.
    let min_usable_side: u32 = (6.0 * SCALE).round() as u32;

    // Algorithm choice: default `MaxRectsBestShortSideFit` (JylÃ¤nki 2010
    // Â§3.2). BSSF places each rect in the free rectangle that leaves the
    // smallest remainder on the SHORTER axis â€” biasing the layout
    // toward filling corners tightly and preserving large, clean
    // leftover rectangles on the longer axis. This is exactly REMA's
    // reusable-offcut objective.
    //
    // Tier 6 operators may override with `BottomLeft` when the goal is
    // to minimize occupied height on a receiver bin during consolidation.
    let algorithm = match strategy {
        PackerStrategy::Bssf => TwoDAlgorithm::MaxRectsBestShortSideFit,
        PackerStrategy::BottomLeft => TwoDAlgorithm::MaxRectsBottomLeft,
        PackerStrategy::Auto => TwoDAlgorithm::Auto,
    };
    let options = TwoDOptions {
        algorithm,
        seed: Some(seed),
        min_usable_side,
        ..TwoDOptions::default()
    };

    let solution = solve_2d(
        TwoDProblem {
            sheets: vec![sheet],
            demands,
        },
        options,
    )
    .map_err(|e| PackError::EngineFailed(format!("bin-packing solve_2d: {e}")))?;

    // Materialize placements. bin-packing's layouts are ordered by the
    // sheet ordering we supplied â€” single sheet here, so layouts[0] is
    // the only one (or none if solver placed nothing).
    let mut placements: Vec<SeedPlacement> = Vec::new();
    let mut per_shape_counter: std::collections::HashMap<String, u32> =
        std::collections::HashMap::new();

    if let Some(layout) = solution.layouts.first() {
        // Canonical emission order: sort by (y asc, x asc, name asc). Keeps
        // repeat runs bit-identical regardless of bin-packing's internal
        // ordering choices.
        let mut sorted: Vec<&bin_packing::two_d::Placement2D> = layout.placements.iter().collect();
        sorted.sort_by(|a, b| {
            a.y.cmp(&b.y)
                .then_with(|| a.x.cmp(&b.x))
                .then_with(|| a.name.cmp(&b.name))
        });

        for p in sorted {
            let meta = match part_meta.get(&p.name) {
                Some(m) => m,
                None => continue, // shouldn't happen; demand names track meta keys
            };
            let x_visible = (p.x as f64) / SCALE + clearance;
            let y_visible = (p.y as f64) / SCALE + clearance;

            let instance_index = *per_shape_counter
                .entry(p.name.clone())
                .and_modify(|c| *c += 1)
                .or_insert(0);

            // can_rotate=false invariant: bin-packing never sets
            // `p.rotated`. Translate canonical polygon directly.
            debug_assert!(!p.rotated, "rotation disabled in v1 demands");
            let polygon: Vec<Point2D> = meta
                .polygon_canonical
                .iter()
                .map(|pt| Point2D::new(pt.x + x_visible, pt.y + y_visible))
                .collect();

            placements.push(SeedPlacement {
                shape_id: p.name.clone(),
                instance_index,
                bin_id: bin.bin_id.clone(),
                x: x_visible,
                y: y_visible,
                rotation_rad: 0.0,
                polygon,
                width: meta.w_visible,
                height: meta.h_visible,
            });
        }
    }

    // Overflow accounting: `rejected_overflow` (parts whose bbox exceeds
    // the bin wholesale) is NOT passed to the solver, so it's not in
    // `placements.len()`. The solver's own unplaced count is implicit in
    // `total - placed`. Total overflow = everything we didn't place.
    let total_requested: u32 = items.iter().map(|p| p.quantity).sum();
    let _ = rejected_overflow; // folded into total - placed below
    Ok(SeedResult {
        overflow: total_requested.saturating_sub(placements.len() as u32),
        placements,
    })
}

/// Vertical-stack packer â€” original Task 11 implementation.
///
/// Fallback for heterogeneous bins. Stacks items at x=clearance,
/// advancing cursor_y by h_eff = h + 2*clearance per copy. Conservative
/// over-rejection on interior stacks (see rustdoc on
/// `greedy_bottom_left`).
fn greedy_vertical_stack(
    bin: &Bin,
    items: &[Part],
    clearance: f64,
) -> Result<SeedResult, PackError> {
    let mut placements = Vec::new();
    let mut cursor_y = 0.0f64;
    let mut overflow: u32 = 0;
    for part in items {
        let bbox = rf_geom::application::bbox_of(part.polygon_slice()).map_err(|source| {
            PackError::InvalidPolygon {
                shape_id: part.shape_id.clone(),
                source,
            }
        })?;
        let w = bbox.1.x - bbox.0.x;
        let h = bbox.1.y - bbox.0.y;
        let w_eff = w + 2.0 * clearance;
        let h_eff = h + 2.0 * clearance;

        if w_eff > bin.width {
            overflow += part.quantity;
            continue;
        }

        let mut placed_this_part: u32 = 0;
        for inst in 0..part.quantity {
            if cursor_y + h_eff > bin.height {
                break;
            }
            let y_visible = cursor_y + clearance;
            placements.push(SeedPlacement {
                shape_id: part.shape_id.clone(),
                instance_index: inst,
                bin_id: bin.bin_id.clone(),
                x: clearance,
                y: y_visible,
                rotation_rad: 0.0,
                polygon: part
                    .polygon_slice()
                    .iter()
                    .map(|p| Point2D::new(p.x - bbox.0.x + clearance, y_visible + (p.y - bbox.0.y)))
                    .collect(),
                width: w,
                height: h,
            });
            cursor_y += h_eff;
            placed_this_part += 1;
        }
        overflow += part.quantity - placed_this_part;
    }
    Ok(SeedResult {
        placements,
        overflow,
    })
}

/// 2D bbox-grid packer for homogeneous single-shape bins.
///
/// Divides the bin into `cols Ã— rows` bbox-aligned cells of size
/// `w_eff Ã— h_eff = (w + 2c) Ã— (h + 2c)`. Places copies row-major
/// (bottom-to-top, left-to-right) into the cells until capacity or
/// quantity runs out.
///
/// Correctness: cells are non-overlapping under the Task 11 conservative
/// clearance model â€” two adjacent copies' halos meet exactly at the
/// cell boundary, so downstream CDE collision detection will accept
/// them.
///
/// Deterministic: pure arithmetic, row-major scan, no RNG.
fn greedy_2d_grid(bin: &Bin, part: &Part, clearance: f64) -> Result<SeedResult, PackError> {
    let bbox = rf_geom::application::bbox_of(part.polygon_slice()).map_err(|source| {
        PackError::InvalidPolygon {
            shape_id: part.shape_id.clone(),
            source,
        }
    })?;
    let w = bbox.1.x - bbox.0.x;
    let h = bbox.1.y - bbox.0.y;
    let w_eff = w + 2.0 * clearance;
    let h_eff = h + 2.0 * clearance;

    if w_eff > bin.width || h_eff > bin.height {
        // Item doesn't even fit one copy.
        return Ok(SeedResult {
            placements: vec![],
            overflow: part.quantity,
        });
    }

    let cols = (bin.width / w_eff).floor() as u32;
    let rows = (bin.height / h_eff).floor() as u32;
    let capacity = cols.saturating_mul(rows);
    let placed_n = part.quantity.min(capacity);
    let overflow = part.quantity - placed_n;

    let mut placements = Vec::with_capacity(placed_n as usize);
    for k in 0..placed_n {
        let j = k / cols; // row
        let i = k % cols; // column
        let x_halo = (i as f64) * w_eff;
        let y_halo = (j as f64) * h_eff;
        let x_visible = x_halo + clearance;
        let y_visible = y_halo + clearance;
        placements.push(SeedPlacement {
            shape_id: part.shape_id.clone(),
            instance_index: k,
            bin_id: bin.bin_id.clone(),
            x: x_visible,
            y: y_visible,
            rotation_rad: 0.0,
            polygon: part
                .polygon_slice()
                .iter()
                .map(|p| Point2D::new(p.x - bbox.0.x + x_visible, y_visible + (p.y - bbox.0.y)))
                .collect(),
            width: w,
            height: h,
        });
    }

    Ok(SeedResult {
        placements,
        overflow,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::BinKind;

    fn rect_part(id: &str, qty: u32, w: f64, h: f64) -> Part {
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
            allow_rotation: true,
            grain_axis: None,
            difficulty: None,
            tag: None,
        }
    }

    fn bin(w: f64, h: f64) -> Bin {
        Bin {
            bin_id: "b1".into(),
            width: w,
            height: h,
            kind: BinKind::Fresh,
            priority: None,
        }
    }

    #[test]
    fn grid_places_items_row_major_no_clearance() {
        // Task 19a: homogeneous single-part inputs now route through the
        // 2D grid packer. 48-wide bin, 10-wide items â†’ cols=4; items
        // 0-3 land at y=0 with x=0/10/20/30. (Row-major ordering.)
        let b = bin(48.0, 96.0);
        let items = vec![rect_part("r", 3, 10.0, 5.0)];
        let result = greedy_bottom_left(&b, &items, 0.0).unwrap();
        let seeds = result.placements;
        assert_eq!(seeds.len(), 3);
        for s in &seeds {
            assert_eq!(s.y, 0.0, "all 3 copies fit in row 0");
        }
        assert_eq!(seeds[0].x, 0.0);
        assert_eq!(seeds[1].x, 10.0);
        assert_eq!(seeds[2].x, 20.0);
    }

    #[test]
    fn grid_places_items_with_clearance_halo() {
        // c=0.125, w=10, h=5 â†’ cells of 10.25Ã—5.25. cols=floor(48/10.25)=4.
        // Items 0-3 in row 0 at x={0.125, 10.375, 20.625, 30.875}, all y=0.125.
        let b = bin(48.0, 96.0);
        let items = vec![rect_part("r", 3, 10.0, 5.0)];
        let result = greedy_bottom_left(&b, &items, 0.125).unwrap();
        let seeds = result.placements;
        assert_eq!(seeds.len(), 3);
        for s in &seeds {
            assert!((s.y - 0.125).abs() < 1e-9, "row 0 @ y = clearance");
        }
        assert!((seeds[0].x - 0.125).abs() < 1e-9);
        assert!((seeds[1].x - 10.375).abs() < 1e-9);
        assert!((seeds[2].x - 20.625).abs() < 1e-9);
    }

    #[test]
    fn grid_wraps_to_next_row_when_cols_exhausted() {
        // 3-col bin, 7 items â†’ row 0 fills 3, row 1 fills 3, row 2 has 1.
        let b = bin(30.0, 30.0);
        let items = vec![rect_part("r", 7, 10.0, 10.0)];
        let result = greedy_bottom_left(&b, &items, 0.0).unwrap();
        let seeds = result.placements;
        assert_eq!(seeds.len(), 7);
        // Row 0: y=0, x = 0, 10, 20
        assert_eq!(seeds[0].y, 0.0);
        assert_eq!(seeds[0].x, 0.0);
        assert_eq!(seeds[1].x, 10.0);
        assert_eq!(seeds[2].x, 20.0);
        // Row 1: y=10, x = 0, 10, 20
        assert_eq!(seeds[3].y, 10.0);
        assert_eq!(seeds[3].x, 0.0);
        // Row 2: y=20, x = 0
        assert_eq!(seeds[6].y, 20.0);
        assert_eq!(seeds[6].x, 0.0);
    }

    #[test]
    fn grid_capacity_triggers_overflow() {
        // 30Ã—30 bin, 10Ã— 10Ã—10 items â†’ grid capacity = 9, overflow = 1.
        let b = bin(30.0, 30.0);
        let items = vec![rect_part("r", 10, 10.0, 10.0)];
        let result = greedy_bottom_left(&b, &items, 0.0).unwrap();
        assert_eq!(result.placements.len(), 9);
        assert_eq!(result.overflow, 1);
    }

    #[test]
    fn heterogeneous_uses_rectangle_pack() {
        // Task 19c: multi-part (heterogeneous) inputs now route through
        // rectangle-pack for 2D packing. Two 10Ã—5 parts on a 48Ã—96 bin
        // get placed without vertical stacking â€” rectangle-pack picks
        // positions based on its section-splitting heuristic.
        let b = bin(48.0, 96.0);
        let items = vec![rect_part("a", 1, 10.0, 5.0), rect_part("b", 1, 10.0, 5.0)];
        let result = greedy_bottom_left(&b, &items, 0.0).unwrap();
        let seeds = result.placements;
        assert_eq!(seeds.len(), 2, "both heterogeneous parts should fit");
        assert_eq!(result.overflow, 0);
        // Placements should be within the bin bounds.
        for seed in &seeds {
            assert!(seed.x >= 0.0 && seed.x + seed.width <= 48.0);
            assert!(seed.y >= 0.0 && seed.y + seed.height <= 96.0);
        }
    }

    #[test]
    fn stops_when_bin_full() {
        // 10-wide items on a 10-wide bin with c=0 fits; 2 of 5 stack
        // vertically on 10-high bin.
        let b = bin(10.0, 10.0);
        let items = vec![rect_part("r", 5, 10.0, 5.0)];
        let result = greedy_bottom_left(&b, &items, 0.0).unwrap();
        assert_eq!(result.placements.len(), 2);
        assert_eq!(result.overflow, 3);
    }

    #[test]
    fn instance_index_starts_at_zero() {
        let b = bin(48.0, 96.0);
        let items = vec![rect_part("r", 2, 10.0, 5.0)];
        let result = greedy_bottom_left(&b, &items, 0.125).unwrap();
        let seeds = result.placements;
        assert_eq!(seeds[0].instance_index, 0);
        assert_eq!(seeds[1].instance_index, 1);
    }

    #[test]
    fn non_origin_polygon_translates_both_axes() {
        let b = bin(100.0, 100.0);
        let offset_part = Part {
            shape_id: "offset".into(),
            quantity: 1,
            polygon: Some(vec![
                Point2D::new(5.0, 3.0),
                Point2D::new(15.0, 3.0),
                Point2D::new(15.0, 8.0),
                Point2D::new(5.0, 8.0),
            ]),
            shape_spec: None,
            allow_rotation: true,
            grain_axis: None,
            difficulty: None,
            tag: None,
        };
        // c=0 keeps min_x,min_y at 0; the clearance-inflated path is
        // tested in `stacks_items_with_clearance_halo`.
        let result = greedy_bottom_left(&b, &[offset_part], 0.0).unwrap();
        assert_eq!(result.placements.len(), 1);
        let p = &result.placements[0];
        let min_x = p
            .polygon
            .iter()
            .map(|pt| pt.x)
            .fold(f64::INFINITY, f64::min);
        let min_y = p
            .polygon
            .iter()
            .map(|pt| pt.y)
            .fold(f64::INFINITY, f64::min);
        assert!((min_x - 0.0).abs() < 1e-9);
        assert!((min_y - 0.0).abs() < 1e-9);
    }

    #[test]
    fn overflow_counts_unplaced_instances() {
        let b = bin(10.0, 10.0);
        let items = vec![rect_part("r", 5, 10.0, 5.0)];
        let result = greedy_bottom_left(&b, &items, 0.0).unwrap();
        assert_eq!(result.placements.len(), 2);
        assert_eq!(result.overflow, 3);
    }

    // --- Task 11 probe-hardening tests -----------------------------------

    #[test]
    fn width_gate_rejects_too_wide_items() {
        // Codex finding: prior to the fix, 50x5 items on a 10x100 bin
        // were false-accepted by the probe (vertical stacker ignored
        // width). Now: overflow = full quantity.
        let b = bin(10.0, 100.0);
        let items = vec![rect_part("r", 3, 50.0, 5.0)];
        let result = greedy_bottom_left(&b, &items, 0.0).unwrap();
        assert_eq!(result.placements.len(), 0);
        assert_eq!(result.overflow, 3);
    }

    #[test]
    fn clearance_applies_to_vertical_stacking() {
        // 2x 10x10 items on a 12x25 bin (width picked so w_eff=12 fits).
        //   c=1.0 â†’ h_eff=12, 2 copies consume 24 â‰¤ 25 â†’ both fit.
        let b1 = bin(12.0, 25.0);
        let items = vec![rect_part("r", 2, 10.0, 10.0)];
        let r1 = greedy_bottom_left(&b1, &items, 1.0).unwrap();
        assert_eq!(r1.placements.len(), 2);
        assert_eq!(r1.overflow, 0);
        //   c=2.0 â†’ h_eff=14, w_eff=14, bin=12 â†’ width gate rejects all.
        let r2 = greedy_bottom_left(&b1, &items, 2.0).unwrap();
        assert_eq!(r2.placements.len(), 0);
        assert_eq!(r2.overflow, 2);
        //   Run the same c=2.0 on a wider bin so only the height check fires.
        let b2 = bin(14.0, 25.0);
        let r3 = greedy_bottom_left(&b2, &items, 2.0).unwrap();
        assert_eq!(r3.placements.len(), 1);
        assert_eq!(r3.overflow, 1);
    }

    #[test]
    fn clearance_applies_to_bin_boundary() {
        // 10x5 item on 11x6 bin (width chosen so w_eff=10.6 â‰¤ 11).
        //   c=0.3 â†’ h_eff=5.6 â‰¤ 6 â†’ fits.
        let b = bin(11.0, 6.0);
        let items = vec![rect_part("r", 1, 10.0, 5.0)];
        let r1 = greedy_bottom_left(&b, &items, 0.3).unwrap();
        assert_eq!(r1.placements.len(), 1);
        assert_eq!(r1.overflow, 0);
        //   c=0.4 â†’ h_eff=5.8 â‰¤ 6 â†’ fits; c=0.6 â†’ h_eff=6.2 > 6 â†’ overflow.
        let r2 = greedy_bottom_left(&b, &items, 0.6).unwrap();
        assert_eq!(r2.placements.len(), 0);
        assert_eq!(r2.overflow, 1);
    }

    #[test]
    fn single_item_exact_boundary() {
        // Codex sign-off: guard against first-item y_offset double-count.
        // H = h + 2c, W = w + 2c means one copy consumes exactly the bin.
        let b = bin(10.0 + 2.0 * 0.5, 10.0 + 2.0 * 0.5);
        let items = vec![rect_part("r", 1, 10.0, 10.0)];
        let r = greedy_bottom_left(&b, &items, 0.5).unwrap();
        assert_eq!(r.placements.len(), 1);
        assert_eq!(r.overflow, 0);
    }

    #[test]
    fn conservative_vs_exact_jagua_semantics() {
        // Codex sign-off: locks conservative over-rejection as documented.
        // Two 10x10 items, c=1, H=23, W=12 (so width gate passes).
        //   Exact jagua (k*h + (k+1)*c): 2*10 + 3*1 = 23 â†’ would fit.
        //   Our uniform (k*h + 2*k*c): 2*10 + 2*2*1 = 24 > 23 â†’ rejects 1.
        let b = bin(12.0, 23.0);
        let items = vec![rect_part("r", 2, 10.0, 10.0)];
        let r = greedy_bottom_left(&b, &items, 1.0).unwrap();
        assert_eq!(
            r.placements.len(),
            1,
            "conservative probe rejects the second copy"
        );
        assert_eq!(r.overflow, 1);
    }
}
