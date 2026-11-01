//! Self-delete stub generation with argument safety (contract §10 D2). Pure logic: no OS
//! calls, so the "no injectable command line" test runs on any target.

use regex::Regex;
use std::path::Path;
use std::sync::OnceLock;

/// Whether `child` is `ancestor` or lies under it (contract §10 D2: the cleanup stub is only
/// written when `%TEMP%` resolves under `%USERPROFILE%`). Pure path-prefix logic; the caller
/// canonicalises both paths first.
pub fn is_under(child: &Path, ancestor: &Path) -> bool {
    child == ancestor || child.starts_with(ancestor)
}

/// The fixed cleanup-stub file name for a 32-hex token (`ia-cleanup-<32 hex>.cmd`, §10 D2).
pub fn cleanup_stub_name(hex32: &str) -> String {
    format!("ia-cleanup-{hex32}.cmd")
}

/// Allow-list for the exe path placed on the stub's command line (§10 D2):
/// a drive-letter path with none of the shell metacharacters `& | < > ^ % ! "`.
fn exe_path_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"^[A-Za-z]:\\[^&|<>^%!"]*$"#).unwrap())
}

/// The cleanup stub: fixed `.cmd` text plus the exact command line to spawn it with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanupStub {
    /// The fixed `.cmd` body (never interpolates the path; uses `%1` and `%~2`).
    pub script_text: String,
    /// The `cmd.exe /c <stub> <pid> <exePath>` command line, with the path quoted/escaped.
    pub command_line: String,
}

/// Build the cleanup stub, or `Err` with the file to delete by hand if the exe path fails
/// the allow-list (§10 D2: "a path that fails the allow-list makes the agent skip the stub
/// and tell the user which file to delete by hand").
pub fn generate_cleanup_stub(
    stub_path: &str,
    pid: u32,
    exe_path: &str,
) -> Result<CleanupStub, String> {
    if !exe_path_re().is_match(exe_path) {
        return Err(exe_path.to_string());
    }
    // The stub's text is fixed; the pid and path arrive only as %1 and %~2.
    let script_text = "\
@echo off\r\n\
setlocal\r\n\
set IA_PID=%1\r\n\
set IA_EXE=%~2\r\n\
set /a IA_TRIES=0\r\n\
:waitpid\r\n\
tasklist /FI \"PID eq %IA_PID%\" | find \"%IA_PID%\" >nul 2>&1\r\n\
if errorlevel 1 goto gone\r\n\
set /a IA_TRIES+=1\r\n\
if %IA_TRIES% GEQ 30 goto gone\r\n\
timeout /t 1 /nobreak >nul 2>&1\r\n\
goto waitpid\r\n\
:gone\r\n\
set /a IA_TRIES=0\r\n\
:delexe\r\n\
del /f /q \"%IA_EXE%\" >nul 2>&1\r\n\
if not exist \"%IA_EXE%\" goto done\r\n\
set /a IA_TRIES+=1\r\n\
if %IA_TRIES% GEQ 10 goto done\r\n\
timeout /t 1 /nobreak >nul 2>&1\r\n\
goto delexe\r\n\
:done\r\n\
del /f /q \"%~f0\" >nul 2>&1\r\n"
        .to_string();

    // `%~2` strips surrounding quotes inside the stub, so we quote the path on the command
    // line and caret-escape any residual metacharacters (the allow-list already excludes
    // the dangerous ones, so this is belt-and-braces).
    let escaped = escape_cmd_arg(exe_path);
    let command_line = format!("cmd.exe /c \"{stub_path}\" {pid} \"{escaped}\"");

    Ok(CleanupStub {
        script_text,
        command_line,
    })
}

fn escape_cmd_arg(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '^' | '"') {
            out.push('^');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_path_builds_safe_command_line() {
        let s = generate_cleanup_stub(
            r"C:\Users\x\AppData\Local\Temp\ia-cleanup-ab.cmd",
            4242,
            r"C:\Users\x\Downloads\IndiansAssist-in-mum-1-2-3.exe",
        )
        .unwrap();
        assert!(s.command_line.contains("4242"));
        assert!(s.script_text.contains("%~2"));
        // Path never interpolated into the body.
        assert!(!s.script_text.contains("IndiansAssist-in-mum"));
    }

    #[test]
    fn metacharacter_path_is_refused_not_injected() {
        // Contract §15.2 vector: a folder named "Down & calc.exe".
        let res = generate_cleanup_stub(
            r"C:\Temp\ia-cleanup.cmd",
            1,
            r"C:\Users\x\Down & calc.exe\IndiansAssist-in-mum-1-2-3.exe",
        );
        assert_eq!(
            res,
            Err(r"C:\Users\x\Down & calc.exe\IndiansAssist-in-mum-1-2-3.exe".to_string())
        );
    }

    #[test]
    fn quote_and_pipe_paths_refused() {
        assert!(generate_cleanup_stub("s", 1, r#"C:\a"b\x.exe"#).is_err());
        assert!(generate_cleanup_stub("s", 1, r"C:\a|b\x.exe").is_err());
        assert!(generate_cleanup_stub("s", 1, r"C:\a%b\x.exe").is_err());
        // A relative path (no drive) is refused too.
        assert!(generate_cleanup_stub("s", 1, r"..\x.exe").is_err());
    }

    // Windows path semantics (backslash separators, drive letters): on Linux `Path` does not split on `\`, so this
    // assertion is only meaningful on a Windows host. The Linux temp/profile rule is the Phase E contract's.
    #[cfg(windows)]
    #[test]
    fn temp_must_be_under_user_profile() {
        let profile = Path::new(r"C:\Users\x");
        assert!(is_under(
            Path::new(r"C:\Users\x\AppData\Local\Temp"),
            profile
        ));
        assert!(is_under(profile, profile));
        // A %TEMP% outside the profile (e.g. a redirected C:\Temp) is refused.
        assert!(!is_under(Path::new(r"C:\Temp"), profile));
        assert!(!is_under(Path::new(r"D:\Users\x\Temp"), profile));
    }

    #[test]
    fn cleanup_stub_name_is_hex_scoped() {
        assert_eq!(
            cleanup_stub_name(&"ab".repeat(16)),
            format!("ia-cleanup-{}.cmd", "ab".repeat(16))
        );
    }
}
