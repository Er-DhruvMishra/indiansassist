//! The portal capturer (Phase F §9.2, §9.3): ashpd for the ScreenCast handshake and pipewire for
//! the frames, on one thread of its own (`ia-portal`).
//!
//! * The handshake (`CreateSession`, `SelectSources`, `Start` with the compositor's dialog,
//!   `OpenPipeWireRemote`) runs on a one-worker tokio runtime that the thread keeps, so the D-Bus
//!   connection (and the session's `Closed` signal) stays alive while frames flow.
//! * The PipeWire main loop then runs on the same thread: a stream connected to the portal's node
//!   through the portal's fd, `EnumFormat` offering only the five 8-bit RGB layouts of
//!   [`crate::format`], `Buffers` asking for `MemFd` / `MemPtr` only (no DMA-BUF), and every
//!   buffer converted to packed BGRA ([`crate::convert`]) and published to the capturer.
//! * The session ends (`portal_closed`) when the portal emits `Closed` (the user pressed "Stop
//!   sharing"), when the node is removed from the registry, or when the stream fails or
//!   disconnects. A cancelled dialog is `portal_denied`; no portal is `wayland_unsupported`.
//!
//! [`Capturer::next_frame`] converts the newest BGRA buffer to I420 when it changed and returns
//! the previous frame again when it did not (the E rule); after a final status it returns `None`
//! (the no-screen state for the rest of the session).

use std::io::Cursor;
use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use ashpd::desktop::screencast::{
    CursorMode, OpenPipeWireRemoteOptions, Screencast, SelectSourcesOptions, SourceType,
    StartCastOptions,
};
use ashpd::desktop::{CreateSessionOptions, PersistMode, ResponseError, Session};
use futures_util::StreamExt as _;
use ia_core::capture_decision::PortalStatus;
use ia_core::types::{CapturePath, MonitorInfo};
use ia_platform::traits::{Capturer, Frame};
use libspa::param::format::{FormatProperties, MediaSubtype, MediaType};
use libspa::param::format_utils;
use libspa::param::video::VideoInfoRaw;
use libspa::param::ParamType;
use libspa::pod::serialize::PodSerializer;
use libspa::pod::{ChoiceValue, Object, Pod, Property, PropertyFlags, Value};
use libspa::utils::{Choice, ChoiceEnum, ChoiceFlags, Fraction, Id, Rectangle, SpaTypes};
use pipewire as pw;

use crate::convert::{bgra_frame, chunk_range, effective_stride, to_bgra};
use crate::format::{data_type_mask, BufferKind, PixelFormat, DEFAULT_SIZE, MAX_SIDE};
use crate::session::{
    offers_monitor, pick_stream, select_plan, status_for, Cursor as PlanCursor, Failure,
};

/// The one monitor a portal session shares (§9.3: the portal reports one stream).
pub const PORTAL_MONITOR_ID: u32 = 1;

#[derive(Default)]
struct Latest {
    seq: u64,
    width: u32,
    height: u32,
    bgra: Vec<u8>,
}

struct Shared {
    status: AtomicU8,
    stop: AtomicBool,
    stop_notify: tokio::sync::Notify,
    latest: Mutex<Latest>,
    size: Mutex<Option<(u32, u32)>>,
}

impl Shared {
    fn status(&self) -> PortalStatus {
        PortalStatus::from_u8(self.status.load(Ordering::SeqCst))
    }

    /// Move to `s` unless a final status was already reached (the first ending wins).
    fn set_status(&self, s: PortalStatus) {
        let mut cur = self.status.load(Ordering::SeqCst);
        while !PortalStatus::from_u8(cur).is_final() {
            match self
                .status
                .compare_exchange(cur, s as u8, Ordering::SeqCst, Ordering::SeqCst)
            {
                Ok(_) => return,
                Err(now) => cur = now,
            }
        }
    }
}

/// Screen capture of a Wayland session through the desktop portal (see the module docs).
pub struct PortalCapturer {
    shared: Arc<Shared>,
    stop_pw: Option<pw::channel::Sender<()>>,
    thread: Option<JoinHandle<()>>,
    last: Option<Frame>,
    last_seq: u64,
}

// The pump moves the capturer to its own thread (`ia_platform::traits::Capturer: Send`).
const _: fn() = || {
    fn send<T: Send>() {}
    send::<PortalCapturer>();
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

/// Whether the session bus has a desktop portal offering ScreenCast of a monitor, checked without
/// any dialog (§9.4: decides between the portal set and the E Wayland set at `desk.hello`).
pub fn probe(timeout: Duration) -> Result<(), Failure> {
    let worker = std::thread::Builder::new()
        .name("ia-portal-probe".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| Failure::Refused(e.to_string()))?;
            rt.block_on(async {
                match tokio::time::timeout(timeout, probe_async()).await {
                    Ok(r) => r.map(|_| ()),
                    Err(_) => Err(Failure::NoPortal),
                }
            })
        });
    match worker {
        Ok(h) => h.join().unwrap_or(Err(Failure::NoPortal)),
        Err(_) => Err(Failure::NoPortal),
    }
}

/// The proxy and its advertised cursor modes (bits), or why there is no usable portal.
async fn probe_async() -> Result<(Screencast, u32), Failure> {
    // A connection of this runtime's own: ashpd's shared one would be bound to the runtime that
    // first made it (the probe's), and stall once that runtime is gone.
    let conn = ashpd::zbus::Connection::session()
        .await
        .map_err(|_| Failure::NoPortal)?;
    let proxy = Screencast::with_connection(conn)
        .await
        .map_err(|e| match e {
            ashpd::Error::PortalNotFound(_) | ashpd::Error::RequiresVersion(..) => {
                Failure::NoScreenCast
            }
            _ => Failure::NoPortal,
        })?;
    let sources = proxy
        .available_source_types()
        .await
        .map_err(|_| Failure::NoScreenCast)?;
    if !offers_monitor(sources.bits()) {
        return Err(Failure::NoMonitorSource);
    }
    let cursors = proxy
        .available_cursor_modes()
        .await
        .map(|b| b.bits())
        .unwrap_or(0);
    Ok((proxy, cursors))
}

/// A portal request that did not succeed: the dialog cancelled, or anything else.
fn classify(e: ashpd::Error) -> Failure {
    match e {
        ashpd::Error::Response(ResponseError::Cancelled) => Failure::Cancelled,
        ashpd::Error::Portal(ashpd::PortalError::Cancelled(_)) => Failure::Cancelled,
        other => Failure::Refused(other.to_string()),
    }
}

struct Handshake {
    session: Session<Screencast>,
    fd: OwnedFd,
    node: u32,
    size: Option<(u32, u32)>,
}

async fn handshake() -> Result<Handshake, Failure> {
    let (proxy, cursors) = probe_async().await?;
    let plan = select_plan(cursors);
    let session = proxy
        .create_session(CreateSessionOptions::default())
        .await
        .map_err(classify)?;
    let cursor = match plan.cursor {
        PlanCursor::Embedded => CursorMode::Embedded,
        PlanCursor::Hidden => CursorMode::Hidden,
    };
    let opts = SelectSourcesOptions::default()
        .set_cursor_mode(cursor)
        .set_sources(Some(SourceType::Monitor.into()))
        .set_multiple(plan.multiple)
        .set_persist_mode(PersistMode::DoNot);
    proxy
        .select_sources(&session, opts)
        .await
        .map_err(classify)?
        .response()
        .map_err(classify)?;
    tracing::info!("portal: sources selected; asking the user to share the screen");
    let streams = proxy
        .start(&session, None, StartCastOptions::default())
        .await
        .map_err(classify)?
        .response()
        .map_err(classify)?;
    let ids: Vec<u32> = streams
        .streams()
        .iter()
        .map(|s| s.pipe_wire_node_id())
        .collect();
    let node = pick_stream(&ids).ok_or_else(|| Failure::Refused("no stream".into()))?;
    let size = streams
        .streams()
        .first()
        .and_then(|s| s.size())
        .filter(|(w, h)| *w > 0 && *h > 0)
        .map(|(w, h)| (w as u32, h as u32));
    let fd = proxy
        .open_pipe_wire_remote(&session, OpenPipeWireRemoteOptions::default())
        .await
        .map_err(|e| Failure::PipeWire(e.to_string()))?;
    tracing::info!(node, ?size, "portal: screen cast started");
    Ok(Handshake {
        session,
        fd,
        node,
        size,
    })
}

impl PortalCapturer {
    /// Start a portal session on a thread of its own. The compositor's source dialog appears
    /// now (call this only after the agent's own consent, §9.3); the result arrives through
    /// [`Self::status`].
    pub fn start() -> PortalCapturer {
        let shared = Arc::new(Shared {
            status: AtomicU8::new(PortalStatus::Pending as u8),
            stop: AtomicBool::new(false),
            stop_notify: tokio::sync::Notify::new(),
            latest: Mutex::new(Latest::default()),
            size: Mutex::new(None),
        });
        let (tx, rx) = pw::channel::channel::<()>();
        let worker_shared = shared.clone();
        let worker_tx = tx.clone();
        let thread = std::thread::Builder::new()
            .name("ia-portal".into())
            .spawn(move || run(worker_shared, worker_tx, rx));
        let thread = match thread {
            Ok(t) => Some(t),
            Err(e) => {
                tracing::warn!("portal: the capture thread could not start: {e}");
                shared.set_status(PortalStatus::Closed);
                None
            }
        };
        PortalCapturer {
            shared,
            stop_pw: Some(tx),
            thread,
            last: None,
            last_seq: 0,
        }
    }

    /// Where the session stands.
    pub fn status(&self) -> PortalStatus {
        self.shared.status()
    }

    /// The stream's size once known (from `Start`, then from the negotiated format).
    pub fn native_size(&self) -> Option<(u32, u32)> {
        self.shared.size.lock().ok().and_then(|s| *s)
    }

    /// `agent.stats.capturePath`.
    pub fn path(&self) -> CapturePath {
        if self.status() == PortalStatus::Streaming {
            CapturePath::Portal
        } else {
            CapturePath::None
        }
    }

    /// The newest packed BGRA buffer (`width`, `height`, bytes), for the portal tests.
    #[doc(hidden)]
    pub fn latest_bgra(&self) -> Option<(u32, u32, Vec<u8>)> {
        let l = self.shared.latest.lock().ok()?;
        (l.seq > 0).then(|| (l.width, l.height, l.bgra.clone()))
    }

    /// Ask the session to end: the dialog is closed if open, the stream disconnected, the portal
    /// session closed. Idempotent; also done on drop.
    pub fn stop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        self.shared.stop_notify.notify_one();
        if let Some(tx) = self.stop_pw.take() {
            let _ = tx.send(());
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for PortalCapturer {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Capturer for PortalCapturer {
    fn enumerate(&self) -> Vec<MonitorInfo> {
        let (width, height) = self.native_size().unwrap_or(DEFAULT_SIZE);
        vec![MonitorInfo {
            id: PORTAL_MONITOR_ID,
            name: "Wayland screen (portal)".into(),
            primary: true,
            x: 0,
            y: 0,
            width,
            height,
            scale: 1.0,
            mid: None,
        }]
    }

    fn next_frame(&mut self, monitor_id: u32) -> Option<Frame> {
        if monitor_id != PORTAL_MONITOR_ID || self.status().is_final() {
            return None;
        }
        let fresh = {
            let l = self.shared.latest.lock().ok()?;
            (l.seq != self.last_seq && l.width >= 2 && l.height >= 2)
                .then(|| (l.seq, l.width, l.height, l.bgra.clone()))
        };
        if let Some((seq, w, h, bgra)) = fresh {
            self.last = Some(bgra_frame(&bgra, w, h));
            self.last_seq = seq;
        }
        self.last.as_ref().map(clone_frame)
    }
}

/// The capture thread: the handshake, then the PipeWire loop, then the session is closed.
fn run(shared: Arc<Shared>, tx: pw::channel::Sender<()>, rx: pw::channel::Receiver<()>) {
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .thread_name("ia-portal-bus")
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            tracing::warn!("portal: no runtime: {e}");
            shared.set_status(PortalStatus::Closed);
            return;
        }
    };
    let hs = rt.block_on(async {
        tokio::select! {
            r = handshake() => Some(r),
            _ = shared.stop_notify.notified() => None,
        }
    });
    let hs = match hs {
        Some(Ok(hs)) => hs,
        Some(Err(f)) => {
            tracing::info!(failure = ?f, "portal: no screen cast");
            shared.set_status(status_for(&f));
            rt.shutdown_timeout(Duration::from_millis(500));
            return;
        }
        None => {
            shared.set_status(PortalStatus::Closed);
            rt.shutdown_timeout(Duration::from_millis(500));
            return;
        }
    };
    if let Ok(mut s) = shared.size.lock() {
        *s = hs.size;
    }
    let session = Arc::new(hs.session);
    // "Stop sharing" in the compositor closes the portal session.
    {
        let session = session.clone();
        let shared = shared.clone();
        let tx = tx.clone();
        rt.spawn(async move {
            if let Ok(mut closed) = session.receive_closed().await {
                if closed.next().await.is_some() {
                    tracing::info!("portal: the session was closed (the user stopped sharing)");
                    shared.set_status(PortalStatus::Closed);
                    let _ = tx.send(());
                }
            }
        });
    }
    if !shared.stop.load(Ordering::SeqCst) {
        if let Err(e) = run_stream(hs.fd, hs.node, &shared, rx) {
            tracing::warn!("portal: PipeWire: {e}");
        }
    }
    shared.set_status(PortalStatus::Closed);
    let _ =
        rt.block_on(async { tokio::time::timeout(Duration::from_secs(1), session.close()).await });
    drop(session);
    rt.shutdown_timeout(Duration::from_millis(500));
}

/// Serialise a pod value to bytes.
fn pod_bytes(value: Value) -> Result<Vec<u8>, String> {
    PodSerializer::serialize(Cursor::new(Vec::new()), &value)
        .map(|(c, _)| c.into_inner())
        .map_err(|e| format!("pod: {e:?}"))
}

fn prop(key: u32, value: Value) -> Property {
    Property {
        key,
        flags: PropertyFlags::empty(),
        value,
    }
}

/// `EnumFormat`: raw video in the five accepted RGB layouts, any size up to 8K, any rate. No
/// modifier is offered, so the producer never picks DMA-BUF.
fn enum_format_pod() -> Result<Vec<u8>, String> {
    let ids: Vec<Id> = PixelFormat::ACCEPTED
        .iter()
        .map(|f| Id(f.spa_id()))
        .collect();
    let (dw, dh) = DEFAULT_SIZE;
    pod_bytes(Value::Object(Object {
        type_: SpaTypes::ObjectParamFormat.as_raw(),
        id: ParamType::EnumFormat.as_raw(),
        properties: vec![
            prop(
                FormatProperties::MediaType.as_raw(),
                Value::Id(Id(MediaType::Video.as_raw())),
            ),
            prop(
                FormatProperties::MediaSubtype.as_raw(),
                Value::Id(Id(MediaSubtype::Raw.as_raw())),
            ),
            prop(
                FormatProperties::VideoFormat.as_raw(),
                Value::Choice(ChoiceValue::Id(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Enum {
                        default: ids[0],
                        alternatives: ids.clone(),
                    },
                ))),
            ),
            prop(
                FormatProperties::VideoSize.as_raw(),
                Value::Choice(ChoiceValue::Rectangle(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Range {
                        default: Rectangle {
                            width: dw,
                            height: dh,
                        },
                        min: Rectangle {
                            width: 1,
                            height: 1,
                        },
                        max: Rectangle {
                            width: MAX_SIDE,
                            height: MAX_SIDE,
                        },
                    },
                ))),
            ),
            prop(
                FormatProperties::VideoFramerate.as_raw(),
                Value::Choice(ChoiceValue::Fraction(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Range {
                        default: Fraction { num: 30, denom: 1 },
                        min: Fraction { num: 0, denom: 1 },
                        max: Fraction { num: 360, denom: 1 },
                    },
                ))),
            ),
        ],
    }))
}

/// `Buffers`: mappable memory only (`MemFd`, `MemPtr`), never DMA-BUF (§9.2).
fn buffers_pod() -> Result<Vec<u8>, String> {
    let mask = data_type_mask();
    pod_bytes(Value::Object(Object {
        type_: SpaTypes::ObjectParamBuffers.as_raw(),
        id: ParamType::Buffers.as_raw(),
        properties: vec![prop(
            libspa::sys::SPA_PARAM_BUFFERS_dataType,
            Value::Choice(ChoiceValue::Int(Choice(
                ChoiceFlags::empty(),
                ChoiceEnum::Flags {
                    default: mask,
                    flags: vec![mask],
                },
            ))),
        )],
    }))
}

/// A read-only mapping of one MemFd buffer, for the length of one `process` call.
struct FdMap {
    base: *mut libc::c_void,
    len: usize,
    delta: usize,
    maxsize: usize,
}

impl FdMap {
    fn new(fd: i64, mapoffset: u32, maxsize: u32) -> Option<FdMap> {
        if fd < 0 || maxsize == 0 {
            return None;
        }
        // SAFETY: sysconf has no preconditions.
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(4096) as usize;
        let start = (mapoffset as usize) & !(page - 1);
        let delta = mapoffset as usize - start;
        let len = delta + maxsize as usize;
        // SAFETY: a fresh read-only shared mapping of `len` bytes of the buffer's fd; the result
        // is checked against MAP_FAILED and unmapped exactly once in `Drop`.
        let base = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ,
                libc::MAP_SHARED,
                fd as libc::c_int,
                start as libc::off_t,
            )
        };
        (base != libc::MAP_FAILED).then_some(FdMap {
            base,
            len,
            delta,
            maxsize: maxsize as usize,
        })
    }

    fn bytes(&self) -> &[u8] {
        // SAFETY: `base + delta .. + maxsize` lies inside the `len`-byte readable mapping.
        unsafe {
            std::slice::from_raw_parts((self.base as *const u8).add(self.delta), self.maxsize)
        }
    }
}

impl Drop for FdMap {
    fn drop(&mut self) {
        // SAFETY: `base` / `len` are the mapping made in `new`.
        unsafe {
            libc::munmap(self.base, self.len);
        }
    }
}

struct StreamData {
    shared: Arc<Shared>,
    mainloop: pw::main_loop::MainLoopWeak,
    format: Option<PixelFormat>,
    size: (u32, u32),
    scratch: Vec<u8>,
    warned: bool,
}

impl StreamData {
    fn end(&self, why: &str) {
        tracing::info!("portal: the stream ended ({why})");
        self.shared.set_status(PortalStatus::Closed);
        if let Some(ml) = self.mainloop.upgrade() {
            ml.quit();
        }
    }
}

/// The PipeWire half: connect to the portal's remote, consume `node` until the stream ends or
/// the capturer stops.
fn run_stream(
    fd: OwnedFd,
    node: u32,
    shared: &Arc<Shared>,
    rx: pw::channel::Receiver<()>,
) -> Result<(), String> {
    pw::init();
    let mainloop = pw::main_loop::MainLoopRc::new(None).map_err(|e| e.to_string())?;
    let context = pw::context::ContextRc::new(&mainloop, None).map_err(|e| e.to_string())?;
    let core = context
        .connect_fd_rc(fd, None)
        .map_err(|e| format!("the portal's PipeWire remote: {e}"))?;

    // The portal's node disappearing (the cast ended on the compositor side) ends the session.
    let registry = core.get_registry_rc().map_err(|e| e.to_string())?;
    let _registry_listener = {
        let shared = shared.clone();
        let ml = mainloop.downgrade();
        registry
            .add_listener_local()
            .global_remove(move |id| {
                if id == node {
                    tracing::info!("portal: the screen-cast node was removed");
                    shared.set_status(PortalStatus::Closed);
                    if let Some(ml) = ml.upgrade() {
                        ml.quit();
                    }
                }
            })
            .register()
    };

    let stream = pw::stream::StreamBox::new(
        &core,
        "IndiansAssist screen",
        pw::properties::properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    )
    .map_err(|e| e.to_string())?;
    let data = StreamData {
        shared: shared.clone(),
        mainloop: mainloop.downgrade(),
        format: None,
        size: DEFAULT_SIZE,
        scratch: Vec::new(),
        warned: false,
    };
    let _listener = stream
        .add_local_listener_with_user_data(data)
        .state_changed(|_, d, old, new| {
            tracing::debug!(?old, ?new, "portal: stream state");
            match new {
                pw::stream::StreamState::Error(e) => d.end(&format!("error: {e}")),
                pw::stream::StreamState::Unconnected => d.end("disconnected"),
                _ => {}
            }
        })
        .param_changed(|stream, d, id, param| {
            let Some(param) = param else { return };
            if id != ParamType::Format.as_raw() {
                return;
            }
            let Ok((mt, ms)) = format_utils::parse_format(param) else {
                return;
            };
            if mt != MediaType::Video || ms != MediaSubtype::Raw {
                return;
            }
            let mut info = VideoInfoRaw::new();
            if info.parse(param).is_err() {
                return;
            }
            let size = (info.size().width, info.size().height);
            d.format = PixelFormat::from_spa(info.format().as_raw());
            d.size = size;
            tracing::info!(format = ?d.format, width = size.0, height = size.1, "portal: format negotiated");
            if let Ok(mut s) = d.shared.size.lock() {
                *s = Some(size);
            }
            match buffers_pod() {
                Ok(bytes) => {
                    if let Some(pod) = Pod::from_bytes(&bytes) {
                        let _ = stream.update_params(&mut [pod]);
                    }
                }
                Err(e) => tracing::warn!("portal: {e}"),
            }
        })
        .process(|stream, d| {
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let Some(data) = buffer.datas_mut().first_mut() else {
                return;
            };
            let kind = BufferKind::from_spa(data.type_().as_raw());
            if !kind.accepted() {
                if !d.warned {
                    tracing::warn!(?kind, "portal: a buffer type this build does not read");
                    d.warned = true;
                }
                return;
            }
            let Some(format) = d.format else { return };
            let (w, h) = d.size;
            let (offset, size, stride) = {
                let c = data.chunk();
                (c.offset(), c.size(), c.stride())
            };
            let stride = effective_stride(stride, w);
            let raw = data.as_raw();
            let converted = match kind {
                BufferKind::MemFd => FdMap::new(raw.fd, raw.mapoffset, raw.maxsize)
                    .ok_or("mmap failed".to_string())
                    .and_then(|m| {
                        let bytes = m.bytes();
                        let range = chunk_range(bytes.len(), offset, size)
                            .ok_or("an empty chunk".to_string())?;
                        to_bgra(&bytes[range], w, h, stride, format, &mut d.scratch)
                            .map_err(|e| e.to_string())
                    }),
                _ => match data.data() {
                    Some(bytes) => chunk_range(bytes.len(), offset, size)
                        .ok_or("an empty chunk".to_string())
                        .and_then(|range| {
                            to_bgra(&bytes[range], w, h, stride, format, &mut d.scratch)
                                .map_err(|e| e.to_string())
                        }),
                    None => Err("no data pointer".to_string()),
                },
            };
            match converted {
                Ok(()) => {
                    if let Ok(mut l) = d.shared.latest.lock() {
                        std::mem::swap(&mut l.bgra, &mut d.scratch);
                        l.width = w;
                        l.height = h;
                        l.seq += 1;
                    }
                    if d.shared.status() == PortalStatus::Pending {
                        tracing::info!("portal: first frame");
                        d.shared.set_status(PortalStatus::Streaming);
                    }
                }
                Err(e) => tracing::debug!("portal: frame skipped: {e}"),
            }
        })
        .register()
        .map_err(|e| e.to_string())?;

    let format = enum_format_pod()?;
    let pod = Pod::from_bytes(&format).ok_or("the format pod")?;
    stream
        .connect(
            libspa::utils::Direction::Input,
            Some(node),
            // No MAP_BUFFERS: PipeWire maps a buffer with the protection its flags name, and a
            // producer that marks a memfd only MAPPABLE (xdg-desktop-portal-wlr does) gets an
            // unreadable mapping. `FdMap` maps MemFd buffers read-only itself.
            pw::stream::StreamFlags::AUTOCONNECT,
            &mut [pod],
        )
        .map_err(|e| format!("connect to node {node}: {e}"))?;

    let _stop = {
        let ml = mainloop.downgrade();
        rx.attach(mainloop.loop_(), move |()| {
            if let Some(ml) = ml.upgrade() {
                ml.quit();
            }
        })
    };
    if !shared.stop.load(Ordering::SeqCst) && !shared.status().is_final() {
        mainloop.run();
    }
    let _ = stream.disconnect();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pure_numbers_match_libspa() {
        use libspa::param::video::VideoFormat;
        assert_eq!(PixelFormat::RGBx.spa_id(), VideoFormat::RGBx.as_raw());
        assert_eq!(PixelFormat::BGRx.spa_id(), VideoFormat::BGRx.as_raw());
        assert_eq!(PixelFormat::xRGB.spa_id(), VideoFormat::xRGB.as_raw());
        assert_eq!(PixelFormat::RGBA.spa_id(), VideoFormat::RGBA.as_raw());
        assert_eq!(PixelFormat::BGRA.spa_id(), VideoFormat::BGRA.as_raw());
        use libspa::buffer::DataType;
        assert_eq!(BufferKind::SPA_MEM_PTR, DataType::MemPtr.as_raw());
        assert_eq!(BufferKind::SPA_MEM_FD, DataType::MemFd.as_raw());
        assert_eq!(BufferKind::SPA_DMA_BUF, DataType::DmaBuf.as_raw());
    }

    #[test]
    fn the_pods_serialise() {
        let f = enum_format_pod().unwrap();
        assert!(Pod::from_bytes(&f).is_some());
        let b = buffers_pod().unwrap();
        assert!(Pod::from_bytes(&b).is_some());
    }
}
