//! The Phase D worker seams (`docs/specs/phase-d-contracts.md` §4.3).
//!
//! `ia-desktop` **is** this binary's serve loop with three things replaced: where the token
//! comes from, where consent comes from, and which desktop is captured. Rather than thread an
//! `Option<&WorkerContext>` through a serve loop that was written for Phase C, the context is
//! set once at start-up and read where those three decisions are made. That is honest about
//! what it is: a process is either a portable agent or a desktop worker for its whole life,
//! like the DPI awareness and the compiled region keys.
//!
//! What the worker deliberately does **not** have:
//!
//! * **the device key** — rule 3.5b's attestation is a request to the service ([`ServiceOps::sign_sas`]);
//! * **a token** — it joins with a single-use worker credential the server minted (§4.2);
//! * **the ability to press Ctrl+Alt+Del** — no process can inject the SAS, so that too is a
//!   request to the service ([`ServiceOps::send_sas`]).

use std::sync::OnceLock;

use ia_core::policy::{ConsentDecision, UnattendedPolicy};

/// What the worker asks the service for over the §4.2 pipe. The implementation lives in
/// `ia-desktop`; this trait is what the serve loop sees.
pub trait ServiceOps: Send + Sync {
    /// Rule 3.5b: ask the service to sign `ia-sas-v1` over this generation's security code and
    /// both `sec.hello` fingerprints. `None` when the service refused or the pipe is gone — the
    /// console then keeps the session in `view` and says the identity could not be verified,
    /// which is the honest outcome.
    fn sign_sas(&self, gen: u16, sas: &str, desk_fpr: &str, assist_fpr: &str) -> Option<String>;
    /// §5.4 `os.sas`: ask the service to press Ctrl+Alt+Del. `false` when the machine has no
    /// `SendSAS` (the op then answers `not_supported`).
    fn send_sas(&self) -> bool;
    /// §5.4d: tell the service which protections are on, so it can tell the server if this
    /// process dies with one of them still set.
    fn report_protections(&self, input_lock: bool, privacy_screen: bool);
    /// Ask the service to re-evaluate §5.3 (a UAC prompt came up, the session locked).
    fn request_desktop_switch(&self, reason: &str);
}

/// The settled consent an `auto_grant` worker applies without asking anybody (§6.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettledConsent {
    pub level: String,
    pub monitors: Vec<u32>,
    pub clipboard: bool,
}

/// Everything the §4.2 blob told this worker, plus the pipe it answers on.
pub struct WorkerContext {
    pub session_id: String,
    pub device_id: String,
    pub api_origin: String,
    /// The region's ordinary `/signal` URL: the worker is a Desk, not a device.
    pub signal_url: String,
    pub assist_name: String,
    /// The reason the technician typed (rule 9.1 / §3.5: required for an unattended session).
    pub reason: Option<String>,
    pub unattended: bool,
    pub decision: ConsentDecision,
    pub policy: UnattendedPolicy,
    pub consent: Option<SettledConsent>,
    pub recording_mode: String,
    /// The `ia.sec` generation this worker starts at (the console accepts `lastGen + 1`).
    pub gen: u16,
    /// Whether this worker starts on a secure desktop (rule 5.1c applies from the first frame).
    pub secure_desktop: bool,
    /// The single-use credential this worker joins with, in place of a token (§4.2).
    pub credential: ia_core::fleet::Secret,
    pub ops: Box<dyn ServiceOps>,
}

impl WorkerContext {
    /// The reason the technician typed, as a sentence for the rule 6.2a card (unattended
    /// sessions always have one: the server requires it).
    pub fn reason_line(&self) -> String {
        match &self.reason {
            Some(r) if !r.is_empty() => format!(" Reason: {r}."),
            _ => String::new(),
        }
    }

    /// Rule 3.5b: whether the security code must be attested with the device key rather than
    /// read out by a person. True exactly when nobody answered the consent.
    pub fn needs_attestation(&self) -> bool {
        matches!(self.decision, ConsentDecision::AutoGrant)
    }

    /// §5.4: what this build can do, and what the effective policy allows.
    pub fn service_grade(&self) -> ia_core::ctl::ServiceGrade {
        ia_core::ctl::ServiceGrade {
            allow_input_lock: self.policy.allow_input_lock,
            allow_privacy_screen: self.policy.allow_privacy_screen,
            // `BlockInput` is reached through the `InputSink` seam, so a build with the Win32
            // layer has it.
            input_lock_built: cfg!(all(windows, feature = "winapi")),
            // The branded overlay of rule 5.4b is **not built** (agent/README.md): advertising
            // it would put a live button in front of a technician that does nothing.
            privacy_screen_built: false,
            // The service answers `os.sas`; whether `SendSAS` exists on the machine is its
            // answer to give, so the op is offered and the refusal comes from there.
            sas_built: true,
        }
    }
}

impl std::fmt::Debug for WorkerContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerContext")
            .field("sessionId", &self.session_id)
            .field("deviceId", &self.device_id)
            .field("decision", &self.decision)
            .field("unattended", &self.unattended)
            .field("gen", &self.gen)
            .field("secureDesktop", &self.secure_desktop)
            .field("credential", &self.credential)
            .finish_non_exhaustive()
    }
}

static CONTEXT: OnceLock<WorkerContext> = OnceLock::new();

/// Rule 5.1c / §5.3: whether the worker is currently on a secure desktop. The service's pipe
/// notifications set it; the serve loop reads it on its own tick, which is why it is an atomic
/// rather than a message into a loop that is busy encoding frames.
static SECURE_DESKTOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// §3.4: whether somebody is present at the device right now (rule 5.4c, rule 6.2a).
static PRESENT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Which secure surface the worker is on, for the rule 5.1c audit entry. A `Mutex<String>`
/// rather than an atomic because it changes at most a few times a session and is read once per
/// change.
static SURFACE: std::sync::Mutex<Option<&'static str>> = std::sync::Mutex::new(None);

/// The service saw a desktop change (§5.3). `surface` is `logon` | `uac` | `lock` when the new
/// desktop is a secure one.
pub fn set_secure_desktop(on: bool, surface: Option<&'static str>) {
    SECURE_DESKTOP.store(on, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut s) = SURFACE.lock() {
        *s = if on { surface } else { None };
    }
}

/// The surface the worker is on (`logon` | `uac` | `lock`), or `None` on a user desktop.
pub fn secure_surface() -> Option<&'static str> {
    SURFACE.lock().ok().and_then(|s| *s)
}

/// Whether the worker is on a secure desktop (the rule 5.1c gate applies to its frames).
pub fn secure_desktop() -> bool {
    SECURE_DESKTOP.load(std::sync::atomic::Ordering::Relaxed)
}

/// The service reported the §3.4 interactive state.
pub fn set_present(present: bool) {
    PRESENT.store(present, std::sync::atomic::Ordering::Relaxed);
}

/// Whether somebody is at the device (rule 5.4c: a protection asks them first; rule 6.2a: an
/// arrival is reported to the console).
pub fn present() -> bool {
    PRESENT.load(std::sync::atomic::Ordering::Relaxed)
}

/// Install the worker context. Called once, by `ia-desktop`, before the session starts.
pub fn set(context: WorkerContext) -> Result<(), &'static str> {
    CONTEXT
        .set(context)
        .map_err(|_| "the worker context is already set")
}

/// The worker context, or `None` in a portable Phase C agent.
pub fn get() -> Option<&'static WorkerContext> {
    CONTEXT.get()
}

/// Whether this process is a Phase D desktop worker.
pub fn is_worker() -> bool {
    CONTEXT.get().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoOps;

    impl ServiceOps for NoOps {
        fn sign_sas(&self, _gen: u16, _sas: &str, _desk: &str, _assist: &str) -> Option<String> {
            None
        }
        fn send_sas(&self) -> bool {
            false
        }
        fn report_protections(&self, _input_lock: bool, _privacy_screen: bool) {}
        fn request_desktop_switch(&self, _reason: &str) {}
    }

    fn context(decision: ConsentDecision, policy: UnattendedPolicy) -> WorkerContext {
        WorkerContext {
            session_id: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b".into(),
            device_id: "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a".into(),
            api_origin: "https://in.example".into(),
            signal_url: "wss://in.example/signal".into(),
            assist_name: "Asha".into(),
            reason: Some("disk check".into()),
            unattended: true,
            decision,
            policy,
            consent: Some(SettledConsent {
                level: "control".into(),
                monitors: vec![1],
                clipboard: false,
            }),
            recording_mode: "server".into(),
            gen: 0,
            secure_desktop: false,
            credential: ia_core::fleet::Secret::new("A".repeat(43)),
            ops: Box::new(NoOps),
        }
    }

    #[test]
    fn a_session_nobody_answered_is_attested_with_the_device_key() {
        assert!(context(ConsentDecision::AutoGrant, Default::default()).needs_attestation());
    }

    #[test]
    fn a_session_a_person_answered_keeps_the_read_out_gate() {
        for d in [
            ConsentDecision::LocalApproval,
            ConsentDecision::LocalConsent,
        ] {
            assert!(!context(d, Default::default()).needs_attestation(), "{d:?}");
        }
    }

    #[test]
    fn the_policy_flags_reach_the_control_dispatch() {
        let policy = UnattendedPolicy {
            allow_input_lock: true,
            allow_privacy_screen: true,
            ..Default::default()
        };
        let grade = context(ConsentDecision::AutoGrant, policy).service_grade();
        assert!(grade.allow_input_lock);
        assert!(grade.allow_privacy_screen);
        assert!(
            !grade.privacy_screen_built,
            "the overlay of rule 5.4b is not built"
        );
        assert!(
            grade.sas_built,
            "os.sas is offered; the service answers whether SendSAS exists"
        );
    }

    #[test]
    fn the_live_flags_the_service_sets_are_readable_by_the_serve_loop() {
        set_secure_desktop(true, Some("uac"));
        assert!(secure_desktop());
        assert_eq!(secure_surface(), Some("uac"));
        set_secure_desktop(false, None);
        assert!(!secure_desktop());
        assert_eq!(secure_surface(), None, "a user desktop is not a surface");
        set_present(true);
        assert!(present());
        set_present(false);
        assert!(!present());
    }

    #[test]
    fn a_debug_dump_of_the_context_never_shows_the_credential() {
        let dump = format!(
            "{:?}",
            context(ConsentDecision::AutoGrant, Default::default())
        );
        assert!(dump.contains("<redacted>"));
        assert!(!dump.contains(&"A".repeat(43)));
    }
}
