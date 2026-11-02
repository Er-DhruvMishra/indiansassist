//! Tile-hash change detection over a BGRA buffer (Phase E §7.2, pure; tested on every host).
//!
//! X11 has no dirty-rectangle feed the capturer can rely on (DAMAGE would need a second event
//! path), so each grabbed frame is cut into [`TILE`] x [`TILE`] tiles and every tile is hashed;
//! when no tile hash differs from the previous frame's, the capturer skips the BGRA→I420
//! conversion and re-sends its last frame, exactly as the Windows capturer does on
//! `DXGI_ERROR_WAIT_TIMEOUT`.
//!
//! The hash folds each tile row segment 8 bytes at a time with
//! `h = rotl((h ^ word) * K, 29)` (K odd). Every step is a bijection of the state for a fixed
//! word and of the word for a fixed state, so **a change confined to one 8-byte word of a tile
//! always changes that tile's hash**; a change spread over several words collides only by chance
//! (about 2^-64). Non-cryptographic on purpose: it runs over every pixel of every frame.

/// The tile edge in pixels.
pub const TILE: u32 = 64;

const K: u64 = 0x9E37_79B9_7F4A_7C15;
const SEED: u64 = 0x243F_6A88_85A3_08D3;

/// What [`TileHasher::update`] found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Change {
    /// Anything differs from the previous call (always `true` on the first call or after the
    /// frame size changed).
    pub changed: bool,
    /// Tiles whose hash differs (all of them on the first call or after a size change).
    pub dirty: usize,
    /// Tiles in the frame.
    pub tiles: usize,
}

/// Remembers the previous frame's tile hashes for one monitor.
#[derive(Debug, Clone, Default)]
pub struct TileHasher {
    width: u32,
    height: u32,
    hashes: Vec<u64>,
}

#[inline]
fn step(h: u64, word: u64) -> u64 {
    (h ^ word).wrapping_mul(K).rotate_left(29)
}

#[inline]
fn fold(mut h: u64, bytes: &[u8]) -> u64 {
    let (words, rest) = bytes.as_chunks::<8>();
    for w in words {
        h = step(h, u64::from_le_bytes(*w));
    }
    if !rest.is_empty() {
        let mut last = [0u8; 8];
        last[..rest.len()].copy_from_slice(rest);
        h = step(h, u64::from_le_bytes(last));
    }
    h
}

/// The tile grid (columns, rows) for a frame size.
pub fn grid(width: u32, height: u32) -> (usize, usize) {
    (
        width.div_ceil(TILE) as usize,
        height.div_ceil(TILE) as usize,
    )
}

/// Hash every tile of a BGRA frame (`stride` bytes per row, `>= width * 4`), row-major tiles.
///
/// # Panics
/// If `bgra` is shorter than `stride * (height - 1) + width * 4`.
pub fn hash_tiles(bgra: &[u8], width: u32, height: u32, stride: usize) -> Vec<u64> {
    let (cols, rows) = grid(width, height);
    let row_bytes = width as usize * 4;
    let tile_bytes = TILE as usize * 4;
    let mut hashes = vec![SEED; cols * rows];
    for y in 0..height as usize {
        let row = &bgra[y * stride..y * stride + row_bytes];
        let band = &mut hashes[(y / TILE as usize) * cols..][..cols];
        for (h, seg) in band.iter_mut().zip(row.chunks(tile_bytes)) {
            *h = fold(*h, seg);
        }
    }
    hashes
}

impl TileHasher {
    pub fn new() -> Self {
        Self::default()
    }

    /// Forget the previous frame: the next [`Self::update`] reports a change.
    pub fn reset(&mut self) {
        self.hashes.clear();
        self.width = 0;
        self.height = 0;
    }

    /// Hash `bgra` and compare it with the previous call's frame.
    pub fn update(&mut self, bgra: &[u8], width: u32, height: u32, stride: usize) -> Change {
        let hashes = hash_tiles(bgra, width, height, stride);
        let tiles = hashes.len();
        let same_size = self.width == width && self.height == height && !self.hashes.is_empty();
        let dirty = if same_size {
            hashes
                .iter()
                .zip(&self.hashes)
                .filter(|(a, b)| a != b)
                .count()
        } else {
            tiles
        };
        self.width = width;
        self.height = height;
        self.hashes = hashes;
        Change {
            changed: dirty > 0 || !same_size,
            dirty,
            tiles,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(w: u32, h: u32, stride: usize) -> Vec<u8> {
        let mut v = vec![0u8; stride * h as usize];
        for y in 0..h as usize {
            for x in 0..w as usize {
                let p = y * stride + x * 4;
                v[p] = (x * 3 + y) as u8;
                v[p + 1] = (y * 5) as u8;
                v[p + 2] = (x ^ y) as u8;
                v[p + 3] = 0;
            }
        }
        v
    }

    #[test]
    fn first_call_reports_everything_dirty() {
        let f = frame(130, 70, 130 * 4);
        let mut t = TileHasher::new();
        let c = t.update(&f, 130, 70, 130 * 4);
        assert_eq!(grid(130, 70), (3, 2));
        assert_eq!(
            c,
            Change {
                changed: true,
                dirty: 6,
                tiles: 6
            }
        );
    }

    #[test]
    fn a_static_frame_is_unchanged() {
        let f = frame(200, 100, 200 * 4);
        let mut t = TileHasher::new();
        t.update(&f, 200, 100, 200 * 4);
        let c = t.update(&f.clone(), 200, 100, 200 * 4);
        assert!(!c.changed);
        assert_eq!(c.dirty, 0);
    }

    #[test]
    fn every_single_pixel_change_is_seen_in_exactly_its_tile() {
        let (w, h) = (150u32, 90u32);
        let stride = w as usize * 4;
        let base = frame(w, h, stride);
        let mut t = TileHasher::new();
        let ref_hashes = hash_tiles(&base, w, h, stride);
        let (cols, _) = grid(w, h);
        for y in (0..h as usize).step_by(7) {
            for x in (0..w as usize).step_by(5) {
                for byte in 0..4 {
                    let mut f = base.clone();
                    f[y * stride + x * 4 + byte] ^= 0x01;
                    let hashes = hash_tiles(&f, w, h, stride);
                    let tile = (y / TILE as usize) * cols + x / TILE as usize;
                    for (i, (a, b)) in hashes.iter().zip(&ref_hashes).enumerate() {
                        assert_eq!(a != b, i == tile, "pixel ({x},{y}) byte {byte} tile {i}");
                    }
                }
            }
        }
        // And through the stateful API.
        t.update(&base, w, h, stride);
        let mut f = base.clone();
        f[(h as usize - 1) * stride + (w as usize - 1) * 4] ^= 0x80;
        let c = t.update(&f, w, h, stride);
        assert_eq!((c.changed, c.dirty), (true, 1));
    }

    #[test]
    fn padding_bytes_past_the_width_are_ignored() {
        let (w, h) = (66u32, 66u32);
        let stride = w as usize * 4 + 24;
        let a = frame(w, h, stride);
        let mut b = a.clone();
        for y in 0..h as usize {
            for p in w as usize * 4..stride {
                b[y * stride + p] = 0xAB;
            }
        }
        assert_eq!(hash_tiles(&a, w, h, stride), hash_tiles(&b, w, h, stride));
    }

    #[test]
    fn a_size_change_is_a_change() {
        let f = frame(128, 128, 512);
        let mut t = TileHasher::new();
        t.update(&f, 128, 128, 512);
        let c = t.update(&f, 128, 64, 512);
        assert_eq!((c.changed, c.dirty, c.tiles), (true, 2, 2));
        t.reset();
        assert!(t.update(&f, 128, 64, 512).changed);
    }

    #[test]
    fn moving_content_between_tiles_is_seen() {
        // Two tiles swap contents: each tile's own hash changes.
        let (w, h) = (128u32, 64u32);
        let stride = w as usize * 4;
        let mut a = vec![0u8; stride * h as usize];
        for y in 0..h as usize {
            for x in 0..64 {
                a[y * stride + x * 4] = 200;
            }
        }
        let mut b = vec![0u8; stride * h as usize];
        for y in 0..h as usize {
            for x in 64..128 {
                b[y * stride + x * 4] = 200;
            }
        }
        let mut t = TileHasher::new();
        t.update(&a, w, h, stride);
        assert_eq!(t.update(&b, w, h, stride).dirty, 2);
    }
}
