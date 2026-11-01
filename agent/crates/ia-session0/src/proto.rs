//! The duplex half of the §4.2 pipe, after the launch blob: what the worker asks the service
//! for, and what the service streams back.
//!
//! Framing is one JSON object per line. The pipe is a byte stream between two processes on one
//! machine, so a line is all the delimiting it needs, and a text frame keeps the protocol
//! greppable in a trace. Every frame is bounded ([`FRAME_MAX`]) and a line that does not parse
//! is reported rather than closing the pipe — a worker and a service from different builds
//! should talk about what they share, not die on what they do not.
//!
//! The one rule worth stating twice: **the identity key never enters the worker.** Rule 3.5b
//! needs a device-key signature over the session's SAS, so the worker *asks* for one
//! ([`WorkerFrame::SignSas`]) and the service answers with the signature alone
//! ([`ServiceFrame::SasSig`]).

use std::io::{BufRead, Write};

use serde::{Deserialize, Serialize};

use ia_core::fleet::InteractiveState;
use ia_platform::DesktopTarget;

/// The largest single frame either side accepts.
pub const FRAME_MAX: usize = 64 * 1024;

/// Worker → service.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum WorkerFrame {
    /// Sent once the worker has the blob and its own `/signal` socket is up. `pid` lets the
    /// service confirm the peer it verified is the process it launched.
    Ready { pid: u32 },
    /// Rule 3.5b: sign `ia-sas-v1` over this generation's SAS and both fingerprints. The
    /// worker cannot do this itself — it holds no device key.
    #[serde(rename_all = "camelCase")]
    SignSas {
        id: String,
        gen: u16,
        sas: String,
        desk_fpr: String,
        assist_fpr: String,
    },
    /// The worker noticed it is on the wrong desktop (a UAC prompt came up, the session
    /// locked) and asks the service to re-evaluate §5.3.
    #[serde(rename_all = "camelCase")]
    DesktopSwitch { id: String, reason: String },
    /// §5.4d: the live state of the protections, so the service (and through it the server)
    /// knows what to release if the worker dies.
    #[serde(rename_all = "camelCase")]
    Protections {
        input_lock: bool,
        privacy_screen: bool,
    },
    /// §5.4 `os.sas`: ask the service to press Ctrl+Alt+Del through `SendSAS`. No process can
    /// inject the SAS, so the worker cannot do this itself — which is the whole reason the op
    /// exists on the service side of the pipe.
    SendSas { id: String },
    /// The worker's session ended; `reason` is the C teardown reason.
    Ended { reason: String },
    /// A heartbeat, so a worker that is wedged (rather than dead) is noticed.
    Alive,
}

/// Service → worker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServiceFrame {
    /// The answer to [`WorkerFrame::SignSas`]: `re` is that request's `id`.
    SasSig { re: String, sig: String },
    /// A request the service could not satisfy (a signing refusal, an unavailable API).
    Error { re: String, code: String },
    /// A request the service performed and that has no payload to return (`os.sas`).
    Ack { re: String },
    /// A `WTS_SESSION_*` change the service saw (§4.1), with the state it derived.
    SessionChange { interactive: InteractiveState },
    /// The §3.4 interactive state, pushed on change (it drives the arrival rule 6.2a).
    Interactive { interactive: InteractiveState },
    /// The desktop the worker should now be targeting (after a §5.3 re-evaluation that did
    /// not need a relaunch). `surface` names which secure surface it is (rule 5.1c:
    /// `logon` | `uac` | `lock`), which the worker needs for its `capture.secure_desktop`
    /// audit entry — the service is the only side that can tell a lock screen from a UAC
    /// prompt, because it is the side that can read the session state.
    #[serde(rename_all = "camelCase")]
    Desktop {
        target: WireDesktop,
        secure_desktop: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        surface: Option<crate::desktop::SecureSurface>,
    },
    /// A fresh worker credential (rule 3.6d: the worker's socket moved node and must re-join).
    #[serde(rename_all = "camelCase")]
    WorkerCredential {
        worker_credential: ia_core::fleet::Secret,
        gen: u16,
        expires_at: String,
    },
    /// Stop: the session ended, the service is stopping, or the worker is being replaced.
    Stop { reason: String },
}

/// `DesktopTarget` on the wire (the trait type is not `serde`-aware by design: it is a
/// platform type, this is a protocol one).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WireDesktop {
    #[serde(rename_all = "camelCase")]
    ConsoleDefault {
        session_id: u32,
    },
    SecureDesktop,
    LogonScreen,
}

impl From<DesktopTarget> for WireDesktop {
    fn from(t: DesktopTarget) -> Self {
        match t {
            DesktopTarget::ConsoleDefault { session_id } => {
                WireDesktop::ConsoleDefault { session_id }
            }
            DesktopTarget::SecureDesktop => WireDesktop::SecureDesktop,
            DesktopTarget::LogonScreen => WireDesktop::LogonScreen,
        }
    }
}

impl From<WireDesktop> for DesktopTarget {
    fn from(t: WireDesktop) -> Self {
        match t {
            WireDesktop::ConsoleDefault { session_id } => {
                DesktopTarget::ConsoleDefault { session_id }
            }
            WireDesktop::SecureDesktop => DesktopTarget::SecureDesktop,
            WireDesktop::LogonScreen => DesktopTarget::LogonScreen,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("the frame is {0} bytes, over the {FRAME_MAX} cap")]
    TooLarge(usize),
    #[error("the frame is not a known message: {0}")]
    Malformed(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// The peer closed the pipe.
    #[error("the pipe closed")]
    Closed,
}

/// Writes one frame as a line.
pub fn write_frame<W: Write, T: Serialize>(w: &mut W, frame: &T) -> Result<(), FrameError> {
    let mut line = serde_json::to_vec(frame).map_err(|e| FrameError::Malformed(e.to_string()))?;
    if line.len() + 1 > FRAME_MAX {
        return Err(FrameError::TooLarge(line.len() + 1));
    }
    line.push(b'\n');
    w.write_all(&line)?;
    w.flush()?;
    Ok(())
}

/// Reads one frame from a line. `Err(Closed)` at a clean end of stream.
pub fn read_frame<R: BufRead, T: for<'de> Deserialize<'de>>(r: &mut R) -> Result<T, FrameError> {
    let mut line = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        match std::io::Read::read(r, &mut byte)? {
            0 => {
                return if line.is_empty() {
                    Err(FrameError::Closed)
                } else {
                    Err(FrameError::Malformed("the pipe closed mid-frame".into()))
                }
            }
            _ => {
                if byte[0] == b'\n' {
                    break;
                }
                line.push(byte[0]);
                if line.len() > FRAME_MAX {
                    return Err(FrameError::TooLarge(line.len()));
                }
            }
        }
    }
    serde_json::from_slice(&line).map_err(|e| FrameError::Malformed(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ia_core::policy::InteractiveStateName;

    fn state() -> InteractiveState {
        InteractiveState {
            state: InteractiveStateName::Active,
            idle_sec: Some(0),
            at: 1_762_000_000_000,
        }
    }

    #[test]
    fn frames_round_trip_in_both_directions_over_one_stream() {
        let mut buf: Vec<u8> = Vec::new();
        write_frame(&mut buf, &WorkerFrame::Ready { pid: 4242 }).unwrap();
        write_frame(
            &mut buf,
            &WorkerFrame::SignSas {
                id: "1".into(),
                gen: 1,
                sas: "042917".into(),
                desk_fpr: "a".repeat(64),
                assist_fpr: "b".repeat(64),
            },
        )
        .unwrap();
        write_frame(
            &mut buf,
            &WorkerFrame::Protections {
                input_lock: true,
                privacy_screen: false,
            },
        )
        .unwrap();
        let mut r = std::io::BufReader::new(buf.as_slice());
        assert_eq!(
            read_frame::<_, WorkerFrame>(&mut r).unwrap(),
            WorkerFrame::Ready { pid: 4242 }
        );
        match read_frame::<_, WorkerFrame>(&mut r).unwrap() {
            WorkerFrame::SignSas { gen, sas, .. } => {
                assert_eq!(gen, 1);
                assert_eq!(sas, "042917");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            read_frame::<_, WorkerFrame>(&mut r).unwrap(),
            WorkerFrame::Protections {
                input_lock: true,
                privacy_screen: false
            }
        );
        assert!(matches!(
            read_frame::<_, WorkerFrame>(&mut r),
            Err(FrameError::Closed)
        ));
    }

    #[test]
    fn the_service_side_frames_round_trip_too() {
        let mut buf: Vec<u8> = Vec::new();
        write_frame(
            &mut buf,
            &ServiceFrame::SasSig {
                re: "1".into(),
                sig: "s".repeat(86),
            },
        )
        .unwrap();
        write_frame(
            &mut buf,
            &ServiceFrame::Interactive {
                interactive: state(),
            },
        )
        .unwrap();
        write_frame(
            &mut buf,
            &ServiceFrame::Desktop {
                target: WireDesktop::SecureDesktop,
                secure_desktop: true,
                surface: Some(crate::desktop::SecureSurface::Uac),
            },
        )
        .unwrap();
        let mut r = std::io::BufReader::new(buf.as_slice());
        assert!(matches!(
            read_frame::<_, ServiceFrame>(&mut r).unwrap(),
            ServiceFrame::SasSig { .. }
        ));
        assert!(matches!(
            read_frame::<_, ServiceFrame>(&mut r).unwrap(),
            ServiceFrame::Interactive { .. }
        ));
        assert_eq!(
            read_frame::<_, ServiceFrame>(&mut r).unwrap(),
            ServiceFrame::Desktop {
                target: WireDesktop::SecureDesktop,
                secure_desktop: true,
                surface: Some(crate::desktop::SecureSurface::Uac),
            }
        );
    }

    #[test]
    fn a_line_that_is_not_a_known_frame_is_reported_not_fatal() {
        let mut data: Vec<u8> = b"{\"t\":\"from_a_newer_build\"}\n".to_vec();
        write_frame(&mut data, &WorkerFrame::Alive).unwrap();
        let mut r = std::io::BufReader::new(data.as_slice());
        assert!(matches!(
            read_frame::<_, WorkerFrame>(&mut r),
            Err(FrameError::Malformed(_))
        ));
        // The stream is still usable: the next frame reads fine.
        assert_eq!(
            read_frame::<_, WorkerFrame>(&mut r).unwrap(),
            WorkerFrame::Alive
        );
    }

    #[test]
    fn an_oversize_line_is_refused_rather_than_buffered() {
        let mut data: Vec<u8> = vec![b'x'; FRAME_MAX + 10];
        data.push(b'\n');
        let mut r = std::io::BufReader::new(data.as_slice());
        assert!(matches!(
            read_frame::<_, WorkerFrame>(&mut r),
            Err(FrameError::TooLarge(_))
        ));
    }

    #[test]
    fn a_truncated_write_is_not_mistaken_for_a_clean_close() {
        let mut r = std::io::BufReader::new(&b"{\"t\":\"alive\""[..]);
        assert!(matches!(
            read_frame::<_, WorkerFrame>(&mut r),
            Err(FrameError::Malformed(_))
        ));
    }

    #[test]
    fn the_desktop_target_survives_the_wire_both_ways() {
        for t in [
            DesktopTarget::ConsoleDefault { session_id: 2 },
            DesktopTarget::SecureDesktop,
            DesktopTarget::LogonScreen,
        ] {
            let wire: WireDesktop = t.into();
            let text = serde_json::to_string(&wire).unwrap();
            let back: WireDesktop = serde_json::from_str(&text).unwrap();
            assert_eq!(DesktopTarget::from(back), t);
        }
        assert_eq!(
            serde_json::to_string(&WireDesktop::ConsoleDefault { session_id: 2 }).unwrap(),
            r#"{"kind":"console_default","sessionId":2}"#
        );
    }
}
