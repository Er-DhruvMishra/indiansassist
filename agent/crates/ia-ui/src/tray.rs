//! The tray icon (contract §3.5): grey "not connected", amber "Waiting for technician", green
//! "Sharing with <technician>", green with a red dot while recording, green with a shield
//! while elevated. Left click toggles the panel; the right-click menu is Show, View only,
//! Stop sharing, Quit (= Stop sharing + exit). Every menu action moves the session in the
//! safe direction (or just shows the panel), so none of them needs a physical-input check.
//!
//! The state, the actions and the icon pixels are pure and shared. The live icon is `tray-icon`
//! on Windows and, on Linux (Phase E §7.3b), a StatusNotifierItem through `ksni` (D-Bus via
//! zbus, no GTK). The Linux tray is **best effort**: when no StatusNotifierWatcher is on the
//! session bus (GNOME without the AppIndicator extension) [`Tray::new`] returns `None`, there
//! is no tray icon, and the pill and panel carry every tray function (W80).

#[cfg(windows)]
pub use win::Tray;

#[cfg(target_os = "linux")]
pub use sni::Tray;

// apple-owned: begin
#[cfg(target_os = "macos")]
pub use mac::{permissions_ui, tcc_guide, tcc_steps, Preflight, Tray};
// apple-owned: end

/// The tray state, mapped to colour + tooltip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrayState {
    NotConnected,
    Waiting,
    Sharing {
        technician: String,
        recording: bool,
        elevated: bool,
    },
}

impl TrayState {
    pub fn tooltip(&self) -> String {
        match self {
            TrayState::NotConnected => "IndiansAssist, not connected".into(),
            TrayState::Waiting => "IndiansAssist: Waiting for technician".into(),
            TrayState::Sharing {
                technician,
                recording,
                elevated,
            } => {
                let mut s = format!("IndiansAssist: Sharing with {technician}");
                if *recording {
                    s.push_str(" (recording)");
                }
                if *elevated {
                    s.push_str(" (elevated)");
                }
                s
            }
        }
    }

    // Used by the Windows and Linux trays; the macOS stub draws nothing yet (apple stream).
    #[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
    fn colours(&self) -> ([u8; 3], bool, bool) {
        match self {
            TrayState::NotConnected => ([128, 128, 128], false, false),
            TrayState::Waiting => ([235, 160, 30], false, false),
            TrayState::Sharing {
                recording,
                elevated,
                ..
            } => ([40, 170, 80], *recording, *elevated),
        }
    }
}

/// What a tray interaction asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    TogglePanel,
    Show,
    ViewOnly,
    Stop,
    Quit,
}

/// A 32x32 RGBA disc in `base`, with an optional red recording dot (top right) and a white
/// shield mark (bottom right).
pub fn icon_rgba(base: [u8; 3], red_dot: bool, shield: bool) -> Vec<u8> {
    const N: i32 = 32;
    let mut px = vec![0u8; (N * N * 4) as usize];
    let mut put = |x: i32, y: i32, c: [u8; 4]| {
        if (0..N).contains(&x) && (0..N).contains(&y) {
            let i = ((y * N + x) * 4) as usize;
            px[i..i + 4].copy_from_slice(&c);
        }
    };
    for y in 0..N {
        for x in 0..N {
            let (dx, dy) = (x as f32 - 15.5, y as f32 - 15.5);
            if dx * dx + dy * dy <= 14.5 * 14.5 {
                put(x, y, [base[0], base[1], base[2], 255]);
            }
        }
    }
    if red_dot {
        for y in 0..12 {
            for x in 20..32 {
                let (dx, dy) = (x as f32 - 25.5, y as f32 - 5.5);
                if dx * dx + dy * dy <= 5.5 * 5.5 {
                    put(x, y, [220, 30, 30, 255]);
                }
            }
        }
    }
    if shield {
        for y in 18..30 {
            let half = if y < 24 { 5 } else { 5 - (y - 24) };
            for x in (25 - half)..=(25 + half) {
                put(x, y, [255, 255, 255, 255]);
            }
        }
    }
    px
}

#[cfg(windows)]
mod win {
    use super::{icon_rgba, TrayAction, TrayState};
    use tray_icon::menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem};
    use tray_icon::{
        Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
    };

    /// The live tray icon.
    pub struct Tray {
        icon: TrayIcon,
        show: MenuId,
        view_only: MenuId,
        stop: MenuId,
        quit: MenuId,
        state: TrayState,
    }

    impl Tray {
        /// Create the icon (must run on a thread with a message loop: the eframe UI thread).
        pub fn new(state: TrayState) -> Option<Tray> {
            let show = MenuItem::new("Show", true, None);
            let view_only = MenuItem::new("View only", true, None);
            let stop = MenuItem::new("Stop sharing", true, None);
            let quit = MenuItem::new("Quit", true, None);
            let menu = Menu::new();
            menu.append_items(&[
                &show,
                &view_only,
                &PredefinedMenuItem::separator(),
                &stop,
                &quit,
            ])
            .ok()?;
            let (c, dot, shield) = state.colours();
            let icon = TrayIconBuilder::new()
                .with_tooltip(state.tooltip())
                .with_icon(Icon::from_rgba(icon_rgba(c, dot, shield), 32, 32).ok()?)
                .with_menu(Box::new(menu))
                .with_menu_on_left_click(false)
                .build()
                .ok()?;
            Some(Tray {
                icon,
                show: show.id().clone(),
                view_only: view_only.id().clone(),
                stop: stop.id().clone(),
                quit: quit.id().clone(),
                state,
            })
        }

        pub fn set_state(&mut self, state: TrayState) {
            if state == self.state {
                return;
            }
            let (c, dot, shield) = state.colours();
            if let Ok(icon) = Icon::from_rgba(icon_rgba(c, dot, shield), 32, 32) {
                let _ = self.icon.set_icon(Some(icon));
            }
            let _ = self.icon.set_tooltip(Some(state.tooltip()));
            self.state = state;
        }

        /// Drain pending tray / menu events.
        pub fn poll(&self) -> Vec<TrayAction> {
            let mut out = Vec::new();
            while let Ok(e) = TrayIconEvent::receiver().try_recv() {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = e
                {
                    out.push(TrayAction::TogglePanel);
                }
            }
            while let Ok(e) = MenuEvent::receiver().try_recv() {
                let id = e.id();
                if *id == self.show {
                    out.push(TrayAction::Show);
                } else if *id == self.view_only {
                    out.push(TrayAction::ViewOnly);
                } else if *id == self.stop {
                    out.push(TrayAction::Stop);
                } else if *id == self.quit {
                    out.push(TrayAction::Quit);
                }
            }
            out
        }
    }
}

/// The RGBA pixels of [`icon_rgba`] as the ARGB32, network-byte-order pixmap a
/// StatusNotifierItem carries (`IconPixmap`).
pub fn rgba_to_argb(rgba: &[u8]) -> Vec<u8> {
    rgba.as_chunks::<4>()
        .0
        .iter()
        .flat_map(|p| [p[3], p[0], p[1], p[2]])
        .collect()
}

/// The Linux tray menu, in order: label and the action it emits (`None` = separator).
pub const SNI_MENU: [(Option<&str>, Option<TrayAction>); 5] = [
    (Some("Show"), Some(TrayAction::Show)),
    (Some("View only"), Some(TrayAction::ViewOnly)),
    (None, None),
    (Some("Stop sharing"), Some(TrayAction::Stop)),
    (Some("Quit"), Some(TrayAction::Quit)),
];

#[cfg(target_os = "linux")]
mod sni {
    use super::{icon_rgba, rgba_to_argb, TrayAction, TrayState, SNI_MENU};
    use ksni::blocking::{Handle, TrayMethods};
    use std::sync::mpsc::{channel, Receiver, Sender};

    struct SniTray {
        state: TrayState,
        tx: Sender<TrayAction>,
    }

    impl ksni::Tray for SniTray {
        fn id(&self) -> String {
            "indiansassist".into()
        }
        fn title(&self) -> String {
            "IndiansAssist".into()
        }
        fn category(&self) -> ksni::Category {
            ksni::Category::ApplicationStatus
        }
        fn icon_pixmap(&self) -> Vec<ksni::Icon> {
            let (c, dot, shield) = self.state.colours();
            vec![ksni::Icon {
                width: 32,
                height: 32,
                data: rgba_to_argb(&icon_rgba(c, dot, shield)),
            }]
        }
        fn tool_tip(&self) -> ksni::ToolTip {
            ksni::ToolTip {
                title: self.state.tooltip(),
                ..Default::default()
            }
        }
        /// Left click toggles the panel, as on Windows.
        fn activate(&mut self, _x: i32, _y: i32) {
            let _ = self.tx.send(TrayAction::TogglePanel);
        }
        fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
            use ksni::menu::StandardItem;
            SNI_MENU
                .iter()
                .map(|(label, action)| match (label, action) {
                    (Some(label), Some(action)) => {
                        let action = *action;
                        StandardItem {
                            label: (*label).into(),
                            activate: Box::new(move |t: &mut SniTray| {
                                let _ = t.tx.send(action);
                            }),
                            ..Default::default()
                        }
                        .into()
                    }
                    _ => ksni::MenuItem::Separator,
                })
                .collect()
        }
        /// No watcher (or it went away): drop the icon; the pill and panel carry everything.
        fn watcher_offline(&self, _reason: ksni::OfflineReason) -> bool {
            false
        }
    }

    /// The live StatusNotifierItem.
    pub struct Tray {
        handle: Handle<SniTray>,
        rx: Receiver<TrayAction>,
        state: TrayState,
    }

    impl Tray {
        /// Register the item on the session bus. `None` when there is no session bus or no
        /// StatusNotifierWatcher (best effort, §7.3b).
        pub fn new(state: TrayState) -> Option<Tray> {
            let (tx, rx) = channel();
            let tray = SniTray {
                state: state.clone(),
                tx,
            };
            match tray.spawn() {
                Ok(handle) => Some(Tray { handle, rx, state }),
                Err(e) => {
                    tracing::info!(
                        "no tray icon (no StatusNotifierWatcher on the session bus): {e}"
                    );
                    None
                }
            }
        }

        pub fn set_state(&mut self, state: TrayState) {
            if state == self.state {
                return;
            }
            let next = state.clone();
            let _ = self.handle.update(move |t: &mut SniTray| t.state = next);
            self.state = state;
        }

        /// Drain pending tray / menu activations.
        pub fn poll(&self) -> Vec<TrayAction> {
            self.rx.try_iter().collect()
        }
    }

    impl Drop for Tray {
        fn drop(&mut self) {
            let _ = self.handle.shutdown();
        }
    }
}

// apple-owned: begin
/// Phase F §17.2: the macOS menu-bar item (`tray-icon` on macOS, apple stream). An F0 stub with
/// the API of the other targets' `Tray`: [`Tray::new`] returns `None` (no menu-bar item, so the
/// pill and panel carry every tray function, as on a Linux desktop without a tray, W80).
#[cfg(target_os = "macos")]
mod mac {
    use super::{TrayAction, TrayState};

    /// The menu-bar item (none until the apple stream fills it).
    pub struct Tray {
        _state: TrayState,
    }

    impl Tray {
        /// No menu-bar item yet: always `None`.
        pub fn new(_state: TrayState) -> Option<Tray> {
            None
        }

        /// Update the icon and tooltip (nothing to update yet).
        pub fn set_state(&mut self, state: TrayState) {
            self._state = state;
        }

        /// The clicks and menu picks since the last poll (none yet).
        pub fn poll(&self) -> Vec<TrayAction> {
            Vec::new()
        }
    }

    use std::cell::Cell;
    use std::time::{Duration, Instant};

    use egui::{
        pos2, vec2, Align2, Color32, FontId, Pos2, Rect, RichText, Sense, Stroke, Vec2,
        ViewportBuilder, ViewportCommand, ViewportId, WindowLevel,
    };

    /// How often the grants are re-read while the consent window is open (they change only in
    /// System Settings, so a person who switches back sees the new state within this time).
    const RECHECK_EVERY: Duration = Duration::from_secs(2);

    thread_local! {
        static GRANTS: Cell<Option<(Instant, bool, bool)>> = const { Cell::new(None) };
    }

    /// `(screen recording, accessibility)`, re-read at most every [`RECHECK_EVERY`] or when
    /// `force` (the "Check again" button).
    fn grants(force: bool) -> (bool, bool) {
        GRANTS.with(|g| match g.get() {
            Some((at, s, a)) if !force && at.elapsed() < RECHECK_EVERY => (s, a),
            _ => {
                let s = ia_capture_mac::screen_recording_granted();
                let a = ia_input_mac::accessibility_granted();
                if g.get().map(|(_, ps, pa)| (ps, pa)) != Some((s, a)) {
                    tracing::info!(screen = s, accessibility = a, "macOS grants");
                }
                g.set(Some((Instant::now(), s, a)));
                (s, a)
            }
        })
    }

    fn open(args: &[&str]) {
        if let Err(e) = std::process::Command::new("/usr/bin/open")
            .args(args)
            .spawn()
        {
            tracing::warn!("open {args:?} failed: {e}");
        }
    }

    /// The two macOS grants, in the order the consent window walks through them.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Grant {
        Screen,
        Control,
    }

    impl Grant {
        /// The system request (`CGRequestScreenCaptureAccess`, `AXIsProcessTrustedWithOptions`
        /// with the prompt). Besides asking, it puts IndiansAssist in the pane's list, so the
        /// person only has to turn a switch on.
        fn request(self) -> bool {
            match self {
                Grant::Screen => ia_capture_mac::request_screen_recording(),
                Grant::Control => ia_input_mac::request_accessibility(),
            }
        }

        fn pane(self) -> &'static str {
            match self {
                Grant::Screen => ia_input_mac::access::SETTINGS_SCREEN_RECORDING,
                Grant::Control => ia_input_mac::access::SETTINGS_ACCESSIBILITY,
            }
        }

        /// The pane's name as System Settings shows it (macOS 14 and later).
        fn pane_name(self) -> &'static str {
            match self {
                Grant::Screen => "Screen & System Audio Recording",
                Grant::Control => "Accessibility",
            }
        }

        fn index(self) -> usize {
            match self {
                Grant::Screen => 0,
                Grant::Control => 1,
            }
        }
    }

    /// The guide's state: which grant it is showing, and which grants were already walked to
    /// automatically (each at most once per run; "Show me how" walks to one again).
    #[derive(Debug, Clone, Copy, Default)]
    struct Guide {
        shown: Option<Grant>,
        walked: [bool; 2],
        /// The consent window is stepped down from always-on-top (while the guide is open).
        lowered: bool,
        /// macOS was asked for the grant this run (its box once is enough: it lists the app).
        asked: [bool; 2],
    }

    thread_local! {
        static GUIDE: Cell<Guide> = const { Cell::new(Guide { shown: None, walked: [false; 2], lowered: false, asked: [false; 2] }) };
    }

    thread_local! {
        /// The window asking is the pre-connect permissions window: a restart keeps the code.
        static RESTART_SAFE: Cell<bool> = const { Cell::new(false) };
        /// The guide's "Restart IndiansAssist" was clicked.
        static RESTART_ASKED: Cell<bool> = const { Cell::new(false) };
    }

    /// The first grant still missing.
    fn next_missing(screen: bool, control: bool) -> Option<Grant> {
        match (screen, control) {
            (false, _) => Some(Grant::Screen),
            (true, false) => Some(Grant::Control),
            (true, true) => None,
        }
    }

    /// Walks the person to one grant: the system request, the exact System Settings pane, and
    /// the guide beside it.
    fn walk_to(g: &mut Guide, grant: Grant) {
        tracing::info!(?grant, "walking the person to a missing macOS grant");
        g.walked[grant.index()] = true;
        g.shown = Some(grant);
        // Ask macOS once per run: its box puts IndiansAssist in the pane's list. Asking again
        // only shows the same box again over a pane that is already open.
        if !g.asked[grant.index()] {
            g.asked[grant.index()] = true;
            grant.request();
        }
        open(&[grant.pane()]);
        grants(true);
    }

    /// The IndiansAssist.app this process runs from (`…/X.app/Contents/MacOS/bin`), for
    /// "Show IndiansAssist in Finder" when the pane's list does not have it.
    fn own_bundle() -> Option<std::path::PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let app = exe.parent()?.parent()?.parent()?;
        (app.extension()? == "app").then(|| app.to_path_buf())
    }

    /// One step in the consent window: a tick when granted; otherwise why, and "Show me how".
    fn step(ui: &mut egui::Ui, g: &mut Guide, granted: bool, grant: Grant, title: &str, why: &str) {
        if granted {
            // U+2714 (Noto Emoji has it; U+2713 is in neither embedded font, `crate::fonts`).
            ui.label(
                RichText::new(format!("\u{2714} {title}")).color(Color32::from_rgb(60, 170, 90)),
            );
            return;
        }
        ui.label(RichText::new(title).strong());
        ui.label(why);
        if ui.button("Show me how").clicked() {
            walk_to(g, grant);
        }
    }

    /// Phase F §17.2: the consent window's two macOS steps, "Allow screen recording" and "Allow
    /// control", each with one sentence of why. The first missing grant is walked to as soon as
    /// the window opens: the system request (which also lists IndiansAssist in the pane), the
    /// exact System Settings pane, and the [`tcc_guide`] beside it; when it is granted the next
    /// one follows. **Check again** re-reads both. The session goes on with whatever is
    /// granted; TCC is never bypassed (PRD 5), the switch is always the person's. Nothing is
    /// shown once both are granted. Returns the grants it showed.
    pub fn tcc_steps(ui: &mut egui::Ui) -> (bool, bool) {
        let (screen, control) = grants(false);
        let mut g = GUIDE.get();
        let next = next_missing(screen, control);
        let granted = |grant| match grant {
            Grant::Screen => screen,
            Grant::Control => control,
        };
        if g.shown.is_some_and(granted) {
            // The grant came through: bring the consent window back.
            g.shown = None;
            ui.ctx()
                .send_viewport_cmd_to(ViewportId::ROOT, ViewportCommand::Focus);
        }
        if let Some(n) = next {
            if g.shown.is_none() && !g.walked[n.index()] {
                walk_to(&mut g, n);
            }
        }
        if screen && control {
            GUIDE.set(g);
            return (screen, control);
        }
        ui.separator();
        ui.label(RichText::new("macOS needs your permission first").strong());
        step(
            ui,
            &mut g,
            screen,
            Grant::Screen,
            "1. Allow screen recording",
            "So the technician can see your screen. Without it they can still chat and send files.",
        );
        ui.add_space(4.0);
        step(
            ui,
            &mut g,
            control,
            Grant::Control,
            "2. Allow control",
            "So the technician can use the mouse and keyboard, and only when you allow control.",
        );
        ui.add_space(4.0);
        if ui.button("Check again").clicked() {
            grants(true);
        }
        GUIDE.set(g);
        ui.ctx().request_repaint_after(RECHECK_EVERY);
        (screen, control)
    }

    /// How the pre-connect permissions window was left.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Preflight {
        /// Both grants are there, or the person goes on without the missing ones.
        Continue,
        /// Restart IndiansAssist (with the same support code) so macOS applies the new grant.
        Restart,
        /// Cancel: quit without connecting.
        Cancel,
    }

    /// Phase F §17.2: the pre-connect permissions window. It runs before the agent connects, so
    /// the support code is not used yet and a restart (System Settings' "Quit & Reopen", or
    /// "Restart IndiansAssist" here and in the guide) keeps it. The steps and the guide are the
    /// consent window's; the window answers by itself once both grants are there. Returns the
    /// answer once there is one.
    pub fn permissions_ui(ctx: &egui::Context) -> Option<Preflight> {
        RESTART_SAFE.set(true);
        let (screen, control) = grants(false);
        if screen && control {
            return Some(Preflight::Continue);
        }
        let mut out = None;
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.add_space(6.0);
            ui.heading("Before IndiansAssist connects");
            ui.add_space(4.0);
            ui.label(
                "So a technician can help, macOS asks you for two permissions. Your support \
                 code is kept while you do this, even if IndiansAssist restarts.",
            );
            tcc_steps(ui);
            if !screen && GUIDE.get().asked[Grant::Screen.index()] {
                ui.separator();
                ui.label(RichText::new("Turned screen recording on?").strong());
                ui.label("macOS lets IndiansAssist use it after a restart.");
                if ui.button("Restart IndiansAssist").clicked() {
                    out = Some(Preflight::Restart);
                }
            }
            ui.separator();
            ui.horizontal(|ui| {
                if ui.button("Continue without them").clicked() {
                    out = Some(Preflight::Continue);
                }
                if ui.button("Cancel").clicked() {
                    out = Some(Preflight::Cancel);
                }
            });
        });
        tcc_guide(ctx);
        if RESTART_ASKED.replace(false) {
            out = Some(Preflight::Restart);
        }
        out
    }

    const GUIDE_W: f32 = 300.0;
    const GUIDE_H: f32 = 500.0;
    /// The gap between the guide and System Settings.
    const GAP: f32 = 10.0;
    /// How much of System Settings' left side is its sidebar (not needed while the pane is open).
    const SIDEBAR_W: f32 = 215.0;

    /// Where the guide goes, beside System Settings (`settings`, its window in global points, or
    /// `None` before it is on screen): to its right when there is room, else to its left, else
    /// over its sidebar so the pane's list and switches stay in view (a 960 x 600 point screen).
    /// Before Settings shows, the top right of the screen. Always kept on the screen.
    fn guide_position(screen: Vec2, size: Vec2, settings: Option<Rect>) -> Pos2 {
        let p = match settings {
            None => pos2(screen.x - size.x - 24.0, 60.0),
            Some(s) if s.right() + GAP + size.x <= screen.x => pos2(s.right() + GAP, s.top()),
            Some(s) if s.left() - GAP - size.x >= 0.0 => pos2(s.left() - GAP - size.x, s.top()),
            Some(s) => pos2(s.left() + SIDEBAR_W - size.x, s.top() + 40.0),
        };
        pos2(
            p.x.clamp(0.0, (screen.x - size.x).max(0.0)),
            p.y.clamp(25.0, (screen.y - size.y).max(25.0)),
        )
    }

    thread_local! {
        /// System Settings' window, re-read every half second while the guide is open.
        static SETTINGS: Cell<Option<(Instant, Option<Rect>)>> = const { Cell::new(None) };
        /// Where the guide was last put.
        static GUIDE_AT: Cell<Option<Pos2>> = const { Cell::new(None) };
    }

    fn settings_rect() -> Option<Rect> {
        SETTINGS.with(|c| match c.get() {
            Some((at, r)) if at.elapsed() < Duration::from_millis(500) => r,
            _ => {
                let r = ia_input_mac::settings_window().map(|w| {
                    Rect::from_min_size(
                        pos2(w.x as f32, w.y as f32),
                        vec2(w.width as f32, w.height as f32),
                    )
                });
                c.set(Some((Instant::now(), r)));
                r
            }
        })
    }

    /// What the guide's buttons asked for.
    enum GuideAction {
        OpenAgain,
        ShowInFinder,
        Restart,
        Close,
    }

    /// The "How to allow" guide: a small always-on-top window beside System Settings (it follows
    /// the Settings window), with a picture of the switch to turn on and the steps for the pane
    /// that is open. It closes by itself when the
    /// grant comes through. Call once per frame after the consent window's panel.
    pub fn tcc_guide(ctx: &egui::Context) {
        let mut g = GUIDE.get();
        // While the guide is open the consent window steps down from always-on-top, so System
        // Settings comes in front of it (on a small screen they cannot sit side by side); it
        // goes back on top when the grant comes through.
        if g.shown.is_some() != g.lowered {
            g.lowered = g.shown.is_some();
            let level = if g.lowered {
                WindowLevel::Normal
            } else {
                WindowLevel::AlwaysOnTop
            };
            ctx.send_viewport_cmd_to(ViewportId::ROOT, ViewportCommand::WindowLevel(level));
        }
        let Some(grant) = g.shown else {
            GUIDE.set(g);
            return;
        };
        let size = vec2(GUIDE_W, GUIDE_H);
        let screen = ctx
            .input(|i| i.viewport().monitor_size)
            .unwrap_or(vec2(1440.0, 900.0));
        let at = guide_position(screen, size, settings_rect());
        let moved = GUIDE_AT.replace(Some(at)).is_some_and(|was| was != at);
        let builder = ViewportBuilder::default()
            .with_title("How to allow IndiansAssist")
            .with_inner_size(size)
            .with_position(at)
            .with_resizable(false)
            .with_minimize_button(false)
            .with_maximize_button(false)
            .with_window_level(WindowLevel::AlwaysOnTop);
        let mut action = None;
        ctx.show_viewport_immediate(
            ViewportId::from_hash_of("ia-tcc-guide"),
            builder,
            |gctx, _| {
                if moved {
                    // System Settings opened or moved: follow it.
                    gctx.send_viewport_cmd(ViewportCommand::OuterPosition(at));
                }
                egui::CentralPanel::default().show(gctx, |ui| guide_body(ui, grant, &mut action));
                if gctx.input(|i| i.viewport().close_requested()) {
                    action = Some(GuideAction::Close);
                }
            },
        );
        match action {
            Some(GuideAction::OpenAgain) => open(&[grant.pane()]),
            Some(GuideAction::ShowInFinder) => {
                if let Some(app) = own_bundle() {
                    open(&["-R", &app.to_string_lossy()]);
                }
            }
            Some(GuideAction::Restart) => RESTART_ASKED.set(true),
            Some(GuideAction::Close) => g.shown = None,
            None => {}
        }
        if g.shown.is_none() {
            GUIDE_AT.set(None);
        }
        GUIDE.set(g);
    }

    fn guide_body(ui: &mut egui::Ui, grant: Grant, action: &mut Option<GuideAction>) {
        let (n, goal) = match grant {
            Grant::Screen => (1, "let the technician see your screen"),
            Grant::Control => (2, "let the technician use the mouse and keyboard"),
        };
        ui.label(RichText::new(format!("Step {n} of 2")).small().weak());
        ui.heading(format!("Allow IndiansAssist to {goal}"));
        ui.add_space(6.0);
        switch_picture(ui, grant);
        ui.add_space(6.0);
        let mut lines = vec![
            format!(
                "System Settings is open at Privacy & Security > {}. If macOS also shows a \
                 box about IndiansAssist, either button is fine: this page is already open.",
                grant.pane_name()
            ),
            "Find IndiansAssist in the list and turn its switch on, like the picture.".to_owned(),
            "Enter your Mac password or use Touch ID if macOS asks.".to_owned(),
        ];
        let safe = RESTART_SAFE.get();
        if grant == Grant::Screen {
            lines.push(if safe {
                "macOS then asks to quit and reopen IndiansAssist. Click Quit & Reopen (or Later, \
                 then Restart IndiansAssist below): your support code is kept."
                    .to_owned()
            } else {
                "If macOS says IndiansAssist must quit and reopen, click Later: quitting now \
                 would end this support request."
                    .to_owned()
            });
        }
        lines.push("Come back here. This guide closes by itself when it is done.".to_owned());
        for (i, line) in lines.iter().enumerate() {
            ui.horizontal_wrapped(|ui| {
                ui.label(RichText::new(format!("{}.", i + 1)).strong());
                ui.label(line);
            });
            ui.add_space(2.0);
        }
        ui.add_space(4.0);
        ui.label(
            RichText::new(
                "IndiansAssist not in the list? Click + under the list and choose it, or drag \
                 it in from Finder. Already on but this still asks? Remove it with −, then \
                 click Show me how again.",
            )
            .small(),
        );
        ui.add_space(6.0);
        if safe && grant == Grant::Screen {
            let restart = egui::Button::new(RichText::new("Restart IndiansAssist").strong());
            if ui.add(restart).clicked() {
                *action = Some(GuideAction::Restart);
            }
            ui.add_space(2.0);
        }
        if ui.button("Open System Settings again").clicked() {
            *action = Some(GuideAction::OpenAgain);
        }
        if own_bundle().is_some() && ui.button("Show IndiansAssist in Finder").clicked() {
            *action = Some(GuideAction::ShowInFinder);
        }
        if ui.button("Close guide").clicked() {
            *action = Some(GuideAction::Close);
        }
        ui.ctx().request_repaint_after(RECHECK_EVERY);
    }

    /// A small picture of the pane's row for IndiansAssist: its icon, its name and the switch,
    /// which turns on and off in a loop, ringed and pointed at.
    fn switch_picture(ui: &mut egui::Ui, grant: Grant) {
        let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 92.0), Sense::hover());
        let p = ui.painter_at(rect);
        let v = ui.visuals();
        let text = v.text_color();
        let weak = v.weak_text_color();
        p.rect_filled(rect, 8.0, v.extreme_bg_color);
        p.rect_stroke(
            rect,
            8.0,
            Stroke::new(1.0_f32, v.widgets.noninteractive.bg_stroke.color),
        );
        p.text(
            rect.left_top() + vec2(10.0, 8.0),
            Align2::LEFT_TOP,
            grant.pane_name(),
            FontId::proportional(11.0),
            weak,
        );
        // A picture, not the real switch: say so, so nobody takes it for the setting itself.
        p.text(
            rect.right_top() + vec2(-10.0, 8.0),
            Align2::RIGHT_TOP,
            "Example",
            FontId::proportional(11.0),
            weak,
        );
        // The row.
        let row = Rect::from_min_size(
            rect.left_top() + vec2(8.0, 30.0),
            vec2(rect.width() - 16.0, 34.0),
        );
        p.rect_filled(row, 6.0, v.faint_bg_color);
        let icon =
            Rect::from_center_size(pos2(row.left() + 20.0, row.center().y), vec2(22.0, 22.0));
        p.rect_filled(icon, 5.0, Color32::from_rgb(20, 120, 110));
        p.text(
            icon.center(),
            Align2::CENTER_CENTER,
            "IA",
            FontId::proportional(10.0),
            Color32::WHITE,
        );
        p.text(
            pos2(icon.right() + 8.0, row.center().y),
            Align2::LEFT_CENTER,
            "IndiansAssist",
            FontId::proportional(13.0),
            text,
        );
        // The switch: off for 1.2 s, on for 1.2 s, the knob sliding between.
        let t = ui.input(|i| i.time) % 2.4;
        let on =
            ((t - 1.0) / 0.2).clamp(0.0, 1.0) as f32 - ((t - 2.2) / 0.2).clamp(0.0, 1.0) as f32;
        let sw = Rect::from_center_size(pos2(row.right() - 26.0, row.center().y), vec2(36.0, 20.0));
        let off_c = Color32::from_gray(150);
        let on_c = Color32::from_rgb(52, 199, 89);
        p.rect_filled(sw, 10.0, off_c.lerp_to_gamma(on_c, on));
        let knob_x = egui::lerp(sw.left() + 10.0..=sw.right() - 10.0, on);
        p.circle_filled(pos2(knob_x, sw.center().y), 8.0, Color32::WHITE);
        // A pulsing ring and an arrow pointing at the switch.
        let pulse = (ui.input(|i| i.time) * 4.0).sin() as f32 * 0.5 + 0.5;
        p.rect_stroke(
            sw.expand(3.0 + 2.0 * pulse),
            13.0,
            Stroke::new(2.0_f32, Color32::from_rgb(255, 149, 0)),
        );
        let tip = pos2(sw.center().x, row.bottom() + 4.0);
        p.arrow(
            pos2(tip.x - 30.0, rect.bottom() - 6.0),
            tip - pos2(tip.x - 30.0, rect.bottom() - 6.0),
            Stroke::new(2.0_f32, Color32::from_rgb(255, 149, 0)),
        );
        p.text(
            pos2(tip.x - 36.0, rect.bottom() - 8.0),
            Align2::RIGHT_BOTTOM,
            "Turn this on",
            FontId::proportional(12.0),
            Color32::from_rgb(255, 149, 0),
        );
        ui.ctx().request_repaint_after(Duration::from_millis(33));
    }

    #[cfg(test)]
    mod tests {
        use super::{guide_position, next_missing, Grant};
        use egui::{pos2, vec2, Rect};

        #[test]
        fn the_guide_sits_beside_system_settings_or_over_its_sidebar() {
            let size = vec2(300.0, 500.0);
            let rect = |x, y, w, h| Rect::from_min_size(pos2(x, y), vec2(w, h));
            // Before Settings shows: the top right.
            assert_eq!(
                guide_position(vec2(1920.0, 1080.0), size, None),
                pos2(1596.0, 60.0)
            );
            // A wide screen: to the right of Settings.
            let s = rect(600.0, 120.0, 715.0, 575.0);
            assert_eq!(
                guide_position(vec2(1920.0, 1080.0), size, Some(s)),
                pos2(1325.0, 120.0)
            );
            // No room on the right, room on the left.
            let s = rect(1100.0, 120.0, 715.0, 575.0);
            assert_eq!(
                guide_position(vec2(1920.0, 1080.0), size, Some(s)),
                pos2(790.0, 120.0)
            );
            // A 1920 x 1200 panel at 2x is 960 x 600 points: over the sidebar, kept on screen.
            let s = rect(110.0, 25.0, 715.0, 575.0);
            assert_eq!(
                guide_position(vec2(960.0, 600.0), size, Some(s)),
                pos2(25.0, 65.0)
            );
            let s = rect(0.0, 300.0, 715.0, 575.0);
            assert_eq!(
                guide_position(vec2(960.0, 600.0), size, Some(s)),
                pos2(0.0, 100.0)
            );
        }

        #[test]
        fn the_guide_walks_screen_recording_first_then_accessibility() {
            assert_eq!(next_missing(false, false), Some(Grant::Screen));
            assert_eq!(next_missing(false, true), Some(Grant::Screen));
            assert_eq!(next_missing(true, false), Some(Grant::Control));
            assert_eq!(next_missing(true, true), None);
        }
    }
}
// apple-owned: end

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tooltips_follow_the_contract_states() {
        assert_eq!(
            TrayState::NotConnected.tooltip(),
            "IndiansAssist, not connected"
        );
        assert!(TrayState::Waiting
            .tooltip()
            .contains("Waiting for technician"));
        let s = TrayState::Sharing {
            technician: "Asha".into(),
            recording: true,
            elevated: false,
        };
        assert_eq!(s.tooltip(), "IndiansAssist: Sharing with Asha (recording)");
    }

    #[test]
    fn icon_marks() {
        let plain = icon_rgba([40, 170, 80], false, false);
        let rec = icon_rgba([40, 170, 80], true, false);
        assert_eq!(plain.len(), 32 * 32 * 4);
        // The recording dot paints red pixels the plain icon does not have.
        let red = |v: &[u8]| v.chunks(4).filter(|p| p[0] == 220 && p[1] == 30).count();
        assert_eq!(red(&plain), 0);
        assert!(red(&rec) > 20);
    }

    #[test]
    fn the_linux_pixmap_is_argb_in_network_order_and_the_menu_matches_windows() {
        assert_eq!(
            rgba_to_argb(&[1, 2, 3, 4, 5, 6, 7, 8]),
            vec![4, 1, 2, 3, 8, 5, 6, 7]
        );
        let argb = rgba_to_argb(&icon_rgba([40, 170, 80], false, false));
        assert_eq!(argb.len(), 32 * 32 * 4);
        let actions: Vec<_> = SNI_MENU.iter().filter_map(|(_, a)| *a).collect();
        assert_eq!(
            actions,
            vec![
                TrayAction::Show,
                TrayAction::ViewOnly,
                TrayAction::Stop,
                TrayAction::Quit
            ]
        );
    }
}
