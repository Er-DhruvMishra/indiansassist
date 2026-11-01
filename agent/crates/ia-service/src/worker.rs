//! The service's half of the §4.2 handoff: what the worker is told at launch, and what the
//! service does with what the worker asks for.
//!
//! The two rules that matter most are both about keeping authority on the right side of the
//! pipe:
//!
//! * **The worker gets a session, not an identity.** The blob carries a single-use worker
//!   credential (minted by the server, valid for 120 s) and no key. A worker that is somehow
//!   subverted can join the session it was launched for and nothing else.
//! * **Only the service signs.** Rule 3.5b needs a device-key signature over the session's
//!   SAS. The worker asks; the service signs **only for the session it launched that worker
//!   for**, and only for a plausible SAS and fingerprints. That check is why
//!   [`answer_worker`] is a pure function with tests rather than a line inside the pipe loop.

use ia_core::fleet::Secret;
use ia_core::policy::{ConsentDecision, UnattendedPolicy};
use ia_platform::DesktopTarget;
use ia_session0::blob::{BlobConsent, LaunchBlob};
use ia_session0::proto::{ServiceFrame, WorkerFrame};

use crate::devicesock::SessionOpen;
use crate::identity::Identity;

/// The level an `auto_grant` session starts at. `control` is what a person would have chosen in
/// the C consent window for a support session, and it is what the policy authorised; privileged
/// mode is a separate, audited step (§5.2) and the secure desktop needs it (rule 5.1c).
pub const AUTO_GRANT_LEVEL: &str = "control";

/// Build the §4.2 launch blob. `monitors` is what the service enumerated; `gen` is 0 for the
/// first worker of a session and `previous + 1` for a rebuild (a desktop switch, §5.3), which
/// is the generation the console will accept.
#[allow(clippy::too_many_arguments)]
pub fn blob_for(
    open: &SessionOpen,
    device_id: &str,
    api_origin: &str,
    worker_signal_url: &str,
    monitors: &[u32],
    gen: u16,
    target: DesktopTarget,
    credential: &Secret,
    credential_expires_at: &str,
) -> LaunchBlob {
    let consent = matches!(open.decision, ConsentDecision::AutoGrant).then(|| BlobConsent {
        level: AUTO_GRANT_LEVEL.to_string(),
        monitors: if monitors.is_empty() {
            vec![1]
        } else {
            monitors.to_vec()
        },
        clipboard: false,
    });
    LaunchBlob {
        v: 1,
        session_id: open.session_id.clone(),
        api_origin: api_origin.to_string(),
        signal_url: worker_signal_url.to_string(),
        assist: ia_core::fleet::Assist {
            name: open.assist_name.clone(),
        },
        reason: open.reason.clone(),
        unattended: open.unattended,
        decision: open.decision,
        policy: open.policy.clone(),
        consent,
        recording_mode: open.recording_mode.clone(),
        gen,
        device_id: device_id.to_string(),
        secure_desktop: target.is_secure_surface(),
        worker_credential: credential.clone(),
        worker_credential_expires_at: credential_expires_at.to_string(),
    }
}

/// What the service does about one worker frame.
#[derive(Debug, Clone, PartialEq)]
pub enum WorkerAction {
    /// Answer down the pipe.
    Reply(ServiceFrame),
    /// The worker is up with this pid; verify it is the process we launched.
    Ready { pid: u32 },
    /// §5.4d: remember what to tell the server if the worker dies with a protection on.
    Protections {
        input_lock: bool,
        privacy_screen: bool,
    },
    /// Re-evaluate §5.3 (the worker saw something change).
    ReconsiderDesktop { reason: String },
    /// The session ended on the worker's side.
    Ended { reason: String },
    /// Press Ctrl+Alt+Del through `SendSAS` (§5.4 `os.sas`), then answer `id`.
    SendSas { id: String },
    /// The worker is alive (the supervision heartbeat).
    Alive,
}

/// A 6-digit SAS and two 64-hex fingerprints: the shape rule 3.5b signs. Checked before
/// signing so the service cannot be talked into signing arbitrary bytes with the device key.
fn plausible_attestation(sas: &str, desk_fpr: &str, assist_fpr: &str) -> bool {
    let six_digits = sas.len() == 6 && sas.bytes().all(|b| b.is_ascii_digit());
    let fpr = |f: &str| f.len() == 64 && f.bytes().all(|b| b.is_ascii_hexdigit());
    six_digits && fpr(desk_fpr) && fpr(assist_fpr)
}

/// The pure answer to a worker frame. `session_id` is the session this worker was launched
/// for; a `sign_sas` for any other session is refused.
pub fn answer_worker(frame: &WorkerFrame, session_id: &str, identity: &Identity) -> WorkerAction {
    match frame {
        WorkerFrame::Ready { pid } => WorkerAction::Ready { pid: *pid },
        WorkerFrame::Alive => WorkerAction::Alive,
        WorkerFrame::Protections {
            input_lock,
            privacy_screen,
        } => WorkerAction::Protections {
            input_lock: *input_lock,
            privacy_screen: *privacy_screen,
        },
        WorkerFrame::DesktopSwitch { reason, .. } => WorkerAction::ReconsiderDesktop {
            reason: reason.clone(),
        },
        WorkerFrame::Ended { reason } => WorkerAction::Ended {
            reason: reason.clone(),
        },
        WorkerFrame::SendSas { id } => WorkerAction::SendSas { id: id.clone() },
        WorkerFrame::SignSas {
            id,
            gen,
            sas,
            desk_fpr,
            assist_fpr,
        } => {
            if !plausible_attestation(sas, desk_fpr, assist_fpr) {
                return WorkerAction::Reply(ServiceFrame::Error {
                    re: id.clone(),
                    code: "bad_request".into(),
                });
            }
            match ia_core::devsig::input::sas(
                session_id,
                u32::from(*gen),
                sas,
                desk_fpr,
                assist_fpr,
            ) {
                Ok(input) => WorkerAction::Reply(ServiceFrame::SasSig {
                    re: id.clone(),
                    sig: identity.sign(&input),
                }),
                Err(_) => WorkerAction::Reply(ServiceFrame::Error {
                    re: id.clone(),
                    code: "bad_request".into(),
                }),
            }
        }
    }
}

/// §5.4d: what the server must be told when a worker dies while a protection was on. The
/// service reports it so the row the console reads is not left claiming the screen is still
/// hidden.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ProtectionState {
    pub input_lock: bool,
    pub privacy_screen: bool,
}

impl ProtectionState {
    pub fn anything_on(&self) -> bool {
        self.input_lock || self.privacy_screen
    }
}

/// Whether the launch is permitted at all, before a pipe is created (rule 5.1c first gate and
/// §10.3). Refusing here keeps a worker from ever reaching a desktop it may not show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchVerdict {
    Go,
    /// §10.3: a modified binary. The worker is not spawned until it is repaired.
    IntegrityFailed(String),
    /// Rule 5.1c: pre-login without `allowLogonScreen`. The server refuses this at `POST`, so
    /// reaching it means the two sides disagree; the device's answer is no.
    PreloginNotPermitted,
}

pub fn launch_verdict(
    target: DesktopTarget,
    policy: &UnattendedPolicy,
    binaries_ok: bool,
    integrity_summary: &str,
) -> LaunchVerdict {
    if !binaries_ok {
        return LaunchVerdict::IntegrityFailed(integrity_summary.to_string());
    }
    if matches!(target, DesktopTarget::LogonScreen) && !policy.allow_logon_screen {
        return LaunchVerdict::PreloginNotPermitted;
    }
    LaunchVerdict::Go
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(decision: ConsentDecision) -> SessionOpen {
        SessionOpen {
            session_id: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b".into(),
            assist_name: "Asha".into(),
            reason: Some("disk check".into()),
            unattended: true,
            decision,
            policy: UnattendedPolicy {
                mode: ia_core::policy::UnattendedMode::Allow,
                ..Default::default()
            },
            recording_mode: "server".into(),
            credential: Secret::new("A".repeat(43)),
            credential_expires_at: "2026-11-01T10:02:00.000Z".into(),
        }
    }

    fn blob(decision: ConsentDecision, target: DesktopTarget, gen: u16) -> LaunchBlob {
        let o = open(decision);
        blob_for(
            &o,
            "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a",
            "https://in.example",
            "wss://in.example/signal",
            &[1, 2],
            gen,
            target,
            &o.credential,
            &o.credential_expires_at,
        )
    }

    #[test]
    fn an_auto_grant_blob_carries_the_settled_consent_and_validates() {
        let b = blob(
            ConsentDecision::AutoGrant,
            DesktopTarget::ConsoleDefault { session_id: 1 },
            0,
        );
        let c = b.consent.as_ref().expect("auto_grant settles consent");
        assert_eq!(c.level, "control");
        assert_eq!(c.monitors, vec![1, 2]);
        assert!(
            !c.clipboard,
            "the clipboard starts off; the technician asks for it"
        );
        assert!(!b.secure_desktop);
        b.validate().expect("a valid blob");
    }

    #[test]
    fn a_blob_for_a_card_decision_carries_no_consent() {
        for d in [
            ConsentDecision::LocalApproval,
            ConsentDecision::LocalConsent,
        ] {
            let b = blob(d, DesktopTarget::ConsoleDefault { session_id: 1 }, 0);
            assert!(b.consent.is_none(), "{d:?} is answered by a person");
            b.validate().expect("a valid blob");
        }
    }

    #[test]
    fn a_rebuild_blob_names_the_next_generation_and_the_secure_desktop() {
        let b = blob(ConsentDecision::AutoGrant, DesktopTarget::SecureDesktop, 3);
        assert_eq!(b.gen, 3);
        assert!(
            b.secure_desktop,
            "the rule 5.1c gate applies from the first frame"
        );
        b.validate().expect("a valid blob");
    }

    #[test]
    fn the_blob_points_the_worker_at_the_ordinary_signal_url() {
        let b = blob(
            ConsentDecision::AutoGrant,
            DesktopTarget::ConsoleDefault { session_id: 1 },
            0,
        );
        assert_eq!(b.signal_url, "wss://in.example/signal");
        assert!(
            !b.signal_url.contains("/signal/device"),
            "the worker is a Desk, not a device"
        );
    }

    #[test]
    fn the_service_signs_the_attestation_the_console_will_verify() {
        let id = Identity::generate();
        let session = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
        let frame = WorkerFrame::SignSas {
            id: "1".into(),
            gen: 2,
            sas: "042917".into(),
            desk_fpr: "a".repeat(64),
            assist_fpr: "b".repeat(64),
        };
        match answer_worker(&frame, session, &id) {
            WorkerAction::Reply(ServiceFrame::SasSig { re, sig }) => {
                assert_eq!(re, "1");
                let input = ia_core::devsig::input::sas(
                    session,
                    2,
                    "042917",
                    &"a".repeat(64),
                    &"b".repeat(64),
                )
                .unwrap();
                assert!(ia_core::devsig::verify_device_signature(
                    &input,
                    &sig,
                    &id.public_key()
                ));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_signature_is_bound_to_the_session_the_worker_was_launched_for() {
        let id = Identity::generate();
        let frame = WorkerFrame::SignSas {
            id: "1".into(),
            gen: 0,
            sas: "042917".into(),
            desk_fpr: "a".repeat(64),
            assist_fpr: "b".repeat(64),
        };
        let mine = answer_worker(&frame, "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b", &id);
        let other = answer_worker(&frame, "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a", &id);
        assert_ne!(mine, other, "a different session is a different signature");
        // And the signature for session A does not verify as session B's attestation.
        let WorkerAction::Reply(ServiceFrame::SasSig { sig, .. }) = mine else {
            panic!()
        };
        let b_input = ia_core::devsig::input::sas(
            "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a",
            0,
            "042917",
            &"a".repeat(64),
            &"b".repeat(64),
        )
        .unwrap();
        assert!(!ia_core::devsig::verify_device_signature(
            &b_input,
            &sig,
            &id.public_key()
        ));
    }

    #[test]
    fn the_service_refuses_to_sign_anything_that_is_not_a_sas_attestation() {
        let id = Identity::generate();
        let session = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
        for (sas, desk, assist) in [
            ("", "a", "b"),
            ("not-digits", &"a".repeat(64), &"b".repeat(64)),
            ("0429170", &"a".repeat(64), &"b".repeat(64)),
            ("042917", "short", &"b".repeat(64)),
            ("042917", &"a".repeat(64), &"z".repeat(64)),
        ] {
            let frame = WorkerFrame::SignSas {
                id: "1".into(),
                gen: 0,
                sas: sas.into(),
                desk_fpr: desk.into(),
                assist_fpr: assist.into(),
            };
            match answer_worker(&frame, session, &id) {
                WorkerAction::Reply(ServiceFrame::Error { code, .. }) => {
                    assert_eq!(code, "bad_request")
                }
                other => panic!("{sas}/{desk}/{assist} should be refused: {other:?}"),
            }
        }
    }

    #[test]
    fn the_other_worker_frames_become_the_actions_the_service_takes() {
        let id = Identity::generate();
        let s = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
        assert_eq!(
            answer_worker(&WorkerFrame::Ready { pid: 42 }, s, &id),
            WorkerAction::Ready { pid: 42 }
        );
        assert_eq!(
            answer_worker(&WorkerFrame::Alive, s, &id),
            WorkerAction::Alive
        );
        assert_eq!(
            answer_worker(
                &WorkerFrame::Protections {
                    input_lock: true,
                    privacy_screen: false
                },
                s,
                &id
            ),
            WorkerAction::Protections {
                input_lock: true,
                privacy_screen: false
            }
        );
        assert_eq!(
            answer_worker(
                &WorkerFrame::Ended {
                    reason: "stop".into()
                },
                s,
                &id
            ),
            WorkerAction::Ended {
                reason: "stop".into()
            }
        );
        assert_eq!(
            answer_worker(
                &WorkerFrame::DesktopSwitch {
                    id: "1".into(),
                    reason: "uac".into()
                },
                s,
                &id
            ),
            WorkerAction::ReconsiderDesktop {
                reason: "uac".into()
            }
        );
        assert_eq!(
            answer_worker(&WorkerFrame::SendSas { id: "7".into() }, s, &id),
            WorkerAction::SendSas { id: "7".into() }
        );
    }

    #[test]
    fn a_modified_binary_stops_the_launch_before_a_pipe_exists() {
        let policy = UnattendedPolicy {
            allow_logon_screen: true,
            ..Default::default()
        };
        assert_eq!(
            launch_verdict(
                DesktopTarget::ConsoleDefault { session_id: 1 },
                &policy,
                false,
                "changed: [ia-desktop.exe]"
            ),
            LaunchVerdict::IntegrityFailed("changed: [ia-desktop.exe]".into())
        );
    }

    #[test]
    fn the_prelogin_gate_is_re_checked_on_the_device() {
        let closed = UnattendedPolicy::default();
        assert_eq!(
            launch_verdict(DesktopTarget::LogonScreen, &closed, true, ""),
            LaunchVerdict::PreloginNotPermitted
        );
        let open = UnattendedPolicy {
            allow_logon_screen: true,
            ..Default::default()
        };
        assert_eq!(
            launch_verdict(DesktopTarget::LogonScreen, &open, true, ""),
            LaunchVerdict::Go
        );
        // A user desktop never needs that flag.
        assert_eq!(
            launch_verdict(
                DesktopTarget::ConsoleDefault { session_id: 1 },
                &closed,
                true,
                ""
            ),
            LaunchVerdict::Go
        );
    }

    #[test]
    fn the_protection_state_knows_when_there_is_something_to_release() {
        assert!(!ProtectionState::default().anything_on());
        assert!(ProtectionState {
            input_lock: true,
            privacy_screen: false
        }
        .anything_on());
        assert!(ProtectionState {
            input_lock: false,
            privacy_screen: true
        }
        .anything_on());
    }
}
