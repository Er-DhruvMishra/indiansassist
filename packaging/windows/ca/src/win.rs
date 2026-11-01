//! The Win32 side of the custom actions. See the crate docs for what each entry point does.

use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{
    LocalFree, ERROR_MORE_DATA, ERROR_SUCCESS, GENERIC_WRITE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW, SDDL_REVISION_1,
    SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    GetSecurityDescriptorDacl, GetSecurityDescriptorSacl, ACL, DACL_SECURITY_INFORMATION,
    LABEL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    SECURITY_ATTRIBUTES,
};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL};
use windows_sys::Win32::System::ApplicationInstallationAndServicing::{
    MsiCloseHandle, MsiCreateRecord, MsiGetPropertyW, MsiProcessMessage, MsiRecordSetStringW,
    INSTALLMESSAGE_INFO, MSIHANDLE,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegOpenKeyExW, RegSetKeySecurity, HKEY,
    HKEY_LOCAL_MACHINE, KEY_ALL_ACCESS, KEY_WOW64_64KEY, REG_OPTION_NON_VOLATILE,
};

use crate::enroll::{
    decode_ia_enroll, is_key_material, join, parse_apply_install, parse_opt_out, parse_wipe,
    plan_config,
};

const ERROR_INSTALL_FAILURE: u32 = 1603;

/// `%ProgramData%\IndiansAssist\` (section 3.3 / 10.4): protected DACL `SYSTEM` + `Administrators`
/// full control, inherited by every file and subfolder, and the system mandatory label with
/// no-write-up, so a process below system integrity (an elevated admin tool included) cannot write.
const SDDL_DATA_DIR: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)S:(ML;OICI;NW;;;SI)";
/// The enroll config beside the binary in `%ProgramFiles%` (which users can read by default).
const SDDL_SECRET_FILE: &str = "D:P(A;;FA;;;SY)(A;;FA;;;BA)S:(ML;;NW;;;SI)";
/// `HKLM\SOFTWARE\IndiansAssist\Device` (section 3.3: entropy blob, `SYSTEM` + `Administrators`).
const SDDL_DEVICE_KEY: &str = "D:P(A;CI;KA;;;SY)(A;CI;KA;;;BA)";
const DEVICE_REG_PARENT: &str = "SOFTWARE\\IndiansAssist";
const DEVICE_REG_SUBKEY: &str = "Device";

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Overwrites a buffer with zeros in a way the optimiser cannot drop.
fn wipe(buf: &mut [u8]) {
    for b in buf.iter_mut() {
        // SAFETY: `b` is a valid, aligned, exclusive reference.
        unsafe { std::ptr::write_volatile(b, 0) };
    }
}

fn wipe_u16(buf: &mut [u16]) {
    for b in buf.iter_mut() {
        // SAFETY: as above.
        unsafe { std::ptr::write_volatile(b, 0) };
    }
}

fn log(h: MSIHANDLE, msg: &str) {
    // Field 0 is the template; square brackets would be expanded as fields, so drop them.
    let text: String = format!("IaMsiCa: {msg}").replace(['[', ']'], "");
    let w = wide(&text);
    // SAFETY: plain MSI API calls on a record we own and close.
    unsafe {
        let rec = MsiCreateRecord(1);
        if rec != 0 {
            MsiRecordSetStringW(rec, 0, w.as_ptr());
            MsiProcessMessage(h, INSTALLMESSAGE_INFO, rec);
            MsiCloseHandle(rec);
        }
    }
}

/// Reads `CustomActionData` into a zeroable UTF-16 buffer and converts it. The caller wipes the
/// returned bytes (`String::into_bytes`) when done.
fn custom_action_data(h: MSIHANDLE) -> Option<String> {
    let name = wide("CustomActionData");
    let mut probe = [0u16; 1];
    let mut len: u32 = 0;
    // SAFETY: a zero-length buffer asks for the required size.
    let r = unsafe { MsiGetPropertyW(h, name.as_ptr(), probe.as_mut_ptr(), &mut len) };
    if r == ERROR_SUCCESS {
        return Some(String::new());
    }
    if r != ERROR_MORE_DATA {
        return None;
    }
    let mut buf = vec![0u16; len as usize + 1];
    let mut cap = buf.len() as u32;
    // SAFETY: `buf` has `cap` u16 slots.
    let r = unsafe { MsiGetPropertyW(h, name.as_ptr(), buf.as_mut_ptr(), &mut cap) };
    let out = if r == ERROR_SUCCESS {
        String::from_utf16(&buf[..cap as usize]).ok()
    } else {
        None
    };
    wipe_u16(&mut buf);
    out
}

/// An owned security descriptor parsed from SDDL.
struct Sd(PSECURITY_DESCRIPTOR);

impl Sd {
    fn from_sddl(sddl: &str) -> Result<Sd, String> {
        let w = wide(sddl);
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: valid NUL-terminated SDDL; `sd` receives a LocalAlloc'd descriptor freed in Drop.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                w.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(format!(
                "SDDL parse failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Sd(sd))
    }

    fn acls(&self) -> (*mut ACL, *mut ACL) {
        let (mut dp, mut dd, mut sp, mut sdf) = (0, 0, 0, 0);
        let (mut dacl, mut sacl): (*mut ACL, *mut ACL) = (null_mut(), null_mut());
        // SAFETY: `self.0` is a valid descriptor; the ACL pointers point into it.
        unsafe {
            GetSecurityDescriptorDacl(self.0, &mut dp, &mut dacl, &mut dd);
            GetSecurityDescriptorSacl(self.0, &mut sp, &mut sacl, &mut sdf);
        }
        (dacl, sacl)
    }

    /// Applies the protected DACL and the mandatory label to an existing path; inheritable entries
    /// propagate to existing children (an upgrade keeps them protected).
    fn apply_to_path(&self, path: &str) -> Result<(), String> {
        let (dacl, sacl) = self.acls();
        let w = wide(path);
        let mut info = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
        if !sacl.is_null() {
            info |= LABEL_SECURITY_INFORMATION;
        }
        // SAFETY: valid path and ACL pointers that live as long as `self`.
        let r = unsafe {
            SetNamedSecurityInfoW(
                w.as_ptr(),
                SE_FILE_OBJECT,
                info,
                null_mut(),
                null_mut(),
                dacl as *const ACL,
                sacl as *const ACL,
            )
        };
        if r != ERROR_SUCCESS {
            return Err(format!(
                "SetNamedSecurityInfo failed: {}",
                std::io::Error::from_raw_os_error(r as i32)
            ));
        }
        Ok(())
    }
}

impl Drop for Sd {
    fn drop(&mut self) {
        // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
        unsafe { LocalFree(self.0 as _) };
    }
}

/// Overwrites a file with zeros, then deletes it. Missing files are fine.
fn shred(path: &Path) -> std::io::Result<()> {
    let len = match fs::metadata(path) {
        Ok(m) => m.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if let Ok(mut f) = fs::OpenOptions::new().write(true).open(path) {
        let zeros = [0u8; 4096];
        let mut left = len;
        while left > 0 {
            let n = left.min(zeros.len() as u64) as usize;
            if f.write_all(&zeros[..n]).is_err() {
                break;
            }
            left -= n as u64;
        }
        let _ = f.sync_all();
    }
    fs::remove_file(path)
}

/// Creates `path` (which must not exist) with `sd` applied at creation, so the secret is never
/// readable under an inherited ACL, writes `bytes`, then re-applies `sd` to set the label.
fn write_secret_file(path: &str, bytes: &[u8], sd: &Sd) -> Result<(), String> {
    let w = wide(path);
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    // SAFETY: valid path and security attributes; CREATE_NEW never reuses an existing file's ACL.
    let h = unsafe {
        CreateFileW(
            w.as_ptr(),
            GENERIC_WRITE,
            0,
            &sa,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    if h == INVALID_HANDLE_VALUE || h.is_null() {
        return Err(format!(
            "create failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: `h` is a fresh, owned file handle; `File` closes it.
    let mut f = unsafe { fs::File::from_raw_handle(h as _) };
    f.write_all(bytes)
        .and_then(|_| f.sync_all())
        .map_err(|e| format!("write failed: {e}"))?;
    drop(f);
    sd.apply_to_path(path)
}

fn protect_device_registry_key(h: MSIHANDLE) -> Result<(), String> {
    let sd = Sd::from_sddl(SDDL_DEVICE_KEY)?;
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    let sub = wide(&format!("{DEVICE_REG_PARENT}\\{DEVICE_REG_SUBKEY}"));
    let mut key: HKEY = null_mut();
    let mut disp = 0u32;
    // SAFETY: standard registry calls on a key we own and close.
    unsafe {
        let r = RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            sub.as_ptr(),
            0,
            null(),
            REG_OPTION_NON_VOLATILE,
            KEY_ALL_ACCESS | KEY_WOW64_64KEY,
            &sa,
            &mut key,
            &mut disp,
        );
        if r != ERROR_SUCCESS {
            return Err(format!(
                "RegCreateKeyEx failed: {}",
                std::io::Error::from_raw_os_error(r as i32)
            ));
        }
        let r = RegSetKeySecurity(
            key,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            sd.0,
        );
        RegCloseKey(key);
        if r != ERROR_SUCCESS {
            return Err(format!(
                "RegSetKeySecurity failed: {}",
                std::io::Error::from_raw_os_error(r as i32)
            ));
        }
    }
    log(
        h,
        "HKLM SOFTWARE IndiansAssist Device protected (SYSTEM + Administrators)",
    );
    Ok(())
}

fn apply_install(h: MSIHANDLE) -> Result<(), String> {
    let data = custom_action_data(h).ok_or("CustomActionData unavailable")?;
    let mut data_bytes = data.into_bytes();
    let result = (|| {
        let text = std::str::from_utf8(&data_bytes).map_err(|_| "CustomActionData not UTF-8")?;
        let d = parse_apply_install(text).ok_or("CustomActionData malformed")?;
        let waker = parse_opt_out(d.waker_opt_out).map_err(|e| e.to_string())?;
        let amt = parse_opt_out(d.amt_proxy_opt_out).map_err(|e| e.to_string())?;

        // 1. Validate IA_ENROLL first, so a bad value fails the install before anything changes.
        let enroll = if d.ia_enroll.trim().is_empty() {
            None
        } else {
            Some(
                decode_ia_enroll(d.ia_enroll)
                    .map_err(|e| format!("IA_ENROLL is not a valid signed enroll.iaconfig: {e}"))?,
            )
        };

        // 2. Section 3.3 / 10.4 ACLs on the data directory (MSI created it for manifest.json).
        fs::create_dir_all(d.data_dir).map_err(|e| format!("create data dir: {e}"))?;
        Sd::from_sddl(SDDL_DATA_DIR)?.apply_to_path(d.data_dir)?;
        log(
            h,
            "data directory protected (SYSTEM + Administrators, system label)",
        );
        protect_device_registry_key(h)?;

        // 3. The signed enroll config beside ia-service.exe (section 12.3).
        if let Some((bytes, _)) = &enroll {
            let path = join(d.install_dir, "enroll.iaconfig");
            shred(Path::new(&path)).map_err(|e| format!("replace enroll.iaconfig: {e}"))?;
            write_secret_file(&path, bytes, &Sd::from_sddl(SDDL_SECRET_FILE)?)?;
            log(
                h,
                &format!("enroll.iaconfig written ({} bytes)", bytes.len()),
            );
        } else {
            log(
                h,
                "IA_ENROLL not set: no enroll.iaconfig written (repair, upgrade or unenrolled)",
            );
        }

        // 4. config.json (section 4.1), inherits the protected data-dir ACL.
        let cfg_path = join(d.data_dir, "config.json");
        let existing = match fs::read_to_string(&cfg_path) {
            Ok(t) => Some(t),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("read config.json: {e}")),
        };
        match plan_config(
            existing.as_deref(),
            enroll.as_ref().map(|(_, c)| c),
            waker,
            amt,
        ) {
            Ok(Some(json)) => {
                let tmp = join(d.data_dir, "config.json.tmp");
                fs::write(&tmp, json.as_bytes()).map_err(|e| format!("write config.json: {e}"))?;
                fs::rename(&tmp, &cfg_path).map_err(|e| format!("replace config.json: {e}"))?;
                log(h, "config.json written");
            }
            Ok(None) => log(h, "config.json unchanged"),
            Err(why) => log(h, &why),
        }
        if let Some((mut bytes, _)) = enroll {
            wipe(&mut bytes);
        }
        Ok(())
    })();
    wipe(&mut data_bytes);
    result
}

fn apply_install_rollback(h: MSIHANDLE) -> Result<(), String> {
    let dir = custom_action_data(h).ok_or("CustomActionData unavailable")?;
    let path = join(dir.trim(), "enroll.iaconfig");
    shred(Path::new(&path)).map_err(|e| format!("shred enroll.iaconfig: {e}"))?;
    log(h, "rollback: enroll.iaconfig removed");
    Ok(())
}

fn wipe_tree(h: MSIHANDLE, dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(t) if t.is_dir() => wipe_tree(h, &path),
            Ok(_) => {
                let name = entry.file_name().to_string_lossy().into_owned();
                if is_key_material(&name) {
                    if let Err(e) = shred(&path) {
                        log(h, &format!("could not shred {name}: {e}"));
                    }
                }
            }
            Err(_) => {}
        }
    }
}

fn wipe_data(h: MSIHANDLE) -> Result<(), String> {
    let data = custom_action_data(h).ok_or("CustomActionData unavailable")?;
    let (install_dir, data_dir) = parse_wipe(&data).ok_or("CustomActionData malformed")?;

    let iaconfig = join(install_dir, "enroll.iaconfig");
    if let Err(e) = shred(Path::new(&iaconfig)) {
        log(h, &format!("could not shred enroll.iaconfig: {e}"));
    }
    let dir = Path::new(data_dir);
    if dir.exists() {
        wipe_tree(h, dir);
        match fs::remove_dir_all(dir) {
            Ok(()) => log(h, "data directory removed"),
            Err(e) => log(h, &format!("could not remove data directory: {e}")),
        }
    }

    let parent = wide(DEVICE_REG_PARENT);
    let sub = wide(DEVICE_REG_SUBKEY);
    let mut key: HKEY = null_mut();
    // SAFETY: standard registry calls on a key we own and close.
    unsafe {
        if RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            parent.as_ptr(),
            0,
            KEY_ALL_ACCESS | KEY_WOW64_64KEY,
            &mut key,
        ) == ERROR_SUCCESS
        {
            let r = RegDeleteTreeW(key, sub.as_ptr());
            RegCloseKey(key);
            if r == ERROR_SUCCESS {
                log(h, "Device registry key removed");
            }
        }
    }
    Ok(())
}

fn run(h: MSIHANDLE, name: &str, fail_closed: bool, f: fn(MSIHANDLE) -> Result<(), String>) -> u32 {
    match catch_unwind(AssertUnwindSafe(|| f(h))) {
        Ok(Ok(())) => ERROR_SUCCESS,
        Ok(Err(why)) => {
            log(h, &format!("{name} failed: {why}"));
            if fail_closed {
                ERROR_INSTALL_FAILURE
            } else {
                ERROR_SUCCESS
            }
        }
        Err(_) => {
            log(h, &format!("{name} panicked"));
            if fail_closed {
                ERROR_INSTALL_FAILURE
            } else {
                ERROR_SUCCESS
            }
        }
    }
}

/// Deferred, no-impersonate. CustomActionData: `installDir|dataDir|wakerOptOut|amtProxyOptOut|IA_ENROLL`.
#[no_mangle]
pub extern "system" fn IaApplyInstall(h: MSIHANDLE) -> u32 {
    run(h, "IaApplyInstall", true, apply_install)
}

/// Rollback for `IaApplyInstall`. CustomActionData: `installDir`.
#[no_mangle]
pub extern "system" fn IaApplyInstallRollback(h: MSIHANDLE) -> u32 {
    run(h, "IaApplyInstallRollback", false, apply_install_rollback)
}

/// Deferred, no-impersonate, uninstall only. CustomActionData: `installDir|dataDir`.
#[no_mangle]
pub extern "system" fn IaWipeData(h: MSIHANDLE) -> u32 {
    run(h, "IaWipeData", false, wipe_data)
}
