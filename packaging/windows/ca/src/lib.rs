//! MSI custom actions for the IndiansAssist Agent package (Phase D contracts section 12.2).
//!
//! All three entry points are **deferred, no-impersonate** actions, so they run as `LocalSystem`
//! inside the Windows Installer server. They read only `CustomActionData` and never log any part of
//! `IA_ENROLL` (the package also lists `IA_ENROLL` and the CustomActionData properties in
//! `MsiHiddenProperties` and sets `HideTarget`).
//!
//! * `IaApplyInstall`: protects `%ProgramData%\IndiansAssist\` and `HKLM\SOFTWARE\IndiansAssist\Device`
//!   with the section 3.3 / 10.4 ACLs (`SYSTEM` + `Administrators`, system mandatory label,
//!   no-write-up), then, when `IA_ENROLL` is set, writes the signed `enroll.iaconfig` beside
//!   `ia-service.exe` (created with that ACL, never readable by users) and `config.json` (section 4.1).
//! * `IaApplyInstallRollback`: shreds an `enroll.iaconfig` the install wrote.
//! * `IaWipeData`: at uninstall (after `ia-service.exe --msi-uninstall` has deregistered), overwrites
//!   and deletes the key blobs and the enroll config, removes the `%ProgramData%\IndiansAssist\` tree
//!   and the `Device` registry key. Best effort: an uninstall never fails because of it.

pub mod enroll;

#[cfg(windows)]
mod win;

#[cfg(windows)]
pub use win::{IaApplyInstall, IaApplyInstallRollback, IaWipeData};
