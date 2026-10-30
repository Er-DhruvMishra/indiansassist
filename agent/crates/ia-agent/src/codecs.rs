//! SDP codec registration spec (contract §4.2). Pure data + negotiation order; tested in
//! the default gate so the fmtp lines stay byte-exact with `fixtures/agent/sdp-codecs.json`
//! (the loopback test and Playwright fake Desk use the same lines). The `media` build feeds
//! this table into the webrtc-rs `MediaEngine`.

use ia_core::types::VideoEncoder;

/// One video codec's SDP registration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoCodec {
    pub encoder: VideoEncoder,
    pub payload_type: u8,
    pub fmtp: &'static str,
}

/// The exact payload types and fmtp lines (contract §4.2).
pub const H264: VideoCodec = VideoCodec {
    encoder: VideoEncoder::H264,
    payload_type: 102,
    fmtp: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
};
pub const VP9: VideoCodec = VideoCodec {
    encoder: VideoEncoder::Vp9,
    payload_type: 98,
    fmtp: "profile-id=0",
};
pub const VP8: VideoCodec = VideoCodec {
    encoder: VideoEncoder::Vp8,
    payload_type: 96,
    fmtp: "",
};
pub const AV1: VideoCodec = VideoCodec {
    encoder: VideoEncoder::Av1,
    payload_type: 45,
    fmtp: "profile=0;level-idx=5;tier=0",
};

/// Opus audio payload type and fmtp (contract §6.3).
pub const OPUS_PT: u8 = 111;
pub const OPUS_FMTP: &str = "minptime=10;useinbandfec=1";

/// The video codec offer order (contract §4.2). Without a server recorder, hardware H.264
/// goes first when available, then VP9, VP8, AV1 (when compiled). With a server recorder,
/// VP8 goes first so the Assist and recorder can share one VP8 encoder.
pub fn offer_order(
    has_server_recorder: bool,
    hw_h264_available: bool,
    av1_compiled: bool,
) -> Vec<VideoCodec> {
    let mut order = Vec::new();
    if has_server_recorder {
        order.push(VP8);
        if hw_h264_available {
            order.push(H264);
        }
        order.push(VP9);
    } else {
        if hw_h264_available {
            order.push(H264);
        }
        order.push(VP9);
        order.push(VP8);
    }
    if av1_compiled {
        order.push(AV1);
    }
    order
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fmtp_lines_are_exact() {
        assert_eq!(H264.payload_type, 102);
        assert_eq!(
            H264.fmtp,
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
        );
        assert_eq!(VP9.payload_type, 98);
        assert_eq!(VP9.fmtp, "profile-id=0");
        assert_eq!(VP8.payload_type, 96);
        assert_eq!(VP8.fmtp, "");
        assert_eq!(AV1.payload_type, 45);
        assert_eq!(AV1.fmtp, "profile=0;level-idx=5;tier=0");
        assert_eq!(OPUS_PT, 111);
    }

    #[test]
    fn order_without_recorder_prefers_hardware_h264() {
        let o = offer_order(false, true, false);
        assert_eq!(o[0].encoder, VideoEncoder::H264);
        assert_eq!(
            o.iter().map(|c| c.encoder).collect::<Vec<_>>(),
            vec![VideoEncoder::H264, VideoEncoder::Vp9, VideoEncoder::Vp8]
        );
    }

    #[test]
    fn order_without_recorder_no_hw_starts_vp9() {
        let o = offer_order(false, false, true);
        assert_eq!(o[0].encoder, VideoEncoder::Vp9);
        assert_eq!(o.last().unwrap().encoder, VideoEncoder::Av1);
    }

    #[test]
    fn order_with_recorder_puts_vp8_first() {
        let o = offer_order(true, true, false);
        assert_eq!(o[0].encoder, VideoEncoder::Vp8);
    }
}
