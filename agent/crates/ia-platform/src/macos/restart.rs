//! The restart hand-off (Phase F §17.2): macOS applies a new Screen Recording grant only to a
//! fresh process. While the permissions window runs (before the agent connects, so the support
//! code is not used yet), the start-up arguments are kept in a file only this user can read; a
//! start with no arguments within [`MAX_AGE_SECS`] (System Settings' "Quit & Reopen", or the
//! window's own "Restart IndiansAssist") takes them back and removes the file.
//!
//! The format is plain lines with every value hex-encoded, so no value can break a line:
//!
//! ```text
//! ia-restart 1
//! at <unix seconds>
//! arg <hex>
//! env <hex name> <hex value>
//! log <hex path>
//! ```

use std::path::PathBuf;

use super::paths::MacEnv;

/// How long a hand-off is honoured: long enough for System Settings' quit-and-reopen, short
/// enough that a code left behind by a crash is not picked up by a later, unrelated start.
pub const MAX_AGE_SECS: u64 = 600;

/// The environment variables a restart carries (the dev switches and the log filter).
pub const CARRIED_ENV: &[&str] = &["IA_ICE_LOOPBACK", "RUST_LOG"];

/// What a restart takes back.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Handoff {
    /// The command-line arguments, without the program name.
    pub args: Vec<String>,
    /// `(name, value)` of the [`CARRIED_ENV`] variables that were set.
    pub env: Vec<(String, String)>,
    /// Dev builds: the file stdout and stderr went to, so the restarted process logs there too.
    pub log: Option<PathBuf>,
}

fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<String> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect();
    String::from_utf8(bytes?).ok()
}

/// The file's text for `h`, stamped `now` (unix seconds).
pub fn encode(h: &Handoff, now: u64) -> String {
    let mut out = format!("ia-restart 1\nat {now}\n");
    for a in &h.args {
        out.push_str(&format!("arg {}\n", hex(a)));
    }
    for (k, v) in &h.env {
        out.push_str(&format!("env {} {}\n", hex(k), hex(v)));
    }
    if let Some(p) = h.log.as_ref().and_then(|p| p.to_str()) {
        out.push_str(&format!("log {}\n", hex(p)));
    }
    out
}

/// The hand-off in `text`, if it is well formed, stamped within [`MAX_AGE_SECS`] before `now`
/// (and not in the future), and names only [`CARRIED_ENV`] variables.
pub fn decode(text: &str, now: u64) -> Option<Handoff> {
    let mut lines = text.lines();
    if lines.next()? != "ia-restart 1" {
        return None;
    }
    let at: u64 = lines.next()?.strip_prefix("at ")?.parse().ok()?;
    if at > now || now - at > MAX_AGE_SECS {
        return None;
    }
    let mut h = Handoff::default();
    for line in lines {
        let mut parts = line.split(' ');
        match (parts.next()?, parts.next(), parts.next(), parts.next()) {
            ("arg", Some(a), None, None) => h.args.push(unhex(a)?),
            ("env", Some(k), Some(v), None) => {
                let k = unhex(k)?;
                if !CARRIED_ENV.contains(&k.as_str()) {
                    return None;
                }
                h.env.push((k, unhex(v)?));
            }
            ("log", Some(p), None, None) => h.log = Some(PathBuf::from(unhex(p)?)),
            _ => return None,
        }
    }
    Some(h)
}

/// `$TMPDIR/indiansassist-restart-<uid>`: the per-user temporary directory (0700, this user's).
pub fn handoff_path(env: &MacEnv, uid: u32) -> Option<PathBuf> {
    Some(
        env.tmpdir
            .as_ref()?
            .join(format!("indiansassist-restart-{uid}")),
    )
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Writes the hand-off (mode 0600, through a new temporary file renamed into place, so a
/// reader never sees half of it and an existing link is replaced, not followed).
pub fn save(env: &MacEnv, uid: u32, h: &Handoff) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let path = handoff_path(env, uid).ok_or(std::io::ErrorKind::NotFound)?;
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(encode(h, now_secs()).as_bytes())?;
    f.sync_all()?;
    std::fs::rename(&tmp, &path)
}

/// Removes the hand-off (the window was answered, or the restart took it back).
pub fn clear(env: &MacEnv, uid: u32) {
    if let Some(path) = handoff_path(env, uid) {
        let _ = std::fs::remove_file(path);
    }
}

/// Takes the hand-off back, if there is a fresh one that is a plain file of this user with mode
/// 0600; it is removed either way, so a code is never picked up twice.
pub fn take(env: &MacEnv, uid: u32) -> Option<Handoff> {
    use std::os::unix::fs::MetadataExt;
    let path = handoff_path(env, uid)?;
    let meta = std::fs::symlink_metadata(&path).ok()?;
    let text = std::fs::read_to_string(&path);
    clear(env, uid);
    if !meta.file_type().is_file() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
        return None;
    }
    decode(&text.ok()?, now_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Handoff {
        Handoff {
            args: vec![
                "--code".into(),
                "1234 5678 9012".into(),
                "--api-origin".into(),
                "http://127.0.0.1:4171".into(),
            ],
            env: vec![("IA_ICE_LOOPBACK".into(), "1".into())],
            log: Some(PathBuf::from("/tmp/a log.txt")),
        }
    }

    #[test]
    fn a_hand_off_round_trips_and_every_value_is_hex() {
        let text = encode(&sample(), 1000);
        assert!(!text.contains("1234"), "values are hex-encoded: {text}");
        assert_eq!(decode(&text, 1000), Some(sample()));
        assert_eq!(decode(&text, 1000 + MAX_AGE_SECS), Some(sample()));
    }

    #[test]
    fn a_stale_future_or_malformed_hand_off_is_refused() {
        let text = encode(&sample(), 1000);
        assert_eq!(decode(&text, 1001 + MAX_AGE_SECS), None, "too old");
        assert_eq!(decode(&text, 999), None, "stamped in the future");
        assert_eq!(decode("ia-restart 2\nat 1000\n", 1000), None);
        assert_eq!(decode("ia-restart 1\nat 1000\narg zz\n", 1000), None);
        assert_eq!(decode("ia-restart 1\nat 1000\narg 61 62\n", 1000), None);
        assert_eq!(decode("ia-restart 1\nat 1000\nwhat 61\n", 1000), None);
        // Only the carried variables: a hand-off can never set DYLD_INSERT_LIBRARIES.
        let bad = format!(
            "ia-restart 1\nat 1000\nenv {} 31\n",
            hex("DYLD_INSERT_LIBRARIES")
        );
        assert_eq!(decode(&bad, 1000), None);
    }

    #[test]
    fn the_file_is_in_the_per_user_temporary_directory() {
        let env = MacEnv {
            home: None,
            tmpdir: Some(PathBuf::from("/var/folders/ab/T")),
        };
        assert_eq!(
            handoff_path(&env, 501),
            Some(PathBuf::from("/var/folders/ab/T/indiansassist-restart-501"))
        );
        assert_eq!(handoff_path(&MacEnv::default(), 501), None);
    }

    #[test]
    fn save_then_take_returns_it_once() {
        let dir = std::env::temp_dir().join(format!("ia-restart-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let env = MacEnv {
            home: None,
            tmpdir: Some(dir.clone()),
        };
        // SAFETY: getuid has no preconditions.
        let uid = unsafe { libc::getuid() };
        save(&env, uid, &sample()).unwrap();
        assert_eq!(take(&env, uid), Some(sample()));
        assert_eq!(take(&env, uid), None, "taken once");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
