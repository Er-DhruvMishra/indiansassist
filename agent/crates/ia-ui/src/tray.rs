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
pub use mac::Tray;
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
