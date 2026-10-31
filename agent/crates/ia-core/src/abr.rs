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

    /// A compact index (floor 0 .. full 4) for sharing the rung through an atomic.
    pub fn index(self) -> u8 {
        self as u8
    }

    /// The inverse of [`Rung::index`]; out-of-range values clamp to `full`.
    pub fn from_index(i: u8) -> Rung {
        match i {
            0 => Rung::Floor,
            1 => Rung::Low,
            2 => Rung::Medium,
            3 => Rung::High,
            _ => Rung::Full,
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

/// The whole Desk uplink cap across the selected monitors **and** the recorder stream
/// (contract §4.3 "8000 total including the recorder stream", §9 R2).
pub const TOTAL_MAX_KBPS: u32 = 8000;

/// The top of the `medium` band: the most the recorder stream is given when the Assist runs
/// above `medium` (contract §4.3 "the recorder stream follows `min(assistRung, medium)`").
pub const MEDIUM_MAX_KBPS: u32 = 1500;

/// The encoder settings one stream runs at (contract §4.3 ladder applied to libvpx).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncodeParams {
    /// Encoded size (even, aspect kept, never above the source).
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// CBR target.
    pub kbps: u32,
    /// libvpx `rc_min_quantizer` ("min quantiser raised" on `low` / `floor`).
    pub min_q: u32,
    /// Bounded keyframe interval (15 s in floor, else 10 s, §4.1 / §4.3).
    pub keyframe_secs: u32,
    /// The `screen-content` tuning column of the ladder (medium, low, floor).
    pub screen_content: bool,
}

impl EncodeParams {
    /// True when a change from `self` to `next` needs a fresh encoder (size, fps or a
    /// create-time tuning changed); a bitrate-only change is a runtime reconfigure.
    pub fn needs_new_encoder(&self, next: &EncodeParams) -> bool {
        self.width != next.width
            || self.height != next.height
            || self.fps != next.fps
            || self.min_q != next.min_q
            || self.keyframe_secs != next.keyframe_secs
            || self.screen_content != next.screen_content
    }

    /// True when the bitrate moved enough (> 10 %) to be worth a libvpx reconfigure.
    pub fn bitrate_moved(&self, next: &EncodeParams) -> bool {
        let (a, b) = (self.kbps as f32, next.kbps as f32);
        (a - b).abs() > a.max(1.0) * 0.10
    }
}

/// Fit `w`x`h` inside `long_edge` on its long side, keeping the aspect ratio, **never
/// upscaling**, with even dimensions (I420 needs even planes).
pub fn fit_no_upscale(w: u32, h: u32, long_edge: u32) -> (u32, u32) {
    let (w, h) = (w.max(2), h.max(2));
    let long = w.max(h);
    let (fw, fh) = if long <= long_edge {
        (w, h)
    } else {
        let s = long_edge as f64 / long as f64;
        ((w as f64 * s).round() as u32, (h as f64 * s).round() as u32)
    };
    ((fw & !1).max(2), (fh & !1).max(2))
}

/// The libvpx settings for the Assist stream at `rung` under `preset` (contract §4.3):
/// `auto` follows the ladder; `sharp` pins the long edge to native (capped at the `full`
/// 2560 px) and lets fps drop with the rung; `smooth` pins 30 fps and lets the resolution drop
/// with the rung; `floor` forces the floor rung (the controller already reports it).
pub fn encode_params(
    rung: Rung,
    preset: QualityPreset,
    native_w: u32,
    native_h: u32,
    target_kbps: u32,
) -> EncodeParams {
    let rung = if preset == QualityPreset::Floor {
        Rung::Floor
    } else {
        rung
    };
    let spec = rung.spec();
    let long_edge = match preset {
        QualityPreset::Sharp => Rung::Full.spec().long_edge_max,
        _ => spec.long_edge_max,
    };
    let fps = match preset {
        QualityPreset::Smooth => Rung::Full.spec().fps_max,
        _ => spec.fps_max,
    };
    let (width, height) = fit_no_upscale(native_w, native_h, long_edge);
    let kbps = if rung == Rung::Floor {
        target_kbps.min(FLOOR_BUDGET_KBPS)
    } else {
        target_kbps
    }
    .clamp(50, limits::AGENT_MAX_KBPS);
    EncodeParams {
        width,
        height,
        fps,
        kbps,
        min_q: match rung {
            Rung::Low => 10,
            Rung::Floor => 16,
            _ => 2,
        },
        keyframe_secs: if rung == Rung::Floor { 15 } else { 10 },
        screen_content: rung <= Rung::Medium,
    }
}

/// The recorder stream's settings (contract §4.3 W24, §9 R2): the ladder at
/// `min(assistRung, medium)` (always `auto`, VP8), so in floor it is also 250 kbps / 5 fps; its
/// bitrate is the Assist target while the Assist is at or below `medium`, else the top of the
/// `medium` band, and never more than what is left of the 8000 kbps uplink cap.
pub fn recorder_params(
    assist_rung: Rung,
    native_w: u32,
    native_h: u32,
    assist_target_kbps: u32,
) -> EncodeParams {
    let rung = assist_rung.min(Rung::Medium);
    let kbps = if assist_rung <= Rung::Medium {
        assist_target_kbps
    } else {
        MEDIUM_MAX_KBPS
    };
    let kbps = kbps.min(TOTAL_MAX_KBPS.saturating_sub(assist_target_kbps).max(50));
    encode_params(rung, QualityPreset::Auto, native_w, native_h, kbps)
}

/// Whether the Assist and recorder streams can share one encoder (contract §4.2: "one encode,
/// two receivers" when the settings match; otherwise a second libvpx VP8 instance).
pub fn can_share_encoder(assist: &EncodeParams, recorder: &EncodeParams) -> bool {
    assist == recorder
}

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
    fn ladder_maps_rungs_to_size_fps_and_bitrate() {
        // 1080p source on each rung (auto).
        let p = encode_params(Rung::Full, QualityPreset::Auto, 1920, 1080, 4000);
        assert_eq!((p.width, p.height, p.fps, p.kbps), (1920, 1080, 30, 4000));
        assert!(!p.screen_content);
        let p = encode_params(Rung::High, QualityPreset::Auto, 2560, 1440, 2000);
        assert_eq!((p.width, p.height, p.fps), (1920, 1080, 24));
        let p = encode_params(Rung::Medium, QualityPreset::Auto, 1920, 1080, 1000);
        assert_eq!((p.width, p.height, p.fps), (1600, 900, 15));
        assert!(p.screen_content);
        let p = encode_params(Rung::Low, QualityPreset::Auto, 1920, 1080, 500);
        assert_eq!((p.width, p.height, p.fps, p.min_q), (1280, 720, 10, 10));
        let p = encode_params(Rung::Floor, QualityPreset::Auto, 1920, 1080, 900);
        assert_eq!((p.width, p.height, p.fps), (1024, 576, 5));
        assert_eq!(p.kbps, FLOOR_BUDGET_KBPS, "floor caps the leg at 250 kbps");
        assert_eq!(p.keyframe_secs, 15);
        // Never upscales a small source; odd sizes become even.
        let p = encode_params(Rung::Full, QualityPreset::Auto, 1279, 721, 3000);
        assert_eq!((p.width, p.height), (1278, 720));
        // The per-monitor cap holds.
        assert_eq!(
            encode_params(Rung::Full, QualityPreset::Auto, 64, 64, 99_000).kbps,
            limits::AGENT_MAX_KBPS
        );
    }

    #[test]
    fn presets_pin_resolution_or_fps() {
        // sharp: native long edge kept at a low rung, fps drops with the rung.
        let p = encode_params(Rung::Low, QualityPreset::Sharp, 1920, 1080, 500);
        assert_eq!((p.width, p.height, p.fps), (1920, 1080, 10));
        // smooth: 30 fps kept, resolution drops with the rung.
        let p = encode_params(Rung::Low, QualityPreset::Smooth, 1920, 1080, 500);
        assert_eq!((p.width, p.height, p.fps), (1280, 720, 30));
        // floor preset forces the floor rung whatever the controller said.
        let p = encode_params(Rung::Full, QualityPreset::Floor, 1920, 1080, 5000);
        assert_eq!((p.width, p.fps, p.kbps), (1024, 5, FLOOR_BUDGET_KBPS));
    }

    #[test]
    fn recorder_follows_min_of_assist_rung_and_medium() {
        // Assist above medium: the recorder runs the medium ladder at the medium-band top,
        // so a second encoder is needed.
        let a = encode_params(Rung::Full, QualityPreset::Auto, 1920, 1080, 5000);
        let r = recorder_params(Rung::Full, 1920, 1080, 5000);
        assert_eq!(
            (r.width, r.height, r.fps, r.kbps),
            (1600, 900, 15, MEDIUM_MAX_KBPS)
        );
        assert!(!can_share_encoder(&a, &r));
        // Assist at medium: identical settings, one shared encoder.
        let a = encode_params(Rung::Medium, QualityPreset::Auto, 1920, 1080, 1100);
        let r = recorder_params(Rung::Medium, 1920, 1080, 1100);
        assert!(can_share_encoder(&a, &r));
        // Floor: the recorder is capped at 250 kbps / 5 fps too, shared.
        let a = encode_params(Rung::Floor, QualityPreset::Auto, 1920, 1080, 200);
        let r = recorder_params(Rung::Floor, 1920, 1080, 200);
        assert_eq!((r.fps, r.kbps), (5, 200));
        assert!(can_share_encoder(&a, &r));
        // The uplink total stays within 8000 kbps.
        let r = recorder_params(Rung::Full, 2560, 1440, 6000);
        assert!(6000 + r.kbps <= TOTAL_MAX_KBPS);
    }

    #[test]
    fn encoder_rebuild_vs_reconfigure() {
        let a = encode_params(Rung::Medium, QualityPreset::Auto, 1920, 1080, 1000);
        let b = encode_params(Rung::Medium, QualityPreset::Auto, 1920, 1080, 1300);
        assert!(!a.needs_new_encoder(&b));
        assert!(a.bitrate_moved(&b));
        let c = encode_params(Rung::Medium, QualityPreset::Auto, 1920, 1080, 1050);
        assert!(!a.bitrate_moved(&c), "a 5 % wobble is not reconfigured");
        let d = encode_params(Rung::High, QualityPreset::Auto, 1920, 1080, 1600);
        assert!(a.needs_new_encoder(&d));
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
