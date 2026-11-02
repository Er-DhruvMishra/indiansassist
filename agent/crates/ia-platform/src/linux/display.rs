//! Display-server detection (Phase E §7.4). Pure and table-tested: the decision is a function of
//! three environment values, so it runs on every host.

/// What kind of graphical session the agent is running in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DisplayServer {
    /// An X11 (Xorg) session; `display` is the `DISPLAY` value (`:0`, `:1`, ...).
    X11 { display: String },
    /// A Wayland session. The agent connects and shares nothing on screen (§7.4), even when
    /// `DISPLAY` is also set: XWayland would show only X11 windows over black.
    Wayland,
    /// No graphical session: the agent says "No graphical session found" and exits.
    None,
}

/// The three environment values the decision reads (`None` = unset).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DisplayEnv {
    pub xdg_session_type: Option<String>,
    pub wayland_display: Option<String>,
    pub display: Option<String>,
}

impl DisplayEnv {
    /// Read the process environment.
    pub fn from_process() -> Self {
        let get = |k: &str| std::env::var(k).ok();
        Self {
            xdg_session_type: get("XDG_SESSION_TYPE"),
            wayland_display: get("WAYLAND_DISPLAY"),
            display: get("DISPLAY"),
        }
    }
}

fn set(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// §7.4: `WAYLAND_DISPLAY` set, or `XDG_SESSION_TYPE == "wayland"` → Wayland (even when
/// `DISPLAY` is also set); otherwise `DISPLAY` set → X11; otherwise none. An empty value counts
/// as unset.
pub fn display_server(env: &DisplayEnv) -> DisplayServer {
    let wayland_type =
        set(&env.xdg_session_type).is_some_and(|t| t.eq_ignore_ascii_case("wayland"));
    if set(&env.wayland_display).is_some() || wayland_type {
        return DisplayServer::Wayland;
    }
    match set(&env.display) {
        Some(d) => DisplayServer::X11 {
            display: d.to_string(),
        },
        None => DisplayServer::None,
    }
}

/// The consent window's Wayland notice (§7.4), verbatim.
pub const WAYLAND_NOTICE: &str = "This computer uses a Wayland session. IndiansAssist cannot share the screen of a Wayland session yet. Chat, files and playbooks still work. If your sign-in screen offers an Xorg (X11) session, signing in to that session lets IndiansAssist share the screen.";

/// What the agent prints when there is no graphical session (§7.4).
pub const NO_SESSION_MESSAGE: &str = "No graphical session found";

#[cfg(test)]
mod tests {
    use super::*;

    fn env(t: Option<&str>, w: Option<&str>, d: Option<&str>) -> DisplayEnv {
        DisplayEnv {
            xdg_session_type: t.map(String::from),
            wayland_display: w.map(String::from),
            display: d.map(String::from),
        }
    }

    #[test]
    fn the_section_7_4_table() {
        let x11 = |d: &str| DisplayServer::X11 {
            display: d.to_string(),
        };
        let cases = [
            // (XDG_SESSION_TYPE, WAYLAND_DISPLAY, DISPLAY) -> expected
            (env(None, None, Some(":0")), x11(":0")),
            (env(Some("x11"), None, Some(":1")), x11(":1")),
            (env(Some("tty"), None, Some(":99")), x11(":99")),
            (env(None, Some("wayland-0"), None), DisplayServer::Wayland),
            // XWayland: DISPLAY is set too, still Wayland (a misleading picture otherwise).
            (
                env(None, Some("wayland-0"), Some(":0")),
                DisplayServer::Wayland,
            ),
            (
                env(Some("wayland"), None, Some(":0")),
                DisplayServer::Wayland,
            ),
            (env(Some("Wayland"), None, None), DisplayServer::Wayland),
            (
                env(Some("x11"), Some("wayland-1"), Some(":0")),
                DisplayServer::Wayland,
            ),
            (env(None, None, None), DisplayServer::None),
            (env(Some("x11"), None, None), DisplayServer::None),
            // Empty values count as unset.
            (env(None, Some(""), Some(":0")), x11(":0")),
            (env(Some(""), Some(" "), Some("")), DisplayServer::None),
        ];
        for (e, want) in cases {
            assert_eq!(display_server(&e), want, "{e:?}");
        }
    }

    #[test]
    fn the_wayland_notice_names_xorg_but_no_desktop_or_distribution() {
        assert!(WAYLAND_NOTICE.contains("Xorg (X11) session"));
        for name in ["GNOME", "KDE", "Ubuntu", "Fedora"] {
            assert!(!WAYLAND_NOTICE.contains(name));
        }
    }
}
