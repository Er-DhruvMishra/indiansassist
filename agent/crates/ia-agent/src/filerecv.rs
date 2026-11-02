//! Receiving a file onto the Desk's disk (contract §6.1 F3, F7). The protocol checks (name,
//! size, order, sha256) are `ia_core::filexfer::Receiver` in streaming mode; this module is
//! the disk side:
//!
//! * the save folder is `Downloads\IndiansAssist\` (`FOLDERID_Downloads`), created on the
//!   first accept; received files are the user's and are never removed by self delete (F7);
//! * **final name first**: the collision-free `<stem> (2).<ext>` name is chosen against the
//!   files already in the folder and the in-flight transfers, then
//!   `<final>.<8 random hex>.iapart` is created `CREATE_NEW` (a stale part file can never
//!   block it) and each accepted chunk is appended to it;
//! * on `file.done` + hash match the part is renamed to `<final>` **without replacing**
//!   anything (`MoveFileExW` with no `REPLACE_EXISTING`); if another file took the name in the
//!   meantime a fresh collision-free name is chosen;
//! * the Mark-of-the-Web is written as the `<final>:Zone.Identifier` stream
//!   (`[ZoneTransfer]` / `ZoneId=3`) so SmartScreen treats the file as an internet download;
//! * every path is opened with the `\\?\` prefix (no device-name parsing, no trailing-dot or
//!   trailing-space stripping);
//! * `*.iapart` files older than 24 h are swept when the folder is first used.

use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use ia_core::filexfer::{choose_final_name, taken_key};

/// The Mark-of-the-Web stream content (`ZoneId=3`, the Internet zone).
pub const MOTW: &str = "[ZoneTransfer]\r\nZoneId=3\r\n";

/// How old a stale `.iapart` must be before it is swept.
pub const STALE_PART_AGE: Duration = Duration::from_secs(24 * 3600);

/// `Downloads\IndiansAssist\` (`FOLDERID_Downloads` when the Win32 layer is built); on Linux
/// `$(xdg-user-dir DOWNLOAD)/IndiansAssist/` read from `$XDG_CONFIG_HOME/user-dirs.dirs`, fallback
/// `~/Downloads` (Phase E §7.3f).
pub fn received_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        let env = ia_platform::linux::XdgEnv::from_process();
        let dirs = env
            .config_home()
            .and_then(|c| std::fs::read_to_string(c.join("user-dirs.dirs")).ok());
        if let Some(d) = ia_platform::linux::paths::received_dir(&env, dirs.as_deref()) {
            return d;
        }
    }
    #[cfg(all(windows, feature = "winapi"))]
    {
        use ia_platform::traits::KnownFolders;
        if let Some(d) = ia_platform::win::WinKnownFolders.downloads() {
            return d.join("IndiansAssist");
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        return PathBuf::from(home).join("Downloads").join("IndiansAssist");
    }
    std::env::temp_dir().join("IndiansAssist")
}

/// `\\?\`-prefix an absolute Windows path (no-op elsewhere or when already prefixed).
pub fn long_path(p: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.as_os_str().to_string_lossy();
        if s.starts_with(r"\\?\") {
            return p.to_path_buf();
        }
        if let Some(unc) = s.strip_prefix(r"\\") {
            return PathBuf::from(format!(r"\\?\UNC\{unc}"));
        }
        if p.is_absolute() {
            return PathBuf::from(format!(r"\\?\{s}"));
        }
    }
    p.to_path_buf()
}

/// The names already in `dir` plus the in-flight finals, as case-insensitive keys.
pub fn taken_names(dir: &Path, in_flight: &HashSet<String>) -> HashSet<String> {
    let mut taken: HashSet<String> = in_flight.iter().map(|n| taken_key(n)).collect();
    if let Ok(rd) = std::fs::read_dir(long_path(dir)) {
        for e in rd.flatten() {
            taken.insert(taken_key(&e.file_name().to_string_lossy()));
        }
    }
    taken
}

/// Remove `*.iapart` files older than `max_age` from `dir` (best effort). Returns how many.
pub fn sweep_stale_parts(dir: &Path, max_age: Duration) -> usize {
    let mut n = 0;
    let Ok(rd) = std::fs::read_dir(long_path(dir)) else {
        return 0;
    };
    let now = SystemTime::now();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.to_ascii_lowercase().ends_with(".iapart") {
            continue;
        }
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age >= max_age);
        if old && std::fs::remove_file(e.path()).is_ok() {
            n += 1;
        }
    }
    n
}

fn random_hex8() -> String {
    use rand::RngCore;
    let mut b = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// An in-progress `<final>.<hex>.iapart` file.
pub struct PartFile {
    dir: PathBuf,
    /// The sanitised leaf the final name was derived from (re-numbered from on a race).
    leaf: String,
    final_name: String,
    part_path: PathBuf,
    file: Option<File>,
    written: u64,
}

impl PartFile {
    /// Create `<final>.<hex>.iapart` in `dir` with `CREATE_NEW` (creating `dir` first).
    /// `leaf` is the sanitised name `final_name` was chosen from (`choose_final_name`).
    pub fn create(dir: &Path, leaf: &str, final_name: &str) -> io::Result<PartFile> {
        let bad = |n: &str| n.contains(['/', '\\']) || n.is_empty();
        if bad(final_name) || bad(leaf) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a leaf"));
        }
        std::fs::create_dir_all(long_path(dir))?;
        for _ in 0..8 {
            let part_path = dir.join(format!("{final_name}.{}.iapart", random_hex8()));
            let mut opts = OpenOptions::new();
            opts.write(true).create_new(true);
            // Phase E §7.3f: the executable bit is never set on a received file (the mode
            // survives the no-replace rename; the umask can only take bits away).
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o644);
            }
            match opts.open(long_path(&part_path)) {
                Ok(file) => {
                    return Ok(PartFile {
                        dir: dir.to_path_buf(),
                        leaf: leaf.to_string(),
                        final_name: final_name.to_string(),
                        part_path,
                        file: Some(file),
                        written: 0,
                    })
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not create a part file",
        ))
    }

    pub fn part_path(&self) -> &Path {
        &self.part_path
    }

    pub fn final_name(&self) -> &str {
        &self.final_name
    }

    pub fn written(&self) -> u64 {
        self.written
    }

    /// Append one accepted chunk.
    pub fn write(&mut self, payload: &[u8]) -> io::Result<()> {
        let f = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("part file closed"))?;
        f.write_all(payload)?;
        self.written += payload.len() as u64;
        Ok(())
    }

    /// Flush, rename to the final name without replacing anything, write the MOTW. Returns
    /// the saved path. `in_flight` names other transfers so a re-chosen name avoids them.
    pub fn commit(mut self, in_flight: &HashSet<String>) -> io::Result<PathBuf> {
        if let Some(f) = self.file.take() {
            f.sync_all()?;
        }
        let mut name = self.final_name.clone();
        for _ in 0..16 {
            let target = self.dir.join(&name);
            match rename_no_replace(&self.part_path, &target) {
                Ok(()) => {
                    // The MOTW failing (FAT32 has no streams) does not lose the file.
                    if let Err(e) = write_motw(&target) {
                        tracing::warn!("mark-of-the-web not written: {e}");
                    }
                    return Ok(target);
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    let taken = taken_names(&self.dir, in_flight);
                    name = choose_final_name(&self.leaf, &taken);
                }
                Err(e) => return Err(e),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "no free final name",
        ))
    }

    /// Cancel: close and delete the part file.
    pub fn abort(mut self) {
        self.file.take();
        let _ = std::fs::remove_file(long_path(&self.part_path));
    }
}

impl Drop for PartFile {
    fn drop(&mut self) {
        // A part that was neither committed nor aborted (teardown mid-transfer) is removed.
        if self.file.take().is_some() {
            let _ = std::fs::remove_file(long_path(&self.part_path));
        }
    }
}

/// Rename `from` to `to`, failing with `AlreadyExists` if `to` exists (never replaces).
pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(all(windows, feature = "winapi"))]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
        let w = |p: &Path| -> Vec<u16> {
            long_path(p)
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect()
        };
        let (f, t) = (w(from), w(to));
        // SAFETY: both paths are NUL-terminated wide strings; no REPLACE_EXISTING flag.
        return unsafe {
            MoveFileExW(
                PCWSTR(f.as_ptr()),
                PCWSTR(t.as_ptr()),
                MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|e| {
            // ERROR_ALREADY_EXISTS (183) / ERROR_FILE_EXISTS (80)
            let code = (e.code().0 as u32) & 0xFFFF;
            if code == 183 || code == 80 {
                io::Error::new(io::ErrorKind::AlreadyExists, e)
            } else {
                io::Error::other(e)
            }
        });
    }
    #[allow(unreachable_code)]
    {
        // Portable fallback: a hard link fails if `to` exists; then drop the part name.
        std::fs::hard_link(long_path(from), long_path(to))?;
        std::fs::remove_file(long_path(from))
    }
}

/// Write the Mark-of-the-Web `Zone.Identifier` stream next to `path` (Windows/NTFS).
pub fn write_motw(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        let mut s = long_path(path).into_os_string();
        s.push(":Zone.Identifier");
        std::fs::write(PathBuf::from(s), MOTW)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(())
    }
}

/// Read back the MOTW stream (tests).
pub fn read_motw(path: &Path) -> io::Result<String> {
    let mut s = long_path(path).into_os_string();
    s.push(":Zone.Identifier");
    std::fs::read_to_string(PathBuf::from(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ia-filerecv-{tag}-{}", random_hex8()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn part_is_created_streamed_and_committed_with_motw() {
        let dir = temp_dir("commit");
        let mut part = PartFile::create(&dir, "note.txt", "note.txt").unwrap();
        let pname = part
            .part_path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(pname.starts_with("note.txt.") && pname.ends_with(".iapart"));
        part.write(b"hello ").unwrap();
        part.write(b"world").unwrap();
        assert_eq!(part.written(), 11);
        let saved = part.commit(&HashSet::new()).unwrap();
        assert_eq!(saved, dir.join("note.txt"));
        assert_eq!(std::fs::read(&saved).unwrap(), b"hello world");
        #[cfg(windows)]
        assert_eq!(read_motw(&saved).unwrap(), MOTW);
        // Phase E §7.3f: no execute bit on a received file.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&saved).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0, "mode {mode:o}");
        }
        // No part file is left behind.
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(left.len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn final_name_is_chosen_first_and_never_replaces() {
        let dir = temp_dir("collide");
        std::fs::write(dir.join("Report.pdf"), b"old").unwrap();
        let taken = taken_names(&dir, &HashSet::new());
        let final_name = choose_final_name("report.pdf", &taken);
        assert_eq!(final_name, "report (2).pdf");
        // Someone grabs the chosen name while the transfer runs: commit picks another.
        let mut part = PartFile::create(&dir, "report.pdf", &final_name).unwrap();
        std::fs::write(dir.join("report (2).pdf"), b"racer").unwrap();
        part.write(b"new").unwrap();
        let saved = part.commit(&HashSet::new()).unwrap();
        assert_eq!(saved.file_name().unwrap(), "report (3).pdf");
        assert_eq!(std::fs::read(dir.join("Report.pdf")).unwrap(), b"old");
        assert_eq!(std::fs::read(dir.join("report (2).pdf")).unwrap(), b"racer");
        assert_eq!(std::fs::read(&saved).unwrap(), b"new");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn abort_and_drop_remove_the_part() {
        let dir = temp_dir("abort");
        let part = PartFile::create(&dir, "a.bin", "a.bin").unwrap();
        let p = part.part_path().to_path_buf();
        assert!(p.exists());
        part.abort();
        assert!(!p.exists());
        let p2 = {
            let part = PartFile::create(&dir, "b.bin", "b.bin").unwrap();
            part.part_path().to_path_buf()
        };
        assert!(!p2.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stale_parts_are_swept_fresh_ones_kept() {
        let dir = temp_dir("sweep");
        std::fs::write(dir.join("x.txt.0011aabb.iapart"), b"").unwrap();
        std::fs::write(dir.join("keep.txt"), b"").unwrap();
        // Age zero sweeps every part; the 24 h default keeps a fresh one.
        assert_eq!(sweep_stale_parts(&dir, STALE_PART_AGE), 0);
        assert_eq!(sweep_stale_parts(&dir, Duration::ZERO), 1);
        assert!(dir.join("keep.txt").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_path_is_never_a_leaf() {
        let dir = temp_dir("leaf");
        assert!(PartFile::create(&dir, "evil.txt", r"..\evil.txt").is_err());
        assert!(PartFile::create(&dir, "b.txt", "a/b.txt").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn long_path_prefixes_absolute_paths() {
        assert_eq!(
            long_path(Path::new(r"C:\x\y.txt")),
            PathBuf::from(r"\\?\C:\x\y.txt")
        );
        assert_eq!(
            long_path(Path::new(r"\\?\C:\x")),
            PathBuf::from(r"\\?\C:\x")
        );
        assert_eq!(
            long_path(Path::new(r"\\srv\share\f")),
            PathBuf::from(r"\\?\UNC\srv\share\f")
        );
    }
}
