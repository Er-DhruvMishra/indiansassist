//! SPA format negotiation (Phase F §9.2): which raw video formats and which buffer types the
//! portal capturer accepts, as plain numbers, so the decision is tested on every host. The
//! numbers are the `spa_video_format` and `spa_data_type` enums of `spa/param/video/raw.h` and
//! `spa/buffer/buffer.h`; the Linux build checks them against libspa's own constants.

/// A raw video format the capturer accepts. Each name is the **byte order in memory** (the SPA
/// and GStreamer convention): `BGRx` is the bytes B, G, R, x of each pixel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum PixelFormat {
    RGBx = 7,
    BGRx = 8,
    #[allow(non_camel_case_types)]
    xRGB = 9,
    RGBA = 11,
    BGRA = 12,
}

impl PixelFormat {
    /// The formats offered in `EnumFormat`, in preference order: the native BGRA layout of the
    /// converter first, so the common compositor format (XRGB8888 = `BGRx`) needs no swizzle.
    pub const ACCEPTED: [PixelFormat; 5] = [
        PixelFormat::BGRx,
        PixelFormat::BGRA,
        PixelFormat::RGBx,
        PixelFormat::RGBA,
        PixelFormat::xRGB,
    ];

    /// The `spa_video_format` value.
    pub fn spa_id(self) -> u32 {
        self as u32
    }

    /// The accepted format with this `spa_video_format` value, if any.
    pub fn from_spa(id: u32) -> Option<PixelFormat> {
        Self::ACCEPTED.into_iter().find(|f| f.spa_id() == id)
    }

    /// Byte offsets of blue, green and red inside one 4-byte pixel.
    pub fn bgr_offsets(self) -> (usize, usize, usize) {
        match self {
            PixelFormat::BGRx | PixelFormat::BGRA => (0, 1, 2),
            PixelFormat::RGBx | PixelFormat::RGBA => (2, 1, 0),
            PixelFormat::xRGB => (3, 2, 1),
        }
    }
}

/// The format to use out of what the producer offers: the first of [`PixelFormat::ACCEPTED`]
/// (our preference) that is among `offered`; `None` when nothing acceptable is offered (for
/// example a producer that offers only DMA-BUF modifiers or YUV).
pub fn negotiate(offered: &[u32]) -> Option<PixelFormat> {
    PixelFormat::ACCEPTED
        .into_iter()
        .find(|f| offered.contains(&f.spa_id()))
}

/// `spa_data_type`: how a buffer's memory is handed over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BufferKind {
    MemPtr,
    MemFd,
    DmaBuf,
    Other(u32),
}

impl BufferKind {
    pub const SPA_MEM_PTR: u32 = 1;
    pub const SPA_MEM_FD: u32 = 2;
    pub const SPA_DMA_BUF: u32 = 3;

    pub fn from_spa(id: u32) -> BufferKind {
        match id {
            Self::SPA_MEM_PTR => BufferKind::MemPtr,
            Self::SPA_MEM_FD => BufferKind::MemFd,
            Self::SPA_DMA_BUF => BufferKind::DmaBuf,
            other => BufferKind::Other(other),
        }
    }

    /// Whether the capturer reads this kind: memory it can map, never DMA-BUF (not negotiated in
    /// Phase F, §9.2).
    pub fn accepted(self) -> bool {
        matches!(self, BufferKind::MemFd | BufferKind::MemPtr)
    }
}

/// The `SPA_PARAM_BUFFERS_dataType` flags the capturer asks for: `MemFd` and `MemPtr` only.
pub fn data_type_mask() -> i32 {
    (1 << BufferKind::SPA_MEM_FD) | (1 << BufferKind::SPA_MEM_PTR)
}

/// The size limits announced in `EnumFormat` (a monitor up to 8K), and the default.
pub const MAX_SIDE: u32 = 8192;
pub const DEFAULT_SIZE: (u32, u32) = (1280, 720);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_spa_numbers_are_the_header_values() {
        assert_eq!(PixelFormat::RGBx.spa_id(), 7);
        assert_eq!(PixelFormat::BGRx.spa_id(), 8);
        assert_eq!(PixelFormat::xRGB.spa_id(), 9);
        assert_eq!(PixelFormat::RGBA.spa_id(), 11);
        assert_eq!(PixelFormat::BGRA.spa_id(), 12);
        for f in PixelFormat::ACCEPTED {
            assert_eq!(PixelFormat::from_spa(f.spa_id()), Some(f));
        }
        // I420 (2), xBGR (10), ARGB (13), RGB (15) are not accepted.
        for id in [0, 2, 10, 13, 14, 15, 16] {
            assert_eq!(PixelFormat::from_spa(id), None, "{id}");
        }
    }

    #[test]
    fn negotiation_takes_our_preference_among_the_offered() {
        assert_eq!(negotiate(&[11, 8, 7]), Some(PixelFormat::BGRx));
        assert_eq!(negotiate(&[7, 11]), Some(PixelFormat::RGBx));
        assert_eq!(negotiate(&[9]), Some(PixelFormat::xRGB));
        assert_eq!(negotiate(&[12, 11]), Some(PixelFormat::BGRA));
        assert_eq!(negotiate(&[2, 4, 13]), None);
        assert_eq!(negotiate(&[]), None);
    }

    #[test]
    fn only_mappable_memory_is_accepted() {
        assert!(BufferKind::from_spa(1).accepted());
        assert!(BufferKind::from_spa(2).accepted());
        assert!(
            !BufferKind::from_spa(3).accepted(),
            "DMA-BUF is not negotiated"
        );
        assert!(!BufferKind::from_spa(4).accepted());
        assert_eq!(BufferKind::from_spa(9), BufferKind::Other(9));
        assert_eq!(data_type_mask(), 0b110);
        assert_eq!(data_type_mask() & (1 << BufferKind::SPA_DMA_BUF), 0);
    }

    #[test]
    fn channel_offsets_follow_the_byte_order() {
        assert_eq!(PixelFormat::BGRx.bgr_offsets(), (0, 1, 2));
        assert_eq!(PixelFormat::RGBA.bgr_offsets(), (2, 1, 0));
        assert_eq!(PixelFormat::xRGB.bgr_offsets(), (3, 2, 1));
    }
}
