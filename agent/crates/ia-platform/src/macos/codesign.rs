//! The macOS image check of the session-0 transport (Phase F §8.2 / §16.3, apple): in place of
//! Linux's `/proc/<pid>/exe` comparison, a peer process counts as "ours" only when its code
//! signature is valid **and** satisfies a requirement derived from this process's own signer:
//! `anchor apple generic and certificate leaf[subject.OU] = "<our Team ID>"` for a Developer ID
//! build. Only then is its image path (`proc_pidpath`) handed to the path comparison.
//!
//! An ad hoc (development) build has no Team ID, so the requirement is just a valid signature; the
//! pid gate and the installed-path comparison stay in force. `Security.framework` is reached
//! through a few raw `extern "C"` declarations, so no crate is added.

use std::ffi::{c_void, CStr, CString};
use std::path::PathBuf;

type CFTypeRef = *const c_void;
type CFStringRef = *const c_void;
type CFDictionaryRef = *const c_void;
type CFAllocatorRef = *const c_void;
type SecCodeRef = *const c_void;
type SecRequirementRef = *const c_void;
type OSStatus = i32;

#[repr(C)]
struct CFDictionaryKeyCallBacks {
    _private: [usize; 6],
}
#[repr(C)]
struct CFDictionaryValueCallBacks {
    _private: [usize; 5],
}

const K_CF_NUMBER_SINT32: isize = 3;
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
const K_SEC_CS_DEFAULT: u32 = 0;
const K_SEC_CS_SIGNING_INFORMATION: u32 = 1 << 1;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFTypeDictionaryKeyCallBacks: CFDictionaryKeyCallBacks;
    static kCFTypeDictionaryValueCallBacks: CFDictionaryValueCallBacks;
    fn CFRelease(cf: CFTypeRef);
    fn CFNumberCreate(alloc: CFAllocatorRef, kind: isize, value: *const c_void) -> CFTypeRef;
    fn CFDictionaryCreate(
        alloc: CFAllocatorRef,
        keys: *const CFTypeRef,
        values: *const CFTypeRef,
        n: isize,
        key_cb: *const CFDictionaryKeyCallBacks,
        value_cb: *const CFDictionaryValueCallBacks,
    ) -> CFDictionaryRef;
    fn CFDictionaryGetValue(d: CFDictionaryRef, key: CFTypeRef) -> CFTypeRef;
    fn CFStringCreateWithCString(alloc: CFAllocatorRef, s: *const i8, enc: u32) -> CFStringRef;
    fn CFStringGetCString(s: CFStringRef, buf: *mut i8, len: isize, enc: u32) -> u8;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
}

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecGuestAttributePid: CFStringRef;
    static kSecCodeInfoTeamIdentifier: CFStringRef;
    fn SecCodeCopySelf(flags: u32, code: *mut SecCodeRef) -> OSStatus;
    fn SecCodeCopyGuestWithAttributes(
        host: SecCodeRef,
        attrs: CFDictionaryRef,
        flags: u32,
        guest: *mut SecCodeRef,
    ) -> OSStatus;
    fn SecCodeCopySigningInformation(
        code: SecCodeRef,
        flags: u32,
        info: *mut CFDictionaryRef,
    ) -> OSStatus;
    fn SecRequirementCreateWithString(
        text: CFStringRef,
        flags: u32,
        req: *mut SecRequirementRef,
    ) -> OSStatus;
    fn SecCodeCheckValidity(code: SecCodeRef, flags: u32, req: SecRequirementRef) -> OSStatus;
}

/// Releases a CF object when dropped (null is ignored).
struct Cf(CFTypeRef);

impl Drop for Cf {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: every `Cf` holds an object this module created or copied (+1).
            unsafe { CFRelease(self.0) }
        }
    }
}

/// Whether `team` is a well-formed Team ID: ten upper-case letters or digits, so it can never
/// carry requirement-language syntax into the string it is placed in.
pub fn is_team_id(team: &str) -> bool {
    team.len() == 10
        && team
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

/// The requirement a peer must satisfy: the same Developer ID team as this process, or none (a
/// valid signature only) when this process has no Team ID (an ad hoc development build). A
/// malformed Team ID is never trusted: it yields a requirement nothing satisfies.
pub fn signer_requirement(own_team: Option<&str>) -> Option<String> {
    match own_team {
        None => None,
        Some(t) if is_team_id(t) => Some(format!(
            "anchor apple generic and certificate leaf[subject.OU] = \"{t}\""
        )),
        Some(_) => Some("never".to_string()),
    }
}

fn cf_string(s: &str) -> Option<Cf> {
    let c = CString::new(s).ok()?;
    // SAFETY: a NUL-terminated UTF-8 string; the result is +1 (released by `Cf`).
    let r = unsafe {
        CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), K_CF_STRING_ENCODING_UTF8)
    };
    (!r.is_null()).then_some(Cf(r))
}

fn string_of(s: CFTypeRef) -> Option<String> {
    // SAFETY: a type check before reading it as a CFString; the buffer is 256 bytes, enough for
    // a Team ID (the call fails rather than overflow when it does not fit).
    unsafe {
        if s.is_null() || CFGetTypeID(s) != CFStringGetTypeID() {
            return None;
        }
        let mut buf = [0i8; 256];
        if CFStringGetCString(
            s,
            buf.as_mut_ptr(),
            buf.len() as isize,
            K_CF_STRING_ENCODING_UTF8,
        ) == 0
        {
            return None;
        }
        Some(CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
    }
}

/// This process's Team ID, or `None` for an ad hoc signature.
pub fn own_team_id() -> Option<String> {
    let mut code: SecCodeRef = std::ptr::null();
    // SAFETY: out-parameters owned here; both results are released through `Cf`.
    unsafe {
        if SecCodeCopySelf(K_SEC_CS_DEFAULT, &mut code) != 0 || code.is_null() {
            return None;
        }
        let code = Cf(code);
        let mut info: CFDictionaryRef = std::ptr::null();
        if SecCodeCopySigningInformation(code.0, K_SEC_CS_SIGNING_INFORMATION, &mut info) != 0
            || info.is_null()
        {
            return None;
        }
        let info = Cf(info);
        string_of(CFDictionaryGetValue(info.0, kSecCodeInfoTeamIdentifier))
    }
}

/// The image of `pid` when its code is validly signed and satisfies `requirement` (`None`: a valid
/// signature is enough); `None` when the process is gone, unsigned, tampered with, or signed by
/// someone else.
pub fn image_if_satisfies(pid: i32, requirement: Option<&str>) -> Option<PathBuf> {
    if pid <= 0 {
        return None;
    }
    // SAFETY: every CF object below is created or copied here and released through `Cf`; the
    // dictionary retains its key and value (the kCFType callbacks).
    unsafe {
        let n = Cf(CFNumberCreate(
            std::ptr::null(),
            K_CF_NUMBER_SINT32,
            (&pid as *const i32).cast(),
        ));
        if n.0.is_null() {
            return None;
        }
        let keys = [kSecGuestAttributePid];
        let values = [n.0];
        let attrs = Cf(CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        ));
        if attrs.0.is_null() {
            return None;
        }
        let mut guest: SecCodeRef = std::ptr::null();
        if SecCodeCopyGuestWithAttributes(std::ptr::null(), attrs.0, K_SEC_CS_DEFAULT, &mut guest)
            != 0
            || guest.is_null()
        {
            return None;
        }
        let guest = Cf(guest);
        let req = match requirement {
            Some(text) => {
                let text = cf_string(text)?;
                let mut r: SecRequirementRef = std::ptr::null();
                if SecRequirementCreateWithString(text.0, K_SEC_CS_DEFAULT, &mut r) != 0
                    || r.is_null()
                {
                    return None;
                }
                Some(Cf(r))
            }
            None => None,
        };
        let req_ref = req.as_ref().map_or(std::ptr::null(), |r| r.0);
        if SecCodeCheckValidity(guest.0, K_SEC_CS_DEFAULT, req_ref) != 0 {
            return None;
        }
    }
    super::os::process_image(pid)
}

/// The §8.2 macOS image check: the peer's image path when it is signed by this process's own
/// signer (same Team ID; any valid signature for an ad hoc development build).
pub fn same_signer_image(pid: i32) -> Option<PathBuf> {
    image_if_satisfies(pid, signer_requirement(own_team_id().as_deref()).as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_requirement_names_this_team_and_never_trusts_a_malformed_id() {
        assert_eq!(signer_requirement(None), None);
        assert_eq!(
            signer_requirement(Some("J4N2Y6KNB8")).as_deref(),
            Some("anchor apple generic and certificate leaf[subject.OU] = \"J4N2Y6KNB8\"")
        );
        assert_eq!(
            signer_requirement(Some("x\" or true")).as_deref(),
            Some("never")
        );
        assert!(!is_team_id("j4n2y6knb8"));
        assert!(!is_team_id("J4N2Y6KNB"));
    }

    #[test]
    fn a_running_signed_process_is_read_and_a_foreign_team_is_refused() {
        // A platform binary (Apple-signed) stands in for the peer.
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("5")
            .spawn()
            .unwrap();
        let pid = child.id() as i32;
        let any_valid = image_if_satisfies(pid, None);
        assert_eq!(
            any_valid.as_deref(),
            Some(std::path::Path::new("/bin/sleep"))
        );
        // Another team's Developer ID requirement: refused.
        let other = signer_requirement(Some("ABCDE12345"));
        assert_eq!(image_if_satisfies(pid, other.as_deref()), None);
        // Apple's own anchor: satisfied by a platform binary.
        assert!(image_if_satisfies(pid, Some("anchor apple")).is_some());
        child.kill().unwrap();
        child.wait().unwrap();
        // A process that is gone, or no process at all.
        assert_eq!(image_if_satisfies(pid, None), None);
        assert_eq!(image_if_satisfies(0, None), None);
        assert_eq!(image_if_satisfies(-1, None), None);
    }

    #[test]
    fn this_test_binary_checks_out_against_its_own_signer() {
        // The test binary is ad hoc signed by the linker: no Team ID, so a valid signature is the
        // requirement, and its own image comes back.
        assert_eq!(own_team_id(), None);
        let me = same_signer_image(std::process::id() as i32).unwrap();
        assert_eq!(me, std::env::current_exe().unwrap().canonicalize().unwrap());
    }
}
