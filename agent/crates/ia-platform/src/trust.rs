//! The Authenticode self-check (contract §2.6 / §11.3 / §14, security C10): `WinVerifyTrust`
//! (`WINTRUST_ACTION_GENERIC_VERIFY_V2`, no UI, no revocation network fetch) over the agent's
//! own image. `wintrust.dll` is not a KnownDLL, so it is reached only through
//! [`crate::sys_lib`]. The user instance logs the verdict (a dev build is unsigned); the
//! elevated hand-over child makes it fatal (§7.3 step 4, with the elevation work).
//!
//! The verdict mapping is pure and tested on any target; the call itself is Windows-only.

/// What `WinVerifyTrust` said about a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustVerdict {
    /// A valid embedded Authenticode signature chaining to a trusted root.
    Trusted,
    /// No embedded signature (`TRUST_E_NOSIGNATURE`): every local / dev build.
    Unsigned,
    /// The file changed after signing (`TRUST_E_BAD_DIGEST`).
    Tampered,
    /// Signed, but not trusted (untrusted root, explicit distrust, expired, policy).
    Untrusted(u32),
    /// The check could not run (`wintrust.dll` missing, path error).
    Unavailable,
}

impl TrustVerdict {
    pub fn as_str(&self) -> &'static str {
        match self {
            TrustVerdict::Trusted => "trusted",
            TrustVerdict::Unsigned => "unsigned",
            TrustVerdict::Tampered => "tampered",
            TrustVerdict::Untrusted(_) => "untrusted",
            TrustVerdict::Unavailable => "unavailable",
        }
    }
}

pub const TRUST_E_NOSIGNATURE: u32 = 0x800B_0100;
pub const TRUST_E_BAD_DIGEST: u32 = 0x8009_6010;
pub const TRUST_E_SUBJECT_FORM_UNKNOWN: u32 = 0x800B_0003;
pub const TRUST_E_PROVIDER_UNKNOWN: u32 = 0x800B_0001;

/// Map a `WinVerifyTrust` HRESULT to a verdict.
pub fn verdict_from_code(code: u32) -> TrustVerdict {
    match code {
        0 => TrustVerdict::Trusted,
        TRUST_E_NOSIGNATURE | TRUST_E_SUBJECT_FORM_UNKNOWN => TrustVerdict::Unsigned,
        TRUST_E_BAD_DIGEST => TrustVerdict::Tampered,
        TRUST_E_PROVIDER_UNKNOWN => TrustVerdict::Unavailable,
        other => TrustVerdict::Untrusted(other),
    }
}

/// Verify `path`'s embedded Authenticode signature.
#[cfg(all(windows, feature = "winapi"))]
pub fn verify_file(path: &std::path::Path) -> TrustVerdict {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    #[repr(C)]
    struct Guid {
        d1: u32,
        d2: u16,
        d3: u16,
        d4: [u8; 8],
    }
    #[repr(C)]
    struct WintrustFileInfo {
        cb_struct: u32,
        path: *const u16,
        h_file: *mut c_void,
        known_subject: *const Guid,
    }
    #[repr(C)]
    struct WintrustData {
        cb_struct: u32,
        policy_callback_data: *mut c_void,
        sip_client_data: *mut c_void,
        ui_choice: u32,
        revocation_checks: u32,
        union_choice: u32,
        file: *mut WintrustFileInfo,
        state_action: u32,
        state_data: *mut c_void,
        url_reference: *mut u16,
        prov_flags: u32,
        ui_context: u32,
        signature_settings: *mut c_void,
    }
    type WinVerifyTrustFn =
        unsafe extern "system" fn(hwnd: *mut c_void, action: *mut Guid, data: *mut c_void) -> i32;

    const WTD_UI_NONE: u32 = 2;
    const WTD_REVOKE_NONE: u32 = 0;
    const WTD_CHOICE_FILE: u32 = 1;
    const WTD_STATEACTION_VERIFY: u32 = 1;
    const WTD_STATEACTION_CLOSE: u32 = 2;
    const WTD_REVOCATION_CHECK_NONE: u32 = 0x10;
    const WTD_CACHE_ONLY_URL_RETRIEVAL: u32 = 0x1000;

    let Ok(lib) = crate::sys_lib("wintrust.dll") else {
        return TrustVerdict::Unavailable;
    };
    let Some(f) = lib.proc("WinVerifyTrust") else {
        return TrustVerdict::Unavailable;
    };
    // SAFETY: the symbol is WinVerifyTrust with this documented signature.
    let win_verify_trust: WinVerifyTrustFn = unsafe { std::mem::transmute(f) };
    let wpath: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut action = Guid {
        d1: 0x00AA_C56B,
        d2: 0xCD44,
        d3: 0x11D0,
        d4: [0x8C, 0xC2, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE],
    };
    let mut file = WintrustFileInfo {
        cb_struct: std::mem::size_of::<WintrustFileInfo>() as u32,
        path: wpath.as_ptr(),
        h_file: std::ptr::null_mut(),
        known_subject: std::ptr::null(),
    };
    let mut data = WintrustData {
        cb_struct: std::mem::size_of::<WintrustData>() as u32,
        policy_callback_data: std::ptr::null_mut(),
        sip_client_data: std::ptr::null_mut(),
        ui_choice: WTD_UI_NONE,
        revocation_checks: WTD_REVOKE_NONE,
        union_choice: WTD_CHOICE_FILE,
        file: &mut file,
        state_action: WTD_STATEACTION_VERIFY,
        state_data: std::ptr::null_mut(),
        url_reference: std::ptr::null_mut(),
        prov_flags: WTD_REVOCATION_CHECK_NONE | WTD_CACHE_ONLY_URL_RETRIEVAL,
        ui_context: 0,
        signature_settings: std::ptr::null_mut(),
    };
    // SAFETY: every pointer refers to a live local for the duration of both calls; the
    // state opened by VERIFY is released by CLOSE.
    let code = unsafe {
        let code = win_verify_trust(
            std::ptr::null_mut(),
            &mut action,
            &mut data as *mut WintrustData as *mut c_void,
        );
        data.state_action = WTD_STATEACTION_CLOSE;
        let _ = win_verify_trust(
            std::ptr::null_mut(),
            &mut action,
            &mut data as *mut WintrustData as *mut c_void,
        );
        code
    };
    verdict_from_code(code as u32)
}

/// Verify the running executable.
#[cfg(all(windows, feature = "winapi"))]
pub fn verify_self() -> TrustVerdict {
    match std::env::current_exe() {
        Ok(p) => verify_file(&p),
        Err(_) => TrustVerdict::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_map_to_verdicts() {
        assert_eq!(verdict_from_code(0), TrustVerdict::Trusted);
        assert_eq!(
            verdict_from_code(TRUST_E_NOSIGNATURE),
            TrustVerdict::Unsigned
        );
        assert_eq!(
            verdict_from_code(TRUST_E_BAD_DIGEST),
            TrustVerdict::Tampered
        );
        assert_eq!(
            verdict_from_code(0x800B_0109),
            TrustVerdict::Untrusted(0x800B_0109)
        );
        assert_eq!(TrustVerdict::Unsigned.as_str(), "unsigned");
    }

    #[cfg(all(windows, feature = "winapi"))]
    #[test]
    fn an_unsigned_test_binary_is_unsigned_and_a_signed_system_file_is_trusted() {
        // The test executable carries no signature.
        assert_eq!(verify_self(), TrustVerdict::Unsigned);
        // mrt.exe ships with an embedded Authenticode signature on Windows 10/11 (most system
        // files are catalog-signed, which the file-only check does not see); skip if absent.
        let windir = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let mrt = std::path::Path::new(&windir).join(r"System32\mrt.exe");
        if mrt.exists() {
            assert_eq!(verify_file(&mrt), TrustVerdict::Trusted);
        }
        assert_ne!(
            verify_file(std::path::Path::new(r"C:\definitely\not\here.exe")),
            TrustVerdict::Trusted
        );
    }
}
