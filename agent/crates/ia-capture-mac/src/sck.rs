//! The ScreenCaptureKit capturer (Phase F §17.2), compiled under
//! `cfg(all(target_os = "macos", feature = "macos"))`. macOS 12.3 or later.
//!
//! One `SCStream` per display, started on the first `next_frame` for it: the content filter is
//! the display **minus this application** (`initWithDisplay:excludingApplications:`), so the
//! agent's pill, panel and prompts never appear in the stream (the macOS equivalent of
//! `WDA_EXCLUDEFROMCAPTURE`); the configuration asks for BGRA at the [`crate::geometry`] size,
//! at most 30 fps, with the cursor drawn in. Each sample buffer is converted to I420 on the
//! stream's own queue and kept as the display's latest frame.
//!
//! Behaviour the pump relies on (it matches the Windows `DxgiCapturer` and `X11Capturer`):
//! * [`Capturer::next_frame`] returns the latest frame, or **the last frame again** when
//!   ScreenCaptureKit delivered nothing new (it sends no buffer while the screen is idle);
//! * `None` only for an unknown monitor or before the first frame of that display arrived;
//! * a stream that stops with an error (Screen Recording revoked, display gone) sets
//!   [`SckCapturer::lost`] and is restarted no more often than every [`RETRY_EVERY`].
//!
//! Capture needs the Screen Recording grant; the agent checks `CGPreflightScreenCaptureAccess`
//! first and does not construct this capturer without it (§17.2 TCC flow).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use block2::RcBlock;
use dispatch2::DispatchQueue;
use ia_core::types::{CapturePath, MonitorInfo};
use ia_frame::convert::bgra_to_i420;
use ia_platform::traits::{Capturer, Frame};
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_core_graphics::{
    CGDirectDisplayID, CGDisplayBounds, CGDisplayPixelsWide, CGGetActiveDisplayList,
    CGMainDisplayID,
};
use objc2_core_media::{CMSampleBuffer, CMTime};
use objc2_core_video::{
    kCVPixelFormatType_32BGRA, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferGetHeight, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCContentFilter, SCRunningApplication, SCShareableContent, SCStream, SCStreamConfiguration,
    SCStreamDelegate, SCStreamOutput, SCStreamOutputType,
};

use crate::geometry::{capture_size, monitors, Display, MAX_LONG_EDGE};

/// How long a call into ScreenCaptureKit (content list, stream start) may take.
const SCK_TIMEOUT: Duration = Duration::from_secs(5);
/// A failed or stopped stream is restarted at most this often.
pub const RETRY_EVERY: Duration = Duration::from_secs(2);

/// The latest frame of one display, written on the stream's queue and read by the pump.
#[derive(Default)]
struct Slot {
    frame: Option<Frame>,
}

struct SinkIvars {
    slot: Arc<Mutex<Slot>>,
    stopped: Arc<AtomicBool>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and `FrameSink` does not implement Drop.
    #[unsafe(super(NSObject))]
    #[name = "IAFrameSink"]
    #[ivars = SinkIvars]
    struct FrameSink;

    unsafe impl NSObjectProtocol for FrameSink {}

    unsafe impl SCStreamOutput for FrameSink {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn stream_did_output(
            &self,
            _stream: &SCStream,
            sample_buffer: &CMSampleBuffer,
            kind: SCStreamOutputType,
        ) {
            if kind != SCStreamOutputType::Screen {
                return;
            }
            if let Some(frame) = convert(sample_buffer) {
                if let Ok(mut slot) = self.ivars().slot.lock() {
                    slot.frame = Some(frame);
                }
            }
        }
    }

    unsafe impl SCStreamDelegate for FrameSink {
        #[unsafe(method(stream:didStopWithError:))]
        fn stream_did_stop(&self, _stream: &SCStream, error: &NSError) {
            tracing::warn!(code = error.code(), "ScreenCaptureKit stream stopped");
            self.ivars().stopped.store(true, Ordering::SeqCst);
        }
    }
);

impl FrameSink {
    fn new(slot: Arc<Mutex<Slot>>, stopped: Arc<AtomicBool>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(SinkIvars { slot, stopped });
        // SAFETY: NSObject's designated initialiser.
        unsafe { msg_send![super(this), init] }
    }
}

/// A BGRA sample buffer → I420. `None` for a buffer without an image (ScreenCaptureKit sends
/// status-only buffers while nothing changes) or one that cannot be locked.
fn convert(sample_buffer: &CMSampleBuffer) -> Option<Frame> {
    // SAFETY: a valid sample buffer handed to us by ScreenCaptureKit for this call.
    let image = unsafe { sample_buffer.image_buffer() }?;
    let flags = CVPixelBufferLockFlags::ReadOnly;
    // SAFETY: lock / unlock pair on a pixel buffer we hold a reference to.
    if unsafe { CVPixelBufferLockBaseAddress(&image, flags) } != 0 {
        return None;
    }
    let width = CVPixelBufferGetWidth(&image);
    let height = CVPixelBufferGetHeight(&image);
    let stride = CVPixelBufferGetBytesPerRow(&image);
    let base = CVPixelBufferGetBaseAddress(&image);
    let frame = if base.is_null() || width < 2 || height < 2 || stride < width * 4 {
        None
    } else {
        // SAFETY: while locked, the base address points at `stride * height` readable bytes.
        let bytes = unsafe { std::slice::from_raw_parts(base as *const u8, stride * height) };
        Some(bgra_to_i420(
            bytes,
            (width & !1) as u32,
            (height & !1) as u32,
            stride,
        ))
    };
    // SAFETY: matches the lock above.
    unsafe { CVPixelBufferUnlockBaseAddress(&image, flags) };
    frame
}

struct Stream {
    stream: Retained<SCStream>,
    // Kept alive: ScreenCaptureKit holds the output weakly.
    _sink: Retained<FrameSink>,
    slot: Arc<Mutex<Slot>>,
    stopped: Arc<AtomicBool>,
    last: Option<Frame>,
}

impl Drop for Stream {
    fn drop(&mut self) {
        // SAFETY: stopping a started stream; no completion handler.
        unsafe { self.stream.stopCaptureWithCompletionHandler(None) };
    }
}

/// ScreenCaptureKit capture of every active display.
pub struct SckCapturer {
    displays: Vec<(MonitorInfo, u32)>,
    streams: HashMap<u32, Stream>,
    failed_at: HashMap<u32, Instant>,
    lost: bool,
}

// SAFETY: the ScreenCaptureKit objects are documented thread-safe; the capturer is moved to the
// pump thread once and only used from there.
unsafe impl Send for SckCapturer {}

impl SckCapturer {
    /// The active displays now; no stream starts until a frame is asked for.
    pub fn new() -> Self {
        Self {
            displays: monitors(&active_displays()),
            streams: HashMap::new(),
            failed_at: HashMap::new(),
            lost: false,
        }
    }

    /// `agent.stats.capturePath`.
    pub fn path(&self, _monitor_id: u32) -> CapturePath {
        CapturePath::Sck
    }

    /// A stream stopped with an error (the agent reports it and greys the screen in words).
    pub fn lost(&self) -> bool {
        self.lost
    }

    fn start(&mut self, monitor_id: u32) -> Result<(), String> {
        let (monitor, display_id) = self
            .displays
            .iter()
            .find(|(m, _)| m.id == monitor_id)
            .cloned()
            .ok_or("unknown monitor")?;
        let (width, height) = capture_size(&monitor, MAX_LONG_EDGE);
        let filter = content_filter(display_id)?;
        let slot = Arc::new(Mutex::new(Slot::default()));
        let stopped = Arc::new(AtomicBool::new(false));
        let sink = FrameSink::new(slot.clone(), stopped.clone());
        // SAFETY: plain configuration setters on a fresh object.
        let config = unsafe {
            let c = SCStreamConfiguration::new();
            c.setWidth(width as usize);
            c.setHeight(height as usize);
            c.setPixelFormat(kCVPixelFormatType_32BGRA);
            c.setMinimumFrameInterval(CMTime::new(1, 30));
            c.setShowsCursor(true);
            c.setQueueDepth(3);
            c
        };
        let delegate = ProtocolObject::from_ref(&*sink);
        // SAFETY: a fresh stream over a valid filter and configuration; the delegate is kept
        // alive by `Stream::_sink` for as long as the stream.
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &config,
                Some(delegate),
            )
        };
        let queue = DispatchQueue::new("com.indiansassist.capture", None);
        // SAFETY: the output object lives as long as the stream; frames arrive on `queue`.
        unsafe {
            stream.addStreamOutput_type_sampleHandlerQueue_error(
                ProtocolObject::from_ref(&*sink),
                SCStreamOutputType::Screen,
                Some(&queue),
            )
        }
        .map_err(|e| format!("addStreamOutput: {}", e.code()))?;
        let (tx, rx) = mpsc::channel::<Option<isize>>();
        let done = RcBlock::new(move |err: *mut NSError| {
            // SAFETY: a null or valid NSError from ScreenCaptureKit.
            let code = unsafe { err.as_ref() }.map(|e| e.code());
            let _ = tx.send(code);
        });
        // SAFETY: start with a completion handler that only sends on a channel.
        unsafe { stream.startCaptureWithCompletionHandler(Some(&done)) };
        match rx.recv_timeout(SCK_TIMEOUT) {
            Ok(None) => {}
            Ok(Some(code)) => return Err(format!("startCapture failed: {code}")),
            Err(_) => return Err("startCapture timed out".into()),
        }
        tracing::info!(monitor_id, width, height, "ScreenCaptureKit stream started");
        self.lost = false;
        self.streams.insert(
            monitor_id,
            Stream {
                stream,
                _sink: sink,
                slot,
                stopped,
                last: None,
            },
        );
        Ok(())
    }
}

impl Default for SckCapturer {
    fn default() -> Self {
        Self::new()
    }
}

impl Capturer for SckCapturer {
    fn enumerate(&self) -> Vec<MonitorInfo> {
        self.displays.iter().map(|(m, _)| m.clone()).collect()
    }

    fn next_frame(&mut self, monitor_id: u32) -> Option<Frame> {
        if self
            .streams
            .get(&monitor_id)
            .is_some_and(|s| s.stopped.load(Ordering::SeqCst))
        {
            self.lost = true;
            let last = self
                .streams
                .remove(&monitor_id)
                .and_then(|mut s| s.last.take());
            self.failed_at.insert(monitor_id, Instant::now());
            return last;
        }
        if !self.streams.contains_key(&monitor_id) {
            if self
                .failed_at
                .get(&monitor_id)
                .is_some_and(|t| t.elapsed() < RETRY_EVERY)
            {
                return None;
            }
            if let Err(e) = self.start(monitor_id) {
                tracing::warn!(monitor_id, "ScreenCaptureKit: {e}");
                self.failed_at.insert(monitor_id, Instant::now());
                return None;
            }
        }
        let s = self.streams.get_mut(&monitor_id)?;
        if let Some(f) = s.slot.lock().ok().and_then(|mut slot| slot.frame.take()) {
            s.last = Some(f);
        }
        s.last.as_ref().map(copy_frame)
    }
}

fn copy_frame(f: &Frame) -> Frame {
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

/// `CGGetActiveDisplayList` with each display's bounds, pixel width and main flag.
pub fn active_displays() -> Vec<Display> {
    let mut ids = [0 as CGDirectDisplayID; 16];
    let mut count = 0u32;
    // SAFETY: the buffer holds 16 ids and `count` receives how many were written.
    let err = unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) };
    if err.0 != 0 {
        return Vec::new();
    }
    let main_id = CGMainDisplayID();
    ids[..count as usize]
        .iter()
        .map(|&id| {
            let b = CGDisplayBounds(id);
            Display {
                display_id: id,
                x: b.origin.x,
                y: b.origin.y,
                width: b.size.width,
                height: b.size.height,
                pixels_wide: CGDisplayPixelsWide(id) as u32,
                main: id == main_id,
            }
        })
        .collect()
}

/// Whether ScreenCaptureKit hands this process the shareable content (it does only with Screen
/// Recording), with the error code otherwise. Called once per process (see
/// `screen_recording_granted`), never on a timer.
pub fn shareable_content_available() -> Result<(), String> {
    shareable_content().map(|_| ())
}

fn shareable_content() -> Result<Retained<SCShareableContent>, String> {
    struct SendContent(Option<Retained<SCShareableContent>>, Option<isize>);
    // SAFETY: SCShareableContent is an immutable snapshot, safe to move between threads.
    unsafe impl Send for SendContent {}
    let (tx, rx) = mpsc::channel::<SendContent>();
    let handler = RcBlock::new(move |content: *mut SCShareableContent, err: *mut NSError| {
        // SAFETY: ScreenCaptureKit passes a valid object or null for each argument.
        let content = unsafe { Retained::retain(content) };
        let code = unsafe { err.as_ref() }.map(|e| e.code());
        let _ = tx.send(SendContent(content, code));
    });
    // SAFETY: the handler only sends on a channel.
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler) };
    match rx.recv_timeout(SCK_TIMEOUT) {
        Ok(SendContent(Some(c), None)) => Ok(c),
        Ok(SendContent(_, code)) => Err(format!(
            "no shareable content (error {code:?}; is Screen Recording granted?)"
        )),
        Err(_) => Err("the shareable content did not arrive".to_string()),
    }
}

/// The ScreenCaptureKit filter for one display without this application's windows.
fn content_filter(display_id: u32) -> Result<Retained<SCContentFilter>, String> {
    let content = shareable_content()?;
    // SAFETY: reading the snapshot's arrays and properties.
    unsafe {
        let display = content
            .displays()
            .iter()
            .find(|d| d.displayID() == display_id)
            .ok_or("the display is not shareable")?;
        let pid = std::process::id() as i32;
        let own: Vec<Retained<SCRunningApplication>> = content
            .applications()
            .iter()
            .filter(|a| a.processID() == pid)
            .collect();
        let own = NSArray::from_retained_slice(&own);
        Ok(
            SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
                SCContentFilter::alloc(),
                &display,
                &own,
                &NSArray::new(),
            ),
        )
    }
}
