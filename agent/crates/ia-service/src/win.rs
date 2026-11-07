//! The Win32 half of the service, compiled under the `service` feature: DPAPI, the registry
//! entropy blob, the SCM, the machine facts, the network facts, and the local toast.
//!
//! §14 / §11.3: `crypt32.dll`, `wtsapi32.dll` and `iphlpapi.dll` are not KnownDLLs, so they are
//! reached through `ia_platform::sys_lib` rather than linked.

use std::ffi::c_void;
use std::sync::OnceLock;

use zeroize::Zeroizing;

/// DPAPI (§3.3), late-bound from `crypt32.dll`.
pub mod dpapi {
    use super::*;

    /// `CRYPTPROTECT_LOCAL_MACHINE`: the blob is bound to this machine, not to a user, so the
    /// service can open it as `LocalSystem` before anybody logs on.
    const CRYPTPROTECT_LOCAL_MACHINE: u32 = 0x4;
    /// `CRYPTPROTECT_UI_FORBIDDEN`: a service must never be able to raise a prompt.
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    type FnProtect = unsafe extern "system" fn(
        *mut DataBlob,
        *const u16,
        *mut DataBlob,
        *mut c_void,
        *mut c_void,
        u32,
        *mut DataBlob,
    ) -> i32;
    type FnUnprotect = unsafe extern "system" fn(
        *mut DataBlob,
        *mut *mut u16,
        *mut DataBlob,
        *mut c_void,
        *mut c_void,
        u32,
        *mut DataBlob,
    ) -> i32;

    struct Crypt32 {
        protect: Option<FnProtect>,
        unprotect: Option<FnUnprotect>,
        _lib: Option<ia_platform::win::SysLib>,
    }

    fn crypt32() -> &'static Crypt32 {
        static C: OnceLock<Crypt32> = OnceLock::new();
        C.get_or_init(|| {
            let lib = ia_platform::sys_lib("crypt32.dll").ok();
            // SAFETY: each cast matches the documented signature of the named export.
            unsafe {
                Crypt32 {
                    protect: lib
                        .as_ref()
                        .and_then(|l| l.proc("CryptProtectData"))
                        .map(|p| std::mem::transmute::<*const c_void, FnProtect>(p)),
                    unprotect: lib
                        .as_ref()
                        .and_then(|l| l.proc("CryptUnprotectData"))
                        .map(|p| std::mem::transmute::<*const c_void, FnUnprotect>(p)),
                    _lib: lib,
                }
            }
        })
    }

    fn blob_of(data: &[u8]) -> DataBlob {
        DataBlob {
            cb_data: data.len() as u32,
            pb_data: data.as_ptr() as *mut u8,
        }
    }

    fn take(out: DataBlob) -> Vec<u8> {
        if out.pb_data.is_null() || out.cb_data == 0 {
            return Vec::new();
        }
        // SAFETY: DPAPI allocated `cb_data` bytes with LocalAlloc; we copy then free them.
        unsafe {
            let v = std::slice::from_raw_parts(out.pb_data, out.cb_data as usize).to_vec();
            let _ = windows::Win32::Foundation::LocalFree(windows::Win32::Foundation::HLOCAL(
                out.pb_data as *mut c_void,
            ));
            v
        }
    }

    /// Seal with machine scope and the install's extra entropy.
    pub fn protect(plaintext: &[u8], entropy: &[u8]) -> std::io::Result<Vec<u8>> {
        let f = crypt32()
            .protect
            .ok_or_else(|| std::io::Error::other("CryptProtectData is unavailable"))?;
        let mut input = blob_of(plaintext);
        let mut ent = blob_of(entropy);
        let mut out = DataBlob {
            cb_data: 0,
            pb_data: std::ptr::null_mut(),
        };
        // SAFETY: every blob points at live memory for the duration of the call; the output is
        // copied out and freed by `take`.
        let ok = unsafe {
            f(
                &mut input,
                std::ptr::null(),
                if entropy.is_empty() {
                    std::ptr::null_mut()
                } else {
                    &mut ent
                },
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(take(out))
    }

    /// Open a blob this machine sealed. A failure here means the blob was not sealed on this
    /// machine (a restored disk) or the entropy is gone — both are reported, never papered over.
    pub fn unprotect(blob: &[u8], entropy: &[u8]) -> std::io::Result<Zeroizing<Vec<u8>>> {
        let f = crypt32()
            .unprotect
            .ok_or_else(|| std::io::Error::other("CryptUnprotectData is unavailable"))?;
        let mut input = blob_of(blob);
        let mut ent = blob_of(entropy);
        let mut out = DataBlob {
            cb_data: 0,
            pb_data: std::ptr::null_mut(),
        };
        // SAFETY: as above; the plaintext is moved straight into a Zeroizing buffer.
        let ok = unsafe {
            f(
                &mut input,
                std::ptr::null_mut(),
                if entropy.is_empty() {
                    std::ptr::null_mut()
                } else {
                    &mut ent
                },
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Zeroizing::new(take(out)))
    }
}

/// `HKLM\SOFTWARE\IndiansAssist\Device` (§3.3): the per-install DPAPI entropy blob. The MSI
/// locks the key to `SYSTEM` + `Administrators` (§10.4); the service creates the value on first
/// start if it is not there.
pub mod registry {
    use windows::core::w;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_LOCAL_MACHINE,
        KEY_READ, KEY_WRITE, REG_BINARY, REG_OPTION_NON_VOLATILE, REG_VALUE_TYPE,
    };

    const VALUE: windows::core::PCWSTR = w!("Entropy");

    fn open() -> std::io::Result<HKEY> {
        // SAFETY: the key is closed by the caller; both strings are static wide literals.
        unsafe {
            let mut key = HKEY::default();
            let r = RegCreateKeyExW(
                HKEY_LOCAL_MACHINE,
                w!("SOFTWARE\\IndiansAssist\\Device"),
                0,
                windows::core::PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_READ | KEY_WRITE,
                None,
                &mut key,
                None,
            );
            if r.is_err() {
                return Err(std::io::Error::other(format!("registry: {r:?}")));
            }
            Ok(key)
        }
    }

    /// The entropy blob, created with 32 CSPRNG bytes on first use.
    pub fn entropy() -> std::io::Result<Vec<u8>> {
        let key = open()?;
        // SAFETY: the buffer is sized by the first query; the key is closed on every path.
        let out = unsafe {
            let mut kind = REG_VALUE_TYPE::default();
            let mut len = 0u32;
            let r = RegQueryValueExW(key, VALUE, None, Some(&mut kind), None, Some(&mut len));
            if r.is_ok() && len > 0 {
                let mut buf = vec![0u8; len as usize];
                let r = RegQueryValueExW(
                    key,
                    VALUE,
                    None,
                    Some(&mut kind),
                    Some(buf.as_mut_ptr()),
                    Some(&mut len),
                );
                if r.is_ok() {
                    buf.truncate(len as usize);
                    Ok(buf)
                } else {
                    Err(std::io::Error::other(
                        "registry: the entropy value could not be read",
                    ))
                }
            } else {
                let fresh = ia_core::rnd::bytes::<32>().to_vec();
                let r = RegSetValueExW(key, VALUE, 0, REG_BINARY, Some(&fresh));
                if r.is_ok() {
                    Ok(fresh)
                } else {
                    Err(std::io::Error::other(
                        "registry: the entropy value could not be written",
                    ))
                }
            }
        };
        // SAFETY: the key was opened above and is not used after this.
        unsafe {
            let _ = RegCloseKey(key);
        }
        out
    }
}

/// The machine facts of an enrollment request and a hello (§3.2).
pub mod facts {
    use sha2::{Digest, Sha256};

    /// The computer name, as the fleet view shows it.
    pub fn computer_name() -> String {
        std::env::var("COMPUTERNAME").unwrap_or_else(|_| "windows-device".to_string())
    }

    /// `osVersion` as `major.minor.build`.
    pub fn os_version() -> String {
        use windows::Win32::System::SystemInformation::GetVersionExW;
        use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
        // SAFETY: the struct is sized before the call, as the API requires.
        unsafe {
            let mut info = OSVERSIONINFOW {
                dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
                ..Default::default()
            };
            if GetVersionExW(&mut info).is_ok() {
                format!(
                    "{}.{}.{}",
                    info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber
                )
            } else {
                "10.0".to_string()
            }
        }
    }

    pub fn arch() -> &'static str {
        if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        }
    }

    /// `hwFingerprint` (rule 3.7a): a stable sha256 over machine facts that survive a reinstall
    /// of the product but change when the machine does. The machine GUID is the anchor; the
    /// computer name and the system drive serial make a re-image of the same hardware match
    /// while a different machine does not.
    ///
    /// It is a **fingerprint, not a secret**: it identifies a re-enrollment so the old device
    /// row is superseded instead of silently duplicated. It is never used to authenticate.
    pub fn hw_fingerprint() -> String {
        let machine_guid = machine_guid().unwrap_or_default();
        let input = format!(
            "ia-hwfp-v1/{}/{}/{}",
            machine_guid,
            computer_name().to_lowercase(),
            arch()
        );
        hex::encode(Sha256::digest(input.as_bytes()))
    }

    /// `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`, the usual Windows machine anchor.
    fn machine_guid() -> Option<String> {
        use windows::core::w;
        use windows::Win32::System::Registry::{
            RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
            KEY_WOW64_64KEY,
        };
        // SAFETY: the key is closed on every path; the buffer is sized by the first query.
        unsafe {
            let mut key = HKEY::default();
            if RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                w!("SOFTWARE\\Microsoft\\Cryptography"),
                0,
                KEY_READ | KEY_WOW64_64KEY,
                &mut key,
            )
            .is_err()
            {
                return None;
            }
            let mut len = 0u32;
            let mut kind = windows::Win32::System::Registry::REG_VALUE_TYPE::default();
            let name = w!("MachineGuid");
            let mut out = None;
            if RegQueryValueExW(key, name, None, Some(&mut kind), None, Some(&mut len)).is_ok()
                && len > 1
            {
                let mut buf = vec![0u16; (len as usize / 2) + 1];
                let mut size = (buf.len() * 2) as u32;
                if RegQueryValueExW(
                    key,
                    name,
                    None,
                    Some(&mut kind),
                    Some(buf.as_mut_ptr() as *mut u8),
                    Some(&mut size),
                )
                .is_ok()
                {
                    let n = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
                    out = Some(String::from_utf16_lossy(&buf[..n]));
                }
            }
            let _ = RegCloseKey(key);
            out
        }
    }
}

/// The network facts the waker mesh needs (rule 8.2a/c), from `iphlpapi.dll` (late-bound).
pub mod netfacts {
    use std::net::Ipv4Addr;

    use windows::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_SKIP_ANYCAST,
        GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};

    /// One usable IPv4 interface: its address, prefix length, MAC and first gateway.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Interface {
        pub addr: Ipv4Addr,
        pub prefix_len: u8,
        /// 12 lower-case hex, or `None` when the adapter has no hardware address.
        pub mac: Option<String>,
        pub gateway: Option<Ipv4Addr>,
        pub dns_suffix: Option<String>,
    }

    /// Enumerate the IPv4 interfaces that have an address and are up.
    pub fn interfaces() -> Vec<Interface> {
        let mut out = Vec::new();
        let flags = GAA_FLAG_SKIP_ANYCAST
            | GAA_FLAG_SKIP_MULTICAST
            | GAA_FLAG_SKIP_DNS_SERVER
            | GAA_FLAG_INCLUDE_GATEWAYS;
        // SAFETY: the buffer is sized by the first call and only read while it is alive; every
        // pointer walk checks for null.
        unsafe {
            let mut size = 0u32;
            let _ = GetAdaptersAddresses(AF_INET.0 as u32, flags, None, None, &mut size);
            if size == 0 {
                return out;
            }
            let mut buf = vec![0u8; size as usize];
            let head = buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
            if GetAdaptersAddresses(AF_INET.0 as u32, flags, None, Some(head), &mut size) != 0 {
                return out;
            }
            let mut a = head;
            while !a.is_null() {
                let ad = &*a;
                let mac =
                    (ad.PhysicalAddressLength >= 6).then(|| hex::encode(&ad.PhysicalAddress[..6]));
                let dns_suffix = (!ad.DnsSuffix.is_null())
                    .then(|| ad.DnsSuffix.to_string().ok())
                    .flatten()
                    .filter(|s| !s.is_empty());
                let gateway = first_ipv4(ad.FirstGatewayAddress.cast());
                let mut u = ad.FirstUnicastAddress;
                while !u.is_null() {
                    let ua = &*u;
                    if let Some(addr) = sockaddr_ipv4(ua.Address.lpSockaddr.cast()) {
                        if !addr.is_loopback() && !addr.is_unspecified() {
                            out.push(Interface {
                                addr,
                                prefix_len: ua.OnLinkPrefixLength,
                                mac: mac.clone(),
                                gateway,
                                dns_suffix: dns_suffix.clone(),
                            });
                        }
                    }
                    u = ua.Next;
                }
                a = ad.Next;
            }
        }
        out
    }

    /// Reads an IPv4 address out of a `SOCKADDR`.
    ///
    /// # Safety
    /// `p` must be null or point at a live `SOCKADDR_IN`.
    unsafe fn sockaddr_ipv4(p: *const SOCKADDR_IN) -> Option<Ipv4Addr> {
        if p.is_null() {
            return None;
        }
        let sa = &*p;
        if sa.sin_family != AF_INET {
            return None;
        }
        Some(Ipv4Addr::from(u32::from_be(sa.sin_addr.S_un.S_addr)))
    }

    /// The first IPv4 of a gateway list.
    ///
    /// # Safety
    /// `p` must be null or point at a live `IP_ADAPTER_GATEWAY_ADDRESS_LH` chain.
    unsafe fn first_ipv4(
        p: *const windows::Win32::NetworkManagement::IpHelper::IP_ADAPTER_GATEWAY_ADDRESS_LH,
    ) -> Option<Ipv4Addr> {
        let mut g = p;
        while !g.is_null() {
            let ga = &*g;
            if let Some(a) = sockaddr_ipv4(ga.Address.lpSockaddr.cast()) {
                return Some(a);
            }
            g = ga.Next;
        }
        None
    }

    /// The gateway's MAC from the neighbour (ARP) table, which is what rule 8.2a hashes.
    pub fn gateway_mac(gateway: Ipv4Addr) -> Option<String> {
        use windows::Win32::NetworkManagement::IpHelper::{
            FreeMibTable, GetIpNetTable2, MIB_IPNET_TABLE2,
        };
        // SAFETY: the table is freed on every path; entries are read only while it is alive.
        unsafe {
            let mut table: *mut MIB_IPNET_TABLE2 = std::ptr::null_mut();
            if GetIpNetTable2(AF_INET, &mut table).is_err() || table.is_null() {
                return None;
            }
            let t = &*table;
            let rows = std::slice::from_raw_parts(t.Table.as_ptr(), t.NumEntries as usize);
            let want = u32::from(gateway).to_be();
            let mut found = None;
            for r in rows {
                if r.Address.si_family == AF_INET
                    && r.Address.Ipv4.sin_addr.S_un.S_addr == want
                    && r.PhysicalAddressLength >= 6
                {
                    found = Some(hex::encode(&r.PhysicalAddress[..6]));
                    break;
                }
            }
            FreeMibTable(table as *const _);
            found
        }
    }
}

/// A local notification (rule 9.6, rule 9.9 "visibility", §6.4 "while you were away").
///
/// A service in session 0 cannot draw a window, so it asks the session itself to show one
/// through `WTSSendMessageW` — the documented way for a service to put a message in front of
/// whoever is at the machine. It is deliberately modest: a title and a line of text. A richer
/// toast would need a packaged app identity, which an MSI-installed service does not have.
pub mod toast {
    use super::*;

    type FnSendMessage = unsafe extern "system" fn(
        windows::Win32::Foundation::HANDLE,
        u32,
        *const u16,
        u32,
        *const u16,
        u32,
        u32,
        u32,
        *mut u32,
        i32,
    ) -> i32;

    fn send_message() -> Option<FnSendMessage> {
        static F: OnceLock<(Option<FnSendMessage>, Option<ia_platform::win::SysLib>)> =
            OnceLock::new();
        let (f, _lib) = F.get_or_init(|| {
            let lib = ia_platform::sys_lib("wtsapi32.dll").ok();
            // SAFETY: the cast matches the documented signature of WTSSendMessageW.
            let f = unsafe {
                lib.as_ref()
                    .and_then(|l| l.proc("WTSSendMessageW"))
                    .map(|p| std::mem::transmute::<*const c_void, FnSendMessage>(p))
            };
            (f, lib)
        });
        *f
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    /// Show `title` / `body` in `session_id`. Returns false when there is nobody to show it to,
    /// which the caller records rather than treating as success.
    pub fn show(session_id: u32, title: &str, body: &str) -> bool {
        let Some(f) = send_message() else {
            return false;
        };
        let t = wide(title);
        let b = wide(body);
        // SAFETY: both strings are NUL-terminated and live for the call; `response` is a stack
        // u32; `bWait` is false so the service never blocks on a user.
        unsafe {
            let mut response = 0u32;
            f(
                windows::Win32::Foundation::HANDLE(std::ptr::null_mut()),
                session_id,
                t.as_ptr(),
                ((t.len() - 1) * 2) as u32,
                b.as_ptr(),
                ((b.len() - 1) * 2) as u32,
                0x40, // MB_ICONINFORMATION
                0,
                &mut response,
                0,
            ) != 0
        }
    }
}

pub mod scm;

/// The SID the §4.2 pipe DACL grants for a worker on this desktop (`ia-session0` reads the
/// console user's token; a secure-desktop worker is `LocalSystem`).
pub use ia_session0::win::worker_sid_for;

/// §5.4 `os.sas`: press Ctrl+Alt+Del. `SendSAS` is a service-only API — no process can inject
/// the sequence (C §5.4), which is exactly why the op lives on this side of the pipe.
///
/// Late-bound from `sas.dll`, which is not a KnownDLL. A machine without it (or with the
/// "Software Generated SAS" policy set to deny services) answers false, and the worker turns
/// that into `not_supported` rather than a silent no-op.
pub fn send_sas() -> bool {
    type FnSendSas = unsafe extern "system" fn(*mut i32);
    static F: OnceLock<(Option<FnSendSas>, Option<ia_platform::win::SysLib>)> = OnceLock::new();
    let (f, _lib) = F.get_or_init(|| {
        let lib = ia_platform::sys_lib("sas.dll").ok();
        // SAFETY: the cast matches the documented signature of SendSAS.
        let f = unsafe {
            lib.as_ref()
                .and_then(|l| l.proc("SendSAS"))
                .map(|p| std::mem::transmute::<*const c_void, FnSendSas>(p))
        };
        (f, lib)
    });
    match f {
        Some(send) => {
            // `AsUser = FALSE`: the SAS is raised for the session, not impersonated.
            let mut as_user = 0i32;
            // SAFETY: the argument is a stack BOOL, as the API expects.
            unsafe { send(&mut as_user) };
            tracing::info!("the secure attention sequence was sent");
            true
        }
        None => {
            tracing::warn!(
                "SendSAS is not available on this machine; os.sas answers not_supported"
            );
            false
        }
    }
}

/// Show a toast in the console session, if there is one (rule 9.6, rule 9.9 visibility, §6.4).
pub fn toast_to_console(title: &str, body: &str) -> bool {
    match facts_console_session() {
        Some(id) => toast::show(id, title, body),
        None => {
            tracing::info!("no console session: the notification was not shown");
            false
        }
    }
}

fn facts_console_session() -> Option<u32> {
    ia_session0::win::active_console_session_id()
}

/// Fetch a presigned object (rule 9.4 / 9.5). Bounded by the caller's declared size, which is
/// checked against what arrives.
pub fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let response = ia_waker::https::builder()
        .build()
        .get(url)
        .set("user-agent", &crate::user_agent())
        .call()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    response
        .into_reader()
        // The action declares the size and the hash; this cap is only so a wrong URL cannot
        // fill the disk before either check runs.
        .take(ia_core::types::limits::FILE_MAX_BYTES_NATIVE)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}
