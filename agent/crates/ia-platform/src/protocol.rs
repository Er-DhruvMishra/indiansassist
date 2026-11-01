//! The HKCU `indiansassist://` protocol-handler value set (§2.5 L1) and the
//! single-instance / hand-over pipe and mutex name derivation (§11.5, §7.2). Pure logic.

/// One registry value to write under `HKCU\Software\Classes\indiansassist`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegValue {
    /// Sub-key relative to `HKCU\Software\Classes\indiansassist` (empty = the key itself).
    pub subkey: &'static str,
    /// Value name (empty = the `(Default)` value).
    pub name: &'static str,
    pub value: String,
}

/// The full value set the agent writes on every start (§2.5 L1). Per-user; no admin.
pub fn protocol_handler_values(exe_path: &str) -> Vec<RegValue> {
    vec![
        RegValue {
            subkey: "",
            name: "",
            value: "URL:IndiansAssist".into(),
        },
        RegValue {
            subkey: "",
            name: "URL Protocol",
            value: String::new(),
        },
        RegValue {
            subkey: "DefaultIcon",
            name: "",
            value: format!("\"{exe_path}\",0"),
        },
        RegValue {
            subkey: r"shell\open\command",
            name: "",
            value: format!("\"{exe_path}\" --url \"%1\""),
        },
    ]
}

/// `Local\IndiansAssist.<userSid>` single-instance mutex (§11.5). `Local\`, never `Global\`.
pub fn mutex_name(user_sid: &str) -> String {
    format!(r"Local\IndiansAssist.{user_sid}")
}

/// A distinct mutex suffix for the elevated hand-over child so it coexists with the
/// exiting parent (§11.5).
pub fn handover_mutex_name(user_sid: &str) -> String {
    format!(r"Local\IndiansAssist.{user_sid}.ho")
}

/// `\\.\pipe\IndiansAssist.<userSid>.<logonRand>` single-instance pipe (§2.1 / §11.5).
pub fn single_instance_pipe(user_sid: &str, logon_rand: &str) -> String {
    format!(r"\\.\pipe\IndiansAssist.{user_sid}.{logon_rand}")
}

/// `\\.\pipe\IndiansAssist.ho.<32 hex>` hand-over pipe (§7.2). Caller supplies 32 hex chars.
pub fn handover_pipe(hex32: &str) -> String {
    format!(r"\\.\pipe\IndiansAssist.ho.{hex32}")
}

/// `\\.\pipe\IndiansAssist.svc.<32 hex>`: the Phase D service to desktop-worker pipe (D §4.2).
/// The suffix is not a secret — the pid, image and DACL checks are what authenticate the peer —
/// but it is fresh per worker, so a stale pipe can never be reused.
pub fn service_worker_pipe(hex32: &str) -> String {
    format!(r"\\.\pipe\IndiansAssist.svc.{hex32}")
}

/// The well-known SDDL alias for `NT AUTHORITY\SYSTEM`.
pub const SDDL_SYSTEM: &str = "SY";

/// The DACL of the §4.2 pipe: a protected ACL (`P`, so no inherited entry widens it) granting
/// full access to `SYSTEM` and to the launched worker's user SID, and to nobody else — not even
/// `Administrators`, which the C §7.2 hand-over pipe grants because its server runs as the user,
/// and which here would only widen the surface (the server is already `LocalSystem`). A worker
/// that itself runs as `LocalSystem` (the secure-desktop and logon-screen targets) collapses to
/// the single `SYSTEM` entry rather than repeating it.
pub fn service_worker_pipe_dacl(worker_sid: &str) -> String {
    let w = worker_sid.trim();
    let is_system =
        w.is_empty() || w.eq_ignore_ascii_case(SDDL_SYSTEM) || w.eq_ignore_ascii_case("S-1-5-18");
    if is_system {
        format!("D:P(A;;GA;;;{SDDL_SYSTEM})")
    } else {
        format!("D:P(A;;GA;;;{SDDL_SYSTEM})(A;;GA;;;{w})")
    }
}

/// Whether two image paths name the same file (case-insensitive, `\\?\` prefix and slash
/// direction ignored). Both pipe peers use it to check that the process on the other end runs
/// the image this one does (C §7.2, D §4.2).
pub fn same_image(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.trim_start_matches(r"\\?\")
            .replace('/', "\\")
            .to_lowercase()
    };
    !a.is_empty() && norm(a) == norm(b)
}

/// A fresh, non-secret pipe suffix: 32 lower-case hex characters from the OS generator.
pub fn new_pipe_suffix() -> String {
    ia_core::rnd::hex(16)
}

/// A pipe suffix is exactly 32 lower-case hex characters (`--handover-pipe`, `--service-pipe`).
pub fn valid_pipe_suffix(s: &str) -> bool {
    s.len() == 32
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// The `--url` argument rule (§2.5 L2): when `--url` is present the agent joins the entire
/// remaining command-line tail into one string and ignores every other switch. This
/// reassembles that tail from the already-split args following `--url`.
pub fn url_tail(args: &[String]) -> Option<String> {
    let pos = args.iter().position(|a| a == "--url")?;
    let tail = &args[pos + 1..];
    if tail.is_empty() {
        None
    } else {
        Some(tail.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handler_values_match_contract() {
        let vs = protocol_handler_values(r"C:\Users\x\Downloads\IndiansAssist-in-mum-1-2-3.exe");
        assert!(vs
            .iter()
            .any(|v| v.name.is_empty() && v.subkey.is_empty() && v.value == "URL:IndiansAssist"));
        assert!(vs
            .iter()
            .any(|v| v.name == "URL Protocol" && v.value.is_empty()));
        let cmd = vs
            .iter()
            .find(|v| v.subkey == r"shell\open\command")
            .unwrap();
        assert!(cmd.value.ends_with(r#" --url "%1""#));
    }

    #[test]
    fn pipe_and_mutex_names() {
        assert_eq!(mutex_name("S-1-5-21-1"), r"Local\IndiansAssist.S-1-5-21-1");
        assert!(!mutex_name("x").starts_with(r"Global\"));
        assert_eq!(
            single_instance_pipe("S-1-5-21-1", "deadbeef"),
            r"\\.\pipe\IndiansAssist.S-1-5-21-1.deadbeef"
        );
        assert_eq!(
            handover_pipe("ab").as_str(),
            r"\\.\pipe\IndiansAssist.ho.ab"
        );
    }

    #[test]
    fn the_service_pipe_name_and_dacl_are_the_contract_ones() {
        assert_eq!(
            service_worker_pipe("0123456789abcdef0123456789abcdef"),
            r"\\.\pipe\IndiansAssist.svc.0123456789abcdef0123456789abcdef"
        );
        // A worker running as a user: SYSTEM and that user, nobody else, protected.
        let d = service_worker_pipe_dacl("S-1-5-21-77-1001");
        assert_eq!(d, "D:P(A;;GA;;;SY)(A;;GA;;;S-1-5-21-77-1001)");
        assert!(
            !d.contains(";;BA)"),
            "Administrators are not granted this pipe"
        );
        // A LocalSystem worker: one entry, not a repeated one.
        for sid in ["SY", "S-1-5-18", "s-1-5-18", ""] {
            assert_eq!(service_worker_pipe_dacl(sid), "D:P(A;;GA;;;SY)");
        }
    }

    #[test]
    fn a_pipe_suffix_is_fresh_and_checked() {
        let a = new_pipe_suffix();
        assert!(valid_pipe_suffix(&a));
        assert_ne!(a, new_pipe_suffix());
        for bad in [
            "",
            "ABCDEF0123456789abcdef0123456789",
            "0123",
            &"0".repeat(33),
        ] {
            assert!(!valid_pipe_suffix(bad), "{bad} must not pass");
        }
    }

    #[test]
    fn the_same_image_check_ignores_case_prefix_and_slashes_but_not_another_file() {
        assert!(same_image(
            r"\\?\C:\Program Files\IndiansAssist\ia-desktop.exe",
            r"c:/program files/indiansassist/IA-DESKTOP.EXE"
        ));
        assert!(!same_image(
            r"C:\Program Files\IndiansAssist\ia-desktop.exe",
            r"C:\Users\x\Downloads\ia-desktop.exe"
        ));
        assert!(!same_image("", ""));
    }

    #[test]
    fn url_tail_takes_everything_after_the_switch() {
        // The quote-breakout: Windows hands us one trailing arg because of the quoting;
        // even split, the tail rejoins to one URL string and no `--api-origin` switch is
        // treated as a switch (§2.5 L2).
        let args = vec![
            "--url".to_string(),
            r#"indiansassist://join?c=1234" --api-origin "http://attacker:4000"#.to_string(),
        ];
        let tail = url_tail(&args).unwrap();
        assert!(tail.contains("attacker"));
        // The caller passes this whole string to normalise_token_input, which rejects it.
        assert_eq!(ia_core::join_input::normalise_token_input(&tail), None);
    }

    #[test]
    fn url_tail_rejoins_split_args() {
        let args = vec!["--url".to_string(), "a".to_string(), "b".to_string()];
        assert_eq!(url_tail(&args), Some("a b".to_string()));
        assert_eq!(url_tail(&["--code".to_string()]), None);
    }
}
