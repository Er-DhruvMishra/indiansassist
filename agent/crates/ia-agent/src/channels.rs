//! Data-channel helpers for the `media` build: driving the `ia.sec` handshake over a live
//! channel (contract §1.3) and writing encoded VP8 samples to a video track (§3.6, §4).
//!
//! These bridge the pure [`crate::sechs`] / [`crate::vp8`] logic to webrtc-rs I/O so the
//! loopback test and the live session share one path.

use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use tokio::sync::mpsc;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::media::Sample;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use crate::sechs::SecHandshake;
use crate::vp8::Vp8Encoder;
use ia_core::sec::{SessionKeys, Side};
use ia_core::types::SecFailReason;
use ia_platform::traits::Capturer;

/// Drive the §1.3 handshake to completion over `dc` (which must be open). Returns the
/// derived keys and the SAS, or the [`SecFailReason`] to put on `sec.fail`.
pub async fn run_handshake(
    dc: Arc<RTCDataChannel>,
    side: Side,
    session_id: &str,
    gen: u16,
    own_fpr: &str,
    remote_fpr: &str,
) -> Result<(SessionKeys, String), SecFailReason> {
    // Forward text frames the peer sends into a queue before sending our own commit, so a
    // commit already in flight is not missed (the channel is ordered + reliable).
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    dc.on_message(Box::new(move |msg: DataChannelMessage| {
        if msg.is_string {
            let _ = tx.send(String::from_utf8_lossy(&msg.data).to_string());
        }
        Box::pin(async {})
    }));

    // The handshake has a single 10 s budget measured from `ia.sec` open — not a fresh
    // timeout per message (contract §1.3 step 8: "10 s from ia.sec open without established").
    let deadline =
        Instant::now() + Duration::from_millis(ia_core::types::limits::SEC_HANDSHAKE_TIMEOUT_MS);
    let remaining = |d: Instant| d.saturating_duration_since(Instant::now());

    // Wait for the channel to open (on_open fires immediately if it already is).
    let (open_tx, open_rx) = tokio::sync::oneshot::channel::<()>();
    let open_tx = std::sync::Arc::new(std::sync::Mutex::new(Some(open_tx)));
    dc.on_open(Box::new(move || {
        if let Some(tx) = open_tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
        Box::pin(async {})
    }));
    if tokio::time::timeout(remaining(deadline), open_rx)
        .await
        .is_err()
    {
        return Err(SecFailReason::Timeout);
    }

    let (mut hs, commit) = SecHandshake::start(side, session_id, gen, own_fpr, remote_fpr);
    dc.send_text(commit)
        .await
        .map_err(|_| SecFailReason::Decrypt)?;

    loop {
        let frame = match tokio::time::timeout(remaining(deadline), rx.recv()).await {
            Ok(Some(f)) => f,
            _ => return Err(SecFailReason::Timeout),
        };
        for out in hs.on_message(&frame)? {
            dc.send_text(out)
                .await
                .map_err(|_| SecFailReason::Decrypt)?;
        }
        if hs.established() {
            // `established()` is true here, so `take_established` yields the keys.
            if let Some(keys) = hs.take_established() {
                return Ok(keys);
            }
        }
    }
}

/// Encode `count` frames from `cap` for `monitor_id` and write them to `track`, forcing a
/// keyframe on the first frame. Returns how many keyframes were sent.
pub async fn send_frames(
    track: Arc<TrackLocalStaticSample>,
    encoder: &mut Vp8Encoder,
    cap: &mut dyn Capturer,
    monitor_id: u32,
    count: usize,
    fps: u32,
) -> Result<usize, String> {
    let dur = Duration::from_millis((1000 / fps.max(1)) as u64);
    let mut keyframes = 0usize;
    for i in 0..count {
        let Some(frame) = cap.next_frame(monitor_id) else {
            continue;
        };
        for pkt in encoder.encode(&frame, i == 0)? {
            if pkt.keyframe {
                keyframes += 1;
            }
            track
                .write_sample(&Sample {
                    data: Bytes::from(pkt.data),
                    duration: dur,
                    ..Default::default()
                })
                .await
                .map_err(|e| format!("write_sample: {e}"))?;
        }
        tokio::time::sleep(dur).await;
    }
    Ok(keyframes)
}
