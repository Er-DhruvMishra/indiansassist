//! VP8 software encoder (contract §4.2 "software default") over the prebuilt libvpx in
//! `shiguredo_libvpx`. Feeds packed I420 [`Frame`]s and yields encoded packets with their
//! keyframe flag, which the peer writes to a `TrackLocalStaticSample` (§3.6 M1).
//!
//! The wrapper is configured for low-latency screen sharing: CBR, no look-ahead, error
//! resilience on, a high `cpu_used`, and a bounded keyframe interval so late joiners resync
//! (§4.1 frame pacing). `VP8E_SET_SCREEN_CONTENT_MODE` is not exposed by this libvpx wrapper
//! (documented deviation in agent/README.md); the other screen-content tunings are applied.

use ia_platform::traits::Frame;
use shiguredo_libvpx::{
    CodecConfig, EncodeOptions, Encoder, EncoderConfig, ImageData, ImageFormat, RateControlMode,
    Vp8Config,
};

/// One encoded VP8 packet.
#[derive(Debug, Clone)]
pub struct EncodedPacket {
    pub data: Vec<u8>,
    pub keyframe: bool,
}

/// A VP8 encoder bound to one frame size.
pub struct Vp8Encoder {
    inner: Encoder,
    width: usize,
    height: usize,
}

impl Vp8Encoder {
    /// Create an encoder for `width`x`height` at `target_kbps` (CBR), ~`fps` frames/s and a
    /// keyframe at least every `keyframe_secs`.
    pub fn new(
        width: u32,
        height: u32,
        target_kbps: u32,
        fps: u32,
        keyframe_secs: u32,
    ) -> Result<Self, String> {
        let (w, h) = (width as usize, height as usize);
        let mut cfg = EncoderConfig::new(
            w,
            h,
            ImageFormat::I420,
            CodecConfig::Vp8(Vp8Config::default()),
        );
        cfg.fps_numerator = fps.max(1) as usize;
        cfg.fps_denominator = 1;
        cfg.target_bitrate = (target_kbps.max(50) as usize) * 1000;
        cfg.rate_control = RateControlMode::Cbr;
        cfg.error_resilient = true;
        cfg.lag_in_frames = None; // g_lag_in_frames 0
        cfg.cpu_used = Some(10); // VP8 realtime (range 0-16, higher = faster)
        cfg.deadline = shiguredo_libvpx::EncodingDeadline::Realtime;
        cfg.keyframe_interval =
            std::num::NonZeroUsize::new((fps.max(1) * keyframe_secs.max(1)) as usize);
        let inner = Encoder::new(cfg).map_err(|e| format!("vp8 encoder init: {e}"))?;
        Ok(Self {
            inner,
            width: w,
            height: h,
        })
    }

    /// Encode one packed-I420 frame. `force_keyframe` requests an IDR (rung change, resync).
    /// Returns every packet libvpx produced for this input (usually one).
    pub fn encode(
        &mut self,
        frame: &Frame,
        force_keyframe: bool,
    ) -> Result<Vec<EncodedPacket>, String> {
        if frame.width as usize != self.width || frame.height as usize != self.height {
            return Err("frame size does not match encoder".into());
        }
        // The wrapper expects tightly packed planes; our converter/scaler produce them.
        if frame.y_stride != self.width || frame.uv_stride != self.width / 2 {
            return Err("encoder requires packed I420 planes".into());
        }
        let image = ImageData::I420 {
            y: &frame.y,
            u: &frame.u,
            v: &frame.v,
        };
        self.inner
            .encode(&image, &EncodeOptions { force_keyframe })
            .map_err(|e| format!("vp8 encode: {e}"))?;
        let mut out = Vec::new();
        while let Some(pkt) = self.inner.next_frame() {
            out.push(EncodedPacket {
                data: pkt.data().to_vec(),
                keyframe: pkt.is_keyframe(),
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_i420(w: u32, h: u32) -> Frame {
        let (wu, hu) = (w as usize, h as usize);
        Frame {
            width: w,
            height: h,
            y: vec![0x80; wu * hu],
            u: vec![0x80; (wu / 2) * (hu / 2)],
            v: vec![0x80; (wu / 2) * (hu / 2)],
            y_stride: wu,
            uv_stride: wu / 2,
        }
    }

    #[test]
    fn first_frame_is_a_keyframe() {
        let mut enc = Vp8Encoder::new(64, 64, 500, 30, 10).unwrap();
        let pkts = enc.encode(&solid_i420(64, 64), false).unwrap();
        assert!(!pkts.is_empty());
        assert!(
            pkts[0].keyframe,
            "the first encoded VP8 frame must be a keyframe"
        );
        assert!(!pkts[0].data.is_empty());
    }

    #[test]
    fn rejects_wrong_size() {
        let mut enc = Vp8Encoder::new(64, 64, 500, 30, 10).unwrap();
        assert!(enc.encode(&solid_i420(32, 32), false).is_err());
    }
}
