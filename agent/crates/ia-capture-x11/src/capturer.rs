//! The X11 capturer (Phase E §7.2): `x11rb`'s pure-Rust `RustConnection` to one named display,
//! RandR 1.5 `GetMonitors` for the monitor list ([`crate::geometry`]), MIT-SHM `ShmGetImage` into
//! a `memfd` segment ([`crate::shm`]) with a core `GetImage` fallback, the XFixes cursor
//! composited in ([`crate::cursor`]), tile-hash change detection ([`crate::tiles`]) and the shared
//! BGRA→I420 converter.
//!
//! Behaviour the pump relies on (it matches the Windows `DxgiCapturer`):
//! * when nothing changed since the previous grab of a monitor, [`Capturer::next_frame`] returns
//!   **the last frame again** (no conversion), so the encoder keeps its pace;
//! * `None` only for an unknown monitor or before any frame of that monitor could be read;
//! * a failed grab (an X error, for example a stale monitor rectangle) re-sends the last frame;
//! * a broken X connection sets [`X11Capturer::lost`] (the agent reports
//!   `ctl.event capture { cause: 'x11_lost' }`) and every later call re-sends the last frame.

use std::collections::HashMap;

use ia_core::types::{CapturePath, MonitorInfo};
use ia_frame::convert::bgra_to_i420;
use ia_platform::traits::{Capturer, Frame};
use x11rb::connection::Connection;
use x11rb::errors::{ConnectionError, ReplyError};
use x11rb::protocol::randr::ConnectionExt as _;
use x11rb::protocol::shm::ConnectionExt as _;
use x11rb::protocol::xfixes::ConnectionExt as _;
use x11rb::protocol::xproto::{
    ConnectionExt as _, ImageFormat, ImageOrder, Screen, Setup, VisualClass, Window,
};
use x11rb::rust_connection::RustConnection;

use crate::cursor::{composite, CursorImage};
use crate::geometry::{even_size, monitors_from_randr, RandrMonitor};
use crate::shm::ShmSegment;
use crate::tiles::TileHasher;

/// How [`X11Capturer::open_with`] captures.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Options {
    /// Never use MIT-SHM: read every frame with core `GetImage` ([`X11Capturer::path`] reports
    /// `Xgetimage`). For tests and for servers whose SHM is known to be broken.
    pub force_getimage: bool,
}

/// Diagnostics: how many grabs were made and how many of them were converted or re-sent.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counters {
    /// Successful grabs (image read, cursor composited, tiles hashed).
    pub grabs: u64,
    /// Grabs that changed something and were converted BGRA→I420.
    pub converted: u64,
    /// Grabs where no tile changed, answered with the previous frame.
    pub reused: u64,
}

struct MonitorState {
    rect: (i32, i32, u32, u32),
    hasher: TileHasher,
    last: Option<Frame>,
}

/// Why a request failed: the connection is gone, or the server refused this one request.
enum Fail {
    Lost(String),
    Refused(String),
}

impl From<ConnectionError> for Fail {
    fn from(e: ConnectionError) -> Self {
        match e {
            ConnectionError::UnsupportedExtension
            | ConnectionError::MaximumRequestLengthExceeded
            | ConnectionError::FdPassingFailed
            | ConnectionError::InsufficientMemory => Fail::Refused(e.to_string()),
            other => Fail::Lost(other.to_string()),
        }
    }
}

impl From<ReplyError> for Fail {
    fn from(e: ReplyError) -> Self {
        match e {
            ReplyError::ConnectionError(c) => c.into(),
            ReplyError::X11Error(x) => Fail::Refused(format!("X11 error {:?}", x.error_kind)),
        }
    }
}

/// Screen capture of one X11 display (see the module docs).
pub struct X11Capturer {
    monitors: Vec<MonitorInfo>,
    state: HashMap<u32, MonitorState>,
    root: Window,
    root_w: u16,
    root_h: u16,
    /// `scanline_pad` of the root depth's pixmap format, in bits.
    scanline_pad: u32,
    randr: bool,
    xfixes: bool,
    /// The `GetImage` path's buffer (the reply's data, kept between frames).
    scratch: Vec<u8>,
    lost: bool,
    counters: Counters,
    shm: Option<ShmSegment>,
    // Declared last, so it closes after everything above is released (and see `Drop`).
    conn: RustConnection,
}

// The pump moves the capturer to its own thread (`ia_platform::traits::Capturer: Send`).
const _: fn() = || {
    fn send<T: Send>() {}
    send::<X11Capturer>();
};

fn clone_frame(f: &Frame) -> Frame {
    Frame {
        width: f.width,
        height: f.height,
        y: f.y.clone(),
        u: f.u.clone(),
        v: f.v.clone(),
        y_stride: f.y_stride,
        uv_stride: f.uv_stride,
    }
}

fn rect(m: &MonitorInfo) -> (i32, i32, u32, u32) {
    (m.x, m.y, m.width, m.height)
}

/// Bytes per row of a 32 bpp `ZPixmap` image `width` pixels wide, padded to `pad_bits`.
fn row_stride(width: u32, pad_bits: u32) -> usize {
    let pad = u64::from(pad_bits.max(8));
    let bits = u64::from(width) * 32;
    (bits.div_ceil(pad) * pad / 8) as usize
}

/// Only 24- and 32-bit TrueColor with 8-bit channels in BGRX byte order is captured; anything
/// else is refused with the reason. Returns the pixmap format's `scanline_pad`.
fn check_visual(setup: &Setup, screen: &Screen) -> Result<u32, String> {
    let depth = screen.root_depth;
    if depth != 24 && depth != 32 {
        return Err(format!(
            "unsupported X11 root depth {depth}: only 24- and 32-bit TrueColor screens can be captured"
        ));
    }
    let visual = screen
        .allowed_depths
        .iter()
        .filter(|d| d.depth == depth)
        .flat_map(|d| &d.visuals)
        .find(|v| v.visual_id == screen.root_visual)
        .ok_or("the X11 root visual is not listed for the root depth")?;
    if visual.class != VisualClass::TRUE_COLOR
        || (visual.red_mask, visual.green_mask, visual.blue_mask) != (0xFF_0000, 0xFF00, 0xFF)
    {
        return Err(format!(
            "unsupported X11 root visual (class {:?}, masks {:#x}/{:#x}/{:#x}): only TrueColor \
             with 8-bit RGB channels can be captured",
            visual.class, visual.red_mask, visual.green_mask, visual.blue_mask
        ));
    }
    let format = setup
        .pixmap_formats
        .iter()
        .find(|f| f.depth == depth)
        .ok_or("the X11 server lists no pixmap format for the root depth")?;
    if format.bits_per_pixel != 32 {
        return Err(format!(
            "unsupported X11 pixmap format: {} bits per pixel at depth {depth} (32 needed)",
            format.bits_per_pixel
        ));
    }
    if setup.image_byte_order != ImageOrder::LSB_FIRST {
        return Err("unsupported X11 image byte order (MSB first)".into());
    }
    Ok(u32::from(format.scanline_pad))
}

/// Detach and unmap the segment; every later grab uses `GetImage`.
fn drop_shm(shm: &mut Option<ShmSegment>, conn: &RustConnection, why: &str) {
    if let Some(segment) = shm.take() {
        segment.detach(conn);
        tracing::warn!(
            why,
            "MIT-SHM capture failed: capturing with GetImage from now on"
        );
    }
}

impl X11Capturer {
    /// Connect to `display` (for example `":0"`, the value of the session's `DISPLAY`) and
    /// capture with MIT-SHM when the server offers it.
    pub fn open(display: &str) -> Result<X11Capturer, String> {
        Self::open_with(display, Options::default())
    }

    /// [`Self::open`] with [`Options`]. Connects only to `display`, never to an implicit default.
    pub fn open_with(display: &str, options: Options) -> Result<X11Capturer, String> {
        let display = display.trim();
        if display.is_empty() {
            return Err("no X11 display named".into());
        }
        let (conn, screen_num) = RustConnection::connect(Some(display))
            .map_err(|e| format!("cannot connect to X11 display {display}: {e}"))?;
        let setup = conn.setup();
        let screen = setup
            .roots
            .get(screen_num)
            .ok_or_else(|| format!("X11 display {display} has no screen {screen_num}"))?;
        let scanline_pad = check_visual(setup, screen)?;
        let (root, root_w, root_h) = (screen.root, screen.width_in_pixels, screen.height_in_pixels);

        let randr = conn
            .randr_query_version(1, 5)
            .ok()
            .and_then(|c| c.reply().ok())
            .is_some_and(|r| (r.major_version, r.minor_version) >= (1, 5));
        if !randr {
            tracing::info!("RandR 1.5 not available: the root window is the only monitor");
        }
        // XFixes requires the version handshake before any other request.
        let xfixes = conn
            .xfixes_query_version(4, 0)
            .ok()
            .and_then(|c| c.reply().ok())
            .is_some_and(|r| r.major_version >= 1);
        if !xfixes {
            tracing::info!("XFixes not available: frames are captured without the cursor");
        }

        let mut capturer = X11Capturer {
            monitors: Vec::new(),
            state: HashMap::new(),
            root,
            root_w,
            root_h,
            scanline_pad,
            randr,
            xfixes,
            scratch: Vec::new(),
            lost: false,
            counters: Counters::default(),
            shm: None,
            conn,
        };
        let (w, h, monitors) = match capturer.read_layout() {
            Ok(layout) => layout,
            Err(Fail::Lost(e) | Fail::Refused(e)) => {
                return Err(format!("cannot read the X11 screen layout: {e}"))
            }
        };
        capturer.root_w = w;
        capturer.root_h = h;
        capturer.monitors = monitors;
        if options.force_getimage {
            tracing::info!("MIT-SHM disabled by option: capturing with GetImage");
        } else {
            capturer.shm = capturer.make_shm();
        }
        tracing::info!(
            monitors = capturer.monitors.len(),
            path = ?capturer.path(1),
            cursor = xfixes,
            "X11 capture ready"
        );
        Ok(capturer)
    }

    /// The path frames are read with (`agent.stats.capturePath`, `ctl.event capture.path`).
    /// The same for every monitor: MIT-SHM, or `GetImage` after a fallback.
    pub fn path(&self, _monitor_id: u32) -> CapturePath {
        if self.shm.is_some() {
            CapturePath::Xshm
        } else {
            CapturePath::Xgetimage
        }
    }

    /// The X connection failed: no further frame can be read (the agent reports
    /// `ctl.event capture { cause: 'x11_lost' }`).
    pub fn lost(&self) -> bool {
        self.lost
    }

    /// Re-read the root size and the RandR monitors (after a RandR change), drop the state of
    /// monitors that moved, resized or went away, and return the new list. On failure the
    /// previous list is kept (and [`Self::lost`] set if the connection broke).
    pub fn refresh_monitors(&mut self) -> Vec<MonitorInfo> {
        if self.lost {
            return self.monitors.clone();
        }
        match self.read_layout() {
            Ok((w, h, monitors)) => {
                if (w, h) != (self.root_w, self.root_h) {
                    self.root_w = w;
                    self.root_h = h;
                    let needed = row_stride(u32::from(w), self.scanline_pad) * usize::from(h);
                    if self.shm.as_ref().is_some_and(|s| s.len() < needed) {
                        if let Some(old) = self.shm.take() {
                            old.detach(&self.conn);
                        }
                        self.shm = self.make_shm();
                    }
                }
                self.state
                    .retain(|id, s| monitors.iter().any(|m| m.id == *id && rect(m) == s.rect));
                self.monitors = monitors;
            }
            Err(Fail::Lost(e)) => self.mark_lost(&e),
            Err(Fail::Refused(e)) => tracing::debug!(error = %e, "X11 monitor refresh failed"),
        }
        self.monitors.clone()
    }

    /// Diagnostics counters (grabs, conversions, re-sent frames).
    pub fn counters(&self) -> Counters {
        self.counters
    }

    /// Test hook: an X resource this capturer's connection owns (the SHM segment), so a test can
    /// break the connection with `KillClient` on its own harness-owned server.
    #[doc(hidden)]
    pub fn test_owned_resource(&self) -> Option<u32> {
        self.shm.as_ref().map(ShmSegment::seg)
    }

    fn mark_lost(&mut self, why: &str) {
        if !self.lost {
            tracing::warn!(error = why, "X11 connection lost: capture stopped");
        }
        self.lost = true;
    }

    fn make_shm(&self) -> Option<ShmSegment> {
        let version = self
            .conn
            .shm_query_version()
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| (r.major_version, r.minor_version));
        if !version.is_some_and(|v| v >= (1, 2)) {
            tracing::warn!(
                ?version,
                "MIT-SHM 1.2 (fd passing) not available: capturing with GetImage"
            );
            return None;
        }
        let len = row_stride(u32::from(self.root_w), self.scanline_pad) * usize::from(self.root_h);
        match ShmSegment::create(&self.conn, len) {
            Ok(segment) => Some(segment),
            Err(e) => {
                tracing::warn!(error = %e, "MIT-SHM segment failed: capturing with GetImage");
                None
            }
        }
    }

    /// The root size and the monitor list, read from the server.
    fn read_layout(&self) -> Result<(u16, u16, Vec<MonitorInfo>), Fail> {
        let geometry = self.conn.get_geometry(self.root)?.reply()?;
        let mut list = Vec::new();
        if self.randr {
            match self.conn.randr_get_monitors(self.root, true)?.reply() {
                Ok(reply) => {
                    let cookies = reply
                        .monitors
                        .iter()
                        .map(|m| self.conn.get_atom_name(m.name))
                        .collect::<Result<Vec<_>, _>>()?;
                    for (m, cookie) in reply.monitors.iter().zip(cookies) {
                        let name = match cookie.reply() {
                            Ok(n) => String::from_utf8_lossy(&n.name).into_owned(),
                            Err(ReplyError::X11Error(_)) => String::new(),
                            Err(ReplyError::ConnectionError(e)) => return Err(e.into()),
                        };
                        list.push(RandrMonitor {
                            name,
                            primary: m.primary,
                            x: m.x,
                            y: m.y,
                            width: m.width,
                            height: m.height,
                        });
                    }
                }
                Err(ReplyError::X11Error(e)) => {
                    tracing::debug!(error = ?e.error_kind, "RandR GetMonitors failed: root window")
                }
                Err(ReplyError::ConnectionError(e)) => return Err(e.into()),
            }
        }
        let monitors = monitors_from_randr(&list, geometry.width, geometry.height);
        Ok((geometry.width, geometry.height, monitors))
    }

    fn last_frame(&self, monitor_id: u32) -> Option<Frame> {
        self.state
            .get(&monitor_id)
            .and_then(|s| s.last.as_ref())
            .map(clone_frame)
    }

    fn capture(&mut self, monitor_id: u32) -> Option<Frame> {
        let monitor = self.monitors.iter().find(|m| m.id == monitor_id)?.clone();
        if self.lost {
            return self.last_frame(monitor_id);
        }
        match self.grab(&monitor) {
            Ok(frame) => Some(frame),
            Err(Fail::Lost(e)) => {
                self.mark_lost(&e);
                self.last_frame(monitor_id)
            }
            Err(Fail::Refused(e)) => {
                tracing::debug!(monitor = monitor_id, error = %e, "X11 grab failed");
                self.last_frame(monitor_id)
            }
        }
    }

    /// Read the monitor, composite the cursor, and convert unless no tile changed.
    fn grab(&mut self, m: &MonitorInfo) -> Result<Frame, Fail> {
        let (w, h) = even_size(m.width, m.height);
        if w == 0 || h == 0 {
            return Err(Fail::Refused("monitor smaller than 2x2".into()));
        }
        let (x, y) = (
            i16::try_from(m.x).map_err(|_| Fail::Refused("monitor x out of range".into()))?,
            i16::try_from(m.y).map_err(|_| Fail::Refused("monitor y out of range".into()))?,
        );
        let (w16, h16) = (
            u16::try_from(w).map_err(|_| Fail::Refused("monitor too wide".into()))?,
            u16::try_from(h).map_err(|_| Fail::Refused("monitor too tall".into()))?,
        );
        let stride = row_stride(w, self.scanline_pad);
        let len = stride * h as usize;

        // The cursor request goes out first, so its reply arrives with the image's.
        let cursor_cookie = if self.xfixes {
            Some(self.conn.xfixes_get_cursor_image()?)
        } else {
            None
        };

        let mut from_shm = false;
        // Why the SHM read failed, if it did. SHM is given up only when `GetImage` then reads
        // the same rectangle: an error both paths share (a monitor rectangle gone stale after a
        // RandR change, for example) says nothing about MIT-SHM.
        let mut shm_failed: Option<String> = None;
        if let Some(seg) = self
            .shm
            .as_ref()
            .filter(|s| s.len() >= len)
            .map(|s| s.seg())
        {
            let reply = self
                .conn
                .shm_get_image(
                    self.root,
                    x,
                    y,
                    w16,
                    h16,
                    !0,
                    ImageFormat::Z_PIXMAP.into(),
                    seg,
                    0,
                )
                .map_err(Fail::from)
                .and_then(|c| c.reply().map_err(Fail::from));
            match reply {
                Ok(r) if r.size as usize >= len => from_shm = true,
                Ok(r) => {
                    shm_failed = Some(format!(
                        "ShmGetImage returned {} bytes, {len} expected",
                        r.size
                    ))
                }
                Err(Fail::Refused(e)) => shm_failed = Some(e),
                Err(lost) => return Err(lost),
            }
        }
        if !from_shm {
            let reply = self
                .conn
                .get_image(ImageFormat::Z_PIXMAP, self.root, x, y, w16, h16, !0)?
                .reply()?;
            if reply.data.len() < len {
                return Err(Fail::Refused(format!(
                    "GetImage returned {} bytes, {len} expected",
                    reply.data.len()
                )));
            }
            self.scratch = reply.data;
            if let Some(why) = shm_failed {
                drop_shm(&mut self.shm, &self.conn, &why);
            }
        }
        let cursor = match cursor_cookie.map(|c| c.reply()) {
            Some(Ok(c)) => Some(c),
            Some(Err(ReplyError::ConnectionError(e))) => return Err(e.into()),
            Some(Err(ReplyError::X11Error(_))) | None => None,
        };

        let buf: &mut [u8] = match (from_shm, self.shm.as_mut()) {
            (true, Some(segment)) => segment.bytes_mut(len),
            _ => &mut self.scratch[..len],
        };
        if let Some(c) = &cursor {
            let image = CursorImage {
                pixels: &c.cursor_image,
                width: u32::from(c.width),
                height: u32::from(c.height),
            };
            let cx = i32::from(c.x) - i32::from(c.xhot) - m.x;
            let cy = i32::from(c.y) - i32::from(c.yhot) - m.y;
            composite(buf, w, h, stride, &image, cx, cy);
        }

        let state = self.state.entry(m.id).or_insert_with(|| MonitorState {
            rect: rect(m),
            hasher: TileHasher::new(),
            last: None,
        });
        if state.rect != rect(m) {
            state.rect = rect(m);
            state.hasher.reset();
            state.last = None;
        }
        let change = state.hasher.update(buf, w, h, stride);
        self.counters.grabs += 1;
        if !change.changed {
            if let Some(last) = &state.last {
                self.counters.reused += 1;
                return Ok(clone_frame(last));
            }
        }
        let frame = bgra_to_i420(buf, w, h, stride);
        self.counters.converted += 1;
        state.last = Some(clone_frame(&frame));
        Ok(frame)
    }
}

impl Capturer for X11Capturer {
    /// The monitors read at [`X11Capturer::open`] or the last [`X11Capturer::refresh_monitors`]
    /// (RandR 1.5 `GetMonitors` through [`crate::geometry::monitors_from_randr`]).
    fn enumerate(&self) -> Vec<MonitorInfo> {
        self.monitors.clone()
    }

    /// An I420 frame of the monitor's even-floored size; the last frame again when nothing
    /// changed; `None` only for an unknown monitor or before any frame could be read.
    fn next_frame(&mut self, monitor_id: u32) -> Option<Frame> {
        self.capture(monitor_id)
    }
}

impl Drop for X11Capturer {
    fn drop(&mut self) {
        // Detach before the connection closes; the segment unmaps as it drops here.
        if let Some(segment) = self.shm.take() {
            segment.detach(&self.conn);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::row_stride;

    #[test]
    fn row_stride_pads_to_the_scanline_unit() {
        assert_eq!(row_stride(1920, 32), 7680);
        assert_eq!(row_stride(3, 32), 12);
        assert_eq!(row_stride(3, 64), 16);
        assert_eq!(row_stride(5, 8), 20);
    }
}
