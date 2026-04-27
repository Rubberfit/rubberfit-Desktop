// engine/crates/rf-layout/src/infrastructure/search/rng.rs
//
// Deterministic RNG for the GLS search.
//
// We use `Xoshiro256PlusPlus` because it is what sparrow uses upstream
// (faster than chacha and statistically solid for this workload) and
// because `SeedableRng::seed_from_u64` gives us a stable mapping from a
// single u64 seed to a well-mixed internal state. That lets the TS side
// pass just `seed: u64` through `PackRequest`, and we reconstruct the
// exact same stream on every run.
//
// When `seed` is None, we reseed from the OS entropy source (`SysRng` in
// rand 0.10) so non-seeded runs are statistically independent across
// invocations.

use rand::rngs::SysRng;
use rand::SeedableRng;
use rand_xoshiro::Xoshiro256PlusPlus;

/// Build a seeded or entropy-backed xoshiro RNG.
///
/// - `Some(seed)` → `Xoshiro256PlusPlus::seed_from_u64(seed)`: deterministic
///   reproducible stream. Identical across runs, platforms, and thread counts
///   as long as the same seed is used.
/// - `None` → `Xoshiro256PlusPlus::from_rng(&mut SysRng)`: entropy-backed via
///   the OS random source. Different on every invocation.
pub fn from_seed(seed: Option<u64>) -> Xoshiro256PlusPlus {
    match seed {
        Some(s) => Xoshiro256PlusPlus::seed_from_u64(s),
        None => {
            Xoshiro256PlusPlus::try_from_rng(&mut SysRng).expect("OS entropy source unavailable")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{Rng, RngExt};

    fn sample_stream(rng: &mut Xoshiro256PlusPlus, n: usize) -> Vec<u64> {
        (0..n).map(|_| rng.next_u64()).collect()
    }

    #[test]
    fn same_seed_gives_same_stream() {
        let mut a = from_seed(Some(42));
        let mut b = from_seed(Some(42));
        assert_eq!(sample_stream(&mut a, 8), sample_stream(&mut b, 8));
    }

    #[test]
    fn different_seeds_give_different_streams() {
        let mut a = from_seed(Some(1));
        let mut b = from_seed(Some(2));
        assert_ne!(sample_stream(&mut a, 8), sample_stream(&mut b, 8));
    }

    #[test]
    fn entropy_backed_rngs_are_independent() {
        // Not a strict uniqueness guarantee (OsRng could theoretically produce
        // identical 8-sample streams), but the probability is negligible for
        // Xoshiro256++.
        let mut a = from_seed(None);
        let mut b = from_seed(None);
        assert_ne!(sample_stream(&mut a, 8), sample_stream(&mut b, 8));
    }

    #[test]
    fn seeded_stream_is_stable_across_runs() {
        // Regression guard: locks in the first four u64 outputs of
        // Xoshiro256PlusPlus::seed_from_u64(42). If rand_xoshiro ever
        // changes the seeding algorithm, this test will catch it before
        // we ship a run that silently changes pack results for existing
        // seeded jobs.
        let mut rng = from_seed(Some(42));
        let stream: Vec<u64> = (0..4).map(|_| rng.next_u64()).collect();
        assert_eq!(
            stream,
            vec![
                15_021_278_609_987_233_951,
                5_881_210_131_331_364_753,
                18_149_643_915_985_481_100,
                12_933_668_939_759_105_464,
            ]
        );
    }

    #[test]
    fn gen_range_is_deterministic_for_seeded_rng() {
        let mut a = from_seed(Some(7));
        let mut b = from_seed(Some(7));
        let samples_a: Vec<u32> = (0..5).map(|_| a.random_range(0..100)).collect();
        let samples_b: Vec<u32> = (0..5).map(|_| b.random_range(0..100)).collect();
        assert_eq!(samples_a, samples_b);
    }
}
