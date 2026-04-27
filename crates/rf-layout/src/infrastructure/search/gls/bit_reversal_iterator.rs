// engine/crates/rf-layout/src/infrastructure/search/gls/bit_reversal_iterator.rs
//
// Ported from sparrow's `src/util/bit_reversal_iterator.rs` (MIT, Copyright 2025
// Jeroen Gardeyn, KU Leuven). Used by the specialized jaguars pipeline to
// iterate polygon edges in bit-reversed order, maximizing early-termination
// hit rate when quadtree queries fire.

/// A bit-reversal permutation iterator for a range of size n.
/// Example: For n = 8, the iterator will yield the indices in the order:
/// 0, 4, 2, 6, 1, 5, 3, 7
/// <https://en.wikipedia.org/wiki/Bit-reversal_permutation>
pub struct BitReversalIterator {
    n: usize,     // Range size (0 to n-1)
    k: u32,       // Number of bits, smallest k where 2^k >= n
    i: usize,     // Current index
    count: usize, // Number of elements yielded
}

impl BitReversalIterator {
    pub fn new(n: usize) -> Self {
        if n == 0 {
            Self {
                n: 0,
                k: 0,
                i: 0,
                count: 0,
            }
        } else {
            // Smallest k such that 2^k >= n
            let k = 64 - n.leading_zeros();
            Self {
                n,
                k,
                i: 0,
                count: 0,
            }
        }
    }
}

impl Iterator for BitReversalIterator {
    type Item = usize;

    fn next(&mut self) -> Option<Self::Item> {
        while self.count < self.n {
            // Reverse bits and shift to get k least significant bits
            let rev = self.i.reverse_bits() >> (64 - self.k);
            self.i += 1;
            if rev < self.n {
                self.count += 1;
                return Some(rev);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn n_zero_is_empty() {
        assert_eq!(
            BitReversalIterator::new(0).collect::<Vec<_>>(),
            Vec::<usize>::new()
        );
    }

    #[test]
    fn n_one_yields_zero() {
        assert_eq!(BitReversalIterator::new(1).collect::<Vec<_>>(), vec![0]);
    }

    #[test]
    fn n_eight_matches_documented_sequence() {
        let v: Vec<usize> = BitReversalIterator::new(8).collect();
        assert_eq!(v, vec![0, 4, 2, 6, 1, 5, 3, 7]);
    }

    #[test]
    fn non_power_of_two_yields_only_in_range() {
        let v: Vec<usize> = BitReversalIterator::new(5).collect();
        assert_eq!(v.len(), 5);
        for i in &v {
            assert!(*i < 5);
        }
        // Each index exactly once
        let mut sorted = v.clone();
        sorted.sort();
        assert_eq!(sorted, vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn yields_every_index_exactly_once_for_sizes_up_to_32() {
        for n in 1..=32 {
            let v: Vec<usize> = BitReversalIterator::new(n).collect();
            assert_eq!(v.len(), n, "size {}", n);
            let mut sorted = v.clone();
            sorted.sort();
            let expected: Vec<usize> = (0..n).collect();
            assert_eq!(sorted, expected, "size {}", n);
        }
    }
}
