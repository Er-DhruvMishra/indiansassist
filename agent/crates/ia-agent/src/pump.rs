//! The video pump (contract §4.1-§4.3, §9 R2), compiled under `media`: capture one monitor,
//! scale it to the ABR rung, encode VP8 and write the samples to the Assist track and, when a
//! server recorder is attached, to the recorder track.
//!
//! The serve loop owns the [`AbrController`](ia_core::abr::AbrController) and publishes its
//! decision into a shared [`VideoCtl`] (rung, target, preset, keyframe requests); the pump reads
//! it every frame and makes libvpx follow: a rung / preset change that moves the size, fps or a
//! create-time tuning re-creates the encoder (the first frame of a new encoder is a keyframe,
//! which is the §4.3 "a rung change forces a keyframe"), a bitrate-only move is a runtime
//! reconfigure. The recorder stream follows `min(assistRung, medium)` (§4.3 W24): when its
//! settings equal the Assist's the encoded frames are written to both tracks (one encode, two
//! receivers); otherwise a second libvpx VP8 instance encodes the recorder stream from the same
//! captured frames at its own size and pace.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use webrtc::media::Sample;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use crate::capture::SyntheticCapturer;
use crate::vp8::{EncodedPacket, Vp8Encoder};
use ia_capture_win::scale::{is_packed_at, scale_i420};
use ia_core::abr::{can_share_encoder, encode_params, recorder_params, EncodeParams, Rung};
use ia_core::types::{CapturePath, QualityPreset};
use ia_platform::traits::{Capturer, Frame};

/// Bytes / frames the send path measures for `agent.stats` (contract §4.4: measured, never
/// invented). `sent_*` count the Assist track, `rec_*` the recorder track.
#[derive(Default)]
pub struct VideoMeter {
    pub sent_bytes: AtomicU64,
    pub sent_frames: AtomicU64,
    pub encode_ns: AtomicU64,
    pub encode_frames: AtomicU64,
    pub capture_frames: AtomicU64,
    pub rec_bytes: AtomicU64,
    pub rec_frames: AtomicU64,
    /// The size the Assist stream is currently encoded at (`w << 16 | h`).
    pub encoded_size: AtomicU32,
}

/// The recorder track the pump also feeds (contract §9 R2), with its own keyframe request
/// (set on attach and on a recorder PLI).
pub struct RecorderSink {
    pub track: Arc<TrackLocalStaticSample>,
    pub force_keyframe: Arc<AtomicBool>,
}

/// What the serve loop tells the pump (shared, lock-free except the recorder slot).
pub struct VideoCtl {
    rung: AtomicU8,
    preset: AtomicU8,
    target_kbps: AtomicU32,
    /// An Assist keyframe request (PLI / FIR from the Assist, or a selection change).
    pub force_keyframe: AtomicBool,
    recorder: Mutex<Option<RecorderSink>>,
    pub meter: VideoMeter,
}

impl Default for VideoCtl {
    fn default() -> Self {
        Self::new(Rung::Medium, 1500)
    }
}

fn preset_index(p: QualityPreset) -> u8 {
    match p {
        QualityPreset::Auto => 0,
        QualityPreset::Sharp => 1,
        QualityPreset::Smooth => 2,
        QualityPreset::Floor => 3,
    }
}

fn preset_from_index(i: u8) -> QualityPreset {
    match i {
        1 => QualityPreset::Sharp,
        2 => QualityPreset::Smooth,
        3 => QualityPreset::Floor,
        _ => QualityPreset::Auto,
    }
}

impl VideoCtl {
    pub fn new(rung: Rung, target_kbps: u32) -> Self {
        Self {
            rung: AtomicU8::new(rung.index()),
            preset: AtomicU8::new(0),
            target_kbps: AtomicU32::new(target_kbps),
            force_keyframe: AtomicBool::new(false),
            recorder: Mutex::new(None),
            meter: VideoMeter::default(),
        }
    }

    /// Publish an ABR decision (rung + target); a rung change also requests a keyframe.
    pub fn set_decision(&self, rung: Rung, target_kbps: u32) {
        let old = self.rung.swap(rung.index(), Ordering::Relaxed);
        if old != rung.index() {
            self.force_keyframe.store(true, Ordering::Relaxed);
        }
        self.target_kbps.store(target_kbps, Ordering::Relaxed);
    }

    pub fn set_preset(&self, preset: QualityPreset) {
        self.preset.store(preset_index(preset), Ordering::Relaxed);
    }

    pub fn rung(&self) -> Rung {
        Rung::from_index(self.rung.load(Ordering::Relaxed))
    }

    pub fn preset(&self) -> QualityPreset {
        preset_from_index(self.preset.load(Ordering::Relaxed))
    }

    pub fn target_kbps(&self) -> u32 {
        self.target_kbps.load(Ordering::Relaxed)
    }

    /// Attach (or replace) the recorder track; it gets a keyframe on its first frame.
    pub fn attach_recorder(&self, track: Arc<TrackLocalStaticSample>) -> Arc<AtomicBool> {
        let force_keyframe = Arc::new(AtomicBool::new(true));
        if let Ok(mut slot) = self.recorder.lock() {
            *slot = Some(RecorderSink {
                track,
                force_keyframe: force_keyframe.clone(),
            });
        }
        force_keyframe
    }

    pub fn detach_recorder(&self) {
        if let Ok(mut slot) = self.recorder.lock() {
            *slot = None;
        }
    }

    pub fn has_recorder(&self) -> bool {
        self.recorder.lock().map(|s| s.is_some()).unwrap_or(false)
    }

    fn recorder(&self) -> Option<(Arc<TrackLocalStaticSample>, Arc<AtomicBool>)> {
        self.recorder.lock().ok().and_then(|s| {
            s.as_ref()
                .map(|r| (r.track.clone(), r.force_keyframe.clone()))
        })
    }

    /// The size the Assist stream is encoded at right now (0 x 0 before the first frame).
    pub fn encoded_size(&self) -> (u32, u32) {
        let v = self.meter.encoded_size.load(Ordering::Relaxed);
        (v >> 16, v & 0xFFFF)
    }
}

/// The frame source: synthetic (e2e / loopback), or DXGI Desktop Duplication with the
/// per-monitor GDI fallback (§4.1).
pub enum CaptureSource {
    Synthetic(SyntheticCapturer),
    #[cfg(all(windows, feature = "winapi"))]
    Dxgi(Box<ia_capture_win::dxgi::DxgiCapturer>),
}

impl CaptureSource {
    pub fn new(synthetic: bool, w: u32, h: u32) -> Self {
        #[cfg(all(windows, feature = "winapi"))]
        if !synthetic {
            return CaptureSource::Dxgi(Box::new(ia_capture_win::dxgi::DxgiCapturer::new()));
        }
        let _ = synthetic;
        CaptureSource::Synthetic(SyntheticCapturer::single(w, h))
    }

    pub fn next_frame(&mut self, id: u32) -> Option<Frame> {
        match self {
            CaptureSource::Synthetic(c) => c.next_frame(id),
            #[cfg(all(windows, feature = "winapi"))]
            CaptureSource::Dxgi(c) => c.next_frame(id),
        }
    }

    /// `agent.stats.capturePath` (the synthetic source reports `gdi`, as before).
    pub fn path(&self, id: u32) -> CapturePath {
        match self {
            CaptureSource::Synthetic(_) => CapturePath::Gdi,
            #[cfg(all(windows, feature = "winapi"))]
            CaptureSource::Dxgi(c) => c.path(id),
        }
    }
}

/// One encoder bound to the settings it was built (or last reconfigured) with.
struct Stream {
    enc: Vp8Encoder,
    params: EncodeParams,
    last_write: Option<Instant>,
}

impl Stream {
    /// Make the encoder follow `want`: rebuild on a size / fps / tuning change, reconfigure on
    /// a bitrate move. Returns false when no encoder could be built.
    fn follow(slot: &mut Option<Stream>, want: EncodeParams, stream: &'static str) -> bool {
        match slot {
            Some(s) if !s.params.needs_new_encoder(&want) => {
                if s.params.bitrate_moved(&want) {
                    match s.enc.set_bitrate(want.kbps) {
                        Ok(()) => s.params.kbps = want.kbps,
                        Err(e) => tracing::debug!("{e}"),
                    }
                }
                true
            }
            _ => match Vp8Encoder::with_params(&want) {
                Ok(enc) => {
                    tracing::info!(
                        stream,
                        width = want.width,
                        height = want.height,
                        fps = want.fps,
                        kbps = want.kbps,
                        "vp8 encoder (re)configured"
                    );
                    let last_write = slot.as_ref().and_then(|s| s.last_write);
                    *slot = Some(Stream {
                        enc,
                        params: want,
                        last_write,
                    });
                    true
                }
                Err(e) => {
                    tracing::warn!("vp8 encoder init failed: {e}");
                    *slot = None;
                    false
                }
            },
        }
    }

    /// The RTP duration of the next sample: the wall time since the previous one, bounded.
    fn sample_duration(&mut self, now: Instant) -> Duration {
        let nominal = Duration::from_millis(1000 / self.params.fps.max(1) as u64);
        let d = self
            .last_write
            .map(|t| now.saturating_duration_since(t))
            .unwrap_or(nominal)
            .clamp(Duration::from_millis(1), Duration::from_secs(2));
        self.last_write = Some(now);
        d
    }
}

/// Scale `frame` to `p`'s size unless it already is exactly that (packed).
fn fit_frame<'a>(frame: &'a Frame, p: &EncodeParams, buf: &'a mut Option<Frame>) -> &'a Frame {
    if is_packed_at(frame, p.width, p.height) {
        frame
    } else {
        buf.insert(scale_i420(frame, p.width, p.height))
    }
}

/// Run the CPU-heavy part (capture, scale, encode) without starving the runtime: on a
/// multi-thread runtime the worker hands its other tasks off first.
fn heavy<R>(f: impl FnOnce() -> R) -> R {
    match tokio::runtime::Handle::try_current().map(|h| h.runtime_flavor()) {
        Ok(tokio::runtime::RuntimeFlavor::MultiThread) => tokio::task::block_in_place(f),
        _ => f(),
    }
}

/// Inputs of one pump.
pub struct PumpSpec {
    pub monitor_id: u32,
    /// The monitor's native size (the ladder fits inside it, never above).
    pub native_w: u32,
    pub native_h: u32,
}

struct Encoded {
    packets: Vec<EncodedPacket>,
    encode_ns: u64,
}

fn encode_one(stream: &mut Stream, frame: &Frame, kf: bool) -> Option<Encoded> {
    let mut buf = None;
    let f = fit_frame(frame, &stream.params, &mut buf);
    let t0 = Instant::now();
    match stream.enc.encode(f, kf) {
        Ok(packets) => Some(Encoded {
            packets,
            encode_ns: t0.elapsed().as_nanos() as u64,
        }),
        Err(e) => {
            tracing::debug!("encode error: {e}");
            None
        }
    }
}

async fn write_packets(
    track: &TrackLocalStaticSample,
    packets: &[EncodedPacket],
    duration: Duration,
) -> u64 {
    let mut bytes = 0u64;
    for pkt in packets {
        bytes += pkt.data.len() as u64;
        let _ = track
            .write_sample(&Sample {
                data: Bytes::from(pkt.data.clone()),
                duration,
                ..Default::default()
            })
            .await;
    }
    bytes
}

/// The continuous pump for one monitor until `stop` fires.
pub async fn run_pump(
    track: Arc<TrackLocalStaticSample>,
    spec: PumpSpec,
    mut source: CaptureSource,
    ctl: Arc<VideoCtl>,
    stop: Arc<tokio::sync::Notify>,
    path: Arc<AtomicU8>,
) {
    let (w, h) = (spec.native_w.max(2), spec.native_h.max(2));
    let mut assist: Option<Stream> = None;
    let mut recorder: Option<Stream> = None;
    let mut next_tick = tokio::time::Instant::now();
    let mut next_rec = Instant::now();
    let mut prev_shared = false;
    loop {
        let rung = ctl.rung();
        let target = ctl.target_kbps();
        let want = encode_params(rung, ctl.preset(), w, h, target);
        next_tick += Duration::from_millis(1000 / want.fps.max(1) as u64);
        let now = tokio::time::Instant::now();
        if next_tick < now {
            next_tick = now; // fell behind (slow encode): do not burst to catch up
        }
        tokio::select! {
            _ = stop.notified() => break,
            _ = tokio::time::sleep_until(next_tick) => {}
        }
        let rec_sink = ctl.recorder();
        let rec_want = rec_sink
            .as_ref()
            .map(|_| recorder_params(rung, w, h, target));
        let shared = rec_want.is_some_and(|r| can_share_encoder(&want, &r));
        if shared || rec_want.is_none() {
            // The recorder's own encoder exists only while it is needed.
            recorder = None;
        }

        // Capture + scale + encode off the async path.
        let wall = Instant::now();
        let rec_due = rec_want.is_some() && !shared && wall >= next_rec;
        // Switching the recorder onto the shared encoder needs a keyframe in that stream (its
        // decoder has only seen the second encoder's frames until now).
        let rec_kf = rec_sink
            .as_ref()
            .map(|(_, kf)| kf.load(Ordering::Relaxed))
            .unwrap_or(false)
            || (shared && !prev_shared);
        prev_shared = shared;
        let assist_kf_req = ctl.force_keyframe.load(Ordering::Relaxed);
        let (frame_ok, a_out, r_out, cap_path) = heavy(|| {
            let frame = source.next_frame(spec.monitor_id);
            let cap_path = source.path(spec.monitor_id);
            let Some(frame) = frame else {
                return (false, None, None, cap_path);
            };
            let a_out = if Stream::follow(&mut assist, want, "assist") {
                let kf = assist_kf_req || (shared && rec_kf);
                assist.as_mut().and_then(|s| encode_one(s, &frame, kf))
            } else {
                None
            };
            let r_out = match (rec_due, rec_want) {
                (true, Some(rw)) if Stream::follow(&mut recorder, rw, "recorder") => recorder
                    .as_mut()
                    .and_then(|s| encode_one(s, &frame, rec_kf)),
                _ => None,
            };
            (true, a_out, r_out, cap_path)
        });
        path.store(cap_path as u8, Ordering::Relaxed);
        if !frame_ok {
            continue;
        }
        ctl.meter.capture_frames.fetch_add(1, Ordering::Relaxed);

        if let (Some(out), Some(stream)) = (a_out, assist.as_mut()) {
            if assist_kf_req {
                ctl.force_keyframe.store(false, Ordering::Relaxed);
            }
            let d = stream.sample_duration(Instant::now());
            ctl.meter
                .encode_ns
                .fetch_add(out.encode_ns, Ordering::Relaxed);
            ctl.meter.encode_frames.fetch_add(1, Ordering::Relaxed);
            ctl.meter.sent_frames.fetch_add(1, Ordering::Relaxed);
            ctl.meter.encoded_size.store(
                (stream.params.width << 16) | (stream.params.height & 0xFFFF),
                Ordering::Relaxed,
            );
            let bytes = write_packets(&track, &out.packets, d).await;
            ctl.meter.sent_bytes.fetch_add(bytes, Ordering::Relaxed);
            if shared {
                if let Some((rt, kf)) = &rec_sink {
                    if rec_kf {
                        kf.store(false, Ordering::Relaxed);
                    }
                    let rb = write_packets(rt, &out.packets, d).await;
                    ctl.meter.rec_bytes.fetch_add(rb, Ordering::Relaxed);
                    ctl.meter.rec_frames.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        if let (Some(out), Some(stream), Some((rt, kf))) = (r_out, recorder.as_mut(), &rec_sink) {
            if rec_kf {
                kf.store(false, Ordering::Relaxed);
            }
            next_rec = wall + Duration::from_millis(1000 / stream.params.fps.max(1) as u64);
            let d = stream.sample_duration(Instant::now());
            let rb = write_packets(rt, &out.packets, d).await;
            ctl.meter.rec_bytes.fetch_add(rb, Ordering::Relaxed);
            ctl.meter.rec_frames.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctl_publishes_rung_preset_and_keyframe_requests() {
        let ctl = VideoCtl::default();
        assert_eq!(ctl.rung(), Rung::Medium);
        ctl.set_decision(Rung::Medium, 1200);
        assert!(!ctl.force_keyframe.load(Ordering::Relaxed));
        ctl.set_decision(Rung::Low, 500);
        assert!(
            ctl.force_keyframe.load(Ordering::Relaxed),
            "a rung change forces a keyframe"
        );
        assert_eq!((ctl.rung(), ctl.target_kbps()), (Rung::Low, 500));
        for p in QualityPreset::ALL {
            ctl.set_preset(p);
            assert_eq!(ctl.preset(), p);
        }
        assert!(!ctl.has_recorder());
    }
}
