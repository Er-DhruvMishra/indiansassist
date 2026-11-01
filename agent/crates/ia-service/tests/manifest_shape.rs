//! The packaging stream writes `manifest.json`; the service reads it on every start and every
//! hour (§10.3, §12.2). Two streams, one file — so this test checks they agree on it, using the
//! **real** file `pnpm packaging:msi` stages when one is there.
//!
//! It skips rather than fails when the MSI has not been built: a developer who has not run the
//! packaging build should not see a red test, and CI runs `packaging:msi` before this.

use std::path::{Path, PathBuf};

use ia_service::config::InstallManifest;
use ia_service::tamperstore::check_binaries;

/// `packaging/windows/out/<arch>/stage` for whichever arch has been built.
fn staged() -> Option<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packaging/windows/out");
    for arch in ["x64", "arm64"] {
        let stage = root.join(arch).join("stage");
        if stage.join("manifest.json").exists() {
            return Some(stage);
        }
    }
    None
}

#[test]
fn the_service_reads_the_manifest_the_packaging_build_writes() {
    let Some(stage) = staged() else {
        eprintln!("no staged MSI payload (run `pnpm packaging:msi`); skipping");
        return;
    };
    let manifest = InstallManifest::load(&stage.join("manifest.json"))
        .expect("the staged manifest.json parses as the shape the service reads");
    assert_eq!(manifest.v, 1);
    assert!(!manifest.version.is_empty());
    assert!(
        matches!(manifest.arch.as_str(), "x64" | "arm64"),
        "arch: {}",
        manifest.arch
    );

    // §11.3: the three installed binaries, each named and hashed.
    for name in ["ia-service.exe", "ia-desktop.exe", "ia-watchdog.exe"] {
        let f = manifest
            .file(name)
            .unwrap_or_else(|| panic!("{name} is not in the staged manifest"));
        assert_eq!(f.sha256.len(), 64, "{name}: sha256 is 64 hex chars");
        assert!(f.size > 0, "{name}: a size");
    }

    // And the §10.3 comparison passes against the very files it describes, which is the whole
    // point: a service installed from this payload starts with `binaries_ok`.
    let report = check_binaries(&stage, &manifest);
    assert!(
        report.binaries_ok(),
        "the staged payload fails its own integrity check: {}",
        report.summary()
    );

    // The size gate of §11.3 (25 MiB per exe), checked here as well as in CI, because a release
    // build that quietly doubles is something to notice before signing.
    for f in &manifest.files {
        assert!(
            f.size <= 25 * 1024 * 1024,
            "{} is {} bytes, over the §11.3 25 MiB limit",
            f.name,
            f.size
        );
    }
}

#[test]
fn a_changed_binary_in_the_staged_payload_would_be_detected() {
    let Some(stage) = staged() else {
        eprintln!("no staged MSI payload; skipping");
        return;
    };
    let manifest = InstallManifest::load(&stage.join("manifest.json")).expect("the manifest");
    // Describe the same files with one wrong hash: the check must notice, which is what makes
    // §10.3 worth having.
    let mut tampered = manifest.clone();
    tampered.files[0].sha256 = "ab".repeat(32);
    let report = check_binaries(&stage, &tampered);
    assert!(!report.binaries_ok());
    assert_eq!(report.changed, vec![tampered.files[0].name.clone()]);
}
