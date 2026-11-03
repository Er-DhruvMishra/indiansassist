//! The macOS implementations of the platform traits (Phase F §17.2) and the calls that need the
//! OS: the self-delete applier, the single-instance socket with its `getpeereid` and image check.

use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::Command;

use ia_core::types::ElevationLevel;

use super::instance::{forward_message_ok, server_accepts};
use super::paths::{self, MacEnv};
use super::selfdel::{self, SelfDeletePlan};
use crate::traits::{
    Elevation, ElevationError, HandoverBlob, KnownFolders, ProtocolHandler, SelfDelete,
};

pub fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

/// `user` always: the macOS agent never runs elevated and has no hand-over (§17.2).
#[derive(Debug, Default, Clone, Copy)]
pub struct MacElevation;

impl Elevation for MacElevation {
    fn integrity(&self) -> ElevationLevel {
        ElevationLevel::User
    }

    fn relaunch_and_handover(&mut self, _blob: &HandoverBlob) -> Result<(), ElevationError> {
        // There is no elevated instance to hand over to on macOS (§17.2: `elevation: user`).
        Err(ElevationError::LaunchFailed)
    }
}

/// The deep link is `CFBundleURLTypes` in the bundle's `Info.plist`; Launch Services learns it
/// when the bundle is first opened, so nothing is written at run time (§17.2).
#[derive(Debug, Default, Clone, Copy)]
pub struct MacProtocolHandler;

impl ProtocolHandler for MacProtocolHandler {
    fn register(&self, _exe_path: &str) -> io::Result<()> {
        Ok(())
    }

    fn unregister(&self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct MacKnownFolders {
    pub env: MacEnv,
}

impl MacKnownFolders {
    pub fn from_process() -> Self {
        Self {
            env: MacEnv::from_process(),
        }
    }
}

impl KnownFolders for MacKnownFolders {
    fn downloads(&self) -> Option<PathBuf> {
        paths::downloads_dir(&self.env)
    }

    fn local_app_data(&self) -> Option<PathBuf> {
        paths::support_dir(&self.env)
    }
}

/// What applying a plan did (logged by the agent).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SelfDeleteReport {
    pub removed: Vec<PathBuf>,
    pub kept_copy: Option<PathBuf>,
    pub failures: Vec<String>,
}

/// Keep (rule 3.4c): copies the bundle `from` to `to` with `ditto` (which keeps the signature)
/// into a new sibling first, then swaps it in by renames, so `to` never holds a half-copied or
/// merged bundle; an older kept app is replaced, not overlaid. `~/Applications` is created when
/// missing (no administrator needed).
fn keep_bundle(from: &Path, to: &Path) -> io::Result<()> {
    let dir = to
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no parent"))?;
    fs::create_dir_all(dir)?;
    let tag = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    );
    let fresh = dir.join(format!(".IndiansAssist.app.{tag}.new"));
    let status = Command::new("/usr/bin/ditto")
        .arg(from)
        .arg(&fresh)
        .status()?;
    if !status.success() {
        let _ = fs::remove_dir_all(&fresh);
        return Err(io::Error::other(format!("ditto exited with {status}")));
    }
    let old = dir.join(format!(".IndiansAssist.app.{tag}.old"));
    let had_old = match fs::symlink_metadata(to) {
        Ok(_) => {
            fs::rename(to, &old)?;
            true
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => false,
        Err(e) => return Err(e),
    };
    if let Err(e) = fs::rename(&fresh, to) {
        if had_old {
            let _ = fs::rename(&old, to);
        }
        let _ = fs::remove_dir_all(&fresh);
        return Err(e);
    }
    if had_old {
        let _ = fs::remove_dir_all(&old);
    }
    Ok(())
}

/// Apply a self-delete plan. Refuses a plan that is not contained to the agent's own files; the
/// bundle goes last. `ditto` copies a kept bundle with its extended attributes and signature.
pub fn apply_self_delete(
    plan: &SelfDeletePlan,
    env: &MacEnv,
    exe: &Path,
) -> io::Result<SelfDeleteReport> {
    if !selfdel::plan_is_contained(plan, env, exe) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "self-delete plan reaches outside the agent's files",
        ));
    }
    let mut report = SelfDeleteReport::default();
    if let Some((from, to)) = &plan.keep_copy {
        keep_bundle(from, to)?;
        report.kept_copy = Some(to.clone());
    }
    for f in &plan.remove_files {
        match fs::remove_file(f) {
            Ok(()) => report.removed.push(f.clone()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => report.failures.push(format!("{}: {e}", f.display())),
        }
    }
    for d in plan.remove_dirs.iter().chain(plan.remove_bundle.iter()) {
        // Never follow a symlink planted in place of the directory.
        match fs::symlink_metadata(d) {
            Ok(m) if m.file_type().is_dir() => match fs::remove_dir_all(d) {
                Ok(()) => report.removed.push(d.clone()),
                Err(e) => report.failures.push(format!("{}: {e}", d.display())),
            },
            Ok(_) => report
                .failures
                .push(format!("{}: not a directory", d.display())),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => report.failures.push(format!("{}: {e}", d.display())),
        }
    }
    Ok(report)
}

/// `SelfDelete` for the running app (§17.2).
#[derive(Debug, Clone)]
pub struct MacSelfDelete {
    pub env: MacEnv,
}

impl SelfDelete for MacSelfDelete {
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

/// The peer's uid and pid: `getpeereid` and `LOCAL_PEERPID`.
pub fn peer_identity(s: &UnixStream) -> io::Result<(u32, i32)> {
    let fd = s.as_raw_fd();
    let (mut uid, mut gid) = (0 as libc::uid_t, 0 as libc::gid_t);
    // SAFETY: a connected Unix socket and two out-parameters.
    if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    // SAFETY: LOCAL_PEERPID writes one pid_t into `pid`.
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut len,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((uid, pid))
}

/// The executable image of a process (`proc_pidpath`).
pub fn process_image(pid: i32) -> Option<PathBuf> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer is PROC_PIDPATHINFO_MAXSIZE bytes long.
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(&buf)))
}

/// How long either side of a forward waits for the other.
const FORWARD_ACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// What [`acquire_single_instance`] found.
pub enum InstanceOutcome {
    /// This process is the instance; serve forwarded messages with [`InstanceServer::spawn`].
    First(InstanceServer),
    /// Another instance took the message; this process should exit.
    Forwarded,
}

pub struct InstanceServer {
    listener: UnixListener,
    path: PathBuf,
}

impl InstanceServer {
    /// Accept forwarded lines on a thread and hand each valid one to `on_forward`.
    pub fn spawn<F>(self, on_forward: F) -> io::Result<std::thread::JoinHandle<()>>
    where
        F: Fn(String) + Send + 'static,
    {
        let my_image = std::env::current_exe()?.canonicalize()?;
        let my_uid = uid();
        std::thread::Builder::new()
            .name("ia-instance".into())
            .spawn(move || {
                for mut conn in self.listener.incoming().flatten() {
                    let Ok((peer_uid, pid)) = peer_identity(&conn) else {
                        continue;
                    };
                    let image = process_image(pid).and_then(|p| p.canonicalize().ok());
                    if !server_accepts(peer_uid, my_uid, image.as_deref(), &my_image) {
                        continue;
                    }
                    let _ = conn.set_read_timeout(Some(FORWARD_ACK_TIMEOUT));
                    let mut line = String::new();
                    if BufReader::new(&conn)
                        .take(4097)
                        .read_line(&mut line)
                        .is_ok()
                        && forward_message_ok(&line)
                    {
                        let _ = conn.write_all(b"ok\n");
                        on_forward(line.trim_end().to_string());
                    }
                }
                let _ = fs::remove_file(&self.path);
            })
    }
}

/// Become the single instance, or forward `message` to the one already running. A stale socket
/// file (nobody listening) is replaced; a path that is not a socket owned by this user is refused.
pub fn acquire_single_instance(env: &MacEnv, message: &str) -> io::Result<InstanceOutcome> {
    let path = paths::instance_socket(env, uid())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no TMPDIR"))?;
    if let Ok(mut s) = UnixStream::connect(&path) {
        // Stay connected until the instance answers: it checks this peer (`getpeereid`,
        // `LOCAL_PEERPID`) while the connection is open, and only an `ok` means it took the link.
        s.set_read_timeout(Some(FORWARD_ACK_TIMEOUT))?;
        s.write_all(format!("{message}\n").as_bytes())?;
        let mut ack = String::new();
        BufReader::new(&s).take(8).read_line(&mut ack)?;
        if ack.trim_end() == "ok" {
            return Ok(InstanceOutcome::Forwarded);
        }
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the running instance refused the link",
        ));
    }
    match fs::symlink_metadata(&path) {
        Ok(m) if m.file_type().is_socket_like() && m.uid() == uid() => fs::remove_file(&path)?,
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "the instance socket path is taken by something else",
            ))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let listener = UnixListener::bind(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    Ok(InstanceOutcome::First(InstanceServer { listener, path }))
}

trait SocketLike {
    fn is_socket_like(&self) -> bool;
}

impl SocketLike for fs::FileType {
    fn is_socket_like(&self) -> bool {
        std::os::unix::fs::FileTypeExt::is_socket(self)
    }
}

/// Create `dir` (and parents) as a 0700 directory owned by this user.
pub fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let m = fs::symlink_metadata(dir)?;
    if !m.is_dir() || m.uid() != uid() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "not a directory owned by this user",
        ));
    }
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temp root standing in for `$HOME` (S7: plans are applied to temporary directories only).
    fn temp_home(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ia-macos-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn fake_bundle(home: &Path) -> PathBuf {
        let exe = home.join("Downloads/IndiansAssist.app/Contents/MacOS/IndiansAssist");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"#!/bin/sh\n").unwrap();
        fs::write(home.join("Downloads/IndiansAssist.iaconfig"), b"{}").unwrap();
        let support = home.join("Library/Application Support/IndiansAssist");
        fs::create_dir_all(&support).unwrap();
        fs::write(support.join("agent.log"), b"log").unwrap();
        fs::create_dir_all(home.join("Downloads/IndiansAssist")).unwrap();
        fs::write(
            home.join("Downloads/IndiansAssist/received.txt"),
            b"keep me",
        )
        .unwrap();
        exe
    }

    #[test]
    fn a_clean_exit_removes_the_bundle_sidecar_and_support_dir_but_not_received_files() {
        let home = temp_home("clean");
        let exe = fake_bundle(&home);
        let env = MacEnv {
            home: Some(home.clone()),
            tmpdir: None,
        };
        let report = apply_self_delete(&selfdel::plan(&env, &exe, false), &env, &exe).unwrap();
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert!(!home.join("Downloads/IndiansAssist.app").exists());
        assert!(!home.join("Downloads/IndiansAssist.iaconfig").exists());
        assert!(!home
            .join("Library/Application Support/IndiansAssist")
            .exists());
        assert!(home.join("Downloads/IndiansAssist/received.txt").exists());
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn keep_replaces_an_older_kept_app_and_a_kept_app_running_again_only_clears_logs() {
        let home = temp_home("rekeep");
        let exe = fake_bundle(&home);
        let env = MacEnv {
            home: Some(home.clone()),
            tmpdir: None,
        };
        // An older kept app with a file the new bundle does not have.
        let kept = home.join("Applications/IndiansAssist.app");
        fs::create_dir_all(kept.join("Contents/Resources")).unwrap();
        fs::write(kept.join("Contents/Resources/stale.txt"), b"old").unwrap();
        apply_self_delete(&selfdel::plan(&env, &exe, true), &env, &exe).unwrap();
        assert!(kept.join("Contents/MacOS/IndiansAssist").exists());
        assert!(
            !kept.join("Contents/Resources/stale.txt").exists(),
            "replaced, not merged"
        );
        let leftovers: Vec<_> = fs::read_dir(home.join("Applications"))
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert_eq!(
            leftovers,
            vec![std::ffi::OsString::from("IndiansAssist.app")]
        );
        // The kept app runs again and keeps: nothing copied, the logs go, the app stays.
        let kept_exe = kept.join("Contents/MacOS/IndiansAssist");
        let support = home.join("Library/Application Support/IndiansAssist");
        fs::create_dir_all(&support).unwrap();
        fs::write(support.join("agent.log"), b"log").unwrap();
        let r = apply_self_delete(&selfdel::plan(&env, &kept_exe, true), &env, &kept_exe).unwrap();
        assert_eq!(r.kept_copy, None);
        assert!(!support.exists());
        assert!(kept_exe.exists());
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn keep_copies_the_bundle_into_applications_and_leaves_the_rest() {
        let home = temp_home("keep");
        let exe = fake_bundle(&home);
        let env = MacEnv {
            home: Some(home.clone()),
            tmpdir: None,
        };
        let report = apply_self_delete(&selfdel::plan(&env, &exe, true), &env, &exe).unwrap();
        assert_eq!(
            report.kept_copy,
            Some(home.join("Applications/IndiansAssist.app"))
        );
        assert!(home
            .join("Applications/IndiansAssist.app/Contents/MacOS/IndiansAssist")
            .exists());
        assert!(home.join("Downloads/IndiansAssist.app").exists());
        // Rule 3.4c: the logs and state go; the sidecar and received files stay.
        assert!(!home
            .join("Library/Application Support/IndiansAssist")
            .exists());
        assert!(home.join("Downloads/IndiansAssist.iaconfig").exists());
        assert!(home.join("Downloads/IndiansAssist/received.txt").exists());
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_symlink_in_place_of_the_support_dir_is_not_followed() {
        let home = temp_home("link");
        let exe = fake_bundle(&home);
        let support = home.join("Library/Application Support/IndiansAssist");
        fs::remove_dir_all(&support).unwrap();
        let victim = home.join("victim");
        fs::create_dir_all(&victim).unwrap();
        fs::write(victim.join("precious"), b"x").unwrap();
        std::os::unix::fs::symlink(&victim, &support).unwrap();
        let env = MacEnv {
            home: Some(home.clone()),
            tmpdir: None,
        };
        let report = apply_self_delete(&selfdel::plan(&env, &exe, false), &env, &exe).unwrap();
        assert!(victim.join("precious").exists());
        assert!(report
            .failures
            .iter()
            .any(|f| f.contains("not a directory")));
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn the_second_instance_forwards_its_message_to_the_first() {
        let tmp = temp_home("instance");
        let env = MacEnv {
            home: None,
            tmpdir: Some(tmp.clone()),
        };
        let InstanceOutcome::First(server) = acquire_single_instance(&env, "focus").unwrap() else {
            panic!("the first call becomes the instance");
        };
        let (tx, rx) = std::sync::mpsc::channel();
        server
            .spawn(move |m| {
                let _ = tx.send(m);
            })
            .unwrap();
        assert!(matches!(
            acquire_single_instance(&env, "indiansassist://join?t=abc").unwrap(),
            InstanceOutcome::Forwarded
        ));
        let got = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(got, "indiansassist://join?t=abc");
        let mode = fs::metadata(paths::instance_socket(&env, uid()).unwrap())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn elevation_is_user_with_no_hand_over() {
        let e = MacElevation;
        assert_eq!(e.integrity(), ElevationLevel::User);
    }
}
