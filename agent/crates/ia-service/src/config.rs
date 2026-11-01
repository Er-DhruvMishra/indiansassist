//! `config.json` and `manifest.json` (§4.1, §12.2).
//!
//! `config.json` is written by the MSI custom action at install and updated by the service once
//! it has enrolled. It holds **no secret**: the device id and key id identify the device, the
//! key itself is sealed in a separate file (§3.3).
//!
//! Two rules the loader enforces rather than trusting the file:
//!
//! * **The origin rules of C §2.4.** `apiOrigin` must be `https` (or `http` on localhost, for
//!   development) and `signalUrl` must be the region's `/signal/device` URL. A config that was
//!   edited to point at another host is refused, and the service runs enrolled-but-idle rather
//!   than talking to it.
//! * **`deviceId` and `keyId` are only ever written by the service.** The installer writes the
//!   file without them (`packaging/README.md`); a config that arrives with a `deviceId` the
//!   sealed keys do not match is treated as un-enrolled.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// `config.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceConfig {
    #[serde(default = "one")]
    pub v: u8,
    pub api_origin: String,
    pub signal_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    /// The region, from the enroll reply (rule 8.2a salts with the org id, which is kept here
    /// too so a reconnect does not have to re-enroll to compute its segment).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    /// Rule 8.2d: this device never acts as a LAN waker.
    #[serde(default)]
    pub waker_opt_out: bool,
    /// Rule 8.4b: this device never proxies AMT commands.
    #[serde(default)]
    pub amt_proxy_opt_out: bool,
}

fn one() -> u8 {
    1
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("config.json is not readable: {0}")]
    Unreadable(String),
    #[error("config.json is not the JSON the contract defines: {0}")]
    Malformed(String),
    #[error("{0}")]
    Invalid(&'static str),
}

/// C §2.4, enforced identically by the MSI and the server: plain `http`/`ws` only for
/// localhost.
fn valid_api_origin(o: &str) -> bool {
    if let Some(rest) = o.strip_prefix("https://") {
        return !rest.is_empty() && !rest.contains('/') && !rest.contains('@');
    }
    if let Some(rest) = o.strip_prefix("http://") {
        return is_local_host(rest);
    }
    false
}

fn valid_signal_url(u: &str) -> bool {
    let Some(rest) = u.strip_suffix("/signal/device") else {
        return false;
    };
    if let Some(host) = rest.strip_prefix("wss://") {
        return !host.is_empty() && !host.contains('/') && !host.contains('@');
    }
    if let Some(host) = rest.strip_prefix("ws://") {
        return is_local_host(host);
    }
    false
}

fn is_local_host(host_port: &str) -> bool {
    let host = host_port.split(':').next().unwrap_or("");
    (host == "localhost" || host == "127.0.0.1")
        && !host_port.contains('/')
        && host_port
            .split(':')
            .nth(1)
            .map(|p| p.parse::<u16>().is_ok())
            .unwrap_or(true)
}

impl ServiceConfig {
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.v != 1 {
            return Err(ConfigError::Invalid("config.json: unsupported version"));
        }
        if !valid_api_origin(&self.api_origin) {
            return Err(ConfigError::Invalid(
                "config.json apiOrigin: an https origin with no path (plain http only for localhost)",
            ));
        }
        if !valid_signal_url(&self.signal_url) {
            return Err(ConfigError::Invalid(
                "config.json signalUrl: the region's wss://.../signal/device URL (plain ws only for localhost)",
            ));
        }
        Ok(())
    }

    /// Whether the service has a device identity (it has enrolled).
    pub fn is_enrolled(&self) -> bool {
        self.device_id.is_some() && self.key_id.is_some()
    }

    /// The `/signal` URL for the **worker** (§4.2): the same host, without the `/device`
    /// suffix. The worker joins as an ordinary Desk, which is what keeps the C serve loop
    /// unchanged.
    pub fn worker_signal_url(&self) -> String {
        self.signal_url.trim_end_matches("/device").to_string()
    }

    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let text =
            std::fs::read_to_string(path).map_err(|e| ConfigError::Unreadable(e.to_string()))?;
        let cfg: Self =
            serde_json::from_str(&text).map_err(|e| ConfigError::Malformed(e.to_string()))?;
        cfg.validate()?;
        Ok(cfg)
    }

    /// Writes the config, replacing it atomically so a crash mid-write cannot leave the service
    /// with half a config and no way back.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        let tmp = path.with_extension("json.new");
        std::fs::write(&tmp, text.as_bytes())?;
        std::fs::rename(&tmp, path)
    }
}

/// One installed file in `manifest.json` (§12.2 / §10.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestFile {
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

/// `manifest.json`: what the MSI installed, so §10.3 can tell whether a binary changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallManifest {
    #[serde(default = "one")]
    pub v: u8,
    pub version: String,
    pub arch: String,
    #[serde(default)]
    pub placeholder: bool,
    pub files: Vec<ManifestFile>,
}

impl InstallManifest {
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let text =
            std::fs::read_to_string(path).map_err(|e| ConfigError::Unreadable(e.to_string()))?;
        serde_json::from_str(&text).map_err(|e| ConfigError::Malformed(e.to_string()))
    }

    pub fn file(&self, name: &str) -> Option<&ManifestFile> {
        self.files
            .iter()
            .find(|f| f.name.eq_ignore_ascii_case(name))
    }

    /// The sha256 of the whole manifest, so a change to it is itself detectable (§10.4
    /// `config_changed`).
    pub fn digest(&self) -> String {
        use sha2::{Digest, Sha256};
        let canonical = serde_json::to_value(self)
            .map(|v| ia_core::canonical::canonical_json(&v))
            .unwrap_or_default();
        hex::encode(Sha256::digest(canonical.as_bytes()))
    }
}

/// The sha256 of a file on disk, for the §10.3 comparison.
pub fn file_digest(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ServiceConfig {
        ServiceConfig {
            v: 1,
            api_origin: "https://in.example".into(),
            signal_url: "wss://in.example/signal/device".into(),
            device_id: None,
            key_id: None,
            region: None,
            org_id: None,
            waker_opt_out: false,
            amt_proxy_opt_out: false,
        }
    }

    #[test]
    fn an_installer_written_config_has_no_device_id_yet() {
        let c: ServiceConfig = serde_json::from_str(
            r#"{"v":1,"apiOrigin":"https://in.example","signalUrl":"wss://in.example/signal/device","wakerOptOut":false,"amtProxyOptOut":false}"#,
        )
        .unwrap();
        assert!(c.validate().is_ok());
        assert!(!c.is_enrolled());
    }

    #[test]
    fn the_origin_rules_of_the_contract_are_enforced_on_load() {
        for bad in [
            "http://in.example",
            "https://in.example/path",
            "ftp://in.example",
            "https://user@in.example",
            "",
        ] {
            let c = ServiceConfig {
                api_origin: bad.into(),
                ..cfg()
            };
            assert!(c.validate().is_err(), "{bad} must not pass");
        }
        for ok in [
            "https://in.example",
            "https://in.example:8443",
            "http://localhost:4105",
            "http://127.0.0.1:4000",
        ] {
            let c = ServiceConfig {
                api_origin: ok.into(),
                ..cfg()
            };
            assert!(c.validate().is_ok(), "{ok} should pass");
        }
    }

    #[test]
    fn the_signal_url_must_be_the_device_path() {
        for bad in [
            "wss://in.example/signal",
            "wss://in.example",
            "ws://in.example/signal/device",
            "https://in.example/signal/device",
        ] {
            let c = ServiceConfig {
                signal_url: bad.into(),
                ..cfg()
            };
            assert!(c.validate().is_err(), "{bad} must not pass");
        }
        let c = ServiceConfig {
            signal_url: "ws://localhost:4105/signal/device".into(),
            api_origin: "http://localhost:4105".into(),
            ..cfg()
        };
        assert!(c.validate().is_ok(), "a localhost dev pair is allowed");
    }

    #[test]
    fn the_worker_gets_the_plain_signal_url() {
        assert_eq!(cfg().worker_signal_url(), "wss://in.example/signal");
        let dev = ServiceConfig {
            signal_url: "ws://localhost:4105/signal/device".into(),
            ..cfg()
        };
        assert_eq!(dev.worker_signal_url(), "ws://localhost:4105/signal");
    }

    #[test]
    fn it_round_trips_through_the_file_without_losing_the_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let c = ServiceConfig {
            device_id: Some("0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a".into()),
            key_id: Some("0123456789abcdef".into()),
            region: Some("in-mum".into()),
            org_id: Some("5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b".into()),
            ..cfg()
        };
        c.save(&path).unwrap();
        let back = ServiceConfig::load(&path).unwrap();
        assert_eq!(back, c);
        assert!(back.is_enrolled());
        // No key material, ever.
        let text = std::fs::read_to_string(&path).unwrap();
        for forbidden in ["seed", "privateKey", "secret", "token"] {
            assert!(
                !text.contains(forbidden),
                "{forbidden} must not be in config.json"
            );
        }
    }

    #[test]
    fn a_manifest_names_its_files_and_hashes_itself() {
        let m = InstallManifest {
            v: 1,
            version: "0.3.0".into(),
            arch: "x64".into(),
            placeholder: false,
            files: vec![ManifestFile {
                name: "ia-service.exe".into(),
                size: 10,
                sha256: "ab".repeat(32),
            }],
        };
        assert_eq!(m.file("IA-SERVICE.EXE").map(|f| f.size), Some(10));
        assert!(m.file("ia-desktop.exe").is_none());
        let d = m.digest();
        assert_eq!(d.len(), 64);
        let changed = InstallManifest {
            version: "0.3.1".into(),
            ..m
        };
        assert_ne!(
            changed.digest(),
            d,
            "a changed manifest has a changed digest"
        );
    }

    #[test]
    fn a_file_digest_is_the_sha256_of_its_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.bin");
        std::fs::write(&p, b"hello").unwrap();
        assert_eq!(
            file_digest(&p).unwrap(),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }
}
