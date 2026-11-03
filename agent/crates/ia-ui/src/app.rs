//! The eframe application driven from the serve loop (contract §3.3 consent window, §3.5
//! pill / panel / tray, §6.1 F4 file prompt, §3.4 level prompt, §6.2 chat).
//!
//! One eframe event loop on a dedicated UI thread (`with_any_thread`, so the tokio runtime
//! keeps the main thread). The root viewport starts as the **consent window** (a normal,
//! always-on-top, 520 x 720 window); after **Share my screen** it morphs into the **pill**
//! (frameless 420 x 44, `WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`, docked
//! top-centre, excluded from capture, topmost re-asserted every 2 s, re-docked if it leaves
//! the desktop). The **panel** is a second, immediate viewport (360 x 480, topmost tool
//! window, activatable, excluded from capture) anchored under the pill; it closes on blur or
//! Escape. The tray icon lives on the same thread.
//!
//! Every view is drawn from plain state; decisions go back to the serve loop as
//! [`UiEvent`]s, and the serve loop pushes [`UiCommand`]s. Grant-direction controls are
//! gated on a recent physical press recorded by the [`Guard`] hooks.

use std::rc::Rc;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use eframe::egui::{
    self, pos2, vec2, Align2, Color32, FontId, Id, Rect, RichText, Sense, ViewportBuilder,
    ViewportCommand, ViewportId, WindowLevel,
};
use ia_core::types::{AgentConsentLevel, ElevationLevel, MonitorInfo};

use crate::bridge::{human_size, ConsentRequest, FilePrompt, UiCommand, UiEvent};
use crate::guard::Guard;
use crate::model::{
    level_chip, mic_direction, mic_label, prompt_allowed, ConsentModel, PillModel, PromptDirection,
};
use crate::tray::{Tray, TrayAction, TrayState};

/// Window titles (the Win32 layer finds the HWNDs by title within this process).
pub const CONSENT_TITLE: &str = "IndiansAssist - Share your screen?";
pub const PILL_TITLE: &str = "IndiansAssist indicator";
pub const PANEL_TITLE: &str = "IndiansAssist panel";
pub const ENDED_TITLE: &str = "IndiansAssist - Session ended";

const PILL_W: f32 = 420.0;
const PILL_H: f32 = 44.0;
const PANEL_W: f32 = 360.0;
const PANEL_H: f32 = 480.0;
/// A grant-direction click must follow a physical press over an agent window this recently.
const PHYSICAL_WINDOW: Duration = Duration::from_secs(3);

/// The UI -> serve-loop sink.
pub type Emit = Box<dyn Fn(UiEvent) + Send + 'static>;

/// The serve loop's handle on the UI thread.
pub struct UiHandle {
    tx: Sender<UiCommand>,
    ctx: Arc<Mutex<Option<egui::Context>>>,
    thread: Option<JoinHandle<()>>,
}

impl UiHandle {
    /// Push a command and wake the UI.
    pub fn send(&self, cmd: UiCommand) {
        let _ = self.tx.send(cmd);
        if let Some(c) = self.ctx.lock().ok().and_then(|g| g.clone()) {
            c.request_repaint();
        }
    }

    /// Wait up to `timeout` for the UI thread to finish (after `Ended`). `true` if it did.
    pub fn wait_closed(mut self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.thread.as_ref().is_none_or(|t| t.is_finished()) {
                if let Some(t) = self.thread.take() {
                    let _ = t.join();
                }
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }
}

/// Start the UI thread with the consent window open.
pub fn spawn(req: ConsentRequest, emit: Emit) -> UiHandle {
    // apple-owned: begin
    // Phase F §17.2: AppKit runs only on the main thread, so on macOS the window is run by the
    // main-thread host (`macos_main_thread_host`) rather than on a thread of its own.
    #[cfg(target_os = "macos")]
    if mac_host::enabled() {
        return mac_host::spawn(req, emit);
    }
    // apple-owned: end
    let (tx, rx) = channel();
    let ctx_slot: Arc<Mutex<Option<egui::Context>>> = Arc::new(Mutex::new(None));
    let slot = ctx_slot.clone();
    let thread = std::thread::Builder::new()
        .name("ia-ui".into())
        .spawn(move || {
            let emit: Rc<Emit> = Rc::new(emit);
            let app_emit = emit.clone();
            let options = eframe::NativeOptions {
                viewport: ViewportBuilder::default()
                    .with_title(CONSENT_TITLE)
                    .with_inner_size([520.0, 720.0])
                    .with_resizable(false)
                    .with_maximize_button(false)
                    .with_minimize_button(false)
                    .with_window_level(WindowLevel::AlwaysOnTop)
                    .with_active(true),
                centered: true,
                renderer: eframe::Renderer::Glow,
                event_loop_builder: Some(Box::new(|b| {
                    #[cfg(windows)]
                    {
                        use winit::platform::windows::EventLoopBuilderExtWindows;
                        b.with_any_thread(true);
                    }
                    // Phase E §7.2: the X11 backend, on this dedicated thread too.
                    #[cfg(target_os = "linux")]
                    {
                        use winit::platform::x11::EventLoopBuilderExtX11;
                        b.with_any_thread(true);
                    }
                    // apple-owned: begin
                    // Phase F §17.2: the AppKit event loop (apple stream); nothing yet.
                    #[cfg(target_os = "macos")]
                    let _ = b;
                    // apple-owned: end
                    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
                    let _ = b;
                })),
                ..Default::default()
            };
            let result = eframe::run_native(
                CONSENT_TITLE,
                options,
                Box::new(move |cc| {
                    if let Ok(mut g) = slot.lock() {
                        *g = Some(cc.egui_ctx.clone());
                    }
                    Ok(Box::new(IaApp::new(req, rx, app_emit)))
                }),
            );
            match result {
                Ok(()) => emit(UiEvent::Closed),
                Err(e) => emit(UiEvent::Failed(e.to_string())),
            }
        })
        .ok();
    UiHandle {
        tx,
        ctx: ctx_slot,
        thread,
    }
}

// apple-owned: begin
/// Phase F §17.2: run the UI on the main thread of a macOS agent. Call [`macos_main_thread_enable`]
/// before the agent's work moves to another thread, then [`macos_main_thread_host`] on the main
/// thread: every [`spawn`] from then on hands its window to the host, and `UiHandle` keeps its
/// shape (its `thread` is a watcher that ends when the window does).
#[cfg(target_os = "macos")]
pub fn macos_main_thread_enable() {
    mac_host::enable();
}

/// Phase F §17.2: run UI windows on this (the main) thread until `done()` holds.
#[cfg(target_os = "macos")]
pub fn macos_main_thread_host(done: impl Fn() -> bool) {
    mac_host::host(done);
}

#[cfg(target_os = "macos")]
mod mac_host {
    use std::rc::Rc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::Duration;

    use eframe::egui::{self, ViewportBuilder, WindowLevel};

    use super::{ConsentRequest, Emit, IaApp, UiEvent, UiHandle, CONSENT_TITLE};

    type Job = Box<dyn FnOnce() + Send>;
    type Queue = (Sender<Job>, Mutex<Option<Receiver<Job>>>);

    static ENABLED: AtomicBool = AtomicBool::new(false);
    static QUEUE: OnceLock<Queue> = OnceLock::new();

    fn queue() -> &'static Queue {
        QUEUE.get_or_init(|| {
            let (tx, rx) = channel();
            (tx, Mutex::new(Some(rx)))
        })
    }

    pub fn enable() {
        let _ = queue();
        ENABLED.store(true, Ordering::SeqCst);
    }

    pub fn enabled() -> bool {
        ENABLED.load(Ordering::SeqCst)
    }

    pub fn host(done: impl Fn() -> bool) {
        let Some(rx) = queue().1.lock().ok().and_then(|mut g| g.take()) else {
            return;
        };
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(job) => job(),
                Err(RecvTimeoutError::Timeout) if done() => return,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    /// [`super::spawn`] on macOS: the same window, run by the main-thread host.
    pub fn spawn(req: ConsentRequest, emit: Emit) -> UiHandle {
        let (tx, rx) = channel();
        let ctx_slot: Arc<Mutex<Option<egui::Context>>> = Arc::new(Mutex::new(None));
        let slot = ctx_slot.clone();
        let (done_tx, done_rx) = channel::<()>();
        let job: Job = Box::new(move || {
            let emit: Rc<Emit> = Rc::new(emit);
            let app_emit = emit.clone();
            let options = eframe::NativeOptions {
                viewport: ViewportBuilder::default()
                    .with_title(CONSENT_TITLE)
                    .with_inner_size([520.0, 720.0])
                    .with_resizable(false)
                    .with_maximize_button(false)
                    .with_minimize_button(false)
                    .with_window_level(WindowLevel::AlwaysOnTop)
                    .with_active(true),
                centered: true,
                renderer: eframe::Renderer::Glow,
                ..Default::default()
            };
            let result = eframe::run_native(
                CONSENT_TITLE,
                options,
                Box::new(move |cc| {
                    if let Ok(mut g) = slot.lock() {
                        *g = Some(cc.egui_ctx.clone());
                    }
                    Ok(Box::new(IaApp::new(req, rx, app_emit)))
                }),
            );
            match result {
                Ok(()) => emit(UiEvent::Closed),
                Err(e) => emit(UiEvent::Failed(e.to_string())),
            }
            let _ = done_tx.send(());
        });
        let _ = queue().0.send(job);
        let thread = std::thread::Builder::new()
            .name("ia-ui-watch".into())
            .spawn(move || {
                let _ = done_rx.recv();
            })
            .ok();
        UiHandle {
            tx,
            ctx: ctx_slot,
            thread,
        }
    }
}
// apple-owned: end

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Consent,
    Live,
    Ended,
}

struct LiveState {
    technician: String,
    org: String,
    started: Instant,
    sas: Option<String>,
    level: AgentConsentLevel,
    clipboard: bool,
    integrity: ElevationLevel,
    monitors: Vec<MonitorInfo>,
    recording: bool,
    recording_is_server: bool,
    file_prompt: Option<(FilePrompt, Instant)>,
    /// The executable warning's first click happened (the second click accepts).
    file_confirm_armed: bool,
    level_prompt: Option<(String, Instant, u64)>,
    chat: Vec<(bool, String)>,
    unread: bool,
    chat_input: String,
    toast: Option<(String, Instant)>,
    notes: Vec<String>,
    stopping: bool,
    refusal_hint: Option<Instant>,
    voice_available: bool,
    mic_muted: bool,
    technician_talking: bool,
}

impl LiveState {
    fn empty() -> Self {
        Self {
            technician: String::new(),
            org: String::new(),
            started: Instant::now(),
            sas: None,
            level: AgentConsentLevel::Control,
            clipboard: false,
            integrity: ElevationLevel::User,
            monitors: Vec::new(),
            recording: false,
            recording_is_server: false,
            file_prompt: None,
            file_confirm_armed: false,
            level_prompt: None,
            chat: Vec::new(),
            unread: false,
            chat_input: String::new(),
            toast: None,
            notes: Vec::new(),
            stopping: false,
            refusal_hint: None,
            voice_available: false,
            mic_muted: true,
            technician_talking: false,
        }
    }

    fn pill(&self) -> PillModel {
        PillModel {
            technician: self.technician.clone(),
            org: self.org.clone(),
            elapsed_secs: self.started.elapsed().as_secs(),
            sas_display: self
                .sas
                .as_deref()
                .map(|s| {
                    if s.len() == 6 {
                        format!("{} {}", &s[..3], &s[3..])
                    } else {
                        s.to_string()
                    }
                })
                .unwrap_or_else(|| "--- ---".into()),
            recording: self.recording,
            recording_is_server: self.recording_is_server,
            integrity: self.integrity,
            level: self.level,
        }
    }
}

struct IaApp {
    rx: Receiver<UiCommand>,
    emit: Rc<Emit>,
    phase: Phase,
    req: ConsentRequest,
    consent: ConsentModel,
    consent_started: Instant,
    answered: bool,
    live: LiveState,
    panel_open: bool,
    panel_was_focused: bool,
    guard: Option<Guard>,
    tray: Option<Tray>,
    /// Whether a tray icon was already tried this session. Linux tries once (§7.3b: no
    /// StatusNotifierWatcher means no tray, and asking the bus every frame would be waste);
    /// Windows keeps retrying until the shell's notification area is up.
    tray_attempted: bool,
    pill_hwnd: Option<isize>,
    panel_hwnd: Option<isize>,
    morph_at: Option<Instant>,
    last_housekeeping: Instant,
    /// Phase E rule 7.3c: the 750 ms post-map input gate (applied on Linux).
    map_gate: crate::model::MapGate,
    /// Whether the panel was open last frame (its opening re-arms the gate).
    panel_was_open: bool,
    /// Linux: the X11 window treatment of the pill (EWMH) and the pill's window id.
    #[cfg(target_os = "linux")]
    x11: Option<crate::x11help::X11Help>,
    #[cfg(target_os = "linux")]
    pill_x11: Option<u32>,
    ended_at: Option<Instant>,
    ended_lines: Vec<String>,
    beeped: bool,
    /// Dev builds only (`IA_DEV_UI_AUTOPILOT=1`): drive the windows without a mouse, for a
    /// locked or headless verification host. Never compiled into a release build.
    #[cfg(feature = "dev")]
    autopilot: bool,
}

impl IaApp {
    fn new(req: ConsentRequest, rx: Receiver<UiCommand>, emit: Rc<Emit>) -> Self {
        let consent = ConsentModel::new(&req.technician, &req.org, req.monitors.clone());
        Self {
            rx,
            emit,
            phase: Phase::Consent,
            req,
            consent,
            consent_started: Instant::now(),
            answered: false,
            live: LiveState::empty(),
            panel_open: false,
            panel_was_focused: false,
            guard: None,
            tray: None,
            tray_attempted: false,
            map_gate: {
                // The consent window is mapped now.
                let mut g = crate::model::MapGate::default();
                g.mapped(Instant::now());
                g
            },
            panel_was_open: false,
            #[cfg(target_os = "linux")]
            x11: None,
            #[cfg(target_os = "linux")]
            pill_x11: None,
            pill_hwnd: None,
            panel_hwnd: None,
            morph_at: None,
            last_housekeeping: Instant::now(),
            ended_at: None,
            ended_lines: Vec::new(),
            beeped: false,
            #[cfg(feature = "dev")]
            autopilot: std::env::var_os("IA_DEV_UI_AUTOPILOT").is_some(),
        }
    }

    fn emit(&self, e: UiEvent) {
        (self.emit)(e);
    }

    /// Rule 7.3c (Linux): whether input is ignored right now because an agent surface was mapped
    /// less than 750 ms ago. Windows relies on its hooks and the physical-press gate instead.
    fn input_gated(&self) -> bool {
        cfg!(target_os = "linux") && !self.map_gate.accepts_input(Instant::now())
    }

    /// Linux: record a pointer press that reached this viewport as physical (rule 7.3c: the
    /// X11 sink never injects onto an agent window), unless the post-map gate is closed.
    fn note_presses(&self, ctx: &egui::Context) {
        #[cfg(target_os = "linux")]
        if !self.input_gated() && ctx.input(|i| i.pointer.any_pressed()) {
            crate::guard::note_physical_press();
        }
        #[cfg(not(target_os = "linux"))]
        let _ = ctx;
    }

    fn physical_ok(&self) -> bool {
        self.guard
            .as_ref()
            .is_some_and(|g| g.physical_press_recent(PHYSICAL_WINDOW))
    }

    /// A grant-direction control was clicked: act only on physical input (§3.5).
    fn grant(&mut self) -> bool {
        let ok = prompt_allowed(PromptDirection::Grant, self.physical_ok());
        if !ok {
            tracing::warn!("grant-direction click without a physical press: ignored");
            self.live.refusal_hint = Some(Instant::now());
        }
        ok
    }

    // ---- commands from the serve loop ------------------------------------------------------

    fn drain(&mut self, ctx: &egui::Context) {
        while let Ok(cmd) = self.rx.try_recv() {
            match cmd {
                UiCommand::Live {
                    technician,
                    org,
                    level,
                    clipboard,
                    monitors,
                    recording,
                    recording_is_server,
                } => {
                    self.live.technician = technician;
                    self.live.org = org;
                    self.live.level = level;
                    self.live.clipboard = clipboard;
                    self.live.monitors = monitors;
                    self.live.recording = recording;
                    self.live.recording_is_server = recording_is_server;
                    if self.phase == Phase::Consent {
                        self.enter_live(ctx);
                    }
                }
                UiCommand::Sas(s) => {
                    self.live.sas = Some(s);
                    if !self.beeped {
                        self.beeped = true;
                        #[cfg(windows)]
                        crate::winhelp::beep();
                    }
                }
                UiCommand::Level {
                    level,
                    clipboard,
                    integrity,
                } => {
                    self.live.level = level;
                    self.live.clipboard = clipboard;
                    self.live.integrity = integrity;
                }
                UiCommand::Recording { on, server } => {
                    self.live.recording = on;
                    self.live.recording_is_server = server;
                }
                UiCommand::FilePrompt(p) => {
                    self.live.file_prompt = Some((p, Instant::now()));
                    self.live.file_confirm_armed = false;
                    self.panel_open = true;
                    // Rule 7.3c: a new prompt card ignores input for 750 ms.
                    self.map_gate.mapped(Instant::now());
                }
                UiCommand::FileClosed { file_id, outcome } => {
                    if self
                        .live
                        .file_prompt
                        .as_ref()
                        .is_some_and(|(p, _)| p.file_id == file_id)
                    {
                        self.live.file_prompt = None;
                    }
                    self.note(outcome);
                }
                UiCommand::LevelPrompt {
                    reason,
                    timeout_secs,
                } => {
                    self.live.level_prompt = Some((reason, Instant::now(), timeout_secs));
                    self.panel_open = true;
                    self.map_gate.mapped(Instant::now());
                }
                UiCommand::LevelPromptClosed => self.live.level_prompt = None,
                UiCommand::Chat {
                    from_technician,
                    text,
                } => {
                    #[cfg(feature = "dev")]
                    if from_technician && self.autopilot {
                        if let Some(cmd) = text.strip_prefix("ia-autopilot: ") {
                            self.autopilot_command(ctx, cmd.trim());
                        }
                    }
                    if from_technician && !self.panel_open {
                        let first: String = text.chars().take(60).collect();
                        self.live.toast =
                            Some((format!("{}: {first}", self.live.technician), Instant::now()));
                        self.live.unread = true;
                    }
                    self.live.chat.push((from_technician, text));
                    if self.live.chat.len() > 200 {
                        self.live.chat.remove(0);
                    }
                }
                UiCommand::Toast(t) => self.live.toast = Some((t, Instant::now())),
                UiCommand::Voice { available, muted } => {
                    self.live.voice_available = available;
                    self.live.mic_muted = muted;
                }
                UiCommand::TechnicianVoice { muted } => self.live.technician_talking = !muted,
                UiCommand::Ended { lines } => self.enter_ended(ctx, lines),
            }
        }
    }

    fn note(&mut self, s: String) {
        self.live.notes.push(s);
        if self.live.notes.len() > 4 {
            self.live.notes.remove(0);
        }
    }

    fn enter_live(&mut self, ctx: &egui::Context) {
        self.phase = Phase::Live;
        self.live.started = Instant::now();
        self.guard = Some(Guard::install());
        ctx.send_viewport_cmd(ViewportCommand::Title(PILL_TITLE.into()));
        ctx.send_viewport_cmd(ViewportCommand::Decorations(false));
        ctx.send_viewport_cmd(ViewportCommand::Resizable(false));
        ctx.send_viewport_cmd(ViewportCommand::InnerSize(vec2(PILL_W, PILL_H)));
        ctx.send_viewport_cmd(ViewportCommand::WindowLevel(WindowLevel::AlwaysOnTop));
        #[cfg(windows)]
        let protect = crate::winhelp::capture_exclusion_enabled();
        #[cfg(not(windows))]
        let protect = true;
        ctx.send_viewport_cmd(ViewportCommand::ContentProtected(protect));
        self.morph_at = Some(Instant::now());
        self.map_gate.mapped(Instant::now());
        self.pill_hwnd = None;
    }

    fn enter_ended(&mut self, ctx: &egui::Context, lines: Vec<String>) {
        self.phase = Phase::Ended;
        self.panel_open = false;
        self.tray = None;
        self.guard = None;
        self.ended_at = Some(Instant::now());
        self.ended_lines = lines;
        #[cfg(windows)]
        if let Some(h) = self.pill_hwnd {
            crate::winhelp::unstyle_pill(h);
        }
        ctx.send_viewport_cmd(ViewportCommand::Title(ENDED_TITLE.into()));
        ctx.send_viewport_cmd(ViewportCommand::Decorations(true));
        ctx.send_viewport_cmd(ViewportCommand::WindowLevel(WindowLevel::Normal));
        ctx.send_viewport_cmd(ViewportCommand::ContentProtected(false));
        ctx.send_viewport_cmd(ViewportCommand::InnerSize(vec2(440.0, 320.0)));
    }

    // ---- consent window ----------------------------------------------------------------------

    fn decline(&mut self, ctx: &egui::Context) {
        if !self.answered {
            self.answered = true;
            self.emit(UiEvent::ConsentDeclined);
        }
        ctx.send_viewport_cmd(ViewportCommand::Close);
    }

    fn consent_ui(&mut self, ctx: &egui::Context) {
        let remaining = self
            .req
            .deadline_secs
            .saturating_sub(self.consent_started.elapsed().as_secs());
        if remaining == 0 || ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
            self.decline(ctx);
            return;
        }
        let mut share = false;
        let mut decline = false;
        let gated = self.input_gated();
        egui::CentralPanel::default().show(ctx, |ui| {
            if gated {
                ui.disable();
            }
            ui.add_space(6.0);
            ui.heading("Share your screen?");
            ui.add_space(8.0);
            ui.label(
                RichText::new(format!(
                    "{} from {} wants to see and control this computer.",
                    self.req.technician, self.req.org
                ))
                .size(16.0),
            );
            ui.add_space(4.0);
            ui.label(format!("Connecting through {}", self.req.api_host));
            for w in &self.req.warnings {
                ui.colored_label(Color32::from_rgb(230, 190, 40), w);
            }
            // apple-owned: begin
            // Phase F §17.2: the two macOS permission steps (Screen Recording, Accessibility).
            #[cfg(target_os = "macos")]
            crate::tray::tcc_steps(ui);
            // apple-owned: end
            ui.separator();
            ui.label(RichText::new("Screens to share").strong());
            for m in &mut self.consent.monitors {
                let label = format!(
                    "{} ({} x {}){}",
                    m.info.name,
                    m.info.width,
                    m.info.height,
                    if m.info.primary { ", primary" } else { "" }
                );
                ui.checkbox(&mut m.checked, label);
            }
            if !self.consent.monitors.iter().any(|m| m.checked) {
                ui.colored_label(
                    Color32::from_rgb(230, 120, 60),
                    "Choose at least one screen.",
                );
            }
            ui.add_space(6.0);
            ui.label(RichText::new("What the technician may do").strong());
            ui.radio_value(
                &mut self.consent.level,
                AgentConsentLevel::View,
                "View only",
            );
            ui.radio_value(
                &mut self.consent.level,
                AgentConsentLevel::Control,
                "View and control (mouse and keyboard)",
            );
            if self.consent.level == AgentConsentLevel::Control {
                ui.label(
                    RichText::new(
                        "The technician can click and type as you. Windows will still ask you \
                         before anything needs administrator rights.",
                    )
                    .small(),
                );
            } else {
                self.consent.clipboard = false;
            }
            ui.add_space(6.0);
            ui.add_enabled(
                self.consent.level == AgentConsentLevel::Control,
                egui::Checkbox::new(
                    &mut self.consent.clipboard,
                    "Share clipboard text both ways",
                ),
            );
            if let Some(rec) = &self.req.recording_sentence {
                ui.add_space(6.0);
                ui.colored_label(Color32::from_rgb(230, 80, 80), rec);
            }
            ui.separator();
            ui.checkbox(
                &mut self.consent.privacy_ack,
                "I have closed or hidden anything private",
            );
            ui.add_space(10.0);
            ui.horizontal(|ui| {
                let can = self.consent.can_share();
                let b = egui::Button::new(RichText::new("Share my screen").strong().size(16.0))
                    .fill(Color32::from_rgb(30, 110, 200))
                    .min_size(vec2(180.0, 40.0));
                if ui.add_enabled(can, b).clicked() {
                    share = true;
                }
                if ui
                    .add(
                        egui::Button::new(RichText::new("Decline").size(16.0))
                            .min_size(vec2(120.0, 40.0)),
                    )
                    .clicked()
                {
                    decline = true;
                }
            });
            ui.add_space(6.0);
            ui.label(
                RichText::new(format!(
                    "This request is declined automatically in {}:{:02}.",
                    remaining / 60,
                    remaining % 60
                ))
                .small(),
            );
        });
        // apple-owned: begin
        // Phase F §17.2: the "How to allow" guide beside System Settings while a grant is missing.
        #[cfg(target_os = "macos")]
        crate::tray::tcc_guide(ctx);
        // apple-owned: end
        if decline {
            self.decline(ctx);
        } else if share {
            self.share(ctx);
        }
    }

    fn share(&mut self, ctx: &egui::Context) {
        {
            if let Some(payload) = self.consent.payload() {
                self.answered = true;
                self.live.technician = self.req.technician.clone();
                self.live.org = self.req.org.clone();
                self.live.level = payload.level;
                self.live.clipboard = payload.clipboard;
                self.live.monitors = self
                    .consent
                    .monitors
                    .iter()
                    .filter(|m| m.checked)
                    .map(|m| m.info.clone())
                    .collect();
                self.emit(UiEvent::ConsentGranted(payload));
                self.enter_live(ctx);
            }
        }
    }

    // ---- pill ----------------------------------------------------------------------------------

    fn pill_ui(&mut self, ctx: &egui::Context) {
        let pill = self.live.pill();
        let frame = egui::Frame::none().fill(Color32::from_rgb(24, 28, 36));
        let mut toggle_panel = false;
        let mut start_drag = false;
        let mut stop = false;
        let mut mic_clicked = false;
        let mic = mic_label(self.live.voice_available, self.live.mic_muted);
        let gated = self.input_gated();
        egui::CentralPanel::default().frame(frame).show(ctx, |ui| {
            if gated {
                ui.disable();
            }
            let full = ui.max_rect();
            let stop_rect =
                Rect::from_min_size(pos2(full.right() - 64.0, full.top()), vec2(64.0, PILL_H));
            let mic_rect = Rect::from_min_size(
                pos2(
                    stop_rect.left() - if mic.is_some() { 58.0 } else { 0.0 },
                    full.top(),
                ),
                vec2(56.0, PILL_H),
            );
            let body_right = if mic.is_some() {
                mic_rect.left()
            } else {
                stop_rect.left()
            };
            let body_rect = Rect::from_min_max(full.min, pos2(body_right - 2.0, full.bottom()));
            if let Some(label) = mic {
                let fill = if self.live.mic_muted {
                    Color32::from_rgb(60, 66, 78)
                } else {
                    Color32::from_rgb(30, 130, 70)
                };
                let btn = egui::Button::new(RichText::new(label).size(13.0).color(Color32::WHITE))
                    .fill(fill)
                    .rounding(0.0);
                if ui.put(mic_rect, btn).clicked() {
                    mic_clicked = true;
                }
            }
            let body = ui.interact(body_rect, Id::new("ia-pill-body"), Sense::click_and_drag());
            if body.clicked() {
                toggle_panel = true;
            }
            if body.drag_started() {
                start_drag = true;
            }
            let painter = ui.painter_at(body_rect);
            let x = body_rect.left() + 10.0;
            let toast = self
                .live
                .toast
                .as_ref()
                .filter(|(_, at)| at.elapsed() < Duration::from_secs(4))
                .map(|(t, _)| t.clone());
            let prompt_pending =
                self.live.file_prompt.is_some() || self.live.level_prompt.is_some();
            let (line1, colour1) = if prompt_pending {
                (
                    "Action needed: click here to answer".to_string(),
                    Color32::from_rgb(240, 180, 40),
                )
            } else if self.live.stopping {
                ("Stopping...".to_string(), Color32::LIGHT_GRAY)
            } else if let Some(t) = toast {
                (t, Color32::from_rgb(140, 200, 255))
            } else {
                (pill.face_text(), Color32::WHITE)
            };
            painter.text(
                pos2(x, body_rect.top() + 12.0),
                Align2::LEFT_CENTER,
                line1,
                FontId::proportional(13.0),
                colour1,
            );
            let mut line2 = format!(
                "{}   {}   {}",
                pill.security_code_line(),
                pill.timer_text(),
                pill.chip()
            );
            if pill.show_shield() {
                line2.push_str("   [admin]");
            }
            if self.live.unread {
                line2.push_str("   new message");
            }
            if self.live.technician_talking {
                line2.push_str("   technician mic on");
            }
            painter.text(
                pos2(x, body_rect.top() + 31.0),
                Align2::LEFT_CENTER,
                line2,
                FontId::proportional(13.0),
                Color32::from_rgb(200, 210, 220),
            );
            if let Some(rec) = pill.recording_label() {
                let rx = body_rect.right() - 8.0;
                painter.text(
                    pos2(rx, body_rect.top() + 12.0),
                    Align2::RIGHT_CENTER,
                    rec,
                    FontId::proportional(12.0),
                    Color32::from_rgb(255, 90, 90),
                );
                let w = 7.5 * rec.len() as f32;
                painter.circle_filled(
                    pos2(rx - w - 6.0, body_rect.top() + 12.0),
                    5.0,
                    Color32::from_rgb(230, 30, 30),
                );
            }
            let stop_btn = egui::Button::new(
                RichText::new("Stop")
                    .strong()
                    .size(15.0)
                    .color(Color32::WHITE),
            )
            .fill(Color32::from_rgb(200, 40, 40))
            .rounding(0.0);
            if ui.put(stop_rect, stop_btn).clicked() {
                stop = true;
            }
        });
        if stop && !self.live.stopping {
            // Safe direction: never gated.
            self.live.stopping = true;
            self.emit(UiEvent::Stop);
        }
        if mic_clicked {
            // Unmuting is a grant (physical press only); muting is always honoured (§3.5, §6.3).
            let unmute = self.live.mic_muted;
            let ok = match mic_direction(unmute) {
                PromptDirection::Safe => true,
                PromptDirection::Grant => self.grant(),
            };
            if ok {
                self.emit(UiEvent::Mic(unmute));
            }
        }
        if toggle_panel {
            self.panel_open = !self.panel_open;
            self.live.unread = false;
        }
        // Dragging the pill is physical-only (§3.5).
        if start_drag && self.physical_ok() {
            ctx.send_viewport_cmd(ViewportCommand::StartDrag);
        }
        if ctx.input(|i| i.viewport().close_requested()) {
            ctx.send_viewport_cmd(ViewportCommand::CancelClose); // never closable
        }
    }

    // ---- panel ---------------------------------------------------------------------------------

    fn panel(&mut self, ctx: &egui::Context) {
        if !self.panel_open {
            self.panel_hwnd = None;
            self.panel_was_focused = false;
            self.panel_was_open = false;
            return;
        }
        if !self.panel_was_open {
            self.panel_was_open = true;
            self.map_gate.mapped(Instant::now());
        }
        let anchor = ctx
            .input(|i| i.viewport().outer_rect)
            .map(|r| pos2(r.left() + 30.0, r.bottom() + 4.0))
            .unwrap_or(pos2(200.0, 60.0));
        let builder = ViewportBuilder::default()
            .with_title(PANEL_TITLE)
            .with_inner_size([PANEL_W, PANEL_H])
            .with_position(anchor)
            .with_decorations(false)
            .with_resizable(false)
            .with_taskbar(false)
            .with_window_level(WindowLevel::AlwaysOnTop);
        ctx.show_viewport_immediate(
            ViewportId::from_hash_of("ia-panel"),
            builder,
            |pctx, _class| {
                self.note_presses(pctx);
                self.panel_body(pctx);
                let (esc, close, focused) = pctx.input(|i| {
                    (
                        i.key_pressed(egui::Key::Escape),
                        i.viewport().close_requested(),
                        i.viewport().focused,
                    )
                });
                let blurred = self.panel_was_focused && focused == Some(false);
                if focused == Some(true) {
                    self.panel_was_focused = true;
                }
                let prompt_pending =
                    self.live.file_prompt.is_some() || self.live.level_prompt.is_some();
                if esc || close || (blurred && !prompt_pending) {
                    self.panel_open = false;
                }
            },
        );
    }

    fn panel_body(&mut self, ctx: &egui::Context) {
        let mut events: Vec<UiEvent> = Vec::new();
        let mut want_grant: Option<UiEvent> = None;
        let mut arm_exe = false;
        let frame = egui::Frame::none()
            .fill(Color32::from_rgb(32, 36, 44))
            .inner_margin(10.0)
            .stroke(egui::Stroke::new(1.0_f32, Color32::from_rgb(70, 80, 95)));
        let gated = self.input_gated();
        egui::CentralPanel::default().frame(frame).show(ctx, |ui| {
            if gated {
                ui.disable();
            }
            ui.horizontal(|ui| {
                ui.label(RichText::new("IndiansAssist").strong());
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("Close").clicked() {
                        self.panel_open = false;
                    }
                });
            });
            let pill = self.live.pill();
            ui.label(pill.face_text());
            ui.label(RichText::new(pill.security_code_line()).monospace().strong());
            if self.live.refusal_hint.is_some_and(|t| t.elapsed() < Duration::from_secs(4)) {
                ui.colored_label(Color32::from_rgb(255, 120, 120), "Use your own mouse to choose this.");
            }
            ui.separator();

            if let Some((reason, at, secs)) = self.live.level_prompt.clone() {
                let left = secs.saturating_sub(at.elapsed().as_secs());
                egui::Frame::group(ui.style()).stroke(egui::Stroke::new(1.5_f32, Color32::from_rgb(240, 180, 40))).show(ui, |ui| {
                    ui.label(format!(
                        "{} asks to control your mouse and keyboard. Reason: {}",
                        self.live.technician, reason
                    ));
                    ui.horizontal(|ui| {
                        if ui.button("Allow").clicked() {
                            want_grant = Some(UiEvent::LevelDecision { allow: true });
                        }
                        if ui.button("Refuse").clicked() {
                            events.push(UiEvent::LevelDecision { allow: false });
                        }
                        ui.label(RichText::new(format!("{left} s")).small());
                    });
                });
                ui.add_space(6.0);
            }

            if let Some((p, at)) = self.live.file_prompt.clone() {
                let left = p.timeout_secs.saturating_sub(at.elapsed().as_secs());
                egui::Frame::group(ui.style()).stroke(egui::Stroke::new(1.5_f32, Color32::from_rgb(240, 180, 40))).show(ui, |ui| {
                    ui.label(format!("{} wants to send you a file", p.sender));
                    ui.label(RichText::new(&p.name).strong());
                    let ext = if p.ext.is_empty() { "(none)".to_string() } else { format!(".{}", p.ext) };
                    ui.label(format!("Type {ext}, declared as {}  |  {}", p.mime, human_size(p.size)));
                    ui.label(RichText::new("Saved to Downloads\\IndiansAssist. It is never opened for you.").small());
                    if p.executable {
                        ui.colored_label(
                            Color32::from_rgb(255, 90, 90),
                            "This is a program or script. It could change or harm this computer. Accept it only if you asked for it.",
                        );
                    }
                    ui.horizontal(|ui| {
                        let label = if p.executable && self.live.file_confirm_armed { "Accept anyway" } else { "Accept" };
                        if ui.button(label).clicked() {
                            if p.executable && !self.live.file_confirm_armed {
                                arm_exe = true;
                            } else {
                                want_grant = Some(UiEvent::FileDecision { file_id: p.file_id, accept: true });
                            }
                        }
                        if ui.button("Decline").clicked() {
                            events.push(UiEvent::FileDecision { file_id: p.file_id, accept: false });
                        }
                        ui.label(RichText::new(format!("{left} s")).small());
                    });
                });
                ui.add_space(6.0);
            }

            ui.label(RichText::new("Shared screens").strong());
            for m in &self.live.monitors {
                ui.label(format!("{} ({} x {})", m.name, m.width, m.height));
            }
            ui.add_space(4.0);
            ui.label(RichText::new(level_chip(self.live.level, self.live.integrity)).strong());
            ui.horizontal(|ui| {
                let view = self.live.level == AgentConsentLevel::View;
                if ui.radio(view, "View only").clicked() && !view {
                    events.push(UiEvent::SetLevel(AgentConsentLevel::View));
                }
                if ui.radio(!view, "Allow control").clicked() && view {
                    want_grant = Some(UiEvent::SetLevel(AgentConsentLevel::Control));
                }
            });
            let mut clip = self.live.clipboard;
            let can_clip = self.live.level != AgentConsentLevel::View;
            if ui
                .add_enabled(can_clip, egui::Checkbox::new(&mut clip, "Share clipboard text both ways"))
                .changed()
            {
                if clip {
                    want_grant = Some(UiEvent::Clipboard(true));
                } else {
                    events.push(UiEvent::Clipboard(false));
                }
            }
            ui.separator();
            ui.label(RichText::new("Chat").strong());
            egui::ScrollArea::vertical().max_height(120.0).stick_to_bottom(true).show(ui, |ui| {
                for (from_tech, text) in &self.live.chat {
                    let who = if *from_tech { self.live.technician.as_str() } else { "You" };
                    // Text is drawn as text: egui interprets no markup (§6.2).
                    ui.label(format!("{who}: {text}"));
                }
            });
            ui.horizontal(|ui| {
                let resp = ui.add(egui::TextEdit::singleline(&mut self.live.chat_input).desired_width(250.0).hint_text("Message"));
                let enter = resp.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                if (ui.button("Send").clicked() || enter) && !self.live.chat_input.trim().is_empty() {
                    let text: String = self.live.chat_input.trim().chars().take(4000).collect();
                    self.live.chat_input.clear();
                    events.push(UiEvent::ChatSend(text));
                }
            });
            for n in &self.live.notes {
                ui.label(RichText::new(n).small());
            }
            ui.with_layout(egui::Layout::bottom_up(egui::Align::Min), |ui| {
                ui.horizontal(|ui| {
                    let stop = egui::Button::new(RichText::new("Stop sharing").color(Color32::WHITE)).fill(Color32::from_rgb(200, 40, 40));
                    if ui.add(stop).clicked() {
                        events.push(UiEvent::Stop);
                    }
                    if ui.button("Revoke consent").clicked() {
                        events.push(UiEvent::Revoke);
                    }
                });
            });
        });
        if arm_exe && self.grant() {
            self.live.file_confirm_armed = true;
        }
        if let Some(e) = want_grant {
            if self.grant() {
                events.push(e);
            }
        }
        for e in events {
            match &e {
                UiEvent::Stop => {
                    if self.live.stopping {
                        continue;
                    }
                    self.live.stopping = true;
                }
                UiEvent::LevelDecision { .. } => self.live.level_prompt = None,
                UiEvent::FileDecision { .. } => self.live.file_prompt = None,
                UiEvent::ChatSend(t) => self.live.chat.push((false, t.clone())),
                _ => {}
            }
            self.emit(e);
        }
    }

    // ---- ended view ----------------------------------------------------------------------------

    fn ended_ui(&mut self, ctx: &egui::Context) {
        let mut close = false;
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("Session ended");
            ui.add_space(6.0);
            for l in &self.ended_lines {
                ui.label(l);
            }
            ui.add_space(10.0);
            if ui.button("Close").clicked() {
                close = true;
            }
        });
        let timed_out = self
            .ended_at
            .is_some_and(|t| t.elapsed() > Duration::from_secs(20));
        if close || timed_out {
            ctx.send_viewport_cmd(ViewportCommand::Close);
        }
    }

    // ---- tray + Win32 housekeeping ----------------------------------------------------------------

    fn tray_tick(&mut self, ctx: &egui::Context) {
        if self.phase != Phase::Live {
            return;
        }
        let state = TrayState::Sharing {
            technician: self.live.technician.clone(),
            recording: self.live.recording,
            elevated: self.live.integrity == ElevationLevel::Admin,
        };
        if self.tray.is_none() && (cfg!(windows) || !self.tray_attempted) {
            self.tray_attempted = true;
            self.tray = Tray::new(state.clone());
        }
        let actions = match self.tray.as_mut() {
            Some(t) => {
                t.set_state(state);
                t.poll()
            }
            None => Vec::new(),
        };
        for a in actions {
            match a {
                TrayAction::TogglePanel => self.panel_open = !self.panel_open,
                TrayAction::Show => self.panel_open = true,
                TrayAction::ViewOnly => {
                    if self.live.level != AgentConsentLevel::View {
                        self.emit(UiEvent::SetLevel(AgentConsentLevel::View));
                    }
                }
                TrayAction::Stop | TrayAction::Quit => {
                    if !self.live.stopping {
                        self.live.stopping = true;
                        self.emit(UiEvent::Stop);
                    }
                }
            }
        }
        let _ = ctx;
    }

    #[cfg(windows)]
    fn housekeeping(&mut self, _ctx: &egui::Context) {
        use crate::winhelp;
        if self.phase != Phase::Live {
            return;
        }
        // Style the pill once the morph has been applied by winit (a few frames later).
        if self.pill_hwnd.is_none()
            && self
                .morph_at
                .is_some_and(|t| t.elapsed() > Duration::from_millis(250))
        {
            if let Some(h) = winhelp::find_own_window(PILL_TITLE) {
                winhelp::style_pill(h);
                winhelp::dock_top_centre(h);
                tracing::info!(
                    rect = ?winhelp::window_rect(h),
                    excluded = winhelp::capture_exclusion_enabled(),
                    "pill styled (topmost, tool window, no-activate) and docked top-centre"
                );
                self.pill_hwnd = Some(h);
                self.last_housekeeping = Instant::now();
            }
        }
        if self.panel_open && self.panel_hwnd.is_none() {
            if let Some(h) = winhelp::find_own_window(PANEL_TITLE) {
                winhelp::style_panel(h);
                tracing::info!(rect = ?winhelp::window_rect(h), "panel opened and styled");
                self.panel_hwnd = Some(h);
            }
        }
        if self.last_housekeeping.elapsed() >= Duration::from_secs(2) {
            self.last_housekeeping = Instant::now();
            if let Some(h) = self.pill_hwnd {
                winhelp::reassert_topmost(h);
                winhelp::exclude_from_capture(h);
                if winhelp::is_offscreen(h) {
                    winhelp::dock_top_centre(h);
                }
            }
            if let Some(h) = self.panel_hwnd {
                winhelp::reassert_topmost(h);
                winhelp::exclude_from_capture(h);
            }
        }
    }

    /// Phase E §7.2 / §7.3b: the pill on X11. Once the morph has been applied it is marked a
    /// utility window and the window manager is asked for above / skip-taskbar / skip-pager;
    /// every 2 s that is re-asserted with `AlwaysOnTop`, and the pill is re-shown if something
    /// unmapped it (the pill stays mandatory).
    #[cfg(target_os = "linux")]
    fn housekeeping(&mut self, ctx: &egui::Context) {
        if self.phase != Phase::Live {
            return;
        }
        if self.x11.is_none()
            && self
                .morph_at
                .is_some_and(|t| t.elapsed() > Duration::from_millis(250))
        {
            self.x11 = crate::x11help::X11Help::connect();
        }
        if let (None, Some(x)) = (self.pill_x11, self.x11.as_ref()) {
            if let Some(w) = x.find_own_window(PILL_TITLE) {
                x.style_pill(w);
                tracing::info!(window = w, "pill styled (utility, above, skip-taskbar)");
                self.pill_x11 = Some(w);
                self.last_housekeeping = Instant::now();
            }
        }
        if self.last_housekeeping.elapsed() >= Duration::from_secs(2) {
            self.last_housekeeping = Instant::now();
            ctx.send_viewport_cmd(ViewportCommand::WindowLevel(WindowLevel::AlwaysOnTop));
            if let (Some(w), Some(x)) = (self.pill_x11, self.x11.as_ref()) {
                x.reassert(w);
                if !x.is_viewable(w) {
                    tracing::warn!("the pill was unmapped; showing it again");
                    ctx.send_viewport_cmd(ViewportCommand::Visible(true));
                    ctx.send_viewport_cmd(ViewportCommand::Minimized(false));
                    self.map_gate.mapped(Instant::now());
                }
            }
        }
    }

    // apple-owned: begin
    /// Phase F §17.2: the pill on macOS. The window level (above other windows) and the capture
    /// exclusion (an `SCContentFilter` that leaves the agent's own windows out of the stream,
    /// the macOS `WDA_EXCLUDEFROMCAPTURE`) are applied here by the apple stream; empty until then.
    #[cfg(target_os = "macos")]
    fn housekeeping(&mut self, _ctx: &egui::Context) {
        if self.last_housekeeping.elapsed() >= Duration::from_secs(2) {
            self.last_housekeeping = Instant::now();
        }
    }
    // apple-owned: end

    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    fn housekeeping(&mut self, _ctx: &egui::Context) {}
}

impl eframe::App for IaApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // §6.2 `auto_grant`: go straight to the pill on the first frame, so an unattended
        // session never flashes a consent form at a machine with nobody in front of it. The
        // pill, the tray icon and the input guard are installed by the same `enter_live` the
        // consent path uses, so an unattended session is indicated exactly like an attended one.
        if self.req.start_live && self.phase == Phase::Consent {
            self.enter_live(ctx);
        }
        self.drain(ctx);
        self.note_presses(ctx);
        #[cfg(feature = "dev")]
        self.autopilot_tick(ctx);
        match self.phase {
            Phase::Consent => {
                if ctx.input(|i| i.viewport().close_requested()) {
                    self.decline(ctx); // closing the window = Decline (§3.3)
                } else {
                    self.consent_ui(ctx);
                }
            }
            Phase::Live => {
                self.expire_prompts();
                self.pill_ui(ctx);
                self.panel(ctx);
                self.tray_tick(ctx);
                self.housekeeping(ctx);
            }
            Phase::Ended => self.ended_ui(ctx),
        }
        ctx.request_repaint_after(Duration::from_millis(250));
    }

    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        if self.phase == Phase::Consent && !self.answered {
            self.answered = true;
            self.emit(UiEvent::ConsentDeclined);
        }
    }
}

#[cfg(feature = "dev")]
impl IaApp {
    /// The autopilot answers what a person would click, 2 s after each prompt appears. It
    /// emits the same events the buttons emit (bypassing only the physical-press gate).
    fn autopilot_tick(&mut self, ctx: &egui::Context) {
        if !self.autopilot {
            return;
        }
        let two = Duration::from_secs(2);
        match self.phase {
            Phase::Consent => {
                if !self.answered && self.consent_started.elapsed() > two {
                    tracing::info!(
                        "ui autopilot: ticking the privacy box and pressing Share my screen"
                    );
                    self.consent.privacy_ack = true;
                    self.share(ctx);
                }
            }
            Phase::Live => {
                if let Some((p, at)) = self.live.file_prompt.clone() {
                    if at.elapsed() > two {
                        tracing::info!(
                            file_id = p.file_id,
                            executable = p.executable,
                            "ui autopilot: accepting the file prompt"
                        );
                        self.live.file_prompt = None;
                        self.emit(UiEvent::FileDecision {
                            file_id: p.file_id,
                            accept: true,
                        });
                    }
                }
                if let Some((_, at, _)) = self.live.level_prompt.clone() {
                    if at.elapsed() > two {
                        tracing::info!("ui autopilot: allowing the level request");
                        self.live.level_prompt = None;
                        self.emit(UiEvent::LevelDecision { allow: true });
                    }
                }
            }
            Phase::Ended => {
                if self
                    .ended_at
                    .is_some_and(|t| t.elapsed() > Duration::from_secs(3))
                {
                    tracing::info!("ui autopilot: closing the ended view");
                    ctx.send_viewport_cmd(ViewportCommand::Close);
                }
            }
        }
    }

    fn autopilot_command(&mut self, _ctx: &egui::Context, cmd: &str) {
        tracing::info!(cmd, "ui autopilot: command");
        match cmd {
            "panel" => self.panel_open = !self.panel_open,
            "view" => self.emit(UiEvent::SetLevel(AgentConsentLevel::View)),
            "control" => self.emit(UiEvent::SetLevel(AgentConsentLevel::Control)),
            "clipboard on" => self.emit(UiEvent::Clipboard(true)),
            "clipboard off" => self.emit(UiEvent::Clipboard(false)),
            "chat" => {
                self.live.chat.push((false, "Hello from the Desk".into()));
                self.emit(UiEvent::ChatSend("Hello from the Desk".into()));
            }
            "stop" => {
                self.live.stopping = true;
                self.emit(UiEvent::Stop);
            }
            "revoke" => self.emit(UiEvent::Revoke),
            "mic on" => self.emit(UiEvent::Mic(true)),
            "mic off" => self.emit(UiEvent::Mic(false)),
            _ => {}
        }
    }
}

impl IaApp {
    /// The serve loop owns the prompt deadlines; this only hides a card whose time is up so a
    /// late click cannot act on it.
    fn expire_prompts(&mut self) {
        if let Some((_, at)) = &self.live.file_prompt {
            let secs = self
                .live
                .file_prompt
                .as_ref()
                .map(|(p, _)| p.timeout_secs)
                .unwrap_or(60);
            if at.elapsed() > Duration::from_secs(secs + 1) {
                self.live.file_prompt = None;
            }
        }
        if let Some((_, at, secs)) = &self.live.level_prompt {
            if at.elapsed() > Duration::from_secs(secs + 1) {
                self.live.level_prompt = None;
            }
        }
    }
}
