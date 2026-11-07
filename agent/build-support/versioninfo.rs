// Shared by the build scripts of the Windows binaries (`include!`d by agent/crates/{ia-agent,ia-desktop,ia-service,
// ia-watchdog}/build.rs and packaging/windows/ca/build.rs). It embeds a VERSIONINFO resource, so Explorer, the UAC
// dialog and a signing service (SignPath checks it) see the product, the publisher and the release version:
//
//   ProductName      IndiansAssist
//   CompanyName      IndiansAssist Project
//   FileVersion      the release version (IA_RELEASE_VERSION, else the crate's version), also as FILEVERSION a.b.c.0
//   ProductVersion   the same
//
// Nothing happens for a non-Windows target. On `-msvc` the resource is compiled with rc.exe from the Windows SDK (RC,
// else the newest Windows Kits 10 x64 rc.exe) and the .res is passed to link.exe; on `-gnu` with windres. When the
// compiler is missing the build continues with a warning (dev builds), unless IA_REQUIRE_VERSIONINFO=1 (release CI).
// No crate dependency is added for this.

#[allow(dead_code)]
fn embed_version_info(original_filename: &str, description: &str) {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=IA_RELEASE_VERSION");
    println!("cargo:rerun-if-env-changed=IA_REQUIRE_VERSIONINFO");
    println!("cargo:rerun-if-env-changed=RC");
    println!("cargo:rerun-if-env-changed=WINDRES");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let required = std::env::var("IA_REQUIRE_VERSIONINFO").as_deref() == Ok("1");
    let version = std::env::var("IA_RELEASE_VERSION")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| std::env::var("CARGO_PKG_VERSION").ok())
        .unwrap_or_default();
    let numeric: Vec<u16> = version
        .split('-')
        .next()
        .unwrap_or("")
        .split('.')
        .map(|p| p.parse::<u16>().unwrap_or(0))
        .collect();
    if numeric.len() != 3 || version.contains('"') {
        panic!("versioninfo: the release version {version:?} is not MAJOR.MINOR.PATCH");
    }
    let (a, b, c) = (numeric[0], numeric[1], numeric[2]);
    let internal = original_filename
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(original_filename);
    // Numeric constants instead of <winver.h>, so rc.exe needs no include path: VS_FF 0, VOS_NT_WINDOWS32 0x40004,
    // VFT_APP 1 / VFT_DLL 2.
    let file_type = if original_filename.to_ascii_lowercase().ends_with(".dll") {
        2
    } else {
        1
    };
    let rc_text = format!(
        "1 VERSIONINFO\r\n\
         FILEVERSION {a},{b},{c},0\r\n\
         PRODUCTVERSION {a},{b},{c},0\r\n\
         FILEFLAGSMASK 0x3fL\r\n\
         FILEFLAGS 0x0L\r\n\
         FILEOS 0x40004L\r\n\
         FILETYPE {file_type}\r\n\
         FILESUBTYPE 0x0L\r\n\
         BEGIN\r\n\
         \x20 BLOCK \"StringFileInfo\"\r\n\
         \x20 BEGIN\r\n\
         \x20   BLOCK \"040904b0\"\r\n\
         \x20   BEGIN\r\n\
         \x20     VALUE \"CompanyName\", \"IndiansAssist Project\"\r\n\
         \x20     VALUE \"FileDescription\", \"{description}\"\r\n\
         \x20     VALUE \"FileVersion\", \"{version}\"\r\n\
         \x20     VALUE \"InternalName\", \"{internal}\"\r\n\
         \x20     VALUE \"LegalCopyright\", \"Copyright (c) IndiansAssist Project contributors\"\r\n\
         \x20     VALUE \"OriginalFilename\", \"{original_filename}\"\r\n\
         \x20     VALUE \"ProductName\", \"IndiansAssist\"\r\n\
         \x20     VALUE \"ProductVersion\", \"{version}\"\r\n\
         \x20   END\r\n\
         \x20 END\r\n\
         \x20 BLOCK \"VarFileInfo\"\r\n\
         \x20 BEGIN\r\n\
         \x20   VALUE \"Translation\", 0x409, 1200\r\n\
         \x20 END\r\n\
         END\r\n"
    );
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let rc = out_dir.join("ia-versioninfo.rc");
    std::fs::write(&rc, rc_text).expect("versioninfo: write the .rc file");

    fn newest_sdk_rc() -> Option<PathBuf> {
        let bin = Path::new(r"C:\Program Files (x86)\Windows Kits\10\bin");
        let mut versions: Vec<(Vec<u32>, PathBuf)> = std::fs::read_dir(bin)
            .ok()?
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let parts: Vec<u32> = name.split('.').filter_map(|p| p.parse().ok()).collect();
                let rc = e.path().join("x64").join("rc.exe");
                (parts.len() == 4 && rc.exists()).then_some((parts, rc))
            })
            .collect();
        versions.sort();
        versions.pop().map(|(_, p)| p)
    }

    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let compiled: Result<PathBuf, String> = if target_env == "msvc" {
        let res = out_dir.join("ia-versioninfo.res");
        let rc_exe = std::env::var_os("RC")
            .map(PathBuf::from)
            .or_else(newest_sdk_rc);
        match rc_exe {
            None => Err("rc.exe not found (Windows SDK); set RC".into()),
            Some(rc_exe) => match Command::new(&rc_exe)
                .arg("/nologo")
                .arg("/fo")
                .arg(&res)
                .arg(&rc)
                .status()
            {
                Ok(s) if s.success() => Ok(res),
                Ok(s) => Err(format!("{} exited {s}", rc_exe.display())),
                Err(e) => Err(format!("{}: {e}", rc_exe.display())),
            },
        }
    } else {
        let obj = out_dir.join("ia-versioninfo.o");
        let windres = std::env::var("WINDRES").unwrap_or_else(|_| "windres".into());
        match Command::new(&windres)
            .arg("--input")
            .arg(&rc)
            .arg("--output")
            .arg(&obj)
            .arg("--output-format=coff")
            .status()
        {
            Ok(s) if s.success() => Ok(obj),
            Ok(s) => Err(format!("{windres} exited {s}")),
            Err(e) => Err(format!("{windres}: {e}")),
        }
    };
    match compiled {
        Ok(path) => println!("cargo:rustc-link-arg={}", path.display()),
        Err(e) if required => panic!("versioninfo: IA_REQUIRE_VERSIONINFO=1 but {e}"),
        Err(e) => {
            println!("cargo:warning=no VERSIONINFO resource embedded in {original_filename}: {e}")
        }
    }
}
