//! F 8.4c: how the Linux worker, already running as the session's user, finds the X cookie.
//!
//! The service never reads another user's files or process environments. The worker does it for
//! itself, and only for **its own uid's** processes: it reads the session scope's
//! `cgroup.procs` (`/sys/fs/cgroup/.../session-<id>.scope/cgroup.procs`, readable by that uid
//! without privilege), and for each of those processes it owns, the `environ`, looking for an
//! `XAUTHORITY` paired with the same `DISPLAY`. Then it falls back to
//! `$XDG_RUNTIME_DIR/gdm/Xauthority` and `~/.Xauthority`. No cookie found is not fatal here: an
//! X server without access control still accepts the connection, and one that refuses it makes
//! the capture path report `ctl.event capture { path: 'none', cause: 'x11_lost' }` and the
//! no-screen state.
//!
//! Every path is taken from [`Roots`], so the tests run against a fake `/proc` and cgroup tree
//! in a temporary directory.

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// Where `/proc` and the cgroup v2 mount are (the real ones, or a test tree).
#[derive(Debug, Clone)]
pub struct Roots {
    pub proc_root: PathBuf,
    pub cgroup_root: PathBuf,
}

impl Roots {
    pub fn system() -> Self {
        Self {
            proc_root: PathBuf::from("/proc"),
            cgroup_root: PathBuf::from("/sys/fs/cgroup"),
        }
    }
}

/// What the discovery knows about the session.
#[derive(Debug, Clone)]
pub struct Want<'a> {
    pub uid: u32,
    /// The session's `Display` (`:0`).
    pub display: &'a str,
    /// The logind session id, when the service passed one.
    pub session_id: Option<&'a str>,
    pub runtime_dir: Option<&'a Path>,
    pub home: Option<&'a Path>,
}

/// How far below the cgroup root the session scope is looked for (`user.slice/user-<uid>.slice/
/// session-<id>.scope` is three levels; the bound keeps a hostile tree from being walked forever).
const SCOPE_DEPTH: usize = 6;

/// `:0`, `:0.0` and `unix:0` all name display 0 on this machine; a TCP display (`host:10.0`) is
/// compared by its whole name.
fn display_key(d: &str) -> String {
    let d = d.trim();
    let (host, rest) = match d.rfind(':') {
        Some(i) => (&d[..i], &d[i + 1..]),
        None => return d.to_string(),
    };
    let number = rest.split('.').next().unwrap_or(rest);
    let local = host.is_empty() || host == "unix";
    if local {
        format!(":{number}")
    } else {
        format!("{host}:{number}")
    }
}

fn find_scope(dir: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for e in entries.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        if e.file_name().to_string_lossy() == name {
            return Some(e.path());
        }
        subdirs.push(e.path());
    }
    subdirs.iter().find_map(|d| find_scope(d, name, depth - 1))
}

/// The pids in the session's scope, or `None` when the scope is not found.
fn scope_pids(roots: &Roots, session_id: &str) -> Option<Vec<u32>> {
    // A session id is short and alphanumeric (`2`, `c1`); anything else is not looked up.
    if session_id.is_empty()
        || session_id.len() > 32
        || !session_id.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        return None;
    }
    let scope = find_scope(
        &roots.cgroup_root,
        &format!("session-{session_id}.scope"),
        SCOPE_DEPTH,
    )?;
    let text = fs::read_to_string(scope.join("cgroup.procs")).ok()?;
    Some(text.lines().filter_map(|l| l.trim().parse().ok()).collect())
}

/// Every numeric `/proc` entry (the fallback when no scope is known: a dev run).
fn all_pids(roots: &Roots) -> Vec<u32> {
    let Ok(entries) = fs::read_dir(&roots.proc_root) else {
        return Vec::new();
    };
    let mut pids: Vec<u32> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().parse().ok())
        .collect();
    pids.sort_unstable();
    pids
}

/// The `XAUTHORITY` of process `pid` when it is ours and its `DISPLAY` is the one we want.
fn cookie_of(roots: &Roots, pid: u32, want: &Want<'_>) -> Option<PathBuf> {
    let dir = roots.proc_root.join(pid.to_string());
    // Only our own processes (the kernel would refuse the read of another uid's environ anyway).
    if fs::metadata(&dir).ok()?.uid() != want.uid {
        return None;
    }
    let raw = fs::read(dir.join("environ")).ok()?;
    let mut display = None;
    let mut xauth = None;
    for var in raw.split(|b| *b == 0) {
        let var = String::from_utf8_lossy(var);
        if let Some(v) = var.strip_prefix("DISPLAY=") {
            display = Some(v.to_string());
        } else if let Some(v) = var.strip_prefix("XAUTHORITY=") {
            xauth = Some(v.to_string());
        }
    }
    let (display, xauth) = (display?, xauth?);
    if display_key(&display) != display_key(want.display) {
        return None;
    }
    let path = PathBuf::from(xauth);
    (path.is_absolute() && path.is_file()).then_some(path)
}

/// F 8.4c: the cookie file for `want.display`, or `None` when none was found.
pub fn discover(roots: &Roots, want: &Want<'_>) -> Option<PathBuf> {
    let pids = want
        .session_id
        .and_then(|id| scope_pids(roots, id))
        .unwrap_or_else(|| all_pids(roots));
    if let Some(found) = pids.iter().find_map(|pid| cookie_of(roots, *pid, want)) {
        return Some(found);
    }
    let fallbacks = [
        want.runtime_dir.map(|r| r.join("gdm").join("Xauthority")),
        want.home.map(|h| h.join(".Xauthority")),
    ];
    fallbacks.into_iter().flatten().find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me() -> u32 {
        // SAFETY: getuid has no preconditions.
        unsafe { libc::getuid() }
    }

    struct Tree {
        root: PathBuf,
        roots: Roots,
    }

    impl Tree {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "ia-xauth-{tag}-{}-{}",
                std::process::id(),
                ia_core::rnd::hex(4)
            ));
            let roots = Roots {
                proc_root: root.join("proc"),
                cgroup_root: root.join("cgroup"),
            };
            fs::create_dir_all(&roots.proc_root).unwrap();
            fs::create_dir_all(&roots.cgroup_root).unwrap();
            Self { root, roots }
        }

        fn cookie(&self, name: &str) -> PathBuf {
            let p = self.root.join(name);
            fs::write(&p, b"MIT-MAGIC-COOKIE-1").unwrap();
            p
        }

        fn process(&self, pid: u32, env: &[(&str, &str)]) {
            let dir = self.roots.proc_root.join(pid.to_string());
            fs::create_dir_all(&dir).unwrap();
            let mut raw = Vec::new();
            for (k, v) in env {
                raw.extend_from_slice(format!("{k}={v}").as_bytes());
                raw.push(0);
            }
            fs::write(dir.join("environ"), raw).unwrap();
        }

        fn scope(&self, session: &str, pids: &[u32]) {
            let dir = self
                .roots
                .cgroup_root
                .join("user.slice/user-1000.slice")
                .join(format!("session-{session}.scope"));
            fs::create_dir_all(&dir).unwrap();
            let text: String = pids.iter().map(|p| format!("{p}\n")).collect();
            fs::write(dir.join("cgroup.procs"), text).unwrap();
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn want<'a>(display: &'a str, session: Option<&'a str>) -> Want<'a> {
        Want {
            uid: me(),
            display,
            session_id: session,
            runtime_dir: None,
            home: None,
        }
    }

    #[test]
    fn the_cookie_of_a_process_in_the_session_scope_with_the_same_display_is_found() {
        let t = Tree::new("scope");
        let right = t.cookie("right");
        let other = t.cookie("other");
        // A process outside the scope with the same display must not win over the scope.
        t.process(
            50,
            &[("DISPLAY", ":0"), ("XAUTHORITY", other.to_str().unwrap())],
        );
        t.process(101, &[("HOME", "/home/asha")]);
        t.process(
            102,
            &[("DISPLAY", ":0.0"), ("XAUTHORITY", right.to_str().unwrap())],
        );
        t.scope("2", &[101, 102]);
        assert_eq!(discover(&t.roots, &want(":0", Some("2"))), Some(right));
    }

    #[test]
    fn a_process_on_another_display_is_not_used() {
        let t = Tree::new("display");
        let c = t.cookie("c");
        t.process(7, &[("DISPLAY", ":1"), ("XAUTHORITY", c.to_str().unwrap())]);
        t.scope("3", &[7]);
        assert_eq!(discover(&t.roots, &want(":0", Some("3"))), None);
    }

    #[test]
    fn a_missing_or_relative_cookie_path_is_ignored() {
        let t = Tree::new("missing");
        t.process(
            8,
            &[("DISPLAY", ":0"), ("XAUTHORITY", "/nonexistent/ia-cookie")],
        );
        t.process(9, &[("DISPLAY", ":0"), ("XAUTHORITY", "relative/cookie")]);
        t.scope("4", &[8, 9]);
        assert_eq!(discover(&t.roots, &want(":0", Some("4"))), None);
    }

    #[test]
    fn without_a_session_id_our_own_processes_are_scanned() {
        let t = Tree::new("noscope");
        let c = t.cookie("c");
        t.process(
            300,
            &[("DISPLAY", ":97"), ("XAUTHORITY", c.to_str().unwrap())],
        );
        assert_eq!(discover(&t.roots, &want(":97", None)), Some(c));
    }

    #[test]
    fn a_process_owned_by_another_uid_is_never_read() {
        let t = Tree::new("uid");
        let c = t.cookie("c");
        t.process(
            400,
            &[("DISPLAY", ":0"), ("XAUTHORITY", c.to_str().unwrap())],
        );
        t.scope("5", &[400]);
        let w = Want {
            uid: me().wrapping_add(1),
            ..want(":0", Some("5"))
        };
        assert_eq!(discover(&t.roots, &w), None);
    }

    #[test]
    fn the_gdm_then_home_fallbacks_apply_in_that_order() {
        let t = Tree::new("fallback");
        let runtime = t.root.join("run");
        let home = t.root.join("home");
        fs::create_dir_all(runtime.join("gdm")).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join(".Xauthority"), b"x").unwrap();
        let w = Want {
            runtime_dir: Some(&runtime),
            home: Some(&home),
            ..want(":0", Some("6"))
        };
        assert_eq!(discover(&t.roots, &w), Some(home.join(".Xauthority")));
        fs::write(runtime.join("gdm/Xauthority"), b"x").unwrap();
        assert_eq!(discover(&t.roots, &w), Some(runtime.join("gdm/Xauthority")));
    }

    #[test]
    fn a_hostile_session_id_is_not_looked_up() {
        let t = Tree::new("hostile");
        assert_eq!(scope_pids(&t.roots, "../../etc"), None);
        assert_eq!(scope_pids(&t.roots, ""), None);
    }

    #[test]
    fn display_names_compare_by_server_number() {
        assert_eq!(display_key(":0"), display_key(":0.0"));
        assert_eq!(display_key("unix:0"), display_key(":0"));
        assert_ne!(display_key(":0"), display_key(":1"));
        assert_ne!(display_key("remote:10.0"), display_key(":10"));
    }
}
