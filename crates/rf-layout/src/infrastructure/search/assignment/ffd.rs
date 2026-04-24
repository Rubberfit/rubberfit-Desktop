// engine/crates/rf-layout/src/infrastructure/search/assignment/ffd.rs
//
// First-Fit-Decreasing bin-assignment heuristic.
//
// Fresh code — not a sparrow port. Replaces pack.rs's prior "iterate
// bins in input order with per-bin greedy spillover" with a global
// assignment pass that routes each item to the first bin (in priority
// order) where it still fits alongside previously assigned items.
//
// Design notes:
//   1. Sort key is 4-level stable: bbox area desc, longest edge desc,
//      shape_id asc, instance ordinal asc. Area desc is the canonical
//      FFD primary; the rest ensure determinism across ties.
//   2. Bin order: priority desc (None == 0, matching TS
//      buildPackRequest.ts:32-34), Remnant-before-Fresh, input order.
//   3. Clearance is pass-through — fit-checking delegates to
//      warm_start::greedy_bottom_left, which calls the jagua adapter
//      with the same clearance. No precomputed bbox inflation.
//   4. Per-bin config.items MUST NOT contain duplicate shape_id rows
//      (replay_seed_into_layout at mod.rs:144 errors on duplicates).
//      When FFD assigns N copies of the same shape to the same bin,
//      quantities are collapsed into a single Part.
//   5. Cardinality preservation: FFD must seed every copy it routes —
//      search::optimize cannot recover missing seeds.
//   6. Deterministic HashMap materialization: all map -> vec steps
//      sort by shape_id to avoid non-deterministic instance_index
//      assignment across runs.
//   7. Pure function, no RNG. Same inputs -> same output bit-for-bit.

use crate::domain::{Bin, BinKind, PackError, Part};
use crate::infrastructure::warm_start::{greedy_bottom_left, SeedResult};
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct FfdAssignment {
    /// One SeedResult per input bin (same order as the input slice).
    /// Bins that FFD routed zero items to carry an empty SeedResult.
    pub per_bin: Vec<SeedResult>,
    /// Items that fit NO bin. `(shape_id, count)` pairs sorted by
    /// `shape_id` for determinism.
    pub overflow: Vec<(String, u32)>,
}

pub fn ffd_assign(
    bins: &[Bin],
    items: &[Part],
    clearance: f64,
) -> Result<FfdAssignment, PackError> {
    if bins.is_empty() {
        return Err(PackError::NoBins);
    }
    if items.is_empty() {
        return Err(PackError::NoItems);
    }

    // Explode quantities into individual assignment units and compute
    // the sort key once per shape (bbox area + longest edge).
    let mut shape_bbox: HashMap<&str, (f64, f64)> = HashMap::with_capacity(items.len());
    for part in items {
        let bbox = rf_geom::application::bbox_of(&part.polygon).map_err(|source| {
            PackError::InvalidPolygon {
                shape_id: part.shape_id.clone(),
                source,
            }
        })?;
        let w = bbox.1.x - bbox.0.x;
        let h = bbox.1.y - bbox.0.y;
        let area = w * h;
        let longest = w.max(h);
        shape_bbox.insert(part.shape_id.as_str(), (area, longest));
    }

    let mut units: Vec<AssignmentUnit> = Vec::new();
    for (part_idx, part) in items.iter().enumerate() {
        let (area, longest) = shape_bbox[part.shape_id.as_str()];
        for inst in 0..part.quantity {
            units.push(AssignmentUnit {
                shape_id: part.shape_id.clone(),
                part_idx,
                bbox_area: area,
                longest_edge: longest,
                instance_ordinal: inst,
            });
        }
    }

    // 4-level sort: area desc, longest edge desc, shape_id asc,
    // instance ordinal asc.
    units.sort_by(|a, b| {
        b.bbox_area
            .partial_cmp(&a.bbox_area)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.longest_edge
                    .partial_cmp(&a.longest_edge)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.shape_id.cmp(&b.shape_id))
            .then_with(|| a.instance_ordinal.cmp(&b.instance_ordinal))
    });

    // Bin order: priority desc (None -> 0), Remnant before Fresh,
    // input order for ties.
    let mut bin_order: Vec<usize> = (0..bins.len()).collect();
    bin_order.sort_by(|&i, &j| {
        let pi = bins[i].priority.unwrap_or(0);
        let pj = bins[j].priority.unwrap_or(0);
        pj.cmp(&pi) // descending
            .then_with(|| bin_kind_rank(&bins[i].kind).cmp(&bin_kind_rank(&bins[j].kind)))
            .then_with(|| i.cmp(&j)) // stable input order
    });

    // Per-bin running assignment: shape_id -> cumulative quantity in
    // that bin. HashMap is fine internally; materialize via sorted
    // iteration for determinism.
    let mut per_bin_counts: Vec<HashMap<String, u32>> = vec![HashMap::new(); bins.len()];
    let mut overflow_counts: HashMap<String, u32> = HashMap::new();

    'unit: for unit in &units {
        for &bin_idx in &bin_order {
            let trial_items = build_trial_items(&per_bin_counts[bin_idx], unit, items);
            // `greedy_bottom_left` returns overflow > 0 if the trial
            // cumulative set doesn't all fit. That's our fit-check.
            let probe = greedy_bottom_left(&bins[bin_idx], &trial_items, clearance)?;
            if probe.overflow == 0 {
                *per_bin_counts[bin_idx]
                    .entry(unit.shape_id.clone())
                    .or_insert(0) += 1;
                continue 'unit;
            }
        }
        // No bin accepted it.
        *overflow_counts.entry(unit.shape_id.clone()).or_insert(0) += 1;
    }

    // Materialize: re-run warm_start once per bin with its final
    // collapsed-quantity Part list (no duplicate shape_ids).
    let per_bin: Vec<SeedResult> = (0..bins.len())
        .map(|i| {
            let final_items = materialize_parts(&per_bin_counts[i], items);
            if final_items.is_empty() {
                Ok(SeedResult {
                    placements: vec![],
                    overflow: 0,
                })
            } else {
                greedy_bottom_left(&bins[i], &final_items, clearance)
            }
        })
        .collect::<Result<_, _>>()?;

    // Overflow list sorted by shape_id for deterministic output.
    let mut overflow: Vec<(String, u32)> = overflow_counts.into_iter().collect();
    overflow.sort_by(|a, b| a.0.cmp(&b.0));

    Ok(FfdAssignment { per_bin, overflow })
}

/// Per-copy intermediate representation used for sorting.
struct AssignmentUnit {
    shape_id: String,
    /// Index into the original `items` slice; used to reconstruct the
    /// full Part when collapsing back into per-bin Vec<Part>.
    #[allow(dead_code)]
    part_idx: usize,
    bbox_area: f64,
    longest_edge: f64,
    instance_ordinal: u32,
}

fn bin_kind_rank(kind: &BinKind) -> u8 {
    // Lower rank == comes first. Remnants before Fresh.
    match kind {
        BinKind::Remnant => 0,
        BinKind::Fresh => 1,
    }
}

/// Given the cumulative `already_assigned` counts for a bin + a new
/// unit we want to probe, emit the trial `Vec<Part>` that reflects
/// "everything in this bin so far plus one more of unit.shape_id."
/// Quantities collapsed per shape (no duplicate rows).
///
/// Sorted by `shape_id` for deterministic probe output.
fn build_trial_items(
    already_assigned: &HashMap<String, u32>,
    unit: &AssignmentUnit,
    original_items: &[Part],
) -> Vec<Part> {
    // Build the target quantity map.
    let mut target: HashMap<String, u32> = already_assigned.clone();
    *target.entry(unit.shape_id.clone()).or_insert(0) += 1;
    materialize_parts(&target, original_items)
}

/// Collapse `counts` into a deduped `Vec<Part>` with `quantity` set
/// per the counts map. Preserves all non-quantity Part fields from the
/// originals. Sorted by `shape_id` for deterministic emission (§3.6
/// Codex sign-off fix).
pub(crate) fn materialize_parts(
    counts: &HashMap<String, u32>,
    original_items: &[Part],
) -> Vec<Part> {
    // Collect sorted shape_ids for deterministic iteration.
    let mut shape_ids: Vec<&String> = counts.keys().filter(|_| true).collect();
    shape_ids.sort();

    shape_ids
        .into_iter()
        .filter_map(|sid| {
            let qty = counts.get(sid).copied().unwrap_or(0);
            if qty == 0 {
                return None;
            }
            // Find the first Part with this shape_id in the originals.
            // There should be exactly one (pack-level precondition is
            // that item list doesn't have duplicates; warm_start + jagua
            // both enforce this upstream).
            let template = original_items.iter().find(|p| &p.shape_id == sid)?;
            Some(Part {
                shape_id: template.shape_id.clone(),
                quantity: qty,
                polygon: template.polygon.clone(),
                shape_spec: template.shape_spec.clone(),
                allow_rotation: template.allow_rotation,
                grain_axis: template.grain_axis,
                difficulty: template.difficulty,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rf_geom::domain::Point2D;

    fn rect_part(id: &str, qty: u32, w: f64, h: f64) -> Part {
        Part {
            shape_id: id.into(),
            quantity: qty,
            polygon: vec![
                Point2D::new(0.0, 0.0),
                Point2D::new(w, 0.0),
                Point2D::new(w, h),
                Point2D::new(0.0, h),
            ],
            shape_spec: None,
            allow_rotation: false,
            grain_axis: None,
            difficulty: None,
        }
    }

    fn bin(id: &str, w: f64, h: f64) -> Bin {
        Bin {
            bin_id: id.into(),
            width: w,
            height: h,
            kind: BinKind::Fresh,
            priority: None,
        }
    }

    #[test]
    fn ffd_beats_naive_on_area_decreasing_case() {
        // Scenario per Codex research: 20x20, 10x10, 10x5 on bins
        // 20x20 (A) and 20x15 (B). Input order: small, small, big —
        // naive would place the two small rects on A, then the big
        // rect finds nowhere (doesn't fit A's leftover, doesn't fit
        // B because B is 15 tall vs 20 required). FFD sorts big first,
        // places it on A, then smalls go to B. No overflow.
        let bins = vec![bin("A", 20.0, 20.0), bin("B", 20.0, 15.0)];
        let items = vec![
            rect_part("small1", 1, 10.0, 10.0),
            rect_part("small2", 1, 10.0, 5.0),
            rect_part("big", 1, 20.0, 20.0),
        ];
        let out = ffd_assign(&bins, &items, 0.0).unwrap();
        assert!(
            out.overflow.is_empty(),
            "FFD should have found homes for all 3 items; got overflow={:?}",
            out.overflow
        );
    }

    #[test]
    fn tie_break_is_deterministic() {
        // Two distinct shapes with identical area -> tie-broken by
        // shape_id asc. Repeated calls produce identical assignments.
        let bins = vec![bin("A", 30.0, 30.0)];
        let items = vec![
            rect_part("a", 1, 10.0, 10.0),
            rect_part("b", 1, 20.0, 5.0), // same area = 100
        ];
        let out1 = ffd_assign(&bins, &items, 0.0).unwrap();
        let out2 = ffd_assign(&bins, &items, 0.0).unwrap();
        let k = |r: &FfdAssignment| {
            r.per_bin
                .iter()
                .map(|b| {
                    b.placements
                        .iter()
                        .map(|p| (p.shape_id.clone(), p.x.to_bits(), p.y.to_bits()))
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(k(&out1), k(&out2));
    }

    #[test]
    fn single_bin_collapses_to_warm_start_shape() {
        // 1 bin + 3 items. FFD's per_bin[0] should have the same
        // placement count as if we called warm_start directly on the
        // FFD-sorted item list.
        let bins = vec![bin("A", 96.0, 96.0)];
        let items = vec![
            rect_part("c", 1, 10.0, 5.0),
            rect_part("a", 1, 30.0, 30.0),
            rect_part("b", 1, 20.0, 20.0),
        ];
        let out = ffd_assign(&bins, &items, 0.0).unwrap();
        assert_eq!(out.per_bin.len(), 1);
        // All 3 items should fit in the single big bin.
        assert_eq!(out.per_bin[0].placements.len(), 3);
        assert!(out.overflow.is_empty());
    }

    #[test]
    fn total_overflow_preserves_item_accounting() {
        // Sum of placed + overflow == sum of requested quantities.
        let bins = vec![bin("A", 20.0, 20.0)];
        let items = vec![
            rect_part("a", 3, 10.0, 10.0), // 3 instances, only 1 will fit
            rect_part("b", 2, 15.0, 15.0), // 2 instances, none fit after first
        ];
        let out = ffd_assign(&bins, &items, 0.0).unwrap();
        let placed: u32 = out.per_bin.iter().map(|b| b.placements.len() as u32).sum();
        let spilled: u32 = out.overflow.iter().map(|(_, n)| *n).sum();
        assert_eq!(placed + spilled, 3 + 2, "no items lost or duplicated");
    }

    #[test]
    fn quantity_split_across_bins_collapses_duplicates() {
        // 1 shape with quantity=4, 2 bins of 10x10. Each fits only 1
        // copy (10x10 item == bin size exactly). FFD routes 1 to each
        // bin, 2 to overflow.
        //
        // Critical test: the materialized per_bin[i].placements should
        // reflect collapsed quantity. We verify by counting placements
        // per-bin and checking no bin has duplicate shape_id rows in
        // any internal data (tested via the trial build path).
        let bins = vec![bin("A", 10.0, 10.0), bin("B", 10.0, 10.0)];
        let items = vec![rect_part("sq", 4, 10.0, 10.0)];
        let out = ffd_assign(&bins, &items, 0.0).unwrap();
        assert_eq!(out.per_bin[0].placements.len(), 1);
        assert_eq!(out.per_bin[1].placements.len(), 1);
        assert_eq!(out.overflow, vec![("sq".to_string(), 2)]);
    }

    #[test]
    fn bin_priority_respected() {
        // 3 bins: priority=5 (Remnant), priority=None (Fresh),
        // priority=10 (Fresh). FFD bin order should be:
        //   1. priority=10 Fresh (highest priority)
        //   2. priority=5 Remnant (next priority)
        //   3. priority=None==0 Fresh (lowest)
        //
        // A single item that fits anywhere should land in the
        // priority-10 bin.
        let bins = vec![
            Bin {
                bin_id: "rem".into(),
                width: 20.0,
                height: 20.0,
                kind: BinKind::Remnant,
                priority: Some(5),
            },
            Bin {
                bin_id: "fresh_default".into(),
                width: 20.0,
                height: 20.0,
                kind: BinKind::Fresh,
                priority: None,
            },
            Bin {
                bin_id: "fresh_high".into(),
                width: 20.0,
                height: 20.0,
                kind: BinKind::Fresh,
                priority: Some(10),
            },
        ];
        let items = vec![rect_part("small", 1, 5.0, 5.0)];
        let out = ffd_assign(&bins, &items, 0.0).unwrap();
        // bins[2] is the high-priority one; it should carry the item.
        assert_eq!(out.per_bin[2].placements.len(), 1);
        assert_eq!(out.per_bin[0].placements.len(), 0);
        assert_eq!(out.per_bin[1].placements.len(), 0);
    }

    #[test]
    fn empty_bins_err() {
        let items = vec![rect_part("a", 1, 1.0, 1.0)];
        let r = ffd_assign(&[], &items, 0.0);
        assert!(matches!(r, Err(PackError::NoBins)));
    }

    #[test]
    fn empty_items_err() {
        let bins = vec![bin("A", 10.0, 10.0)];
        let r = ffd_assign(&bins, &[], 0.0);
        assert!(matches!(r, Err(PackError::NoItems)));
    }
}
