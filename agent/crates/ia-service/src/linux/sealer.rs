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

#[cfg(test)]
mod tests {
    use super::*;

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
