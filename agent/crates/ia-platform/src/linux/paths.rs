//! The Linux file locations (Phase E §7.3f, §7.7), derived purely from the XDG environment so the
//! derivation is tested on every host and the tests can point everything at a temporary root.
//!
//! | Use | Location |
//! |---|---|
//! | lock, `sh` run directory, single-instance file | `$XDG_RUNTIME_DIR/indiansassist` (0700), fallback `$XDG_STATE_HOME/indiansassist` |
//! | `agent.log` | `$XDG_STATE_HOME/indiansassist` (`~/.local/state/indiansassist`) |
//! | received files | `$(xdg-user-dir DOWNLOAD)/IndiansAssist/`, read from `$XDG_CONFIG_HOME/user-dirs.dirs`, fallback `~/Downloads` |
//! | Keep (C §10 D5) | `$XDG_DATA_HOME/indiansassist/IndiansAssist` |
//! | deep-link handler | `$XDG_DATA_HOME/applications/indiansassist-handler.desktop` + `$XDG_CONFIG_HOME/mimeapps.list` |

use std::path::{Path, PathBuf};

/// The XDG environment the derivations read (`None` = unset or not absolute: the XDG base
/// directory spec says a relative value is invalid and must be ignored).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct XdgEnv {
    pub home: Option<PathBuf>,
    pub data_home: Option<PathBuf>,
    pub config_home: Option<PathBuf>,
    pub state_home: Option<PathBuf>,
    pub runtime_dir: Option<PathBuf>,
}

fn abs(v: Option<String>) -> Option<PathBuf> {
    v.filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() || p.to_string_lossy().starts_with('/'))
}

impl XdgEnv {
    /// Read the process environment.
    pub fn from_process() -> Self {
        let get = |k: &str| std::env::var(k).ok();
        Self {
            home: abs(get("HOME")),
            data_home: abs(get("XDG_DATA_HOME")),
            config_home: abs(get("XDG_CONFIG_HOME")),
            state_home: abs(get("XDG_STATE_HOME")),
            runtime_dir: abs(get("XDG_RUNTIME_DIR")),
        }
    }

    fn home_join(&self, rel: &str) -> Option<PathBuf> {
        self.home.as_ref().map(|h| h.join(rel))
    }

    /// `$XDG_DATA_HOME`, default `~/.local/share`.
    pub fn data_home(&self) -> Option<PathBuf> {
        self.data_home
            .clone()
            .or_else(|| self.home_join(".local/share"))
    }

    /// `$XDG_CONFIG_HOME`, default `~/.config`.
    pub fn config_home(&self) -> Option<PathBuf> {
        self.config_home
            .clone()
            .or_else(|| self.home_join(".config"))
    }

    /// `$XDG_STATE_HOME`, default `~/.local/state`.
    pub fn state_home(&self) -> Option<PathBuf> {
        self.state_home
            .clone()
            .or_else(|| self.home_join(".local/state"))
    }
}

/// The directory name under each XDG base.
pub const APP_DIR: &str = "indiansassist";

/// `$XDG_RUNTIME_DIR/indiansassist`, fallback `$XDG_STATE_HOME/indiansassist` (§7.7): the lock,
/// the `sh` run directory and the single-instance file. Created 0700.
pub fn runtime_dir(env: &XdgEnv) -> Option<PathBuf> {
    env.runtime_dir
        .as_ref()
        .map(|r| r.join(APP_DIR))
        .or_else(|| state_dir(env))
}

/// `$XDG_STATE_HOME/indiansassist` (§7.7): `agent.log`.
pub fn state_dir(env: &XdgEnv) -> Option<PathBuf> {
    env.state_home().map(|s| s.join(APP_DIR))
}

/// The `sh` playbook working directory (§7.8): `<runtime dir>/run`, 0700.
pub fn run_dir(env: &XdgEnv) -> Option<PathBuf> {
    runtime_dir(env).map(|r| r.join("run"))
}

/// `session.lock` (C §10 D4) under the runtime dir.
pub fn session_lock(env: &XdgEnv) -> Option<PathBuf> {
    runtime_dir(env).map(|r| r.join("session.lock"))
}

/// The single-instance random-part file (§7.7).
pub fn instance_file(env: &XdgEnv) -> Option<PathBuf> {
    runtime_dir(env).map(|r| r.join("instance"))
}

/// `agent.log` (§7.7, C §11.5).
pub fn log_file(env: &XdgEnv) -> Option<PathBuf> {
    state_dir(env).map(|s| s.join("agent.log"))
}

/// Keep (C §10 D5): `$XDG_DATA_HOME/indiansassist/IndiansAssist`.
pub fn kept_binary(env: &XdgEnv) -> Option<PathBuf> {
    env.data_home()
        .map(|d| d.join(APP_DIR).join("IndiansAssist"))
}

/// `$XDG_DATA_HOME/applications/indiansassist-handler.desktop` (§7.7).
pub fn desktop_file(env: &XdgEnv) -> Option<PathBuf> {
    env.data_home().map(|d| {
        d.join("applications")
            .join(super::desktop::DESKTOP_FILE_NAME)
    })
}

/// `$XDG_CONFIG_HOME/mimeapps.list` (§7.7).
pub fn mimeapps_list(env: &XdgEnv) -> Option<PathBuf> {
    env.config_home().map(|c| c.join("mimeapps.list"))
}

/// Where the previous `x-scheme-handler/indiansassist` default is remembered while the agent
/// runs, so it can be restored on exit (§7.7).
pub fn mimeapps_backup(env: &XdgEnv) -> Option<PathBuf> {
    runtime_dir(env).map(|r| r.join("mimeapps.previous"))
}

/// The `XDG_DOWNLOAD_DIR` value of a `user-dirs.dirs` file, expanded (`$HOME/...` or an
/// absolute path; the format `xdg-user-dirs-update` writes). `None` when absent or unusable.
pub fn parse_user_dirs_download(text: &str, home: &Path) -> Option<PathBuf> {
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some(rest) = line.strip_prefix("XDG_DOWNLOAD_DIR=") else {
            continue;
        };
        let v = rest.trim().trim_matches('"');
        let path = if let Some(r) = v.strip_prefix("$HOME") {
            let r = r.trim_start_matches('/');
            if r.is_empty() {
                // "$HOME" alone means downloads are disabled (the spec's convention).
                return None;
            }
            home.join(r)
        } else if v.starts_with('/') {
            PathBuf::from(v)
        } else {
            return None;
        };
        if path
            .components()
            .any(|c| c == std::path::Component::ParentDir)
        {
            return None;
        }
        return Some(path);
    }
    None
}

/// The user's download folder (§7.3f): `XDG_DOWNLOAD_DIR` from
/// `$XDG_CONFIG_HOME/user-dirs.dirs`, fallback `~/Downloads`.
pub fn downloads_dir(env: &XdgEnv, user_dirs_text: Option<&str>) -> Option<PathBuf> {
    let home = env.home.as_ref()?;
    user_dirs_text
        .and_then(|t| parse_user_dirs_download(t, home))
        .or_else(|| Some(home.join("Downloads")))
}

/// Received files (§7.3f): `<downloads>/IndiansAssist/`.
pub fn received_dir(env: &XdgEnv, user_dirs_text: Option<&str>) -> Option<PathBuf> {
    downloads_dir(env, user_dirs_text).map(|d| d.join("IndiansAssist"))
}

/// `IA_FILE_OFFER` (C §8.5 O1, Phase E §7.8): an offered path is accepted only when it is
/// absolute, has no `..`, and lies under the runtime dir or the state dir of the agent.
pub fn file_offer_allowed(env: &XdgEnv, path: &Path) -> bool {
    if !path.is_absolute() && !path.to_string_lossy().starts_with('/') {
        return false;
    }
    if path
        .components()
        .any(|c| c == std::path::Component::ParentDir)
    {
        return false;
    }
    [runtime_dir(env), state_dir(env)]
        .into_iter()
        .flatten()
        .any(|root| path.starts_with(&root) && path != root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> XdgEnv {
        XdgEnv {
            home: Some("/home/asha".into()),
            data_home: None,
            config_home: None,
            state_home: None,
            runtime_dir: Some("/run/user/1000".into()),
        }
    }

    #[test]
    fn defaults_follow_the_xdg_base_directory_spec() {
        let e = env();
        assert_eq!(runtime_dir(&e), Some("/run/user/1000/indiansassist".into()));
        assert_eq!(run_dir(&e), Some("/run/user/1000/indiansassist/run".into()));
        assert_eq!(
            log_file(&e),
            Some("/home/asha/.local/state/indiansassist/agent.log".into())
        );
        assert_eq!(
            kept_binary(&e),
            Some("/home/asha/.local/share/indiansassist/IndiansAssist".into())
        );
        assert_eq!(
            desktop_file(&e),
            Some("/home/asha/.local/share/applications/indiansassist-handler.desktop".into())
        );
        assert_eq!(
            mimeapps_list(&e),
            Some("/home/asha/.config/mimeapps.list".into())
        );
    }

    #[test]
    fn without_a_runtime_dir_the_state_dir_holds_the_lock() {
        let e = XdgEnv {
            runtime_dir: None,
            state_home: Some("/tmp/x/state".into()),
            ..env()
        };
        assert_eq!(runtime_dir(&e), Some("/tmp/x/state/indiansassist".into()));
        assert_eq!(
            session_lock(&e),
            Some("/tmp/x/state/indiansassist/session.lock".into())
        );
    }

    #[test]
    fn explicit_xdg_roots_win_and_relative_values_are_ignored() {
        let e = XdgEnv {
            data_home: Some("/tmp/r/data".into()),
            config_home: Some("/tmp/r/config".into()),
            ..env()
        };
        assert_eq!(
            desktop_file(&e),
            Some("/tmp/r/data/applications/indiansassist-handler.desktop".into())
        );
        assert_eq!(abs(Some("relative/dir".into())), None);
        assert_eq!(abs(Some(String::new())), None);
        assert_eq!(abs(Some("/abs".into())), Some("/abs".into()));
    }

    #[test]
    fn the_download_folder_comes_from_user_dirs_with_a_fallback() {
        let e = env();
        let home = Path::new("/home/asha");
        let dirs = "# written by xdg-user-dirs-update\nXDG_DESKTOP_DIR=\"$HOME/Desktop\"\nXDG_DOWNLOAD_DIR=\"$HOME/Téléchargements\"\n";
        assert_eq!(
            parse_user_dirs_download(dirs, home),
            Some("/home/asha/Téléchargements".into())
        );
        assert_eq!(
            received_dir(&e, Some(dirs)),
            Some("/home/asha/Téléchargements/IndiansAssist".into())
        );
        assert_eq!(
            parse_user_dirs_download("XDG_DOWNLOAD_DIR=\"/data/dl\"", home),
            Some("/data/dl".into())
        );
        for bad in [
            "XDG_DOWNLOAD_DIR=\"$HOME\"",
            "XDG_DOWNLOAD_DIR=\"relative\"",
            "XDG_DOWNLOAD_DIR=\"$HOME/../etc\"",
            "# XDG_DOWNLOAD_DIR=\"/x\"",
        ] {
            assert_eq!(parse_user_dirs_download(bad, home), None, "{bad}");
        }
        assert_eq!(
            received_dir(&e, None),
            Some("/home/asha/Downloads/IndiansAssist".into())
        );
        assert_eq!(
            received_dir(&e, Some("XDG_DOWNLOAD_DIR=\"$HOME\"")),
            Some("/home/asha/Downloads/IndiansAssist".into())
        );
    }

    #[test]
    fn a_file_offer_is_accepted_only_under_the_agent_dirs() {
        let e = env();
        let ok = [
            "/run/user/1000/indiansassist/run/report.txt",
            "/home/asha/.local/state/indiansassist/agent.log",
        ];
        for p in ok {
            assert!(file_offer_allowed(&e, Path::new(p)), "{p}");
        }
        let bad = [
            "/run/user/1000/indiansassist",
            "/run/user/1000/indiansassist/../other",
            "/etc/shadow",
            "relative/report.txt",
            "/home/asha/.ssh/id_ed25519",
        ];
        for p in bad {
            assert!(!file_offer_allowed(&e, Path::new(p)), "{p}");
        }
    }
}
