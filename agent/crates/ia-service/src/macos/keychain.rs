//! The device keys at rest on macOS (Phase F §17.3, the D §3.3 DPAPI analogue): two
//! generic-password items, `device.key` and `device.kex`, under the service
//! `com.indiansassist.agent` in the **System keychain**, each with an access list that trusts only
//! the running daemon binary (`SecAccessCreate` with a one-application list), so no other process,
//! root included, reads them without a keychain prompt that a daemon never answers. Never a plain
//! file.
//!
//! A dev `--console` run uses the same code against a **file keychain** in its own data directory
//! (`SecKeychainCreate`), so a test never touches the System or the login keychain, and the
//! keychain is not added to the user's search list.
//!
//! `Security.framework` is reached through raw `extern "C"` declarations (as `ia_platform`'s
//! code-signing check is), so no crate is added.

use std::ffi::{c_void, CString};
use std::io;
use std::path::Path;

use zeroize::Zeroizing;

use crate::identity::{BlobSealer, Identity};

type CFTypeRef = *const c_void;
type OSStatus = i32;

/// The keychain item service the two keys are stored under.
pub const SERVICE: &str = "com.indiansassist.agent";
const KEY_ACCOUNT: &str = "device.key";
const KEX_ACCOUNT: &str = "device.kex";
/// The System keychain.
const SYSTEM_KEYCHAIN: &str = "/Library/Keychains/System.keychain";

const ERR_SEC_ITEM_NOT_FOUND: OSStatus = -25300;
const ERR_SEC_DUPLICATE_ITEM: OSStatus = -25299;
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

#[repr(C)]
struct CallBacks {
    _private: [usize; 6],
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFTypeDictionaryKeyCallBacks: CallBacks;
    static kCFTypeDictionaryValueCallBacks: CallBacks;
    static kCFTypeArrayCallBacks: CallBacks;
    static kCFBooleanTrue: CFTypeRef;
    fn CFRelease(cf: CFTypeRef);
    fn CFStringCreateWithCString(alloc: CFTypeRef, s: *const i8, enc: u32) -> CFTypeRef;
    fn CFDataCreate(alloc: CFTypeRef, bytes: *const u8, len: isize) -> CFTypeRef;
    fn CFDataGetBytePtr(d: CFTypeRef) -> *const u8;
    fn CFDataGetLength(d: CFTypeRef) -> isize;
    fn CFArrayCreate(
        alloc: CFTypeRef,
        values: *const CFTypeRef,
        n: isize,
        cb: *const CallBacks,
    ) -> CFTypeRef;
    fn CFDictionaryCreate(
        alloc: CFTypeRef,
        keys: *const CFTypeRef,
        values: *const CFTypeRef,
        n: isize,
        key_cb: *const CallBacks,
        value_cb: *const CallBacks,
    ) -> CFTypeRef;
}

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecClass: CFTypeRef;
    static kSecClassGenericPassword: CFTypeRef;
    static kSecAttrService: CFTypeRef;
    static kSecAttrAccount: CFTypeRef;
    static kSecAttrAccess: CFTypeRef;
    static kSecValueData: CFTypeRef;
    static kSecUseKeychain: CFTypeRef;
    static kSecMatchSearchList: CFTypeRef;
    static kSecReturnData: CFTypeRef;
    fn SecKeychainOpen(path: *const i8, kc: *mut CFTypeRef) -> OSStatus;
    fn SecKeychainCreate(
        path: *const i8,
        password_len: u32,
        password: *const c_void,
        prompt_user: u8,
        initial_access: CFTypeRef,
        kc: *mut CFTypeRef,
    ) -> OSStatus;
    fn SecKeychainUnlock(
        kc: CFTypeRef,
        password_len: u32,
        password: *const c_void,
        use_password: u8,
    ) -> OSStatus;
    fn SecTrustedApplicationCreateFromPath(path: *const i8, app: *mut CFTypeRef) -> OSStatus;
    fn SecAccessCreate(
        descriptor: CFTypeRef,
        trusted: CFTypeRef,
        access: *mut CFTypeRef,
    ) -> OSStatus;
    fn SecItemAdd(attrs: CFTypeRef, result: *mut CFTypeRef) -> OSStatus;
    fn SecItemCopyMatching(query: CFTypeRef, result: *mut CFTypeRef) -> OSStatus;
    fn SecItemDelete(query: CFTypeRef) -> OSStatus;
}

/// Releases a CF object (+1) when dropped.
struct Cf(CFTypeRef);

impl Drop for Cf {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: every `Cf` holds an object created or copied here.
            unsafe { CFRelease(self.0) }
        }
    }
}

fn status(what: &str, s: OSStatus) -> io::Result<()> {
    if s == 0 {
        Ok(())
    } else {
        Err(io::Error::other(format!("{what} failed (OSStatus {s})")))
    }
}

fn cf_str(s: &str) -> io::Result<Cf> {
    let c = CString::new(s).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    // SAFETY: a NUL-terminated string; the result is +1.
    let r = unsafe {
        CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), K_CF_STRING_ENCODING_UTF8)
    };
    if r.is_null() {
        return Err(io::Error::other("CFString"));
    }
    Ok(Cf(r))
}

fn dict(pairs: &[(CFTypeRef, CFTypeRef)]) -> io::Result<Cf> {
    let keys: Vec<CFTypeRef> = pairs.iter().map(|p| p.0).collect();
    let values: Vec<CFTypeRef> = pairs.iter().map(|p| p.1).collect();
    // SAFETY: equal-length arrays of live CF objects; the dictionary retains them.
    let d = unsafe {
        CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            pairs.len() as isize,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
    };
    if d.is_null() {
        return Err(io::Error::other("CFDictionary"));
    }
    Ok(Cf(d))
}

/// The keychain's own protection is the seal: the bytes go in as they are.
struct KeychainSealer;

impl BlobSealer for KeychainSealer {
    fn seal(&self, plaintext: &[u8]) -> io::Result<Vec<u8>> {
        Ok(plaintext.to_vec())
    }
    fn unseal(&self, blob: &[u8]) -> io::Result<Zeroizing<Vec<u8>>> {
        Ok(Zeroizing::new(blob.to_vec()))
    }
    fn kind(&self) -> &'static str {
        "keychain"
    }
}

/// A keychain holding the device keys: the System keychain, or a dev file keychain.
pub struct KeyStore {
    keychain: Cf,
    /// The binary trusted to read the items (`None`: the running one).
    trusted_app: Option<CString>,
}

// SAFETY: a SecKeychainRef is a CF object, safe to use from any thread; it is never mutated here.
unsafe impl Send for KeyStore {}
unsafe impl Sync for KeyStore {}

/// The password of a dev file keychain. It protects nothing secret: the dev keys exist only to
/// run the service under a test, and the keychain lives inside the run's own data directory.
const DEV_PASSWORD: &[u8] = b"indiansassist-dev";

impl KeyStore {
    /// The System keychain (the daemon, as root).
    pub fn system() -> io::Result<Self> {
        let path = CString::new(SYSTEM_KEYCHAIN).expect("no NUL");
        let mut kc: CFTypeRef = std::ptr::null();
        // SAFETY: a NUL-terminated path and an out-parameter.
        status("SecKeychainOpen", unsafe {
            SecKeychainOpen(path.as_ptr(), &mut kc)
        })?;
        Ok(Self {
            keychain: Cf(kc),
            trusted_app: None,
        })
    }

    /// A dev file keychain at `path` (created when missing, then unlocked). Never the login or
    /// System keychain, and never added to a search list.
    pub fn dev(path: &Path) -> io::Result<Self> {
        let c = CString::new(path.to_string_lossy().as_bytes())
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        let mut kc: CFTypeRef = std::ptr::null();
        // SAFETY: NUL-terminated path, a password buffer of the stated length, out-parameters.
        unsafe {
            if path.exists() {
                status("SecKeychainOpen", SecKeychainOpen(c.as_ptr(), &mut kc))?;
            } else {
                status(
                    "SecKeychainCreate",
                    SecKeychainCreate(
                        c.as_ptr(),
                        DEV_PASSWORD.len() as u32,
                        DEV_PASSWORD.as_ptr().cast(),
                        0,
                        std::ptr::null(),
                        &mut kc,
                    ),
                )?;
            }
            let kc = Cf(kc);
            status(
                "SecKeychainUnlock",
                SecKeychainUnlock(
                    kc.0,
                    DEV_PASSWORD.len() as u32,
                    DEV_PASSWORD.as_ptr().cast(),
                    1,
                ),
            )?;
            Ok(Self {
                keychain: kc,
                trusted_app: None,
            })
        }
    }

    /// Trust `binary` instead of the running one (tests store from one process and read back
    /// from the same, so they keep the default).
    #[cfg(test)]
    fn trusting(mut self, binary: &Path) -> Self {
        self.trusted_app = CString::new(binary.to_string_lossy().as_bytes()).ok();
        self
    }

    /// The access list: only the trusted application reads the item without a prompt.
    fn access(&self) -> io::Result<Cf> {
        let mut app: CFTypeRef = std::ptr::null();
        let path = self
            .trusted_app
            .as_ref()
            .map_or(std::ptr::null(), |c| c.as_ptr());
        // SAFETY: a NUL-terminated path or null (the calling application); out-parameters; every
        // object created is released through `Cf`.
        unsafe {
            status(
                "SecTrustedApplicationCreateFromPath",
                SecTrustedApplicationCreateFromPath(path, &mut app),
            )?;
            let app = Cf(app);
            let apps = [app.0];
            let list = Cf(CFArrayCreate(
                std::ptr::null(),
                apps.as_ptr(),
                1,
                &kCFTypeArrayCallBacks,
            ));
            if list.0.is_null() {
                return Err(io::Error::other("CFArray"));
            }
            let descriptor = cf_str("IndiansAssist device key")?;
            let mut access: CFTypeRef = std::ptr::null();
            status(
                "SecAccessCreate",
                SecAccessCreate(descriptor.0, list.0, &mut access),
            )?;
            Ok(Cf(access))
        }
    }

    fn search_list(&self) -> io::Result<Cf> {
        let kcs = [self.keychain.0];
        // SAFETY: one live keychain; the array retains it.
        let list =
            unsafe { CFArrayCreate(std::ptr::null(), kcs.as_ptr(), 1, &kCFTypeArrayCallBacks) };
        if list.is_null() {
            return Err(io::Error::other("CFArray"));
        }
        Ok(Cf(list))
    }

    fn delete(&self, account: &str) -> io::Result<()> {
        let service = cf_str(SERVICE)?;
        let account = cf_str(account)?;
        let list = self.search_list()?;
        // SAFETY: the Security constants are valid CFStrings for the process's lifetime.
        let query = unsafe {
            dict(&[
                (kSecClass, kSecClassGenericPassword),
                (kSecAttrService, service.0),
                (kSecAttrAccount, account.0),
                (kSecMatchSearchList, list.0),
            ])?
        };
        // SAFETY: a valid query dictionary.
        match unsafe { SecItemDelete(query.0) } {
            0 | ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            s => status("SecItemDelete", s),
        }
    }

    fn put(&self, account: &str, bytes: &[u8]) -> io::Result<()> {
        self.delete(account)?;
        let service = cf_str(SERVICE)?;
        let acct = cf_str(account)?;
        // SAFETY: a byte buffer of the stated length; the result is +1.
        let data =
            Cf(unsafe { CFDataCreate(std::ptr::null(), bytes.as_ptr(), bytes.len() as isize) });
        let access = self.access()?;
        // SAFETY: the Security constants are valid CFStrings for the process's lifetime.
        let attrs = unsafe {
            dict(&[
                (kSecClass, kSecClassGenericPassword),
                (kSecAttrService, service.0),
                (kSecAttrAccount, acct.0),
                (kSecValueData, data.0),
                (kSecUseKeychain, self.keychain.0),
                (kSecAttrAccess, access.0),
            ])?
        };
        // SAFETY: a valid attribute dictionary; no result is asked for.
        match unsafe { SecItemAdd(attrs.0, std::ptr::null_mut()) } {
            ERR_SEC_DUPLICATE_ITEM => Err(io::Error::other(format!(
                "{account} is still in the keychain"
            ))),
            s => status("SecItemAdd", s),
        }
    }

    fn get(&self, account: &str) -> io::Result<Option<Zeroizing<Vec<u8>>>> {
        let service = cf_str(SERVICE)?;
        let acct = cf_str(account)?;
        let list = self.search_list()?;
        // SAFETY: the Security and CF constants are valid for the process's lifetime.
        let query = unsafe {
            dict(&[
                (kSecClass, kSecClassGenericPassword),
                (kSecAttrService, service.0),
                (kSecAttrAccount, acct.0),
                (kSecMatchSearchList, list.0),
                (kSecReturnData, kCFBooleanTrue),
            ])?
        };
        let mut out: CFTypeRef = std::ptr::null();
        // SAFETY: a valid query; `out` receives a +1 CFData.
        match unsafe { SecItemCopyMatching(query.0, &mut out) } {
            ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            0 => {
                let data = Cf(out);
                // SAFETY: `data` is a CFData; the bytes are copied before it is released.
                let bytes = unsafe {
                    std::slice::from_raw_parts(
                        CFDataGetBytePtr(data.0),
                        CFDataGetLength(data.0) as usize,
                    )
                };
                Ok(Some(Zeroizing::new(bytes.to_vec())))
            }
            s => status("SecItemCopyMatching", s).map(|_| None),
        }
    }

    /// Store both keys, replacing what was there.
    pub fn store(&self, identity: &Identity) -> io::Result<()> {
        let (seed, kex) = identity.seal_with(&KeychainSealer)?;
        let (seed, kex) = (Zeroizing::new(seed), Zeroizing::new(kex));
        self.put(KEY_ACCOUNT, &seed)?;
        self.put(KEX_ACCOUNT, &kex)
    }

    /// Load both keys: `Ok(None)` before the first start (neither item there yet); an error when
    /// only one is, or either is not 32 bytes (never mistaken for "not enrolled").
    pub fn load(&self) -> io::Result<Option<Identity>> {
        match (self.get(KEY_ACCOUNT)?, self.get(KEX_ACCOUNT)?) {
            (None, None) => Ok(None),
            (Some(seed), Some(kex)) => {
                let arr = |v: &[u8]| -> io::Result<[u8; 32]> {
                    v.try_into().map_err(|_| {
                        io::Error::new(io::ErrorKind::InvalidData, "a device key must be 32 bytes")
                    })
                };
                Ok(Some(Identity::from_parts(arr(&seed)?, arr(&kex)?)))
            }
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "only one of the two device keys is in the keychain",
            )),
        }
    }

    /// Remove both keys (the bounded deregister, §8.9 on macOS).
    pub fn shred(&self) -> io::Result<()> {
        self.delete(KEY_ACCOUNT)?;
        self.delete(KEX_ACCOUNT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ia-keychain-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn search_list() -> String {
        let out = std::process::Command::new("/usr/bin/security")
            .args(["list-keychains", "-d", "user"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[test]
    fn a_dev_file_keychain_round_trips_the_keys_and_stays_off_the_search_list() {
        let before = search_list();
        let dir = temp("roundtrip");
        let path = dir.join("dev.keychain-db");
        let store = KeyStore::dev(&path).unwrap();
        assert!(
            store.load().unwrap().is_none(),
            "nothing before the first start"
        );
        let id = Identity::generate();
        store.store(&id).unwrap();
        let back = store.load().unwrap().unwrap();
        assert_eq!(back.public_key(), id.public_key());
        assert_eq!(back.kex_public_key(), id.kex_public_key());
        // A second store replaces both items (no duplicate error).
        let other = Identity::generate();
        store.store(&other).unwrap();
        assert_eq!(store.load().unwrap().unwrap().key_id(), other.key_id());
        // Reopened from disk, the keys are still there.
        drop(store);
        let again = KeyStore::dev(&path).unwrap();
        assert_eq!(again.load().unwrap().unwrap().key_id(), other.key_id());
        again.shred().unwrap();
        assert!(again.load().unwrap().is_none());
        assert_eq!(
            search_list(),
            before,
            "the user's keychain search list is unchanged"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn half_a_pair_is_an_error_not_a_first_start() {
        let dir = temp("half");
        let store = KeyStore::dev(&dir.join("dev.keychain-db")).unwrap();
        store.put(KEY_ACCOUNT, &[7u8; 32]).unwrap();
        assert!(store.load().is_err());
        store.put(KEX_ACCOUNT, &[1u8; 5]).unwrap();
        assert!(store.load().is_err(), "a short key");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_item_trusted_to_another_binary_is_still_stored() {
        // The access list names the given binary; storing must not depend on it being this one.
        let dir = temp("acl");
        let store = KeyStore::dev(&dir.join("dev.keychain-db"))
            .unwrap()
            .trusting(Path::new("/bin/ls"));
        store.store(&Identity::generate()).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
