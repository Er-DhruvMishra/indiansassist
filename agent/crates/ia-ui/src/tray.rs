//! The tray icon (contract §3.5): grey "not connected", amber "Waiting for technician", green
//! "Sharing with <technician>", green with a red dot while recording, green with a shield
//! while elevated. Left click toggles the panel; the right-click menu is Show, View only,
//! Stop sharing, Quit (= Stop sharing + exit). Every menu action moves the session in the
//! safe direction (or just shows the panel), so none of them needs a physical-input check.

use tray_icon::menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

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
}
