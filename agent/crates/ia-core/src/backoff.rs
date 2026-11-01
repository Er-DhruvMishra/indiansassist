//! Reconnect and retry backoff (C §3.1 "1, 2, 4, 8 s, max 30 s", Phase D §13.5 "±30 % jitter").
//!
//! One implementation for the `/signal/device` socket, the enrollment client and the action
//! retry, so a NAT'd office that all comes back at once does not reconnect in lockstep.

use std::time::Duration;

/// The C §3.1 ladder: 1 s doubling to a 30 s ceiling.
pub const BASE_MS: u64 = 1_000;
pub const MAX_MS: u64 = 30_000;
/// §13.5: ±30 %.
pub const JITTER: f64 = 0.30;

/// A retry counter. `next_delay()` advances it; `reset()` is called on every success.
#[derive(Debug, Clone)]
pub struct Backoff {
    attempt: u32,
    base_ms: u64,
    max_ms: u64,
    jitter: f64,
}

impl Default for Backoff {
    fn default() -> Self {
        Self {
            attempt: 0,
            base_ms: BASE_MS,
            max_ms: MAX_MS,
            jitter: JITTER,
        }
    }
}

impl Backoff {
    /// A ladder with its own base and ceiling (the `device_disabled` pause uses an hour).
    pub fn with(base_ms: u64, max_ms: u64) -> Self {
        Self {
            attempt: 0,
            base_ms,
            max_ms,
            jitter: JITTER,
        }
    }

    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    /// The un-jittered delay for `attempt` (0-based), so the ladder itself is testable.
    pub fn plain_ms(&self, attempt: u32) -> u64 {
        self.base_ms
            .saturating_mul(1u64 << attempt.min(16))
            .min(self.max_ms)
    }

    /// The next delay, jittered by ±`jitter`. The ceiling applies before the jitter, so a
    /// jittered delay can reach 1.3 × `max_ms`; that is the point — the peak is spread.
    pub fn next_delay(&mut self) -> Duration {
        let plain = self.plain_ms(self.attempt);
        self.attempt = self.attempt.saturating_add(1);
        Duration::from_millis(jitter_ms(plain, self.jitter))
    }
}

/// Applies ±`frac` jitter to `ms` with the OS generator.
pub fn jitter_ms(ms: u64, frac: f64) -> u64 {
    if ms == 0 || frac <= 0.0 {
        return ms;
    }
    let r = u64::from_be_bytes(crate::rnd::bytes::<8>()) as f64 / u64::MAX as f64; // 0.0..1.0
    let factor = 1.0 + (r * 2.0 - 1.0) * frac;
    (ms as f64 * factor).round().max(1.0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ladder_doubles_to_the_ceiling() {
        let b = Backoff::default();
        assert_eq!(
            (0..8).map(|a| b.plain_ms(a)).collect::<Vec<_>>(),
            vec![1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]
        );
    }

    #[test]
    fn every_delay_stays_within_the_jitter_band_and_they_are_not_all_equal() {
        let mut b = Backoff::default();
        let mut seen = Vec::new();
        for attempt in 0..6 {
            let plain = b.plain_ms(attempt) as f64;
            let got = b.next_delay().as_millis() as f64;
            assert!(
                got >= plain * 0.69 && got <= plain * 1.31,
                "{got} is outside ±30 % of {plain}"
            );
            seen.push(got);
        }
        let mut again = Backoff::default();
        let other: Vec<f64> = (0..6)
            .map(|_| again.next_delay().as_millis() as f64)
            .collect();
        assert_ne!(seen, other, "two ladders must not line up");
    }

    #[test]
    fn reset_puts_it_back_at_the_first_rung() {
        let mut b = Backoff::default();
        b.next_delay();
        b.next_delay();
        assert_eq!(b.attempt(), 2);
        b.reset();
        assert_eq!(b.attempt(), 0);
    }
}
