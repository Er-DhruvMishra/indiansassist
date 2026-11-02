//! Voice when the `voice` feature is not built (Phase E §7.2, §7.5: the Linux build has no
//! cpal / Opus, so it needs no ALSA). The same surface as `voice.rs`, honest about having no
//! device: [`voice_available`] is `false`, so the `voice` capability is never advertised, no
//! [`Voice`] is ever constructed by the serve loop, and no audio track is added to a peer.
//!
//! [`new_audio_track`] and [`voice_state`] stay real: they are pure wire shapes (the recorder
//! test builds a track with them).

use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use webrtc::api::media_engine::MIME_TYPE_OPUS;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_remote::TrackRemote;

use crate::codecs::OPUS_FMTP;

/// Opus runs at 48 kHz (contract §6.3).
pub const OPUS_RATE: u32 = 48_000;

/// `voice.state { from: 'desk', muted }` on `ia.ctrl` (contract §6.3, A §8).
pub fn voice_state(muted: bool, ts: i64) -> serde_json::Value {
    serde_json::json!({ "t": "voice.state", "from": "desk", "muted": muted, "ts": ts })
}

/// No voice stack is built, so there is never a usable device.
pub fn devices_available() -> bool {
    false
}

/// Always `false` in this build: the `voice` feature is not advertised (§7.5).
pub fn voice_available() -> bool {
    false
}

/// The Desk's outgoing audio track shape (Opus), kept so the wire code compiles unchanged.
pub fn new_audio_track() -> Arc<TrackLocalStaticSample> {
    Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: MIME_TYPE_OPUS.to_string(),
            clock_rate: OPUS_RATE,
            channels: 2,
            sdp_fmtp_line: OPUS_FMTP.to_string(),
            rtcp_feedback: vec![],
        },
        "desk-audio".to_string(),
        "ia-screen".to_string(),
    ))
}

/// The live voice state of one session. Never constructed while [`voice_available`] is false;
/// every operation is a no-op that reports "muted".
pub struct Voice {
    pub track: Arc<TrackLocalStaticSample>,
    pub sent_bytes: Arc<AtomicU64>,
}

impl Default for Voice {
    fn default() -> Self {
        Self::new()
    }
}

impl Voice {
    pub fn new() -> Self {
        Self {
            track: new_audio_track(),
            sent_bytes: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn muted(&self) -> bool {
        true
    }

    pub fn set_muted(&mut self, muted: bool) -> Result<(), String> {
        if muted {
            Ok(())
        } else {
            Err("voice is not built into this agent".into())
        }
    }

    pub fn attach_remote(&mut self, _remote: Arc<TrackRemote>) {}

    pub fn stop(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_build_without_voice_never_advertises_it_and_cannot_unmute() {
        assert!(!voice_available());
        let mut v = Voice::new();
        assert!(v.muted());
        assert!(v.set_muted(true).is_ok());
        assert!(v.set_muted(false).is_err());
        assert_eq!(voice_state(true, 5)["muted"], serde_json::json!(true));
    }
}
