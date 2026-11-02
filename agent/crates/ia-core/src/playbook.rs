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

fn int_canon_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?:0|-?[1-9][0-9]{0,15})$").unwrap())
}

fn is_nfc(s: &str) -> bool {
    icu_normalizer::ComposingNormalizerBorrowed::new_nfc().normalize(s) == s
}

/// Canonicalise a param `default` (typed, from the manifest) to its canonical string.
fn canonical_default(p: &PlaybookParam, v: &Value) -> Result<String, String> {
    match (p.ty, v) {
        (ParamType::Bool, Value::Bool(b)) => Ok(b.to_string()),
        (ParamType::Int, Value::Number(n)) if n.is_i64() => Ok(n.as_i64().unwrap_or(0).to_string()),
        (ParamType::String | ParamType::Enum, Value::String(s)) => Ok(s.clone()),
        _ => Err(format!("bad_args: {} default has the wrong type", p.name)),
    }
}

/// The **agent path** of `validatePlaybookArgs` (contract §8.4; the TypeScript
/// `validatePlaybookArgs(params, args, interpreter, { canonical: true })`): every provided
/// value is the canonical string the server shipped in the `202` reply — `true` / `false`,
/// a decimal integer with no sign for zero and no leading zero, strings already in NFC. No
/// coercion: `"TRUE"`, `"+5"` or `"05"` are refused. An unknown parameter is refused. A
/// missing optional parameter takes its manifest default. Returns the `IA_PARAM_<NAME>`
/// values (upper-cased names are applied by the runner).
pub fn validate_canonical_playbook_args(
    params: &[PlaybookParam],
    args: &BTreeMap<String, Value>,
    interpreter: PlaybookInterpreter,
) -> Result<BTreeMap<String, String>, String> {
    for k in args.keys() {
        if !params.iter().any(|p| &p.name == k) {
            return Err(format!("bad_args: unknown parameter {k}"));
        }
    }
    let mut out = BTreeMap::new();
    for p in params {
        if !param_name_re().is_match(&p.name) {
            return Err(format!("bad_args: param name {}", p.name));
        }
        let (s, from_default) = match (args.get(&p.name), &p.default) {
            (Some(Value::String(s)), _) => (s.clone(), false),
            (Some(_), _) => return Err(format!("bad_args: {} must be a canonical string", p.name)),
            (None, Some(d)) => (canonical_default(p, d)?, true),
            (None, None) if p.required => return Err(format!("bad_args: {} required", p.name)),
            (None, None) => continue,
        };
        match p.ty {
            ParamType::Bool => {
                if s != "true" && s != "false" {
                    return Err(format!("bad_args: {} expected true or false", p.name));
                }
            }
            ParamType::Int => {
                if !int_canon_re().is_match(&s) {
                    return Err(format!("bad_args: {} expected a canonical integer", p.name));
                }
                let n: i64 = s
                    .parse()
                    .map_err(|_| format!("bad_args: {} expected a canonical integer", p.name))?;
                if p.min.is_some_and(|min| n < min) || p.max.is_some_and(|max| n > max) {
                    return Err(format!("bad_args: {} out of range", p.name));
                }
            }
            ParamType::String | ParamType::Enum => {
                if !from_default && !is_nfc(&s) {
                    return Err(format!("bad_args: {} not in NFC", p.name));
                }
                if p.ty == ParamType::Enum {
                    if s.chars().count() > 4000 || has_c0_control(&s) {
                        return Err(format!("bad_args: {} bad enum value", p.name));
                    }
                    if interpreter == PlaybookInterpreter::Cmd && !cmd_value_re().is_match(&s) {
                        return Err(format!("bad_args: {} fails cmd value rule", p.name));
                    }
                    let allowed = p.enum_values.as_deref().unwrap_or(&[]);
                    if !allowed.contains(&s) {
                        return Err(format!("bad_args: {} not in enum", p.name));
                    }
                } else {
                    validate_string_value(p, &s, interpreter)?;
                }
            }
        }
        out.insert(p.name.clone(), s);
    }
    Ok(out)
}

/// The `IA_PARAM_<NAME>` environment for a validated arg set (contract §8.4): the param name
/// upper-cased, the canonical string as the value. Values travel out of band as data.
pub fn param_env(canonical: &BTreeMap<String, String>) -> Vec<(String, String)> {
    canonical
        .iter()
        .map(|(k, v)| (format!("IA_PARAM_{}", k.to_ascii_uppercase()), v.clone()))
        .collect()
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

/// The pinned manifest entry the agent received at `session.created` (contract §8.3). Only
/// the fields the agent's run checks need.
#[derive(Debug, Clone, PartialEq)]
pub struct ManifestEntry {
    pub id: String,
    pub body_hash: String,
    pub requires_elevation: bool,
    /// The pinned `parameters` (re-validated on every run, §8.4).
    pub parameters: Vec<PlaybookParam>,
    /// The pinned `timeoutSec` (1..=900); the runner enforces it (§8.5 O3).
    pub timeout_sec: u32,
}

impl ManifestEntry {
    /// The timeout the runner enforces: the pinned manifest value clamped to
    /// `1..=LIMITS.playbookTimeoutMaxSec` (a run op cannot extend it).
    pub fn effective_timeout_sec(&self, requested: u32) -> u32 {
        let pinned = if self.timeout_sec == 0 {
            120
        } else {
            self.timeout_sec
        };
        let asked = if requested == 0 { pinned } else { requested };
        asked
            .min(pinned)
            .clamp(1, crate::types::limits::PLAYBOOK_TIMEOUT_MAX_SEC)
    }
}

/// A `playbook.run` op's body-bearing args (contract §8.4), copied verbatim from the REST
/// `202` reply by the console.
#[derive(Debug, Clone, PartialEq)]
pub struct RunRequest {
    pub run_id: String,
    pub playbook_id: String,
    pub body_hash: String,
    pub body: String,
    pub interpreter: PlaybookInterpreter,
    pub requires_elevation: bool,
    pub timeout_sec: u32,
    /// The canonical-string args copied from the `202` reply (re-validated, §8.4).
    pub args: BTreeMap<String, Value>,
}

/// The agent's checks before running (contract §8.4). Each failure maps to a
/// [`PlaybookError`] the caller puts on `ctl.res` and `pb.end`.
pub fn check_run(
    run: &RunRequest,
    manifest: &[ManifestEntry],
    integrity: crate::types::ElevationLevel,
) -> Result<(), PlaybookError> {
    use sha2::{Digest, Sha256};
    let entry = manifest
        .iter()
        .find(|m| m.id == run.playbook_id)
        .ok_or(PlaybookError::NotAllowed)?;
    // sha256(body) === bodyHash === manifest.bodyHash (contract §8.4).
    let computed = hex::encode(Sha256::digest(run.body.as_bytes()));
    if !computed.eq_ignore_ascii_case(&run.body_hash)
        || !run.body_hash.eq_ignore_ascii_case(&entry.body_hash)
    {
        return Err(PlaybookError::HashMismatch);
    }
    if run.requires_elevation != entry.requires_elevation {
        return Err(PlaybookError::HashMismatch);
    }
    if run.requires_elevation && integrity != crate::types::ElevationLevel::Admin {
        return Err(PlaybookError::ElevationRequired);
    }
    // An interpreter this agent does not run is not_allowed: the Windows agent runs PowerShell
    // and cmd, the Linux agent `sh` only (Phase E §7.5 / §7.8; the manifest already filters by
    // the advertised interpreters, so this is the agent's own check).
    if !native_interpreters().contains(&run.interpreter) {
        return Err(PlaybookError::NotAllowed);
    }
    Ok(())
}

/// The interpreters the agent on this target runs (and advertises): `powershell` and `cmd`
/// on Windows, `sh` on Linux (Phase E §7.5).
pub fn native_interpreters() -> &'static [PlaybookInterpreter] {
    if cfg!(target_os = "linux") {
        &[PlaybookInterpreter::Sh]
    } else {
        &[PlaybookInterpreter::Powershell, PlaybookInterpreter::Cmd]
    }
}

/// How a playbook is launched (contract §8.4 execution table). Pure decision; the binary
/// performs the spawn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    pub interpreter: PlaybookInterpreter,
    /// PowerShell: the body goes to the child's **stdin** (`-Command -`), no file on disk.
    pub via_stdin: bool,
    /// cmd: the body is written to a run file under the (user or admin) run dir.
    pub via_run_file: bool,
    /// `ranAs` on `pb.end`: `admin` only in the elevated instance for a `requiresElevation`
    /// playbook; otherwise `user` (the limited linked token in the admin instance).
    pub ran_as: &'static str,
    pub create_no_window: bool,
}

/// Decide the launch plan (contract §8.4).
pub fn launch_plan(
    interpreter: PlaybookInterpreter,
    requires_elevation: bool,
    integrity: crate::types::ElevationLevel,
) -> LaunchPlan {
    let admin_instance = integrity == crate::types::ElevationLevel::Admin;
    let ran_as = if requires_elevation && admin_instance {
        "admin"
    } else {
        // A non-`requiresElevation` playbook in the admin instance runs under the limited
        // linked token (`ranAs: 'user'`, §8.4).
        "user"
    };
    LaunchPlan {
        interpreter,
        via_stdin: interpreter == PlaybookInterpreter::Powershell,
        via_run_file: interpreter == PlaybookInterpreter::Cmd,
        ran_as,
        create_no_window: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ElevationLevel;
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

    fn run_req(body: &str, requires_elevation: bool) -> RunRequest {
        use sha2::{Digest, Sha256};
        RunRequest {
            run_id: "ab".repeat(16),
            playbook_id: "pb-1".into(),
            body_hash: hex::encode(Sha256::digest(body.as_bytes())),
            body: body.into(),
            interpreter: native_interpreters()[0],
            requires_elevation,
            timeout_sec: 120,
            args: BTreeMap::new(),
        }
    }

    #[test]
    fn check_run_refuses_an_interpreter_this_agent_does_not_run() {
        for i in PlaybookInterpreter::ALL {
            let mut run = run_req("echo hi", false);
            run.interpreter = i;
            let manifest = vec![entry("pb-1", &run.body_hash, false)];
            let want = if native_interpreters().contains(&i) {
                Ok(())
            } else {
                Err(PlaybookError::NotAllowed)
            };
            assert_eq!(
                check_run(&run, &manifest, ElevationLevel::User),
                want,
                "{i:?}"
            );
        }
        assert_eq!(
            native_interpreters().contains(&PlaybookInterpreter::Sh),
            cfg!(target_os = "linux")
        );
    }

    fn entry(id: &str, body_hash: &str, requires_elevation: bool) -> ManifestEntry {
        ManifestEntry {
            id: id.into(),
            body_hash: body_hash.into(),
            requires_elevation,
            parameters: vec![],
            timeout_sec: 120,
        }
    }

    #[test]
    fn check_run_passes_when_hash_and_elevation_agree() {
        let run = run_req("Write-Output 'hi'", false);
        let manifest = vec![entry("pb-1", &run.body_hash, false)];
        assert_eq!(check_run(&run, &manifest, ElevationLevel::User), Ok(()));
    }

    #[test]
    fn check_run_rejects_unknown_tampered_and_under_privileged() {
        let run = run_req("whoami", true);
        // playbookId not in manifest => not_allowed
        assert_eq!(
            check_run(&run, &[], ElevationLevel::Admin),
            Err(PlaybookError::NotAllowed)
        );
        // hash mismatch
        let bad_hash = vec![entry("pb-1", &"00".repeat(32), true)];
        assert_eq!(
            check_run(&run, &bad_hash, ElevationLevel::Admin),
            Err(PlaybookError::HashMismatch)
        );
        // requiresElevation but a user instance
        let good = vec![entry("pb-1", &run.body_hash, true)];
        assert_eq!(
            check_run(&run, &good, ElevationLevel::User),
            Err(PlaybookError::ElevationRequired)
        );
        assert_eq!(check_run(&run, &good, ElevationLevel::Admin), Ok(()));
    }

    fn fixture_params() -> Vec<PlaybookParam> {
        serde_json::from_value(json!([
            { "name": "host", "label": "Host", "type": "string", "required": true, "pattern": "[A-Za-z0-9.-]{1,253}" },
            { "name": "count", "label": "Count", "type": "int", "required": false, "min": -5, "max": 100, "default": 4 },
            { "name": "verbose", "label": "Verbose", "type": "bool", "required": false, "default": false },
            { "name": "mode", "label": "Mode", "type": "enum", "required": false, "enum": ["fast", "full"] }
        ]))
        .unwrap()
    }

    #[test]
    fn canonical_args_accept_server_strings_and_apply_defaults() {
        let ps = fixture_params();
        let out = validate_canonical_playbook_args(
            &ps,
            &args(&[("host", json!("example.com"))]),
            PlaybookInterpreter::Powershell,
        )
        .unwrap();
        assert_eq!(out.get("count").unwrap(), "4");
        assert_eq!(out.get("verbose").unwrap(), "false");
        assert!(!out.contains_key("mode"));
        let env = param_env(&out);
        assert!(env.contains(&("IA_PARAM_HOST".to_string(), "example.com".to_string())));
    }

    #[test]
    fn canonical_args_refuse_non_canonical_and_unknown() {
        let ps = fixture_params();
        for bad in [
            args(&[("host", json!("a")), ("count", json!("+5"))]),
            args(&[("host", json!("a")), ("count", json!("05"))]),
            args(&[("host", json!("a")), ("verbose", json!("TRUE"))]),
            args(&[("host", json!("a")), ("count", json!(5))]),
            args(&[("host", json!("a")), ("extra", json!("x"))]),
            args(&[("host", json!("a b"))]),
            args(&[]),
        ] {
            assert!(
                validate_canonical_playbook_args(&ps, &bad, PlaybookInterpreter::Powershell)
                    .is_err(),
                "{bad:?}"
            );
        }
        // NFD input is not canonical.
        let nfd = PlaybookParam {
            pattern: Some(".*".into()),
            ..fixture_params()[0].clone()
        };
        assert!(validate_canonical_playbook_args(
            &[nfd],
            &args(&[("host", json!("e\u{301}"))]),
            PlaybookInterpreter::Powershell
        )
        .is_err());
    }

    #[test]
    fn effective_timeout_never_exceeds_the_pin() {
        let e = entry("x", "h", false);
        assert_eq!(e.effective_timeout_sec(0), 120);
        assert_eq!(e.effective_timeout_sec(30), 30);
        assert_eq!(e.effective_timeout_sec(5000), 120);
    }

    #[test]
    fn launch_plan_matches_contract() {
        let ps = launch_plan(PlaybookInterpreter::Powershell, false, ElevationLevel::User);
        assert!(ps.via_stdin && !ps.via_run_file);
        assert_eq!(ps.ran_as, "user");

        let cmd = launch_plan(PlaybookInterpreter::Cmd, false, ElevationLevel::User);
        assert!(cmd.via_run_file && !cmd.via_stdin);

        // requiresElevation in the admin instance => ranAs admin.
        let admin = launch_plan(PlaybookInterpreter::Powershell, true, ElevationLevel::Admin);
        assert_eq!(admin.ran_as, "admin");
        // non-requiresElevation in the admin instance still runs as user (limited token).
        let as_user = launch_plan(PlaybookInterpreter::Cmd, false, ElevationLevel::Admin);
        assert_eq!(as_user.ran_as, "user");
    }
}
