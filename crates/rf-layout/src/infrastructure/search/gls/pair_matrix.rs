// engine/crates/rf-layout/src/infrastructure/search/gls/pair_matrix.rs
//
// Ported from sparrow's `src/quantify/pair_matrix.rs` (MIT, Copyright 2025
// Jeroen Gardeyn, KU Leuven).
//
// Triangular storage of pair-wise collision loss + weight entries used by
// `CollisionTracker`. Keeps the symmetric (i, j) = (j, i) lookup cheap
// (N(N+1)/2 entries instead of N²).

use super::tracker::CTEntry;
use std::ops::{Index, IndexMut};

/// Triangular matrix of pair-wise collision loss and weights.
/// Supporting data structure for the `CollisionTracker`.
#[derive(Debug, Clone)]
pub struct PairMatrix {
    pub size: usize,
    pub data: Vec<CTEntry>,
}

impl PairMatrix {
    pub fn new(size: usize) -> Self {
        let len = size * (size + 1) / 2;
        Self {
            size,
            data: vec![
                CTEntry {
                    weight: 1.0,
                    loss: 0.0
                };
                len
            ],
        }
    }
}

impl Index<(usize, usize)> for PairMatrix {
    type Output = CTEntry;

    fn index(&self, (row, col): (usize, usize)) -> &Self::Output {
        &self.data[calc_idx(row, col, self.size)]
    }
}

impl IndexMut<(usize, usize)> for PairMatrix {
    fn index_mut(&mut self, (row, col): (usize, usize)) -> &mut Self::Output {
        &mut self.data[calc_idx(row, col, self.size)]
    }
}

fn calc_idx(row: usize, col: usize, size: usize) -> usize {
    /* Example:
        0 1 2 3
          4 5 6
            7 8
              9
    */
    debug_assert!(row < size && col < size);
    if row <= col {
        (row * size) + col - ((row * (row + 1)) / 2)
    } else {
        (col * size) + row - ((col * (col + 1)) / 2)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_fills_triangular_length() {
        // N(N+1)/2 entries for size N=4.
        let m = PairMatrix::new(4);
        assert_eq!(m.data.len(), 10);
        assert_eq!(m.size, 4);
        for e in &m.data {
            assert_eq!(e.weight, 1.0);
            assert_eq!(e.loss, 0.0);
        }
    }

    #[test]
    fn indexing_is_symmetric() {
        let mut m = PairMatrix::new(4);
        m[(1, 2)].loss = 7.0;
        assert_eq!(m[(1, 2)].loss, 7.0);
        assert_eq!(m[(2, 1)].loss, 7.0, "symmetric indexing should alias");
    }

    #[test]
    fn diagonal_is_addressable() {
        let mut m = PairMatrix::new(3);
        m[(0, 0)].loss = 1.0;
        m[(1, 1)].loss = 2.0;
        m[(2, 2)].loss = 3.0;
        assert_eq!(m[(0, 0)].loss, 1.0);
        assert_eq!(m[(1, 1)].loss, 2.0);
        assert_eq!(m[(2, 2)].loss, 3.0);
    }

    #[test]
    fn distinct_pairs_map_to_distinct_slots() {
        let mut m = PairMatrix::new(5);
        let pairs = [
            (0, 1),
            (0, 2),
            (0, 3),
            (0, 4),
            (1, 2),
            (1, 3),
            (1, 4),
            (2, 3),
            (2, 4),
            (3, 4),
        ];
        for (k, p) in pairs.iter().enumerate() {
            m[*p].loss = k as f32 + 1.0;
        }
        for (k, p) in pairs.iter().enumerate() {
            assert_eq!(m[*p].loss, k as f32 + 1.0, "pair {:?} overwritten", p);
        }
    }

    // These should_panic tests rely on debug-mode `Vec`/slice bounds
    // checks. rustc 1.95 release-mode indexing can elide the panic on
    // the trailing index, so they only run under `debug_assertions`.
    #[test]
    #[cfg(debug_assertions)]
    #[should_panic]
    fn out_of_bounds_row_panics() {
        let _ = PairMatrix::new(3)[(3, 0)].loss;
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic]
    fn out_of_bounds_col_panics() {
        let _ = PairMatrix::new(3)[(0, 3)].loss;
    }
}
