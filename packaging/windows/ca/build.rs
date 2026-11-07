//! Embeds the Windows VERSIONINFO resource in the custom-action DLL (docs/release.md section 4.4). The release
//! version comes from IA_RELEASE_VERSION, which packaging/windows/build.mjs sets to the MSI's version.
include!("../../../agent/build-support/versioninfo.rs");

fn main() {
    embed_version_info(
        "ia_msi_ca.dll",
        "IndiansAssist Agent installer custom actions",
    );
}
