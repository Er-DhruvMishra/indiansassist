//! Playbook argument validation, the cmd value rule, body lint, the output marker parser,
//! and the `pb.output` / `pb.end` wire types (contract §8).
//!
//! `validatePlaybookArgs` is enforced by the server and again by the agent. NFC
//! normalisation (contract §8.4) is performed by the shared canonicaliser before the
//! args reach the agent as canonical strings; this port validates charset, length and
//! pattern and is idempotent on already-NFC input (see agent/README.md).

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::OnceLock;

use crate::types::PlaybookInterpreter;

/// `CMD_VALUE_RE` (contract §8.4): extra restriction on every `cmd` string value.
pub fn cmd_value_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9 ._:\\/-]{0,256}$").unwrap())
}

fn param_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z][a-z0-9_]{0,31}$").unwrap())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParamType {
    String,
    Int,
    Bool,
    Enum,
}

/// `PlaybookParam` (contract §8.1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaybookParam {
    pub name: String,
    pub label: String,
    #[serde(rename = "type")]
    pub ty: ParamType,
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(rename = "enum", default, skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
    /// Required for `string` params; anchored by the server as `^(?:...)$`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<i64>,
}

fn has_c0_control(s: &str) -> bool {
    s.chars().any(|c| (c as u32) < 0x20 && c != '\t')
}

/// Validate and canonicalise args against the param set (contract §8.4). Returns the
/// `IA_PARAM_*` canonical string values on success, or a `bad_args` reason string.
pub fn validate_playbook_args(
    params: &[PlaybookParam],
    args: &BTreeMap<String, Value>,
    interpreter: PlaybookInterpreter,
) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    for p in params {
        if !param_name_re().is_match(&p.name) {
            return Err(format!("bad_args: param name {}", p.name));
        }
        let provided = args.get(&p.name);
        let value = match (provided, &p.default) {
            (Some(v), _) => v.clone(),
            (None, Some(d)) if !p.required => d.clone(),
            (None, _) if p.required => return Err(format!("bad_args: {} required", p.name)),
            (None, _) => continue,
        };

        let canonical = match p.ty {
            ParamType::Bool => match value {
                Value::Bool(b) => b.to_string(),
                _ => return Err(format!("bad_args: {} must be bool (no coercion)", p.name)),
            },
            ParamType::Int => match value.as_i64() {
                // Reject floats and numeric strings (no coercion from string).
                Some(n) if value.is_i64() => {
                    if let Some(min) = p.min {
                        if n < min {
                            return Err(format!("bad_args: {} < min", p.name));
                        }
                    }
                    if let Some(max) = p.max {
                        if n > max {
                            return Err(format!("bad_args: {} > max", p.name));
                        }
                    }
                    n.to_string()
                }
                _ => return Err(format!("bad_args: {} must be int (no coercion)", p.name)),
            },
            ParamType::String => {
                let s = match value {
                    Value::String(s) => s,
                    _ => return Err(format!("bad_args: {} must be string (no coercion)", p.name)),
                };
                validate_string_value(p, &s, interpreter)?;
                s
            }
            ParamType::Enum => {
                let s = match value {
                    Value::String(s) => s,
                    _ => return Err(format!("bad_args: {} must be enum string", p.name)),
                };
                let allowed = p
                    .enum_values
                    .as_ref()
                    .ok_or_else(|| format!("bad_args: {} enum has no values", p.name))?;
                if !allowed.contains(&s) {
                    return Err(format!("bad_args: {} not in enum", p.name));
                }
                s
            }
        };
        out.insert(p.name.clone(), canonical);
    }
    Ok(out)
}

fn validate_string_value(
    p: &PlaybookParam,
    s: &str,
    interpreter: PlaybookInterpreter,
) -> Result<(), String> {
    if s.chars().count() > 4000 {
        return Err(format!("bad_args: {} > 4000 chars", p.name));
    }
    if has_c0_control(s) {
        return Err(format!("bad_args: {} has control chars", p.name));
    }
    let pattern = p
        .pattern
        .as_ref()
        .ok_or_else(|| format!("bad_args: {} string needs a pattern", p.name))?;
    let anchored = Regex::new(&format!("^(?:{pattern})$"))
        .map_err(|_| format!("bad_args: {} bad pattern", p.name))?;
    if !anchored.is_match(s) {
        return Err(format!("bad_args: {} fails pattern", p.name));
    }
    match interpreter {
        PlaybookInterpreter::Cmd => {
            if !cmd_value_re().is_match(s) {
                return Err(format!("bad_args: {} fails cmd value rule", p.name));
            }
        }
        PlaybookInterpreter::Powershell => {
            if s.chars().count() > 4096 || s.contains('\u{0000}') {
                return Err(format!("bad_args: {} fails powershell rule", p.name));
            }
        }
        PlaybookInterpreter::Sh => {}
    }
    Ok(())
}

/// Result of linting a playbook body (contract §8.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LintResult {
    pub warnings: Vec<String>,
    /// `Some(reason)` means the body is refused (`400 validation_failed`).
    pub refusal: Option<String>,
}

/// `lintPlaybookBody` (contract §8.1): warn on risky PowerShell constructs; refuse a `cmd`
/// body that references `%IA_PARAM_` outside the quoted `set "x=%IA_PARAM_X%"` form.
pub fn lint_playbook_body(interpreter: PlaybookInterpreter, body: &str) -> LintResult {
    let mut warnings = Vec::new();
    let mut refusal = None;
    match interpreter {
        PlaybookInterpreter::Powershell => {
            for (needle, msg) in [
                ("invoke-expression", "Invoke-Expression"),
                ("iex", "iex"),
                ("add-type", "Add-Type"),
                ("start-process", "Start-Process"),
                ("cmd /c", "cmd /c"),
                ("%ia_param", "%IA_PARAM"),
            ] {
                if body.to_ascii_lowercase().contains(needle) {
                    warnings.push(format!("uses {msg}"));
                }
            }
        }
        PlaybookInterpreter::Cmd => {
            // Allowed only inside `set "x=%IA_PARAM_X%"`. Any other %IA_PARAM_ is refused.
            let allowed =
                Regex::new(r#"(?i)set\s+"[A-Za-z0-9_]+=%IA_PARAM_[A-Za-z0-9_]+%""#).unwrap();
            let any = Regex::new(r"(?i)%IA_PARAM_[A-Za-z0-9_]+%").unwrap();
            let total = any.find_iter(body).count();
            let ok = allowed.find_iter(body).count();
            if total > ok {
                refusal = Some("cmd body references %IA_PARAM_ outside the quoted set form".into());
            }
        }
        PlaybookInterpreter::Sh => {}
    }
    LintResult { warnings, refusal }
}

/// `PLAYBOOK_FILE_OFFER_RE` marker (contract §8.5 O1). A `pb.output` line that reads exactly
/// `IA_FILE_OFFER <absolute path>` with a path under `base_dir` opens the F5 send prompt.
pub fn parse_marker(line: &str, base_dir: &str) -> Option<String> {
    let path = line.trim().strip_prefix("IA_FILE_OFFER ")?.trim();
    if path.is_empty() {
        return None;
    }
    let base = base_dir.trim_end_matches(['/', '\\']);
    let norm = path.replace('/', "\\");
    let base_norm = base.replace('/', "\\");
    if norm
        .to_ascii_lowercase()
        .starts_with(&format!("{}\\", base_norm.to_ascii_lowercase()))
    {
        Some(path.to_string())
    } else {
        None
    }
}

/// `PLAYBOOK_ERRORS` (contract §8.5 O2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybookError {
    Timeout,
    Cancelled,
    SpawnFailed,
    HashMismatch,
    NotAllowed,
    ElevationRequired,
    Busy,
    OutputError,
}

impl PlaybookError {
    pub const ALL: [Self; 8] = [
        Self::Timeout,
        Self::Cancelled,
        Self::SpawnFailed,
        Self::HashMismatch,
        Self::NotAllowed,
        Self::ElevationRequired,
        Self::Busy,
        Self::OutputError,
    ];
}

/// `pb.output` (contract §8.5 O1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PbOutput {
    pub t: String, // "pb.output"
    #[serde(rename = "runId")]
    pub run_id: String,
    pub stream: String, // "stdout" | "stderr"
    pub seq: u32,
    pub chunk: String,
    pub ts: i64,
}

/// `pb.end` (contract §8.5 O2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PbEnd {
    pub t: String, // "pb.end"
    #[serde(rename = "runId")]
    pub run_id: String,
    pub exit: Option<i32>,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
    pub truncated: bool,
    #[serde(rename = "ranAs")]
    pub ran_as: String, // "user" | "admin"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<PlaybookError>,
    pub ts: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(pairs: &[(&str, Value)]) -> BTreeMap<String, Value> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    fn string_param(name: &str, pattern: &str) -> PlaybookParam {
        PlaybookParam {
            name: name.into(),
            label: name.into(),
            ty: ParamType::String,
            required: true,
            default: None,
            enum_values: None,
            pattern: Some(pattern.into()),
            min: None,
            max: None,
        }
    }

    #[test]
    fn bool_and_int_no_coercion() {
        let p_bool = PlaybookParam {
            name: "force".into(),
            label: "f".into(),
            ty: ParamType::Bool,
            required: true,
            default: None,
            enum_values: None,
            pattern: None,
            min: None,
            max: None,
        };
        let p_int = PlaybookParam {
            name: "count".into(),
            label: "c".into(),
            ty: ParamType::Int,
            required: true,
            default: None,
            enum_values: None,
            pattern: None,
            min: Some(0),
            max: Some(10),
        };
        let ps = vec![p_bool, p_int];
        let good = validate_playbook_args(
            &ps,
            &args(&[("force", json!(true)), ("count", json!(5))]),
            PlaybookInterpreter::Powershell,
        )
        .unwrap();
        assert_eq!(good.get("force").unwrap(), "true");
        assert_eq!(good.get("count").unwrap(), "5");

        // String "true" for a bool param => bad_args (no coercion).
        assert!(validate_playbook_args(
            &ps,
            &args(&[("force", json!("true")), ("count", json!(5))]),
            PlaybookInterpreter::Powershell
        )
        .is_err());
        // Out of range.
        assert!(validate_playbook_args(
            &ps,
            &args(&[("force", json!(false)), ("count", json!(99))]),
            PlaybookInterpreter::Powershell
        )
        .is_err());
    }

    #[test]
    fn string_pattern_enforced() {
        let p = string_param("name", r"[A-Za-z]+");
        assert!(validate_playbook_args(
            std::slice::from_ref(&p),
            &args(&[("name", json!("Rahul"))]),
            PlaybookInterpreter::Powershell
        )
        .is_ok());
        assert!(validate_playbook_args(
            &[p],
            &args(&[("name", json!("Rahul123"))]),
            PlaybookInterpreter::Powershell
        )
        .is_err());
    }

    #[test]
    fn cmd_value_rule_blocks_injection() {
        // A pattern that would otherwise allow `&`, but the cmd rule rejects it.
        let p = string_param("target", r".*");
        assert!(validate_playbook_args(
            std::slice::from_ref(&p),
            &args(&[("target", json!("C:/temp/report.txt"))]),
            PlaybookInterpreter::Cmd
        )
        .is_ok());
        assert!(validate_playbook_args(
            &[p],
            &args(&[("target", json!("x & calc.exe"))]),
            PlaybookInterpreter::Cmd
        )
        .is_err());
    }

    #[test]
    fn lint_warns_powershell_and_refuses_cmd() {
        let warn = lint_playbook_body(PlaybookInterpreter::Powershell, "iex (Get-Thing)");
        assert!(warn.warnings.iter().any(|w| w.contains("iex")));
        assert!(warn.refusal.is_none());

        let refused = lint_playbook_body(PlaybookInterpreter::Cmd, "echo %IA_PARAM_X%");
        assert!(refused.refusal.is_some());

        let ok = lint_playbook_body(
            PlaybookInterpreter::Cmd,
            "set \"x=%IA_PARAM_X%\"\r\necho %x%",
        );
        assert!(ok.refusal.is_none());
    }

    #[test]
    fn marker_parsing_requires_base_dir() {
        let base = r"C:\Users\x\AppData\Local\IndiansAssist";
        assert_eq!(
            parse_marker(
                r"IA_FILE_OFFER C:\Users\x\AppData\Local\IndiansAssist\logs.zip",
                base
            ),
            Some(r"C:\Users\x\AppData\Local\IndiansAssist\logs.zip".to_string())
        );
        // Outside the base dir => ignored.
        assert_eq!(
            parse_marker(r"IA_FILE_OFFER C:\Windows\system32\x.dll", base),
            None
        );
        // Not a marker line.
        assert_eq!(parse_marker("just output", base), None);
    }

    #[test]
    fn pb_frames_round_trip() {
        let out = PbOutput {
            t: "pb.output".into(),
            run_id: "ab".repeat(16),
            stream: "stdout".into(),
            seq: 0,
            chunk: "hello".into(),
            ts: 1,
        };
        let j = serde_json::to_string(&out).unwrap();
        assert!(j.contains("\"runId\""));
        assert_eq!(serde_json::from_str::<PbOutput>(&j).unwrap(), out);

        let end = PbEnd {
            t: "pb.end".into(),
            run_id: "ab".repeat(16),
            exit: Some(0),
            duration_ms: 1234,
            truncated: false,
            ran_as: "user".into(),
            error: None,
            ts: 2,
        };
        let j = serde_json::to_string(&end).unwrap();
        assert_eq!(serde_json::from_str::<PbEnd>(&j).unwrap(), end);
    }
}
