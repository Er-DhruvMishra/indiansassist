//! The Linux trait impls that touch the OS (Phase E §7.7), behind `cfg(target_os = "linux")` and
//! the `linux-os` feature. Every path comes from [`XdgEnv`], so tests run them against a temporary
//! XDG root and never write the real `~/.local/share/applications` or `mimeapps.list`.

use std::fs;
use std::io::{self, Read, Write};
use std::os::linux::net::SocketAddrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{SocketAddr, UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::desktop;
use super::instance;
use super::paths::{self, XdgEnv};
use super::selfdel::{self, ArchiveFacts, SelfDeletePlan};
use crate::traits::{KnownFolders, ProtocolHandler, SelfDelete};

/// The real uid of this process.
pub fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

/// The effective uid (rule 7.3d: the agent refuses to run as root, `euid 0`).
pub fn euid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

/// Create `dir` (and parents) and make it private: mode 0700, owned by us. An existing directory
/// owned by someone else is refused.
pub fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let meta = fs::symlink_metadata(dir)?;
    if !meta.is_dir() || meta.uid() != uid() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{} is not a directory owned by this user", dir.display()),
        ));
    }
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

fn write_atomic(path: &Path, text: &str, mode: u32) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("ia-tmp-{}", std::process::id()));
    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

/// The `indiansassist://` handler (§7.7) for one XDG environment.
#[derive(Debug, Clone)]
pub struct LinuxProtocolHandler {
    pub env: XdgEnv,
}

impl LinuxProtocolHandler {
    pub fn from_process() -> Self {
        Self {
            env: XdgEnv::from_process(),
        }
    }
}

impl ProtocolHandler for LinuxProtocolHandler {
    /// Write the `.desktop` file and make it the scheme default in `mimeapps.list`, remembering
    /// the previous default (once: a second start does not overwrite the remembered value).
    fn register(&self, exe_path: &str) -> io::Result<()> {
        let none = || io::Error::new(io::ErrorKind::NotFound, "no XDG data / config home");
        let desktop_path = paths::desktop_file(&self.env).ok_or_else(none)?;
        write_atomic(&desktop_path, &desktop::desktop_entry(exe_path), 0o644)?;
        let list = paths::mimeapps_list(&self.env).ok_or_else(none)?;
        let before = fs::read_to_string(&list).unwrap_or_default();
        let edit = desktop::set_default(&before);
        if let Some(backup) = paths::mimeapps_backup(&self.env) {
            if let Some(dir) = backup.parent() {
                ensure_private_dir(dir)?;
            }
            if !backup.exists() {
                write_atomic(&backup, edit.previous.as_deref().unwrap_or(""), 0o600)?;
            }
        }
        if edit.text != before {
            write_atomic(&list, &edit.text, 0o644)?;
        }
        Ok(())
    }

    /// Remove the `.desktop` file and restore the previous scheme default.
    fn unregister(&self) -> io::Result<()> {
        if let Some(d) = paths::desktop_file(&self.env) {
            let _ = fs::remove_file(d);
        }
        let previous = paths::mimeapps_backup(&self.env)
            .and_then(|b| fs::read_to_string(b).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if let Some(list) = paths::mimeapps_list(&self.env) {
            if let Ok(text) = fs::read_to_string(&list) {
                let restored = desktop::restore_default(&text, previous.as_deref());
                if restored != text {
                    write_atomic(&list, &restored, 0o644)?;
                }
            }
        }
        if let Some(b) = paths::mimeapps_backup(&self.env) {
            let _ = fs::remove_file(b);
        }
        Ok(())
    }
}

/// Known folders (§7.7): downloads per §7.3f, `local_app_data` = `$XDG_DATA_HOME`.
#[derive(Debug, Clone)]
pub struct LinuxKnownFolders {
    pub env: XdgEnv,
}

impl LinuxKnownFolders {
    pub fn from_process() -> Self {
        Self {
            env: XdgEnv::from_process(),
        }
    }
}

impl KnownFolders for LinuxKnownFolders {
    fn downloads(&self) -> Option<PathBuf> {
        let dirs = self
            .env
            .config_home()
            .and_then(|c| fs::read_to_string(c.join("user-dirs.dirs")).ok());
        paths::downloads_dir(&self.env, dirs.as_deref())
    }
    fn local_app_data(&self) -> Option<PathBuf> {
        self.env.data_home()
    }
}

/// What applying a plan did (logged by the agent).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SelfDeleteReport {
    pub removed: Vec<PathBuf>,
    pub kept_copy: Option<PathBuf>,
    pub failures: Vec<String>,
}

fn archive_facts(path: &Path) -> Option<ArchiveFacts> {
    let m = fs::symlink_metadata(path).ok()?;
    Some(ArchiveFacts {
        regular_file: m.file_type().is_file(),
        owner_uid: m.uid(),
        size: m.len(),
    })
}

/// Apply a self-delete plan (C §10, §7.7). Refuses a plan that is not contained to the agent's
/// own files. The binary is unlinked last.
pub fn apply_self_delete(
    plan: &SelfDeletePlan,
    env: &XdgEnv,
    exe: &Path,
) -> io::Result<SelfDeleteReport> {
    if !selfdel::plan_is_contained(plan, exe) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "self-delete plan reaches outside the agent's files",
        ));
    }
    let mut report = SelfDeleteReport::default();
    if let Some((from, to)) = &plan.keep_copy {
        if let Some(dir) = to.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::copy(from, to)?;
        fs::set_permissions(to, fs::Permissions::from_mode(0o755))?;
        LinuxProtocolHandler { env: env.clone() }.register(&to.to_string_lossy())?;
        report.kept_copy = Some(to.clone());
    }
    if plan.restore_mimeapps {
        if let Err(e) = (LinuxProtocolHandler { env: env.clone() }).unregister() {
            report.failures.push(format!("handler: {e}"));
        }
    }
    for f in &plan.remove_files {
        match fs::remove_file(f) {
            Ok(()) => report.removed.push(f.clone()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => report.failures.push(format!("{}: {e}", f.display())),
        }
    }
    for d in &plan.remove_dirs {
        match fs::remove_dir_all(d) {
            Ok(()) => report.removed.push(d.clone()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => report.failures.push(format!("{}: {e}", d.display())),
        }
    }
    if let Some(a) = &plan.archive {
        if archive_facts(a).is_some_and(|f| selfdel::archive_removable(&f, uid())) {
            match fs::remove_file(a) {
                Ok(()) => report.removed.push(a.clone()),
                Err(e) => report.failures.push(format!("{}: {e}", a.display())),
            }
        }
    }
    if let Some(e) = &plan.unlink_exe {
        match fs::remove_file(e) {
            Ok(()) => report.removed.push(e.clone()),
            Err(err) => report.failures.push(format!("{}: {err}", e.display())),
        }
    }
    Ok(report)
}

/// `SelfDelete` for the running binary (§7.7).
#[derive(Debug, Clone)]
pub struct LinuxSelfDelete {
    pub env: XdgEnv,
}

impl SelfDelete for LinuxSelfDelete {
    fn self_delete(&self, kept: bool) -> io::Result<()> {
        let exe = std::env::current_exe()?;
        let plan = selfdel::plan(&self.env, &exe, kept);
        let report = apply_self_delete(&plan, &self.env, &exe)?;
        if report.failures.is_empty() {
            Ok(())
        } else {
            Err(io::Error::other(report.failures.join("; ")))
        }
    }
}

// ---- single instance -----------------------------------------------------------------------

/// The peer's credentials from `SO_PEERCRED`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerCred {
    pub pid: i32,
    pub uid: u32,
}

/// `getsockopt(SO_PEERCRED)` on a connected Unix stream.
pub fn peer_cred(s: &UnixStream) -> io::Result<PeerCred> {
    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: `cred` and `len` are valid for writes of the sizes passed; the fd is open for the
    // life of `s`.
    let rc = unsafe {
        libc::getsockopt(
            s.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(PeerCred {
        pid: cred.pid,
        uid: cred.uid,
    })
}

/// Read (or create, once) the random part of the socket name in the runtime dir.
pub fn instance_rand(env: &XdgEnv) -> io::Result<String> {
    let file = paths::instance_file(env)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no runtime dir"))?;
    if let Some(dir) = file.parent() {
        ensure_private_dir(dir)?;
    }
    if let Ok(s) = fs::read_to_string(&file) {
        let s = s.trim().to_string();
        if instance::valid_rand(&s) {
            return Ok(s);
        }
        let _ = fs::remove_file(&file);
    }
    let rand = ia_core::rnd::hex(8);
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&file)
    {
        Ok(mut f) => {
            f.write_all(rand.as_bytes())?;
            Ok(rand)
        }
        // Another instance created it meanwhile: use theirs.
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            let s = fs::read_to_string(&file)?.trim().to_string();
            if instance::valid_rand(&s) {
                Ok(s)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "bad instance file",
                ))
            }
        }
        Err(e) => Err(e),
    }
}

/// The outcome of trying to become the single instance.
#[derive(Debug)]
pub enum InstanceOutcome {
    /// This process holds the name; call [`InstanceServer::spawn`] to serve forwards.
    Primary(InstanceServer),
    /// Another instance of this image, run by this user, holds it; the message was forwarded.
    Forwarded,
    /// The name is held by something that failed the peer checks (another user, another image).
    /// The agent does not forward to it and carries on as its own instance.
    Squatted(String),
}

/// The listening side of the single-instance socket.
#[derive(Debug)]
pub struct InstanceServer {
    listener: UnixListener,
    my_uid: u32,
}

impl InstanceServer {
    /// Serve forwarded starts on a thread: each accepted client is checked with `SO_PEERCRED`
    /// (same uid only), one line of at most [`instance::FORWARD_MAX_BYTES`] is read and handed to
    /// `on_forward`.
    pub fn spawn<F>(self, on_forward: F) -> io::Result<std::thread::JoinHandle<()>>
    where
        F: Fn(String) + Send + 'static,
    {
        std::thread::Builder::new()
            .name("ia-instance".into())
            .spawn(move || {
                for conn in self.listener.incoming() {
                    let Ok(mut s) = conn else { continue };
                    let ok = peer_cred(&s)
                        .map(|c| instance::server_accepts(c.uid, self.my_uid))
                        .unwrap_or(false);
                    if !ok {
                        continue;
                    }
                    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
                    let mut buf = Vec::new();
                    let _ = (&mut s)
                        .take(instance::FORWARD_MAX_BYTES as u64)
                        .read_to_end(&mut buf);
                    let line = String::from_utf8_lossy(&buf)
                        .lines()
                        .next()
                        .unwrap_or("")
                        .to_string();
                    on_forward(line);
                }
            })
    }
}

fn abstract_addr(env: &XdgEnv) -> io::Result<SocketAddr> {
    let rand = instance_rand(env)?;
    SocketAddr::from_abstract_name(instance::socket_name(uid(), &rand).as_bytes())
}

/// Become the single instance, or forward `message` (one line) to the running one (§7.7).
pub fn acquire_single_instance(env: &XdgEnv, message: &str) -> io::Result<InstanceOutcome> {
    let addr = abstract_addr(env)?;
    match UnixListener::bind_addr(&addr) {
        Ok(listener) => Ok(InstanceOutcome::Primary(InstanceServer {
            listener,
            my_uid: uid(),
        })),
        Err(e) if e.kind() == io::ErrorKind::AddrInUse => {
            let mut s = UnixStream::connect_addr(&addr)?;
            let cred = peer_cred(&s)?;
            let server_exe = fs::read_link(format!("/proc/{}/exe", cred.pid)).ok();
            let my_exe = std::env::current_exe()?;
            if !instance::client_forwards(cred.uid, uid(), server_exe.as_deref(), &my_exe) {
                return Ok(InstanceOutcome::Squatted(format!(
                    "the single-instance name is held by pid {} (uid {})",
                    cred.pid, cred.uid
                )));
            }
            let line: String = message
                .chars()
                .filter(|c| *c != '\n' && *c != '\r')
                .take(instance::FORWARD_MAX_BYTES - 1)
                .collect();
            s.write_all(line.as_bytes())?;
            s.write_all(b"\n")?;
            Ok(InstanceOutcome::Forwarded)
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "ia-linux-os-{tag}-{}-{}",
            std::process::id(),
            ia_core::rnd::hex(4)
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn env_in(root: &Path) -> XdgEnv {
        XdgEnv {
            home: Some(root.join("home")),
            data_home: Some(root.join("data")),
            config_home: Some(root.join("config")),
            state_home: Some(root.join("state")),
            runtime_dir: Some(root.join("runtime")),
        }
    }

    #[test]
    fn the_handler_is_written_and_restored_under_a_temporary_xdg_root() {
        let root = temp_root("handler");
        let env = env_in(&root);
        let list = paths::mimeapps_list(&env).unwrap();
        fs::create_dir_all(list.parent().unwrap()).unwrap();
        let before = "[Default Applications]\nx-scheme-handler/indiansassist=old.desktop\n";
        fs::write(&list, before).unwrap();
        let h = LinuxProtocolHandler { env: env.clone() };
        h.register("/opt/x/IndiansAssist-in-mum-4821-9365-7715")
            .unwrap();
        let desktop = fs::read_to_string(paths::desktop_file(&env).unwrap()).unwrap();
        assert!(desktop.contains("--url %u"));
        assert!(fs::read_to_string(&list)
            .unwrap()
            .contains("=indiansassist-handler.desktop"));
        // A second start keeps the first remembered value.
        h.register("/opt/x/IndiansAssist-in-mum-4821-9365-7715")
            .unwrap();
        h.unregister().unwrap();
        assert_eq!(fs::read_to_string(&list).unwrap(), before);
        assert!(!paths::desktop_file(&env).unwrap().exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_plan_applied_to_a_copy_removes_exactly_the_working_set() {
        let root = temp_root("selfdel");
        let env = env_in(&root);
        let dl = root.join("home/Downloads");
        fs::create_dir_all(dl.join("IndiansAssist")).unwrap();
        let exe = dl.join("IndiansAssist-in-mum-4821-9365-7715");
        fs::write(&exe, b"\x7fELF fake").unwrap();
        fs::write(dl.join("IndiansAssist-in-mum-4821-9365-7715.tar.gz"), b"gz").unwrap();
        fs::write(
            dl.join("IndiansAssist-in-mum-4821-9365-7715.iaconfig"),
            b"{}",
        )
        .unwrap();
        fs::write(dl.join("IndiansAssist/received.txt"), b"kept").unwrap();
        fs::write(dl.join("unrelated.tar.gz"), b"not ours").unwrap();
        ensure_private_dir(&paths::run_dir(&env).unwrap()).unwrap();
        fs::create_dir_all(paths::state_dir(&env).unwrap()).unwrap();
        fs::write(paths::log_file(&env).unwrap(), b"log").unwrap();
        LinuxProtocolHandler { env: env.clone() }
            .register(&exe.to_string_lossy())
            .unwrap();

        let plan = selfdel::plan(&env, &exe, false);
        let report = apply_self_delete(&plan, &env, &exe).unwrap();
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert!(!exe.exists());
        assert!(!dl
            .join("IndiansAssist-in-mum-4821-9365-7715.tar.gz")
            .exists());
        assert!(!dl
            .join("IndiansAssist-in-mum-4821-9365-7715.iaconfig")
            .exists());
        assert!(!paths::runtime_dir(&env).unwrap().exists());
        assert!(!paths::state_dir(&env).unwrap().exists());
        assert!(!paths::desktop_file(&env).unwrap().exists());
        // Received files and anything else are untouched (C §10 D1).
        assert!(dl.join("IndiansAssist/received.txt").exists());
        assert!(dl.join("unrelated.tar.gz").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_oversized_archive_sibling_is_left_alone() {
        let root = temp_root("bigarchive");
        let env = env_in(&root);
        let exe = root.join("IndiansAssist-in-mum-4821-9365-7715");
        fs::write(&exe, b"x").unwrap();
        let archive = root.join("IndiansAssist-in-mum-4821-9365-7715.tar.gz");
        let f = fs::File::create(&archive).unwrap();
        f.set_len(selfdel::ARCHIVE_MAX_BYTES + 1).unwrap();
        let plan = selfdel::plan(&env, &exe, false);
        apply_self_delete(&plan, &env, &exe).unwrap();
        assert!(archive.exists());
        assert!(!exe.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_runtime_dir_is_private_and_the_instance_rand_is_stable() {
        let root = temp_root("instance");
        let env = env_in(&root);
        let a = instance_rand(&env).unwrap();
        let b = instance_rand(&env).unwrap();
        assert_eq!(a, b);
        assert!(instance::valid_rand(&a));
        let mode = fs::metadata(paths::runtime_dir(&env).unwrap())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_second_start_of_the_same_image_is_forwarded_to_the_first() {
        let root = temp_root("forward");
        let env = env_in(&root);
        let first = match acquire_single_instance(&env, "").unwrap() {
            InstanceOutcome::Primary(s) => s,
            other => panic!("first start must be primary: {other:?}"),
        };
        let (tx, rx) = std::sync::mpsc::channel();
        first
            .spawn(move |line| {
                let _ = tx.send(line);
            })
            .unwrap();
        // Same process = same uid and same /proc/<pid>/exe: the client checks pass.
        match acquire_single_instance(&env, "indiansassist://join?c=1234\nsecond line").unwrap() {
            InstanceOutcome::Forwarded => {}
            other => panic!("second start must forward: {other:?}"),
        }
        let got = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(got, "indiansassist://join?c=1234second line");
        let _ = fs::remove_dir_all(&root);
    }
}
