//! Windows syscall layer (contract §11.1, §14), compiled only under the `winapi` feature.
//!
//! NOTE: this module is compiled and linked by CI on the Windows targets; it is **not**
//! built by the default dev gate on this machine (the `winapi` feature is off so the
//! pure-Rust workspace stays green without the `windows` crate). See agent/README.md.

use std::ffi::c_void;
use std::io;
use std::path::PathBuf;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, FreeLibrary, HMODULE};
use windows::Win32::System::LibraryLoader::{
    GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
    KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
};
use windows::Win32::UI::Shell::{
    FOLDERID_Downloads, FOLDERID_LocalAppData, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
};

use crate::protocol::protocol_handler_values;
use crate::traits::{KnownFolders, ProtocolHandler};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A late-bound system library handle (§14): loaded with `LOAD_LIBRARY_SEARCH_SYSTEM32`
/// so only `%SystemRoot%\System32` is searched, never the exe's directory.
pub struct SysLib(HMODULE);

/// `sys_lib(name)` — load a non-KnownDLL system library from System32 and resolve procs.
pub fn sys_lib(name: &str) -> io::Result<SysLib> {
    let wname = wide(name);
    // SAFETY: `wname` is a valid NUL-terminated wide string; flags restrict the search.
    let module =
        unsafe { LoadLibraryExW(PCWSTR(wname.as_ptr()), None, LOAD_LIBRARY_SEARCH_SYSTEM32) }
            .map_err(|e| io::Error::new(io::ErrorKind::NotFound, e.to_string()))?;
    Ok(SysLib(module))
}

impl SysLib {
    /// Resolve a function pointer by name, or `None` if absent.
    pub fn proc(&self, name: &str) -> Option<*const c_void> {
        use windows::core::PCSTR;
        let cname = std::ffi::CString::new(name).ok()?;
        // SAFETY: self.0 is a live module handle; cname is a NUL-terminated ANSI name.
        let f = unsafe { GetProcAddress(self.0, PCSTR(cname.as_ptr() as *const u8)) };
        f.map(|p| p as *const c_void)
    }
}

impl Drop for SysLib {
    fn drop(&mut self) {
        // SAFETY: self.0 was returned by LoadLibraryExW.
        let _ = unsafe { FreeLibrary(self.0) };
    }
}

/// `SHGetKnownFolderPath`-backed known folders (§6.1 F3).
pub struct WinKnownFolders;

fn known_folder(id: &windows::core::GUID) -> Option<PathBuf> {
    // SAFETY: id is a valid FOLDERID; the returned PWSTR is freed with CoTaskMemFree.
    let pwstr: PWSTR = unsafe { SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()? };
    if pwstr.is_null() {
        return None;
    }
    // SAFETY: pwstr is a NUL-terminated wide string owned by the shell allocator.
    let path = unsafe { pwstr.to_string().ok() };
    unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(pwstr.0 as *const c_void)) };
    path.map(PathBuf::from)
}

impl KnownFolders for WinKnownFolders {
    fn downloads(&self) -> Option<PathBuf> {
        known_folder(&FOLDERID_Downloads)
    }
    fn local_app_data(&self) -> Option<PathBuf> {
        known_folder(&FOLDERID_LocalAppData)
    }
}

/// HKCU `indiansassist://` protocol handler (§2.5 L1).
pub struct WinProtocolHandler;

const CLASS_ROOT: &str = r"Software\Classes\indiansassist";

impl ProtocolHandler for WinProtocolHandler {
    fn register(&self, exe_path: &str) -> io::Result<()> {
        for v in protocol_handler_values(exe_path) {
            let subpath = if v.subkey.is_empty() {
                CLASS_ROOT.to_string()
            } else {
                format!("{CLASS_ROOT}\\{}", v.subkey)
            };
            write_sz(&subpath, v.name, &v.value)?;
        }
        Ok(())
    }

    fn unregister(&self) -> io::Result<()> {
        let wsub = wide(CLASS_ROOT);
        // SAFETY: valid key handle + NUL-terminated subkey.
        let r = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(wsub.as_ptr())) };
        if r.is_ok() {
            Ok(())
        } else {
            // Absent key is not an error for teardown.
            Ok(())
        }
    }
}

fn write_sz(subkey: &str, name: &str, value: &str) -> io::Result<()> {
    let wsub = wide(subkey);
    let mut hkey = HKEY::default();
    // SAFETY: all pointers valid and NUL-terminated; hkey receives the opened key.
    let create = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(wsub.as_ptr()),
            None,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut hkey,
            None,
        )
    };
    if create.is_err() {
        return Err(io::Error::other(format!(
            "RegCreateKeyExW failed: {create:?}"
        )));
    }
    let wname = wide(name);
    let wval = wide(value);
    let bytes: &[u8] =
        unsafe { std::slice::from_raw_parts(wval.as_ptr() as *const u8, wval.len() * 2) };
    // SAFETY: hkey live; name NUL-terminated; bytes covers the wide value incl. NUL.
    let set = unsafe { RegSetValueExW(hkey, PCWSTR(wname.as_ptr()), None, REG_SZ, Some(bytes)) };
    // SAFETY: close the key we opened.
    let _ = unsafe { RegCloseKey(hkey) };
    if set.is_err() {
        return Err(io::Error::other(format!("RegSetValueExW failed: {set:?}")));
    }
    Ok(())
}

/// Close a raw handle (helper for the pipe code in ia-agent).
///
/// # Safety
/// `handle` must be a valid, owned handle not used after this call.
pub unsafe fn close_handle(handle: windows::Win32::Foundation::HANDLE) {
    let _ = CloseHandle(handle);
}
