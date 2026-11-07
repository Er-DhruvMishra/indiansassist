//! Embeds the Windows VERSIONINFO resource (ProductName, CompanyName, FileVersion; docs/release.md section 4.4).
//! Nothing happens on other targets.
include!("../../build-support/versioninfo.rs");

fn main() {
    embed_version_info("ia-desktop.exe", "IndiansAssist Agent desktop worker");
}
