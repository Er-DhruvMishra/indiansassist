//! Voice (contract §6.3), compiled under `media`: the default capture / render endpoints via
//! `cpal` (WASAPI), Opus 48 kHz through `audiopus`, one audio `TrackLocalStaticSample` (payload
//! type 111, `opus/48000/2`) added to the Assist PC at start and to the recorder PC (§9 R5).
//!
//! **Muted by default** (A D8): while muted no capture stream is open at all (so Windows shows
//! no microphone-in-use indicator) and no samples are written, so unmuting needs no
//! renegotiation. The Assist's audio, when it sends any, is decoded and played on the default
//! render device. No acoustic echo cancellation on this path (headsets expected, §6.3 Echo).
//!
//! The frame plumbing (downmix, linear resampling, 20 ms framing, Opus encode / decode, the
//! bounded render queue) is pure and unit-tested; opening real devices is not exercised by an
//! automated test (a host may have none).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use audiopus::coder::{Decoder as OpusDecoder, Encoder as OpusEncoder};
use audiopus::{Application, Bitrate, Channels, SampleRate};
use bytes::Bytes;
use webrtc::api::media_engine::MIME_TYPE_OPUS;
use webrtc::media::Sample;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_remote::TrackRemote;

use crate::codecs::OPUS_FMTP;

/// Opus runs at 48 kHz; one frame is 20 ms (contract §6.3).
pub const OPUS_RATE: u32 = 48_000;
pub const FRAME_SAMPLES: usize = 960;
pub const FRAME: Duration = Duration::from_millis(20);
/// 32 kbps VBR (contract §6.3).
pub const OPUS_BITRATE: i32 = 32_000;
/// The render queue holds at most this much audio (older samples are dropped).
pub const RENDER_MAX_MS: u32 = 200;
const OPUS_SET_DTX_REQUEST: i32 = 4016;

// ---- pure plumbing ---------------------------------------------------------------------------

/// Linear resampler over interleaved samples with a fixed channel count.
pub struct Resampler {
    channels: usize,
    /// Input samples consumed per output sample.
    step: f64,
    /// Fractional read position (in frames) into `buf`.
    pos: f64,
    buf: Vec<f32>,
}

impl Resampler {
    pub fn new(channels: usize, in_rate: u32, out_rate: u32) -> Self {
        Self {
            channels: channels.max(1),
            step: in_rate.max(1) as f64 / out_rate.max(1) as f64,
            pos: 0.0,
            buf: Vec::new(),
        }
    }

    /// Feed interleaved input; append the resampled interleaved output to `out`.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        let c = self.channels;
        self.buf.extend_from_slice(input);
        let frames = self.buf.len() / c;
        if (self.step - 1.0).abs() < f64::EPSILON {
            out.extend_from_slice(&self.buf[..frames * c]);
            self.buf.drain(..frames * c);
            return;
        }
        while self.pos + 1.0 < frames as f64 {
            let i = self.pos as usize;
            let t = (self.pos - i as f64) as f32;
            for ch in 0..c {
                let a = self.buf[i * c + ch];
                let b = self.buf[(i + 1) * c + ch];
                out.push(a + (b - a) * t);
            }
            self.pos += self.step;
        }
        let used = (self.pos as usize).min(frames);
        self.buf.drain(..used * c);
        self.pos -= used as f64;
    }
}

/// Downmix interleaved `channels` to mono.
pub fn downmix(input: &[f32], channels: usize) -> Vec<f32> {
    let c = channels.max(1);
    input
        .chunks_exact(c)
        .map(|f| f.iter().sum::<f32>() / c as f32)
        .collect()
}

/// Map interleaved stereo onto a device with `channels` outputs (mono = average; more than two
/// = left / right on the first two, silence on the rest).
pub fn map_stereo(stereo: &[f32], channels: usize) -> Vec<f32> {
    match channels {
        0 | 1 => stereo
            .as_chunks::<2>()
            .0
            .iter()
            .map(|f| (f[0] + f[1]) * 0.5)
            .collect(),
        2 => stereo.to_vec(),
        n => {
            let mut out = Vec::with_capacity(stereo.len() / 2 * n);
            for f in stereo.as_chunks::<2>().0 {
                out.push(f[0]);
                out.push(f[1]);
                out.extend(std::iter::repeat_n(0.0, n - 2));
            }
            out
        }
    }
}

/// Capture side: device samples (any rate / channel count) -> mono 48 kHz 20 ms frames.
pub struct CaptureFramer {
    channels: usize,
    resampler: Resampler,
    pending: Vec<f32>,
}

impl CaptureFramer {
    pub fn new(channels: usize, device_rate: u32) -> Self {
        Self {
            channels: channels.max(1),
            resampler: Resampler::new(1, device_rate, OPUS_RATE),
            pending: Vec::new(),
        }
    }

    /// Feed one device callback's interleaved samples; returns every complete 20 ms frame.
    pub fn push(&mut self, interleaved: &[f32]) -> Vec<Vec<f32>> {
        let mono = downmix(interleaved, self.channels);
        self.resampler.process(&mono, &mut self.pending);
        let mut frames = Vec::new();
        while self.pending.len() >= FRAME_SAMPLES {
            frames.push(self.pending.drain(..FRAME_SAMPLES).collect());
        }
        frames
    }
}

/// The mic encoder: mono 48 kHz VoIP, 32 kbps VBR, in-band FEC and DTX on (contract §6.3).
pub struct OpusTx {
    enc: OpusEncoder,
    out: Vec<u8>,
}

impl OpusTx {
    pub fn new() -> Result<Self, String> {
        let mut enc = OpusEncoder::new(SampleRate::Hz48000, Channels::Mono, Application::Voip)
            .map_err(|e| format!("opus encoder: {e}"))?;
        enc.set_bitrate(Bitrate::BitsPerSecond(OPUS_BITRATE))
            .map_err(|e| format!("opus bitrate: {e}"))?;
        enc.set_vbr(true).map_err(|e| format!("opus vbr: {e}"))?;
        enc.set_inband_fec(true)
            .map_err(|e| format!("opus fec: {e}"))?;
        enc.set_encoder_ctl_request(OPUS_SET_DTX_REQUEST, 1)
            .map_err(|e| format!("opus dtx: {e}"))?;
        Ok(Self {
            enc,
            out: vec![0u8; 4000],
        })
    }

    /// Encode one 20 ms mono frame (960 samples, -1..1).
    pub fn encode(&mut self, frame: &[f32]) -> Result<Vec<u8>, String> {
        if frame.len() != FRAME_SAMPLES {
            return Err("an Opus frame is 960 samples".into());
        }
        let n = self
            .enc
            .encode_float(frame, &mut self.out)
            .map_err(|e| format!("opus encode: {e}"))?;
        Ok(self.out[..n].to_vec())
    }
}

/// The Assist-audio decoder: 48 kHz stereo (the SDP's `opus/48000/2`).
pub struct OpusRx {
    dec: OpusDecoder,
    out: Vec<f32>,
}

impl OpusRx {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            dec: OpusDecoder::new(SampleRate::Hz48000, Channels::Stereo)
                .map_err(|e| format!("opus decoder: {e}"))?,
            // 120 ms stereo, the largest Opus packet.
            out: vec![0.0; 5760 * 2],
        })
    }

    /// Decode one packet (`None` = a lost packet, concealed) into interleaved stereo.
    pub fn decode(&mut self, packet: Option<&[u8]>) -> Result<Vec<f32>, String> {
        let n = match packet {
            Some(p) => self.dec.decode_float(Some(p), &mut self.out[..], false),
            // Concealment fills exactly the buffer it is given: one 20 ms frame.
            None => self
                .dec
                .decode_float(None::<&[u8]>, &mut self.out[..FRAME_SAMPLES * 2], false),
        }
        .map_err(|e| format!("opus decode: {e}"))?;
        Ok(self.out[..n * 2].to_vec())
    }
}

/// The bounded queue between the decoder and the render callback (drop-oldest above
/// [`RENDER_MAX_MS`]; an underrun plays silence).
#[derive(Clone)]
pub struct RenderQueue {
    inner: Arc<Mutex<VecDeque<f32>>>,
    max: usize,
}

impl RenderQueue {
    pub fn new(device_rate: u32, channels: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(VecDeque::new())),
            max: (device_rate as usize * channels.max(1) * RENDER_MAX_MS as usize) / 1000,
        }
    }

    pub fn push(&self, samples: &[f32]) {
        if let Ok(mut q) = self.inner.lock() {
            q.extend(samples.iter().copied());
            let over = q.len().saturating_sub(self.max);
            q.drain(..over);
        }
    }

    /// Fill `out` from the queue, padding with silence.
    pub fn pull(&self, out: &mut [f32]) {
        let mut q = match self.inner.lock() {
            Ok(q) => q,
            Err(_) => {
                out.fill(0.0);
                return;
            }
        };
        for s in out.iter_mut() {
            *s = q.pop_front().unwrap_or(0.0);
        }
    }

    pub fn len(&self) -> usize {
        self.inner.lock().map(|q| q.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// `voice.state { from: 'desk', muted }` on `ia.ctrl` (contract §6.3, A §8).
pub fn voice_state(muted: bool, ts: i64) -> serde_json::Value {
    serde_json::json!({ "t": "voice.state", "from": "desk", "muted": muted, "ts": ts })
}

// ---- devices ---------------------------------------------------------------------------------

/// Whether a default capture **and** render endpoint exist (the `voice` capability, §6.3).
/// Probed on a throwaway thread so cpal's COM initialisation never lands on a runtime worker
/// or the UI thread.
pub fn devices_available() -> bool {
    std::thread::spawn(|| {
        use cpal::traits::HostTrait;
        let host = cpal::default_host();
        host.default_input_device().is_some() && host.default_output_device().is_some()
    })
    .join()
    .unwrap_or(false)
}

/// [`devices_available`], probed once per process (the `desk.hello` capability and the serve
/// loop agree).
pub fn voice_available() -> bool {
    static AVAILABLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *AVAILABLE.get_or_init(devices_available)
}

/// The Desk's outgoing audio track (Opus, added muted, contract §6.3).
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

/// A device stream running on its own thread (cpal streams are not `Send`); dropping the
/// handle stops it.
struct DeviceThread {
    stop: std::sync::mpsc::Sender<()>,
}

impl Drop for DeviceThread {
    fn drop(&mut self) {
        let _ = self.stop.send(());
    }
}

/// Open the default capture device and stream encoded Opus frames into `tx` until dropped.
fn start_capture(tx: tokio::sync::mpsc::UnboundedSender<Vec<u8>>) -> Result<DeviceThread, String> {
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("ia-voice-capture".into())
        .spawn(move || {
            use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
            let open = || -> Result<cpal::Stream, String> {
                let dev = cpal::default_host()
                    .default_input_device()
                    .ok_or("no capture device")?;
                let cfg = dev.default_input_config().map_err(|e| e.to_string())?;
                let channels = cfg.channels() as usize;
                let rate = cfg.sample_rate().0;
                let mut framer = CaptureFramer::new(channels, rate);
                let mut opus = OpusTx::new()?;
                let mut on_samples = move |data: &[f32]| {
                    for frame in framer.push(data) {
                        if let Ok(pkt) = opus.encode(&frame) {
                            let _ = tx.send(pkt);
                        }
                    }
                };
                let err = |e| tracing::warn!("voice capture stream error: {e}");
                let stream = match cfg.sample_format() {
                    cpal::SampleFormat::F32 => dev.build_input_stream(
                        &cfg.config(),
                        move |d: &[f32], _: &cpal::InputCallbackInfo| on_samples(d),
                        err,
                        None,
                    ),
                    cpal::SampleFormat::I16 => dev.build_input_stream(
                        &cfg.config(),
                        move |d: &[i16], _: &cpal::InputCallbackInfo| {
                            let f: Vec<f32> = d.iter().map(|s| *s as f32 / 32768.0).collect();
                            on_samples(&f)
                        },
                        err,
                        None,
                    ),
                    other => return Err(format!("unsupported capture format {other:?}")),
                }
                .map_err(|e| e.to_string())?;
                stream.play().map_err(|e| e.to_string())?;
                Ok(stream)
            };
            match open() {
                Ok(stream) => {
                    let _ = ready_tx.send(Ok(()));
                    let _ = stop_rx.recv();
                    drop(stream);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            }
        })
        .map_err(|e| e.to_string())?;
    ready_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "capture device did not open".to_string())??;
    Ok(DeviceThread { stop: stop_tx })
}

/// Open the default render device, playing `queue` until dropped. Returns the device's
/// rate and channel count so the decoder side can resample into it.
fn start_render() -> Result<(DeviceThread, RenderQueue, u32, usize), String> {
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let (ready_tx, ready_rx) =
        std::sync::mpsc::channel::<Result<(RenderQueue, u32, usize), String>>();
    std::thread::Builder::new()
        .name("ia-voice-render".into())
        .spawn(move || {
            use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
            let open = || -> Result<(cpal::Stream, RenderQueue, u32, usize), String> {
                let dev = cpal::default_host()
                    .default_output_device()
                    .ok_or("no render device")?;
                let cfg = dev.default_output_config().map_err(|e| e.to_string())?;
                let channels = cfg.channels() as usize;
                let rate = cfg.sample_rate().0;
                let queue = RenderQueue::new(rate, channels);
                let q = queue.clone();
                let err = |e| tracing::warn!("voice render stream error: {e}");
                let stream = match cfg.sample_format() {
                    cpal::SampleFormat::F32 => dev.build_output_stream(
                        &cfg.config(),
                        move |d: &mut [f32], _: &cpal::OutputCallbackInfo| q.pull(d),
                        err,
                        None,
                    ),
                    cpal::SampleFormat::I16 => dev.build_output_stream(
                        &cfg.config(),
                        move |d: &mut [i16], _: &cpal::OutputCallbackInfo| {
                            let mut f = vec![0.0f32; d.len()];
                            q.pull(&mut f);
                            for (o, s) in d.iter_mut().zip(f) {
                                *o = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                            }
                        },
                        err,
                        None,
                    ),
                    other => return Err(format!("unsupported render format {other:?}")),
                }
                .map_err(|e| e.to_string())?;
                stream.play().map_err(|e| e.to_string())?;
                Ok((stream, queue, rate, channels))
            };
            match open() {
                Ok((stream, queue, rate, channels)) => {
                    let _ = ready_tx.send(Ok((queue, rate, channels)));
                    let _ = stop_rx.recv();
                    drop(stream);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            }
        })
        .map_err(|e| e.to_string())?;
    let (queue, rate, channels) = ready_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "render device did not open".to_string())??;
    Ok((DeviceThread { stop: stop_tx }, queue, rate, channels))
}

/// The live voice state of one session.
pub struct Voice {
    /// The outgoing Opus track (added to the Assist PC and the recorder PC).
    pub track: Arc<TrackLocalStaticSample>,
    muted: Arc<AtomicBool>,
    capture: Option<(DeviceThread, tokio::task::JoinHandle<()>)>,
    render: Option<DeviceThread>,
    /// Encoded bytes sent (diagnostics).
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
            muted: Arc::new(AtomicBool::new(true)),
            capture: None,
            render: None,
            sent_bytes: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn muted(&self) -> bool {
        self.muted.load(Ordering::Relaxed)
    }

    /// Mute / unmute the Desk microphone. Unmuting opens the capture device (and fails, staying
    /// muted, if it cannot be opened); muting closes it.
    pub fn set_muted(&mut self, muted: bool) -> Result<(), String> {
        if muted {
            self.muted.store(true, Ordering::Relaxed);
            if let Some((dev, task)) = self.capture.take() {
                drop(dev);
                task.abort();
            }
            return Ok(());
        }
        if self.capture.is_none() {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
            let dev = start_capture(tx)?;
            let track = self.track.clone();
            let muted = self.muted.clone();
            let sent = self.sent_bytes.clone();
            let task = tokio::spawn(async move {
                while let Some(pkt) = rx.recv().await {
                    if muted.load(Ordering::Relaxed) {
                        continue; // never send while muted (A D8)
                    }
                    sent.fetch_add(pkt.len() as u64, Ordering::Relaxed);
                    let _ = track
                        .write_sample(&Sample {
                            data: Bytes::from(pkt),
                            duration: FRAME,
                            ..Default::default()
                        })
                        .await;
                }
            });
            self.capture = Some((dev, task));
        }
        self.muted.store(false, Ordering::Relaxed);
        Ok(())
    }

    /// Play the Assist's audio track on the default render device (opened on first use).
    pub fn attach_remote(&mut self, remote: Arc<TrackRemote>) {
        let (queue, rate, channels) = match start_render() {
            Ok((dev, q, r, c)) => {
                self.render = Some(dev);
                (q, r, c)
            }
            Err(e) => {
                tracing::warn!(
                    "voice: render device unavailable ({e}); the technician's audio is not played"
                );
                return;
            }
        };
        tokio::spawn(async move {
            let mut rx = match OpusRx::new() {
                Ok(d) => d,
                Err(e) => {
                    tracing::warn!("{e}");
                    return;
                }
            };
            let mut rs = Resampler::new(2, OPUS_RATE, rate);
            let mut out = Vec::new();
            while let Ok((pkt, _)) = remote.read_rtp().await {
                if pkt.payload.is_empty() {
                    continue;
                }
                if let Ok(stereo) = rx.decode(Some(&pkt.payload)) {
                    out.clear();
                    rs.process(&stereo, &mut out);
                    queue.push(&map_stereo(&out, channels));
                }
            }
        });
        tracing::info!("voice: playing the technician's audio");
    }

    /// Close every device stream (teardown).
    pub fn stop(&mut self) {
        let _ = self.set_muted(true);
        self.render = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, hz: f32, n: usize, channels: usize) -> Vec<f32> {
        (0..n)
            .flat_map(|i| {
                let v = (i as f32 * hz * std::f32::consts::TAU / rate as f32).sin() * 0.5;
                std::iter::repeat_n(v, channels)
            })
            .collect()
    }

    #[test]
    fn capture_framer_makes_20ms_mono_48k_frames_from_any_device_format() {
        // 44.1 kHz stereo, fed in odd-sized callback chunks: 1 s in => ~50 frames out.
        let input = sine(44_100, 440.0, 44_100, 2);
        let mut f = CaptureFramer::new(2, 44_100);
        let mut frames = Vec::new();
        for chunk in input.chunks(441 * 2 + 6) {
            frames.extend(f.push(chunk));
        }
        assert!((49..=50).contains(&frames.len()), "{} frames", frames.len());
        assert!(frames.iter().all(|fr| fr.len() == FRAME_SAMPLES));
        // 48 kHz mono passes straight through: exactly 50 frames per second.
        let mut f = CaptureFramer::new(1, 48_000);
        let n: usize = sine(48_000, 440.0, 48_000, 1)
            .chunks(480)
            .map(|c| f.push(c).len())
            .sum();
        assert_eq!(n, 50);
    }

    #[test]
    fn resampler_keeps_the_signal_level() {
        let input = sine(48_000, 300.0, 4800, 1);
        let mut out = Vec::new();
        Resampler::new(1, 48_000, 44_100).process(&input, &mut out);
        assert!((4400..=4410).contains(&out.len()), "{}", out.len());
        let peak = out.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!((0.45..=0.51).contains(&peak), "peak {peak}");
    }

    #[test]
    fn downmix_and_channel_mapping() {
        assert_eq!(downmix(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(map_stereo(&[1.0, 0.0], 1), vec![0.5]);
        assert_eq!(map_stereo(&[1.0, 0.0], 2), vec![1.0, 0.0]);
        assert_eq!(map_stereo(&[1.0, 0.5], 4), vec![1.0, 0.5, 0.0, 0.0]);
    }

    #[test]
    fn opus_round_trip_carries_a_tone() {
        let mut tx = OpusTx::new().unwrap();
        let mut rx = OpusRx::new().unwrap();
        let tone = sine(48_000, 440.0, FRAME_SAMPLES * 10, 1);
        let mut energy = 0.0f32;
        let mut bytes = 0usize;
        for frame in tone.chunks(FRAME_SAMPLES) {
            let pkt = tx.encode(frame).unwrap();
            bytes += pkt.len();
            let pcm = rx.decode(Some(&pkt)).unwrap();
            assert_eq!(pcm.len(), FRAME_SAMPLES * 2, "20 ms of interleaved stereo");
            energy += pcm.iter().map(|s| s * s).sum::<f32>();
        }
        assert!(
            energy > 10.0,
            "decoded audio carries the tone (energy {energy})"
        );
        // ~32 kbps: 200 ms of tone is well under 2 KB.
        assert!(bytes < 2000, "{bytes} bytes for 200 ms");
        // A lost packet is concealed, not an error.
        assert_eq!(rx.decode(None).unwrap().len(), FRAME_SAMPLES * 2);
        assert!(tx.encode(&[0.0; 10]).is_err());
    }

    #[test]
    fn dtx_shrinks_silence() {
        let mut tx = OpusTx::new().unwrap();
        let silence = vec![0.0f32; FRAME_SAMPLES];
        let sizes: Vec<usize> = (0..30)
            .map(|_| tx.encode(&silence).unwrap().len())
            .collect();
        assert!(sizes[20..].iter().all(|n| *n <= 3), "DTX frames: {sizes:?}");
    }

    #[test]
    fn render_queue_is_bounded_and_pads_with_silence() {
        let q = RenderQueue::new(48_000, 2);
        q.push(&vec![0.25; 48_000]); // 0.5 s of stereo
        assert_eq!(q.len(), 48_000 * 2 * 200 / 1000, "capped at 200 ms");
        let mut out = vec![1.0; 8];
        let q2 = RenderQueue::new(48_000, 2);
        q2.push(&[0.5, 0.5]);
        q2.pull(&mut out);
        assert_eq!(out, vec![0.5, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        assert!(q2.is_empty());
    }

    #[test]
    fn voice_state_shape() {
        let v = voice_state(true, 5);
        assert_eq!(v["t"], "voice.state");
        assert_eq!(v["from"], "desk");
        assert_eq!(v["muted"], true);
    }

    #[test]
    fn audio_track_is_opus_48k_stereo() {
        use webrtc::track::track_local::TrackLocal;
        let t = new_audio_track();
        assert_eq!(t.codec().mime_type, MIME_TYPE_OPUS);
        assert_eq!(t.codec().channels, 2);
        assert_eq!(
            t.kind(),
            webrtc::rtp_transceiver::rtp_codec::RTPCodecType::Audio
        );
    }
}
