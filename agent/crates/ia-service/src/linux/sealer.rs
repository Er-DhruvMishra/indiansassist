//! The `FileModeSealer` mode check (contract F §8.3b).
//!
//! There is no DPAPI equivalent on a generic Linux host: `device.key` and `device.kex` are written
//! mode 0600, owned by root, and stored without OS sealing (the D §3.3 rule "never logged,
//! exported or sent" is what protects them). What the sealer must enforce is that it **refuses to
//! load** a key file whose mode or owner is wider than 0600 root (W109): a key a group or the
//! world can read, or one another user owns, is treated as compromised rather than used.
//!
//! The decision is pure — a function of the file's mode and owner, the current uid and whether the
//! service is in `--console` dev mode (where the keys are owned by the current user, not root) —
//! so it is tested with a table here, and the OS part (reading the metadata, writing atomically)
//! is a thin caller.

/// Why a key file was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SealerRefusal {
    /// The mode grants any group or other permission (wider than 0600).
    ModeTooWide,
    /// The file is not owned by the expected principal (root in production, the current user in
    /// dev `--console` mode).
    WrongOwner,
}

/// The context the §8.3b check runs in.
#[derive(Debug, Clone, Copy)]
pub struct SealerContext {
    /// `getuid()` of the running service.
    pub current_uid: u32,
    /// Dev `--console` mode: the keys are owned by the current user, not root (§8.3b, §8.5).
    pub dev_console: bool,
}

/// The uid the key file must be owned by: root (0) in production, the current user in dev mode.
pub fn required_owner(ctx: &SealerContext) -> u32 {
    if ctx.dev_console {
        ctx.current_uid
    } else {
        0
    }
}

/// The §8.3b gate: accept the key file only when its mode is no wider than 0600 and it is owned by
/// the required principal. `mode` is the raw `st_mode` permission bits (the low 12 bits matter).
pub fn check_key_file(mode: u32, owner_uid: u32, ctx: &SealerContext) -> Result<(), SealerRefusal> {
    // Anything beyond `rw-------` — a group/other bit, owner-execute, or setuid/setgid/sticky —
    // is wider than 0600 and refused (W109).
    if mode & 0o7777 & !0o600 != 0 {
        return Err(SealerRefusal::ModeTooWide);
    }
    if owner_uid != required_owner(ctx) {
        return Err(SealerRefusal::WrongOwner);
    }
    Ok(())
}

impl SealerContext {
    /// The context of this process: its real uid, and whether it runs in dev `--console` mode.
    pub fn current(dev_console: bool) -> Self {
        Self {
            // SAFETY: getuid has no preconditions and cannot fail.
            current_uid: unsafe { libc::getuid() },
            dev_console,
        }
    }
}

/// The marker a `FileModeSealer` blob starts with, so a DPAPI blob copied from Windows (or a
/// stray file) is refused as "not ours" rather than read as a key.
const MARKER: &[u8] = b"IA-FILEMODE-1:";

/// §8.3b: the keys are stored **without OS sealing** — the protection is the file's mode and
/// owner, which [`load_identity`] enforces before it reads a byte. The type exists so the
/// operator can see in the log which protection is in force (`kind`).
#[derive(Debug, Clone, Copy)]
pub struct FileModeSealer;

impl crate::identity::BlobSealer for FileModeSealer {
    fn seal(&self, plaintext: &[u8]) -> std::io::Result<Vec<u8>> {
        let mut out = MARKER.to_vec();
        out.extend_from_slice(plaintext);
        Ok(out)
    }

    fn unseal(&self, blob: &[u8]) -> std::io::Result<zeroize::Zeroizing<Vec<u8>>> {
        blob.strip_prefix(MARKER)
            .map(|b| zeroize::Zeroizing::new(b.to_vec()))
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "not a key file this service wrote",
                )
            })
    }

    fn kind(&self) -> &'static str {
        "file-mode-0600"
    }
}

fn refusal_error(
    path: &std::path::Path,
    why: SealerRefusal,
    ctx: &SealerContext,
) -> std::io::Error {
    let what = match why {
        SealerRefusal::ModeTooWide => "its mode is wider than 0600".to_string(),
        SealerRefusal::WrongOwner => format!("it is not owned by uid {}", required_owner(ctx)),
    };
    std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        format!(
            "{} is refused: {what} (F §8.3b; the key is treated as exposed)",
            path.display()
        ),
    )
}

/// Write one key file atomically with mode 0600 (`O_EXCL` temp file, fsync, rename).
fn write_0600(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension(format!("new-{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, path)
}

/// Store both keys (§8.3b): mode 0600, written atomically, owned by the running user (root under
/// systemd).
pub fn store_identity(
    identity: &crate::identity::Identity,
    key: &std::path::Path,
    kex: &std::path::Path,
) -> std::io::Result<()> {
    let (a, b) = identity.seal_with(&FileModeSealer)?;
    write_0600(key, &a)?;
    write_0600(kex, &b)
}

/// Load both keys, refusing a file whose mode or owner is wider than §8.3b allows **before** it is
/// read. `Ok(None)` when neither exists yet (first start).
pub fn load_identity(
    ctx: &SealerContext,
    key: &std::path::Path,
    kex: &std::path::Path,
) -> std::io::Result<Option<crate::identity::Identity>> {
    use std::os::unix::fs::MetadataExt;
    for p in [key, kex] {
        match std::fs::symlink_metadata(p) {
            Ok(m) => {
                if !m.file_type().is_file() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        format!("{} is not a regular file", p.display()),
                    ));
                }
                check_key_file(m.mode(), m.uid(), ctx).map_err(|why| refusal_error(p, why, ctx))?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    crate::identity::Identity::load(&FileModeSealer, key, kex)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "ia-sealer-{tag}-{}-{}",
            std::process::id(),
            ia_core::rnd::hex(4)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn keys_are_written_0600_and_read_back_in_dev_mode() {
        use std::os::unix::fs::PermissionsExt;
        let d = temp("roundtrip");
        let (key, kex) = (d.join("device.key"), d.join("device.kex"));
        let id = crate::identity::Identity::generate();
        store_identity(&id, &key, &kex).unwrap();
        for p in [&key, &kex] {
            assert_eq!(
                std::fs::metadata(p).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let ctx = SealerContext::current(true);
        let back = load_identity(&ctx, &key, &kex).unwrap().unwrap();
        assert_eq!(back.public_key(), id.public_key());
        // First start: nothing there yet.
        let _ = std::fs::remove_dir_all(&d);
        assert!(load_identity(&ctx, &key, &kex).unwrap().is_none());
    }

    #[test]
    fn a_widened_key_file_is_refused_before_it_is_read() {
        use std::os::unix::fs::PermissionsExt;
        let d = temp("wide");
        let (key, kex) = (d.join("device.key"), d.join("device.kex"));
        store_identity(&crate::identity::Identity::generate(), &key, &kex).unwrap();
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
        let err = load_identity(&SealerContext::current(true), &key, &kex).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(err.to_string().contains("wider than 0600"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_user_owned_key_is_refused_in_production() {
        let d = temp("owner");
        let (key, kex) = (d.join("device.key"), d.join("device.kex"));
        store_identity(&crate::identity::Identity::generate(), &key, &kex).unwrap();
        let ctx = SealerContext::current(false);
        if ctx.current_uid != 0 {
            let err = load_identity(&ctx, &key, &kex).unwrap_err();
            assert!(err.to_string().contains("not owned by uid 0"));
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_blob_this_sealer_did_not_write_is_not_a_key() {
        use crate::identity::BlobSealer;
        assert!(FileModeSealer.unseal(b"\x01\x00\x00\x00DPAPI").is_err());
        let sealed = FileModeSealer.seal(b"k").unwrap();
        assert_eq!(&FileModeSealer.unseal(&sealed).unwrap()[..], b"k");
        assert_eq!(FileModeSealer.kind(), "file-mode-0600");
    }

    const PROD: SealerContext = SealerContext {
        current_uid: 1000,
        dev_console: false,
    };
    const DEV: SealerContext = SealerContext {
        current_uid: 1000,
        dev_console: true,
    };

    #[test]
    fn a_0600_root_key_is_accepted_in_production() {
        assert_eq!(check_key_file(0o600, 0, &PROD), Ok(()));
    }

    #[test]
    fn a_world_or_group_readable_key_is_refused() {
        for mode in [0o640, 0o604, 0o660, 0o666, 0o700, 0o644] {
            assert_eq!(
                check_key_file(mode, 0, &PROD),
                Err(SealerRefusal::ModeTooWide),
                "mode {mode:o} must be refused as too wide"
            );
        }
    }

    #[test]
    fn a_key_owned_by_a_non_root_user_is_refused_in_production() {
        assert_eq!(
            check_key_file(0o600, 1000, &PROD),
            Err(SealerRefusal::WrongOwner)
        );
    }

    #[test]
    fn dev_console_accepts_the_current_users_0600_key_but_still_refuses_a_wide_one() {
        assert_eq!(required_owner(&DEV), 1000);
        assert_eq!(check_key_file(0o600, 1000, &DEV), Ok(()));
        // root-owned in dev is the wrong owner (the service never ran as root to write it).
        assert_eq!(
            check_key_file(0o600, 0, &DEV),
            Err(SealerRefusal::WrongOwner)
        );
        // A wide mode is refused regardless of mode.
        assert_eq!(
            check_key_file(0o640, 1000, &DEV),
            Err(SealerRefusal::ModeTooWide)
        );
    }

    #[test]
    fn setuid_and_sticky_bits_count_as_too_wide() {
        assert_eq!(
            check_key_file(0o4600, 0, &PROD),
            Err(SealerRefusal::ModeTooWide)
        );
        assert_eq!(
            check_key_file(0o1600, 0, &PROD),
            Err(SealerRefusal::ModeTooWide)
        );
    }
}
