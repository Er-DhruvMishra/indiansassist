//! The enrollment client state machine (`docs/specs/phase-d-contracts.md` §3.1, §3.2).
//!
//! Pure: it decides what to do with each HTTP answer and never performs the call. The service
//! owns the transport; this module owns the rules that are easy to get wrong —
//!
//! * a `429` is backed off with jitter (an office enrolls in waves, §3.2), as is a `5xx` and a
//!   transport failure;
//! * a `410 token_used` / `token_gone` is **terminal**: the rollout's token has no capacity
//!   left, so retrying forever would only hammer the server. The service logs it and waits for
//!   a new enrollment config;
//! * a `400` means the config itself is wrong (bad signature, wrong token type, unknown
//!   group); also terminal;
//! * the enrollment material is shredded only after a `201`, never before (§3.1 step 5).

use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::backoff::Backoff;
use crate::fleet::DeviceEnrollReply;

/// Why enrollment stopped for good. Each one needs a person: a new token, a fixed config, or a
/// look at the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnrollFailure {
    /// `400 invalid_enroll_config` / `invalid_token_type` / `invalid_group` / `token_bad_signature`.
    BadConfig(String),
    /// `410 token_used` (the rollout filled its `maxDevices`) or `token_gone` (revoked/expired).
    TokenGone(String),
    /// The server answered `201` with something this build cannot read.
    BadReply(String),
    /// A `4xx` the contract does not name; retrying would not help.
    Refused(u16),
    /// The service gave up after `max_attempts` retryable answers.
    Exhausted,
}

/// What the service should do next.
#[derive(Debug, Clone, PartialEq)]
pub enum EnrollAction {
    /// Send (or re-send) `POST /api/v1/devices/enroll`.
    Send,
    /// Wait, then send again.
    WaitThenRetry(Duration),
    /// Enrolled. Store the identity, then shred the enrollment material (§3.1 step 5).
    Enrolled(Box<DeviceEnrollReply>),
    /// Stop; the reason needs a person.
    GiveUp(EnrollFailure),
}

/// One answer to classify: an HTTP status with its body, or a transport failure.
#[derive(Debug, Clone)]
pub enum EnrollResponse<'a> {
    Http {
        status: u16,
        body: &'a str,
    },
    /// The request never completed (DNS, TLS, no route): the usual state of a machine that
    /// boots before the network is up, so it is always retryable.
    Transport(&'a str),
}

/// The enrollment client. Default: the C §3.1 ladder with a generous attempt budget — a
/// machine imaged on a Friday evening keeps trying over the weekend rather than needing a
/// restart.
#[derive(Debug, Clone)]
pub struct EnrollClient {
    backoff: Backoff,
    attempts: u32,
    max_attempts: u32,
    done: bool,
}

impl Default for EnrollClient {
    fn default() -> Self {
        Self {
            backoff: Backoff::default(),
            attempts: 0,
            max_attempts: 10_000,
            done: false,
        }
    }
}

/// The error code of an api error body (`{ error: { code, message } }`), if it has one.
fn error_code(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    v.get("error")?.get("code")?.as_str().map(str::to_string)
}

impl EnrollClient {
    pub fn new(max_attempts: u32) -> Self {
        Self {
            max_attempts,
            ..Default::default()
        }
    }

    /// The first action: send.
    pub fn start(&self) -> EnrollAction {
        EnrollAction::Send
    }

    pub fn attempts(&self) -> u32 {
        self.attempts
    }

    /// Classifies one answer. After an [`EnrollAction::Enrolled`] or
    /// [`EnrollAction::GiveUp`] the client is spent and keeps returning that verdict.
    pub fn on_response(&mut self, r: EnrollResponse<'_>) -> EnrollAction {
        if self.done {
            return EnrollAction::GiveUp(EnrollFailure::Exhausted);
        }
        self.attempts = self.attempts.saturating_add(1);
        let retry = |me: &mut Self| {
            if me.attempts >= me.max_attempts {
                me.done = true;
                EnrollAction::GiveUp(EnrollFailure::Exhausted)
            } else {
                EnrollAction::WaitThenRetry(me.backoff.next_delay())
            }
        };
        match r {
            EnrollResponse::Transport(_) => retry(self),
            EnrollResponse::Http { status: 201, body } => {
                match serde_json::from_str::<DeviceEnrollReply>(body) {
                    Ok(reply) => {
                        self.done = true;
                        EnrollAction::Enrolled(Box::new(reply))
                    }
                    Err(e) => {
                        self.done = true;
                        EnrollAction::GiveUp(EnrollFailure::BadReply(e.to_string()))
                    }
                }
            }
            EnrollResponse::Http { status: 429, .. } => retry(self),
            EnrollResponse::Http { status, .. } if status >= 500 => retry(self),
            EnrollResponse::Http { status: 400, body } => {
                self.done = true;
                EnrollAction::GiveUp(EnrollFailure::BadConfig(
                    error_code(body).unwrap_or_else(|| "invalid_enroll_config".into()),
                ))
            }
            EnrollResponse::Http { status: 410, body } => {
                self.done = true;
                EnrollAction::GiveUp(EnrollFailure::TokenGone(
                    error_code(body).unwrap_or_else(|| "token_gone".into()),
                ))
            }
            EnrollResponse::Http { status, .. } => {
                self.done = true;
                EnrollAction::GiveUp(EnrollFailure::Refused(status))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPLY: &str = r#"{"deviceId":"0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a","orgId":"5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
        "region":"in-mum","apiOrigin":"https://in.example","signalUrl":"wss://in.example/signal/device","keyId":"0123456789abcdef",
        "group":null,"policy":{"mode":"approval_only","requireLocalApprovalWhenPresent":true,"autoAllowAfterSec":null,
        "allowedHours":null,"recordingRequired":true,"allowLogonScreen":false,"allowSecureDesktop":false,
        "allowPrivileged":true,"allowInputLock":false,"allowPrivacyScreen":false,"allowAmtSol":false,
        "allowAmtBootRedirect":false,"notifyLocalUser":true,"maxUnattendedMinutes":120}}"#;

    #[test]
    fn a_created_reply_enrolls_once_and_only_once() {
        let mut c = EnrollClient::default();
        assert_eq!(c.start(), EnrollAction::Send);
        let got = c.on_response(EnrollResponse::Http {
            status: 201,
            body: REPLY,
        });
        match got {
            EnrollAction::Enrolled(r) => {
                assert_eq!(r.device_id, "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a");
                assert_eq!(r.key_id, "0123456789abcdef");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            c.on_response(EnrollResponse::Http {
                status: 201,
                body: REPLY
            }),
            EnrollAction::GiveUp(EnrollFailure::Exhausted)
        ));
    }

    #[test]
    fn a_rate_limit_and_a_server_error_and_a_dead_network_are_all_backed_off() {
        for r in [
            EnrollResponse::Http {
                status: 429,
                body: "{}",
            },
            EnrollResponse::Http {
                status: 503,
                body: "",
            },
            EnrollResponse::Transport("dns failure"),
        ] {
            let mut c = EnrollClient::default();
            assert!(matches!(c.on_response(r), EnrollAction::WaitThenRetry(_)));
        }
    }

    #[test]
    fn the_backoff_grows_across_retries() {
        let mut c = EnrollClient::default();
        let mut last = Duration::ZERO;
        for _ in 0..4 {
            match c.on_response(EnrollResponse::Http {
                status: 429,
                body: "{}",
            }) {
                EnrollAction::WaitThenRetry(d) => {
                    // ±30 % jitter can overlap one rung, never two.
                    assert!(d >= last.mul_f64(0.5), "{d:?} after {last:?}");
                    last = d;
                }
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(c.attempts(), 4);
    }

    #[test]
    fn a_full_token_is_terminal_and_names_its_code() {
        let mut c = EnrollClient::default();
        assert_eq!(
            c.on_response(EnrollResponse::Http {
                status: 410,
                body: r#"{"error":{"code":"token_used","message":"this enrollment token is used up"}}"#,
            }),
            EnrollAction::GiveUp(EnrollFailure::TokenGone("token_used".into()))
        );
    }

    #[test]
    fn a_bad_config_is_terminal_and_names_its_code() {
        let mut c = EnrollClient::default();
        assert_eq!(
            c.on_response(EnrollResponse::Http {
                status: 400,
                body: r#"{"error":{"code":"invalid_token_type","message":"not an enrollment token"}}"#,
            }),
            EnrollAction::GiveUp(EnrollFailure::BadConfig("invalid_token_type".into()))
        );
    }

    #[test]
    fn an_unreadable_created_reply_does_not_pretend_to_be_enrolled() {
        let mut c = EnrollClient::default();
        assert!(matches!(
            c.on_response(EnrollResponse::Http {
                status: 201,
                body: r#"{"deviceId":"x"}"#
            }),
            EnrollAction::GiveUp(EnrollFailure::BadReply(_))
        ));
    }

    #[test]
    fn the_attempt_budget_ends_it() {
        let mut c = EnrollClient::new(3);
        for _ in 0..2 {
            assert!(matches!(
                c.on_response(EnrollResponse::Transport("offline")),
                EnrollAction::WaitThenRetry(_)
            ));
        }
        assert_eq!(
            c.on_response(EnrollResponse::Transport("offline")),
            EnrollAction::GiveUp(EnrollFailure::Exhausted)
        );
    }
}
