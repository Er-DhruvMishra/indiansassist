//! Platform seam for the agent (contract §11.1). The traits here are the only surface
//! Phase E's macOS/Linux crates fill; the Windows implementations live behind the
//! `winapi` feature (so the default build is pure-Rust and compiles on the gnu dev
//! toolchain without a C compiler).
//!
//! The pure logic the contract requires tests for — the self-delete stub's argument
//! safety (§10 D2), the HKCU protocol-handler value set (§2.5 L1) and the single-instance
//! pipe-name derivation (§11.5) — is implemented and tested here with no OS calls.
//!
//! Phase D adds the service seams of its §11.1 — `ServiceHost`, `DesktopBridge`, `Waker`,
//! `Amt` and `SecretInjector` ([`service`]) — on the same principle: the trait is the OS
//! boundary, the decision behind it is a pure function in the crate that owns it.

pub mod linux;
// apple-owned: begin
/// Phase F §17.2: the macOS impls of the traits (apple stream).
#[cfg(target_os = "macos")]
pub mod macos;
// apple-owned: end
pub mod protocol;
pub mod selfdelete;
pub mod service;
#[cfg(feature = "tls")]
pub mod tls;
pub mod traits;
pub mod trust;

#[cfg(all(windows, feature = "winapi"))]
pub mod win;

pub use service::*;
pub use traits::*;

/// `sys_lib(name)`: the single late-binding loader of §14. Every non-KnownDLL system
/// library is reached through `LoadLibraryExW(name, NULL, LOAD_LIBRARY_SEARCH_SYSTEM32)`
/// plus `GetProcAddress`, so the agent's import table carries only KnownDLLs (DLL-hijack
/// defence). The real loader is in [`win`] under the `winapi` feature; without it the
/// symbol is unavailable (the pure build does no dynamic loading).
#[cfg(all(windows, feature = "winapi"))]
pub use win::sys_lib;
