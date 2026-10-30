//! Adaptive-bitrate controller (contract §4.3). Platform-free and unit-tested.
//!
//! webrtc-rs ships no congestion-control estimator, so this is ours: REMB is the primary
//! estimate, a TWCC delay-gradient estimate is clamped to `[0.5, 1.5] x REMB` when REMB is
//! present, the target is `min(remb, twcc)` smoothed over 2 s, loss raises/lowers it, and
//! the rung is the highest whose `minKbps <= target` with 3 s up / 1 s down hysteresis.

use crate::types::{limits, QualityPreset};

/// A quality rung (contract §4.3 ladder).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Rung {
    Floor,
    Low,
    Medium,
    High,
    Full,
}

/// Per-rung encoder parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RungSpec {
    pub min_kbps: u32,
    pub long_edge_max: u32,
    pub fps_max: u32,
}

impl Rung {
    pub fn spec(self) -> RungSpec {
        match self {
            Rung::Full => RungSpec {
                min_kbps: 2500,
                long_edge_max: 2560,
                fps_max: 30,
            },
            Rung::High => RungSpec {
                min_kbps: 1500,
                long_edge_max: 1920,
                fps_max: 24,
            },
            Rung::Medium => RungSpec {
                min_kbps: 800,
                long_edge_max: 1600,
                fps_max: 15,
            },
            Rung::Low => RungSpec {
                min_kbps: 300,
                long_edge_max: 1280,
                fps_max: 10,
            },
            Rung::Floor => RungSpec {
                min_kbps: 0,
                long_edge_max: 1024,
                fps_max: 5,
            },
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Rung::Full => "full",
            Rung::High => "high",
            Rung::Medium => "medium",
            Rung::Low => "low",
            Rung::Floor => "floor",
        }
    }
}

/// The highest rung whose `minKbps <= target` (contract §4.3).
pub fn rung_for_target(target_kbps: u32) -> Rung {
    if target_kbps >= 2500 {
        Rung::Full
    } else if target_kbps >= 1500 {
        Rung::High
    } else if target_kbps >= 800 {
        Rung::Medium
    } else if target_kbps >= 300 {
        Rung::Low
    } else {
        Rung::Floor
    }
}

/// `floor` session budget: 250 kbps per leg, one monitor (contract §4.3, W24).
pub const FLOOR_BUDGET_KBPS: u32 = 250;

/// One controller tick input.
#[derive(Debug, Clone, Copy, Default)]
pub struct AbrSample {
    pub now_ms: u64,
    pub remb_kbps: Option<u32>,
    pub twcc_kbps: Option<u32>,
    /// Fraction lost 0..1 from receiver reports.
    pub fraction_lost: f32,
}

/// One controller tick output.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AbrDecision {
    pub target_kbps: u32,
    pub rung: Rung,
    pub floor_mode: bool,
    /// True on the tick the rung changed (force a keyframe, contract §4.3).
    pub force_keyframe: bool,
}

pub struct AbrController {
    max_kbps: f32,
    preset: QualityPreset,
    smoothed: f32,
    rung: Rung,
    last_ms: Option<u64>,
    /// `(moving_up, since_ms)` — a sustained trend away from the current rung.
    pending: Option<(bool, u64)>,
    high_loss_since: Option<u64>,
    low_loss_since: Option<u64>,
}

impl Default for AbrController {
    fn default() -> Self {
        Self::new(limits::AGENT_MAX_KBPS)
    }
}

impl AbrController {
    pub fn new(max_kbps_per_monitor: u32) -> Self {
        Self {
            max_kbps: max_kbps_per_monitor as f32,
            preset: QualityPreset::Auto,
            smoothed: 1500.0,
            rung: Rung::Medium,
            last_ms: None,
            pending: None,
            high_loss_since: None,
            low_loss_since: None,
        }
    }

    pub fn set_preset(&mut self, preset: QualityPreset) {
        self.preset = preset;
    }

    pub fn rung(&self) -> Rung {
        self.rung
    }

    /// Advance the controller.
    pub fn step(&mut self, s: AbrSample) -> AbrDecision {
        let dt = self
            .last_ms
            .map(|l| s.now_ms.saturating_sub(l))
            .unwrap_or(0);
        self.last_ms = Some(s.now_ms);

        // Combine REMB (primary) and the TWCC estimate (clamped to [0.5,1.5]xREMB).
        let raw = match (s.remb_kbps, s.twcc_kbps) {
            (Some(r), Some(t)) => {
                let lo = (r as f32) * 0.5;
                let hi = (r as f32) * 1.5;
                let t = (t as f32).clamp(lo, hi);
                (r as f32).min(t)
            }
            (Some(r), None) => r as f32,
            (None, Some(t)) => t as f32,
            (None, None) => self.smoothed,
        };

        // Smooth over ~2 s.
        let alpha = if dt == 0 {
            1.0
        } else {
            (dt as f32 / 2000.0).min(1.0)
        };
        self.smoothed += (raw - self.smoothed) * alpha;

        // Loss response: >10% for 2 s => x0.7; <2% for 5 s => x1.08.
        if s.fraction_lost > 0.10 {
            self.low_loss_since = None;
            let since = *self.high_loss_since.get_or_insert(s.now_ms);
            if s.now_ms.saturating_sub(since) >= 2000 {
                self.smoothed *= 0.7;
                self.high_loss_since = Some(s.now_ms);
            }
        } else if s.fraction_lost < 0.02 {
            self.high_loss_since = None;
            let since = *self.low_loss_since.get_or_insert(s.now_ms);
            if s.now_ms.saturating_sub(since) >= 5000 {
                self.smoothed = (self.smoothed * 1.08).min(self.max_kbps);
                self.low_loss_since = Some(s.now_ms);
            }
        } else {
            self.high_loss_since = None;
            self.low_loss_since = None;
        }

        self.smoothed = self.smoothed.clamp(50.0, self.max_kbps);

        // Forced presets override rung selection.
        let candidate = match self.preset {
            QualityPreset::Floor => Rung::Floor,
            _ => rung_for_target(self.smoothed as u32),
        };

        // Hysteresis on the trend direction (3 s to raise quality, 1 s to lower it), then
        // commit to whatever candidate the target now supports. This lets a sustained ramp
        // climb several rungs after one 3 s wait rather than re-arming at each rung.
        let mut force_keyframe = false;
        if candidate != self.rung {
            let up = candidate > self.rung;
            let required = if up { 3000 } else { 1000 };
            match self.pending {
                Some((pending_up, since)) if pending_up == up => {
                    if s.now_ms.saturating_sub(since) >= required {
                        self.rung = candidate;
                        self.pending = None;
                        force_keyframe = true;
                    }
                }
                _ => self.pending = Some((up, s.now_ms)),
            }
        } else {
            self.pending = None;
        }

        let floor_mode = self.rung == Rung::Floor;
        let target = if floor_mode {
            FLOOR_BUDGET_KBPS.min(self.smoothed as u32)
        } else {
            self.smoothed as u32
        };

        AbrDecision {
            target_kbps: target,
            rung: self.rung,
            floor_mode,
            force_keyframe,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rung_thresholds() {
        assert_eq!(rung_for_target(3000), Rung::Full);
        assert_eq!(rung_for_target(2500), Rung::Full);
        assert_eq!(rung_for_target(2000), Rung::High);
        assert_eq!(rung_for_target(1000), Rung::Medium);
        assert_eq!(rung_for_target(400), Rung::Low);
        assert_eq!(rung_for_target(100), Rung::Floor);
    }

    #[test]
    fn climbs_up_only_after_three_seconds() {
        let mut c = AbrController::new(6000);
        // Start by settling low.
        for t in (0..3000).step_by(500) {
            c.step(AbrSample {
                now_ms: t,
                remb_kbps: Some(400),
                ..Default::default()
            });
        }
        assert_eq!(c.rung(), Rung::Low);
        // Offer a lot of bandwidth; the rung must not jump instantly (3 s up hysteresis).
        let d = c.step(AbrSample {
            now_ms: 3200,
            remb_kbps: Some(3000),
            ..Default::default()
        });
        assert_eq!(d.rung, Rung::Low, "no instant climb");
        // Keep it high for >3 s.
        let mut last = d;
        for t in (3400..7000).step_by(200) {
            last = c.step(AbrSample {
                now_ms: t,
                remb_kbps: Some(3000),
                ..Default::default()
            });
        }
        assert_eq!(last.rung, Rung::Full);
    }

    #[test]
    fn drops_down_within_one_second() {
        let mut c = AbrController::new(6000);
        for t in (0..6000).step_by(200) {
            c.step(AbrSample {
                now_ms: t,
                remb_kbps: Some(3000),
                ..Default::default()
            });
        }
        assert_eq!(c.rung(), Rung::Full);
        // Bandwidth collapses; a drop should commit after ~1 s.
        let mut last = c.step(AbrSample {
            now_ms: 6100,
            remb_kbps: Some(200),
            ..Default::default()
        });
        for t in (6300..7600).step_by(200) {
            last = c.step(AbrSample {
                now_ms: t,
                remb_kbps: Some(200),
                ..Default::default()
            });
        }
        assert!(last.rung < Rung::Full, "dropped from full");
    }

    #[test]
    fn forced_floor_preset_caps_budget_and_one_monitor() {
        let mut c = AbrController::new(6000);
        c.set_preset(QualityPreset::Floor);
        // Even with plenty of REMB the rung is floor and the target is the 250 budget.
        let mut last = c.step(AbrSample {
            now_ms: 0,
            remb_kbps: Some(5000),
            ..Default::default()
        });
        for t in (200..4000).step_by(200) {
            last = c.step(AbrSample {
                now_ms: t,
                remb_kbps: Some(5000),
                ..Default::default()
            });
        }
        assert_eq!(last.rung, Rung::Floor);
        assert!(last.floor_mode);
        assert!(last.target_kbps <= FLOOR_BUDGET_KBPS);
    }

    #[test]
    fn target_never_exceeds_per_monitor_cap() {
        let mut c = AbrController::new(6000);
        let mut last = AbrDecision {
            target_kbps: 0,
            rung: Rung::Medium,
            floor_mode: false,
            force_keyframe: false,
        };
        for t in (0..10000).step_by(200) {
            last = c.step(AbrSample {
                now_ms: t,
                remb_kbps: Some(20000),
                fraction_lost: 0.0,
                ..Default::default()
            });
        }
        assert!(last.target_kbps <= 6000);
    }
}
