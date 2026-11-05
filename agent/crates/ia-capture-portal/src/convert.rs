//! Stride and format conversion of one PipeWire buffer to tightly packed BGRA (Phase F §9.2),
//! and from there to the I420 [`Frame`] the encoder takes (`ia_frame::convert::bgra_to_i420`,
//! the converter the X11 and Windows capturers share). Pure; tested on every host.

use ia_frame::convert::bgra_to_i420;
use ia_platform::traits::Frame;

use crate::format::PixelFormat;

/// Why a buffer could not be read as a frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConvertError {
    /// A zero or odd-less-than-two size.
    EmptySize,
    /// The row stride is smaller than one row of pixels.
    StrideTooSmall { stride: usize, row: usize },
    /// The buffer is shorter than `stride * (height - 1) + width * 4` bytes.
    Short { have: usize, need: usize },
}

impl std::fmt::Display for ConvertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConvertError::EmptySize => f.write_str("the frame has no size"),
            ConvertError::StrideTooSmall { stride, row } => {
                write!(f, "stride {stride} is smaller than a row of {row} bytes")
            }
            ConvertError::Short { have, need } => {
                write!(f, "the buffer holds {have} bytes, a frame needs {need}")
            }
        }
    }
}

/// The stride to use: the chunk's own when positive, else a packed row (some producers leave it
/// 0 for packed buffers).
pub fn effective_stride(chunk_stride: i32, width: u32) -> usize {
    if chunk_stride > 0 {
        chunk_stride as usize
    } else {
        width as usize * 4
    }
}

/// The byte range of the valid data inside a mapped buffer of `maxsize` bytes, from the chunk's
/// `offset` and `size` (the offset is taken modulo `maxsize`, as `spa_chunk` documents). `None`
/// when the chunk says nothing is there (size 0) or points outside the mapping.
pub fn chunk_range(maxsize: usize, offset: u32, size: u32) -> Option<std::ops::Range<usize>> {
    if maxsize == 0 || size == 0 {
        return None;
    }
    let start = offset as usize % maxsize;
    let end = start.checked_add(size as usize)?;
    (end <= maxsize).then_some(start..end)
}

/// Copy `src` (`width` × `height` pixels of `format`, rows `stride` bytes apart) into `dst` as
/// packed opaque BGRA (`width * 4` bytes per row). `dst` is resized as needed, so a caller can
/// keep one buffer across frames.
pub fn to_bgra(
    src: &[u8],
    width: u32,
    height: u32,
    stride: usize,
    format: PixelFormat,
    dst: &mut Vec<u8>,
) -> Result<(), ConvertError> {
    if width == 0 || height == 0 {
        return Err(ConvertError::EmptySize);
    }
    let (w, h) = (width as usize, height as usize);
    let row = w * 4;
    if stride < row {
        return Err(ConvertError::StrideTooSmall { stride, row });
    }
    let need = stride * (h - 1) + row;
    if src.len() < need {
        return Err(ConvertError::Short {
            have: src.len(),
            need,
        });
    }
    dst.resize(row * h, 0);
    let (ob, og, or) = format.bgr_offsets();
    for y in 0..h {
        let s = &src[y * stride..y * stride + row];
        let d = &mut dst[y * row..(y + 1) * row];
        if matches!(format, PixelFormat::BGRx | PixelFormat::BGRA) {
            d.copy_from_slice(s);
            for px in d.as_chunks_mut::<4>().0 {
                px[3] = 0xFF;
            }
            continue;
        }
        for (sp, dp) in s.as_chunks::<4>().0.iter().zip(d.as_chunks_mut::<4>().0) {
            dp[0] = sp[ob];
            dp[1] = sp[og];
            dp[2] = sp[or];
            dp[3] = 0xFF;
        }
    }
    Ok(())
}

/// Packed BGRA → the I420 frame the encoder takes (sizes rounded down to even, as every capturer
/// does).
pub fn bgra_frame(bgra: &[u8], width: u32, height: u32) -> Frame {
    bgra_to_i420(bgra, width, height, width as usize * 4)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 3 × 2 image of `format` with `pad` extra bytes per row; pixel (x, y) has red `10 * x`,
    /// green `100 + y`, blue `200 + x`.
    fn image(format: PixelFormat, pad: usize) -> (Vec<u8>, usize) {
        let (w, h) = (3usize, 2usize);
        let stride = w * 4 + pad;
        let mut v = vec![0xEEu8; stride * h];
        let (ob, og, or) = format.bgr_offsets();
        for y in 0..h {
            for x in 0..w {
                let p = &mut v[y * stride + x * 4..y * stride + x * 4 + 4];
                p.fill(0x11); // the x / A byte stays 0x11
                p[ob] = 200 + x as u8;
                p[og] = 100 + y as u8;
                p[or] = 10 * x as u8;
            }
        }
        (v, stride)
    }

    #[test]
    fn every_accepted_format_becomes_the_same_opaque_bgra() {
        let mut want = Vec::new();
        for y in 0..2u8 {
            for x in 0..3u8 {
                want.extend_from_slice(&[200 + x, 100 + y, 10 * x, 0xFF]);
            }
        }
        for format in PixelFormat::ACCEPTED {
            for pad in [0, 4, 52] {
                let (src, stride) = image(format, pad);
                let mut dst = Vec::new();
                to_bgra(&src, 3, 2, stride, format, &mut dst).unwrap();
                assert_eq!(dst, want, "{format:?} pad {pad}");
            }
        }
    }

    #[test]
    fn short_buffers_and_bad_strides_are_refused() {
        let (src, stride) = image(PixelFormat::BGRx, 8);
        let mut dst = Vec::new();
        assert_eq!(
            to_bgra(&src, 3, 2, 8, PixelFormat::BGRx, &mut dst),
            Err(ConvertError::StrideTooSmall { stride: 8, row: 12 })
        );
        // The last row needs only `width * 4` bytes, not a whole stride.
        let need = stride + 12;
        assert!(to_bgra(&src[..need], 3, 2, stride, PixelFormat::BGRx, &mut dst).is_ok());
        assert_eq!(
            to_bgra(&src[..need - 1], 3, 2, stride, PixelFormat::BGRx, &mut dst),
            Err(ConvertError::Short {
                have: need - 1,
                need
            })
        );
        assert_eq!(
            to_bgra(&src, 0, 2, stride, PixelFormat::BGRx, &mut dst),
            Err(ConvertError::EmptySize)
        );
    }

    #[test]
    fn the_stride_and_the_chunk_range() {
        assert_eq!(effective_stride(5120, 1280), 5120);
        assert_eq!(effective_stride(0, 1280), 5120);
        assert_eq!(effective_stride(-4, 10), 40);
        assert_eq!(chunk_range(100, 0, 100), Some(0..100));
        assert_eq!(
            chunk_range(100, 120, 50),
            Some(20..70),
            "offset modulo maxsize"
        );
        assert_eq!(chunk_range(100, 60, 50), None, "past the mapping");
        assert_eq!(chunk_range(100, 0, 0), None, "an empty chunk");
        assert_eq!(chunk_range(0, 0, 10), None);
    }

    #[test]
    fn a_solid_colour_reaches_the_i420_planes() {
        // #3366CC in BGRx, 4 × 2.
        let src: Vec<u8> = [0xCC, 0x66, 0x33, 0x00].repeat(8);
        let mut bgra = Vec::new();
        to_bgra(&src, 4, 2, 16, PixelFormat::BGRx, &mut bgra).unwrap();
        let f = bgra_frame(&bgra, 4, 2);
        assert_eq!((f.width, f.height), (4, 2));
        let y = f.y[0];
        assert!(f.y.iter().all(|v| *v == y));
        assert!(f.u.iter().all(|v| *v == f.u[0]));
        // Blue-heavy: U above, V below the neutral 128.
        assert!(f.u[0] > 128 && f.v[0] < 128, "u {} v {}", f.u[0], f.v[0]);
    }
}
