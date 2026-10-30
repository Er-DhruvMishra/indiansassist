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
