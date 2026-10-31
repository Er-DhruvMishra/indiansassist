//! `ia-core`: the portable heart of the IndiansAssist Windows agent (Phase C §11.1).
//!
//! Contains **no platform or webrtc calls** so it compiles and is tested on any OS
//! (here: the `x86_64-pc-windows-gnu` dev toolchain without a C compiler). It owns:
//!
//! * protocol types that mirror the shared zod schemas ([`types`]),
//! * the §1.3 secure-channel handshake and frame crypto ([`sec`], [`secchan`]),
//! * canonical JSON used by the transcript hash ([`canonical`]),
//! * the session state machine ([`state`]),
//! * the adaptive-bitrate controller ([`abr`]),
//! * token / short-code / compact-token parsing ([`join_input`]),
//! * the download filename grammar and signed sidecar parsing ([`download`]),
//! * file-name sanitisation and the risk extension lists ([`files`]),
//! * playbook argument validation, the cmd value rule, body lint and the output
//!   marker parser ([`playbook`]).
//!
//! Cross-language parity: `tests/shared_vectors.rs` loads the shared fixtures under
//! `packages/shared/test/fixtures/agent/` (sec vectors, wire names, file lists), the same
//! files the TypeScript and Kotlin tests load.

pub mod abr;
pub mod canonical;
pub mod capture_decision;
pub mod clipsync;
pub mod consent;
pub mod control;
pub mod ctl;
pub mod download;
pub mod files;
pub mod filexfer;
pub mod handover;
pub mod join_input;
pub mod playbook;
pub mod sec;
pub mod secchan;
pub mod state;
pub mod stats;
pub mod teardown;
pub mod types;

/// Protocol-wide error for parsing / validation failures surfaced to the agent.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CoreError {
    #[error("bad input: {0}")]
    BadInput(String),
    #[error("crypto failure: {0}")]
    Crypto(String),
    #[error("not valid: {0}")]
    Invalid(String),
}

pub type CoreResult<T> = Result<T, CoreError>;
