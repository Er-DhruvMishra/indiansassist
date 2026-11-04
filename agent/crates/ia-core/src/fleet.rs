//! Phase D fleet wire types and the `/signal/device` protocol, as the installed service sees
//! them (`docs/specs/phase-d-contracts.md` §3.1-§3.4, §4.2, §9, §10, §12.3, §13.1a).
//!
//! The authority is `packages/shared/src/schemas/signal-device.ts` plus
//! `packages/shared/src/fleet/*.ts`; these are their serde mirrors. Only the shapes the
//! device produces or consumes live here — REST objects the console reads (`Device`,
//! `WakeAttempt`) are not mirrored.
//!
//! Two rules the types encode rather than leave to the caller:
//!
//! * **Server to device is parsed leniently, device to server is produced strictly.** An
//!   unknown field in a server message is ignored (a newer node may add one); every message
//!   the device sends is built from these structs, so it cannot carry a stray key.
//! * **No secret is `Debug`-printable.** The worker credential and the sealed payloads are
//!   wrapped, so a `tracing` call cannot leak one through a struct dump (§6 redaction).

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::policy::{
    ApprovedBy, ConsentDecision, DeviceActionKind, InteractiveStateName, UnattendedPolicy,
};
use crate::seal::Sealed;

/// A value that must never reach a log. `Debug` prints a placeholder; the secret is read with
/// [`Secret::expose`].
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

impl Drop for Secret {
    /// Wipe the bytes rather than just freeing them: a worker credential or an injected secret
    /// that outlives its use in a freed allocation is exactly what rule 9.8 asks us not to do.
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.0.zeroize();
    }
}

/// §3.4 `InteractiveState`. `at` is epoch ms; `idleSec` is null when it cannot be read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveState {
    pub state: InteractiveStateName,
    pub idle_sec: Option<u32>,
    pub at: i64,
    /// F §8.3e: `x11` | `wayland` for a Linux device's target session (`None` otherwise, and
    /// always on Windows, where the field is not sent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
}

/// Rule 8.2a: org-salted hashes computed on the device; raw addresses never travel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanSegment {
    pub subnet_hash: String,
    pub gateway_mac_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dhcp_domain: Option<String>,
}

/// Rule 8.4a: what the device can see of its own AMT.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmtInventory {
    pub present: bool,
    pub provisioned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    pub tls: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub power_state: Option<i32>,
}

/// §13.1a `ServiceCapabilities`: a superset of the C `AgentCapabilities`. `features` is what
/// the console greys its controls by, so it must report what this machine can actually do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCapabilities {
    pub monitors: u8,
    /// Always `"admin"`: the service runs as `LocalSystem`.
    pub elevation: String,
    pub features: Vec<String>,
    pub encoders: Vec<String>,
    pub hw_encoder: bool,
    pub interpreters: Vec<String>,
    pub service_version: String,
}

/// The machine facts of an enrollment request (§3.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceMachine {
    pub name: String,
    pub platform: String,
    pub os_version: String,
    pub arch: String,
    pub service_version: String,
    pub hw_fingerprint: String,
    pub wake_mac: Option<String>,
    pub amt: Option<AmtInventory>,
    pub capabilities: ServiceCapabilities,
    pub interactive: InteractiveState,
}

/// `POST /api/v1/devices/enroll` body (§3.2). `enrollConfig` is the signed `enroll.iaconfig`
/// **verbatim** — the server verifies the same bytes the service did.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEnrollRequest {
    pub enroll_config: String,
    pub device_public_key: String,
    pub device_kex_public_key: String,
    pub device_key_proof: String,
    pub machine: DeviceMachine,
}

/// The `201` reply of enrollment (§3.2): the identity the service stores.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEnrollReply {
    pub device_id: String,
    pub org_id: String,
    pub region: String,
    pub api_origin: String,
    pub signal_url: String,
    pub key_id: String,
    pub group: Option<EnrollGroup>,
    pub policy: UnattendedPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnrollGroup {
    pub id: String,
    pub name: String,
}

/// `enroll.iaconfig` (§12.3): the single carrier of a new device's org, region and group,
/// signed by the region's token-signing key over the canonical JSON without `sig`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnrollConfig {
    pub v: u8,
    #[serde(rename = "apiOrigin")]
    pub api_origin: String,
    #[serde(rename = "signalUrl")]
    pub signal_url: String,
    pub region: String,
    pub token: String,
    #[serde(rename = "groupId")]
    pub group_id: Option<String>,
    pub kid: String,
    pub sig: String,
}

/// The bytes an `enroll.iaconfig` signature covers (§12.3): the canonical JSON of the object
/// **without** `sig`. The same input the server re-verifies at enrollment, so a config the
/// service accepted is one the server will accept too.
pub fn enroll_config_signing_input(cfg: &EnrollConfig) -> Vec<u8> {
    let mut v = serde_json::to_value(cfg).unwrap_or(Value::Null);
    if let Some(o) = v.as_object_mut() {
        o.remove("sig");
    }
    crate::canonical::canonical_json(&v).into_bytes()
}

/// Parses and verifies an `enroll.iaconfig` against the region keys compiled into this build
/// (C §2.4 reused). `None` for anything malformed, oversize, or not signed by a known key —
/// and **no** partial acceptance: a device never enrols from a config it could not verify.
pub fn verify_enroll_config(text: &str, keys: &[[u8; 32]]) -> Option<EnrollConfig> {
    if text.len() > ENROLL_CONFIG_MAX_BYTES {
        return None;
    }
    let cfg: EnrollConfig = serde_json::from_str(text).ok()?;
    if cfg.v != 1 || cfg.token.is_empty() {
        return None;
    }
    let input = enroll_config_signing_input(&cfg);
    for key in keys {
        // The `kid` names which key signed it; a config whose kid matches no compiled key is
        // refused without trying every key, so a mismatch is a clear "wrong region" rather
        // than a vague signature failure.
        if crate::devsig::kid_of(key).ok()? != cfg.kid {
            continue;
        }
        let pk = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, key);
        if crate::devsig::verify_device_signature(&input, &cfg.sig, &pk) {
            return Some(cfg);
        }
    }
    None
}

/// `LIMITS.enrollConfigMaxBytes`.
pub const ENROLL_CONFIG_MAX_BYTES: usize = 16_384;

/// Rule 10.5 `TamperEvent`: a device-recorded event, signed with the identity key
/// (`ia-tamper-v1` over the canonical JSON of the event without `sig`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TamperEvent {
    pub id: String,
    pub cause: TamperCause,
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub sig: String,
}

/// `TAMPER_CAUSES` (rule 10.5): device-recorded causes only. The server derives `suspected`
/// itself; a device never claims it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TamperCause {
    Stopped,
    Disabled,
    Deleted,
    BinaryChanged,
    ConfigChanged,
    WatchdogRestarted,
}

impl TamperCause {
    pub fn as_str(self) -> &'static str {
        match self {
            TamperCause::Stopped => "stopped",
            TamperCause::Disabled => "disabled",
            TamperCause::Deleted => "deleted",
            TamperCause::BinaryChanged => "binary_changed",
            TamperCause::ConfigChanged => "config_changed",
            TamperCause::WatchdogRestarted => "watchdog_restarted",
        }
    }
}

/// `DEVICE_ACTION_STATES` as a device reports them (rule 9.7); the other states are the
/// server's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportedActionState {
    AwaitingApproval,
    Running,
    Done,
    Failed,
}

impl ReportedActionState {
    pub fn as_str(self) -> &'static str {
        match self {
            ReportedActionState::AwaitingApproval => "awaiting_approval",
            ReportedActionState::Running => "running",
            ReportedActionState::Done => "done",
            ReportedActionState::Failed => "failed",
        }
    }
}

/// The `result` object a device reports (rule 9.7). Playbook **output** is never in it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceActionResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ran_as: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

/// A queued action as the device receives it (`device.hello.ok.queued` and `device.action`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedAction {
    pub id: String,
    pub device_id: String,
    pub kind: DeviceActionKind,
    pub payload: Value,
    pub state: String,
    pub reason: Option<String>,
    pub approved_by: Option<ApprovedBy>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub expires_at: String,
}

/// A secret delivered with a `device.action` (rule 9.8): sealed to this device, opened only
/// into the child process's environment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionSecret {
    pub env: String,
    pub sealed: Sealed,
}

/// A playbook manifest entry as the service receives it in `device.hello.ok` (C §8.3); kept as
/// a `Value` because the worker hands it to the C agent unchanged.
pub type PlaybookManifest = Value;

// ---------------------------------------------------------------- S -> D

/// Every message the server may send on `/signal/device` (§3.4, §4.2, §6.4b, §8.2b, §8.4b,
/// §9.1, §10.2). Unknown variants are a protocol error the service logs and ignores; unknown
/// **fields** are tolerated.
//
// The variants differ in size because three of them carry a full `UnattendedPolicy`. Boxing
// them would buy nothing: a frame is parsed, acted on and dropped one at a time, never held in
// a collection, so the enum's footprint is one short-lived stack value.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum DeviceServerMessage {
    #[serde(rename = "device.challenge", rename_all = "camelCase")]
    Challenge {
        server_challenge: String,
        ts: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    #[serde(rename = "device.hello.ok", rename_all = "camelCase")]
    HelloOk {
        device_id: String,
        org_display_name: String,
        region: String,
        policy: UnattendedPolicy,
        group_id: Option<String>,
        #[serde(default)]
        queued: Vec<QueuedAction>,
        #[serde(default)]
        playbooks: Vec<PlaybookManifest>,
        rotation_nonce: Option<String>,
    },
    #[serde(rename = "device.session_open", rename_all = "camelCase")]
    SessionOpen {
        session_id: String,
        assist: Assist,
        reason: Option<String>,
        unattended: bool,
        decision: ConsentDecision,
        policy: UnattendedPolicy,
        recording_mode: String,
        worker_credential: Secret,
        worker_credential_expires_at: String,
    },
    #[serde(rename = "device.worker_credential", rename_all = "camelCase")]
    WorkerCredential {
        session_id: String,
        gen: u16,
        worker_credential: Secret,
        expires_at: String,
    },
    #[serde(rename = "device.action", rename_all = "camelCase")]
    Action {
        action_id: String,
        kind: DeviceActionKind,
        payload: Value,
        reason: Option<String>,
        technician: Assist,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        secrets: Option<Vec<ActionSecret>>,
    },
    #[serde(rename = "device.policy")]
    Policy { policy: UnattendedPolicy },
    #[serde(rename = "device.receipt")]
    Receipt { receipt: Value },
    #[serde(rename = "device.tamper.ok")]
    TamperOk { ids: Vec<String> },
    #[serde(rename = "device.rotate.ok", rename_all = "camelCase")]
    RotateOk { key_id: String },
    #[serde(rename = "wake.send", rename_all = "camelCase")]
    WakeSend {
        wake_id: String,
        target_mac_sealed: Sealed,
    },
    #[serde(rename = "amt.command", rename_all = "camelCase")]
    AmtCommand {
        cmd_id: String,
        target_device_id: String,
        amt_host: String,
        tls: bool,
        op: AmtOp,
        #[serde(default)]
        args: AmtArgs,
        cred_sealed: Sealed,
    },
    #[serde(rename = "error", rename_all = "camelCase")]
    Error {
        code: String,
        #[serde(default)]
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        re: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_after_sec: Option<u32>,
    },
    #[serde(rename = "ping")]
    Ping {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    #[serde(rename = "pong")]
    Pong {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        re: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Assist {
    pub name: String,
}

/// `AMT_OPS` (rule 8.4b).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AmtOp {
    PowerOn,
    BootRedirect,
    SolOpen,
    SolClose,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AmtArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<AmtBootTarget>,
}

/// `AMT_BOOT_TARGETS` (rule 8.4b).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AmtBootTarget {
    Pxe,
    Hdd,
    Cd,
}

impl AmtBootTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            AmtBootTarget::Pxe => "pxe",
            AmtBootTarget::Hdd => "hdd",
            AmtBootTarget::Cd => "cd",
        }
    }
}

// ---------------------------------------------------------------- D -> S

/// The client facts of `device.hello` (§3.4).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceHelloClient {
    pub service_version: String,
    pub agent_version: String,
    pub os_version: String,
    pub arch: String,
    pub capabilities: ServiceCapabilities,
    pub lan_segment: LanSegment,
    pub wake_mac: Option<String>,
    pub amt: Option<AmtInventory>,
    pub interactive: InteractiveState,
    /// F §8.3e: `linux` on a Linux service; absent means `windows`, so a Phase D service is
    /// unaffected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
}

/// Every message a device may send on `/signal/device`. Nothing else is ever sent, and none of
/// these is valid on the ordinary `/signal` socket (the server refuses them there).
//
// `Hello` carries the whole capability report, so it dwarfs a heartbeat. As above, a frame is
// built, sent and dropped; boxing it would trade a clear shape for nothing.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum DeviceClientMessage {
    #[serde(rename = "device.hello", rename_all = "camelCase")]
    Hello {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        device_id: String,
        key_id: String,
        nonce: String,
        sig: String,
        client: DeviceHelloClient,
    },
    #[serde(rename = "device.heartbeat", rename_all = "camelCase")]
    Heartbeat {
        #[serde(skip_serializing_if = "Option::is_none")]
        lan_segment: Option<LanSegment>,
        #[serde(skip_serializing_if = "Option::is_none")]
        wake_mac: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        amt: Option<AmtInventory>,
        #[serde(skip_serializing_if = "Option::is_none")]
        interactive: Option<InteractiveState>,
        #[serde(skip_serializing_if = "Option::is_none")]
        metrics: Option<HostMetrics>,
    },
    #[serde(rename = "device.interactive")]
    Interactive { interactive: InteractiveState },
    #[serde(rename = "device.worker_credential.request", rename_all = "camelCase")]
    WorkerCredentialRequest {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        session_id: String,
        gen: u16,
    },
    #[serde(rename = "device.action_result", rename_all = "camelCase")]
    ActionResult {
        action_id: String,
        state: ReportedActionState,
        #[serde(skip_serializing_if = "Option::is_none")]
        approved_by: Option<ApprovedBy>,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<DeviceActionResult>,
        sig: String,
    },
    #[serde(rename = "device.tamper")]
    Tamper { events: Vec<TamperEvent> },
    #[serde(rename = "device.rotate", rename_all = "camelCase")]
    Rotate {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        new_public_key: String,
        new_kex_public_key: String,
        old_key_sig: String,
        new_key_proof: String,
    },
    #[serde(rename = "wake.sent", rename_all = "camelCase")]
    WakeSent {
        wake_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "amt.result", rename_all = "camelCase")]
    AmtResult {
        cmd_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        power_state: Option<i32>,
    },
    #[serde(rename = "amt.sol.data", rename_all = "camelCase")]
    AmtSolData {
        cmd_id: String,
        seq: u64,
        data: String,
    },
    #[serde(rename = "ping")]
    Ping {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    #[serde(rename = "pong")]
    Pong {
        #[serde(skip_serializing_if = "Option::is_none")]
        re: Option<String>,
    },
}

/// The optional host metrics of a heartbeat (§13.5).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMetrics {
    pub cpu: f32,
    pub mem: f32,
    pub uptime_sec: u64,
}

/// Parses a frame the server sent. Unknown message types and malformed frames are an error the
/// caller logs and ignores, never a panic and never a disconnect (B §3.7 tolerance).
pub fn parse_server_frame(text: &str) -> Result<DeviceServerMessage, String> {
    serde_json::from_str(text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_config(seed: &[u8; 32], token: &str) -> (String, [u8; 32]) {
        use base64::Engine as _;
        let pk_b64 = crate::devsig::device_public_key_of(seed);
        let pk: [u8; 32] = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&pk_b64)
            .unwrap()
            .try_into()
            .unwrap();
        let cfg = EnrollConfig {
            v: 1,
            api_origin: "https://in.example".into(),
            signal_url: "wss://in.example/signal/device".into(),
            region: "in-mum".into(),
            token: token.into(),
            group_id: None,
            kid: crate::devsig::kid_of(&pk).unwrap(),
            sig: String::new(),
        };
        let sig = crate::devsig::sign_device_input(&enroll_config_signing_input(&cfg), seed);
        let signed = EnrollConfig { sig, ..cfg };
        (serde_json::to_string(&signed).unwrap(), pk)
    }

    #[test]
    fn an_enroll_config_verifies_against_the_region_key_that_signed_it() {
        let seed = [0x51u8; 32];
        let (text, pk) = signed_config(&seed, "ia1.token");
        let cfg = verify_enroll_config(&text, &[pk]).expect("verifies");
        assert_eq!(cfg.region, "in-mum");
        assert_eq!(cfg.token, "ia1.token");
        // A different region key does not verify it, and neither does an empty key set.
        let other = [0x52u8; 32];
        let other_pk: [u8; 32] = {
            use base64::Engine as _;
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(crate::devsig::device_public_key_of(&other))
                .unwrap()
                .try_into()
                .unwrap()
        };
        assert!(verify_enroll_config(&text, &[other_pk]).is_none());
        assert!(verify_enroll_config(&text, &[]).is_none());
    }

    #[test]
    fn a_tampered_or_oversize_or_malformed_enroll_config_is_refused() {
        let seed = [0x51u8; 32];
        let (text, pk) = signed_config(&seed, "ia1.token");
        // Swapping the token keeps the signature but changes the signed bytes.
        let swapped = text.replace("ia1.token", "ia1.other");
        assert!(verify_enroll_config(&swapped, &[pk]).is_none());
        // Pointing it at another origin likewise.
        let moved = text.replace("in.example", "attacker.example");
        assert!(verify_enroll_config(&moved, &[pk]).is_none());
        assert!(verify_enroll_config("not json", &[pk]).is_none());
        assert!(verify_enroll_config(&"x".repeat(ENROLL_CONFIG_MAX_BYTES + 1), &[pk]).is_none());
        // An unknown field is not tolerated here: this file decides which org a machine joins.
        let extra = text.replace("{\"v\":1", "{\"surprise\":1,\"v\":1");
        assert!(verify_enroll_config(&extra, &[pk]).is_none());
    }

    #[test]
    fn a_server_frame_with_an_unknown_field_still_parses() {
        let m = parse_server_frame(
            r#"{"t":"device.policy","somethingNew":1,"policy":{"mode":"allow","requireLocalApprovalWhenPresent":true,
            "autoAllowAfterSec":null,"allowedHours":null,"recordingRequired":true,"allowLogonScreen":false,
            "allowSecureDesktop":false,"allowPrivileged":true,"allowInputLock":false,"allowPrivacyScreen":false,
            "allowAmtSol":false,"allowAmtBootRedirect":false,"notifyLocalUser":true,"maxUnattendedMinutes":120}}"#,
        )
        .unwrap();
        assert!(matches!(m, DeviceServerMessage::Policy { .. }));
    }

    #[test]
    fn an_unknown_server_type_is_an_error_not_a_panic() {
        assert!(parse_server_frame(r#"{"t":"device.somethingelse"}"#).is_err());
        assert!(parse_server_frame("not json").is_err());
    }

    #[test]
    fn the_worker_credential_never_prints() {
        let s = Secret::new("abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE");
        assert_eq!(format!("{s:?}"), "<redacted>");
        assert!(!format!("{s:?}").contains("abcdef"));
        assert_eq!(
            serde_json::to_string(&s).unwrap(),
            "\"abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE\""
        );
    }

    #[test]
    fn a_device_message_serialises_with_its_wire_name_and_camel_case_fields() {
        let m = DeviceClientMessage::Interactive {
            interactive: InteractiveState {
                state: InteractiveStateName::Active,
                idle_sec: Some(3),
                at: 1_762_000_000_000,
                display: None,
            },
        };
        let text = serde_json::to_string(&m).unwrap();
        assert_eq!(
            text,
            r#"{"t":"device.interactive","interactive":{"state":"active","idleSec":3,"at":1762000000000}}"#
        );
        // F §8.3e: a Linux device names its display type.
        let linux = DeviceClientMessage::Interactive {
            interactive: InteractiveState {
                state: InteractiveStateName::Locked,
                idle_sec: None,
                at: 1,
                display: Some("x11".into()),
            },
        };
        assert!(serde_json::to_string(&linux)
            .unwrap()
            .contains(r#""display":"x11""#));
    }

    #[test]
    fn an_absent_optional_is_omitted_rather_than_sent_as_null() {
        let m = DeviceClientMessage::WakeSent {
            wake_id: "a".into(),
            ok: true,
            error: None,
        };
        assert_eq!(
            serde_json::to_string(&m).unwrap(),
            r#"{"t":"wake.sent","wakeId":"a","ok":true}"#
        );
    }
}
