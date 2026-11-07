//! The TLS client configuration of every `https://` and `wss://` call the agents make (licence
//! audit F1, `docs/LICENSE-REGISTER.md`): rustls with the **operating system's** certificate
//! verifier and trust store, through `rustls-platform-verifier`, instead of a root list compiled
//! into the binary.
//!
//! * **Windows:** CryptoAPI chain building (`CertGetCertificateChain`) against the machine's and
//!   the account's stores, so a root Windows has not cached yet is fetched by Windows itself, and
//!   an organisation's own TLS-inspection root deployed by Group Policy is trusted.
//! * **macOS:** the Security framework (`SecTrust`), with the keychains' trust settings.
//! * **Linux:** the system store (`/etc/ssl/certs` and friends, or `SSL_CERT_FILE` /
//!   `SSL_CERT_DIR`) read by `rustls-native-certs`, verified by webpki. Building the config fails
//!   when that store is empty, rather than producing a config that can trust nothing.
//!
//! The crypto provider is ring with TLS 1.2 and 1.3, the same rustls features ureq turned on
//! before. Plain `ws://` and `http://` (a dev build against localhost) never reach this module.
//! The config is built once per process and shared.

use std::sync::{Arc, Mutex};

use rustls::ClientConfig;
use rustls_platform_verifier::BuilderVerifierExt;

/// Build a fresh client config from the operating system's verifier. Callers want
/// [`client_config`], which caches it; this is separate so a test can build one directly.
pub fn build_client_config() -> Result<ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| format!("tls: protocol versions: {e}"))?
        .with_platform_verifier()
        .map_err(|e| format!("tls: the system certificate verifier is unavailable: {e}"))?
        .with_no_client_auth();
    Ok(config)
}

/// The shared client config (built on first use; a failure is not cached, so a later call can
/// succeed once the system store is readable).
pub fn client_config() -> Result<Arc<ClientConfig>, String> {
    static CONFIG: Mutex<Option<Arc<ClientConfig>>> = Mutex::new(None);
    let mut slot = CONFIG.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(c) = slot.as_ref() {
        return Ok(c.clone());
    }
    let built = Arc::new(build_client_config()?);
    *slot = Some(built.clone());
    Ok(built)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The config builds from the platform verifier (on Linux this also proves the system store
    /// is non-empty, since `Verifier::new` loads it and fails on an empty store), with ring and
    /// both protocol versions. No network.
    #[test]
    fn config_builds_from_the_platform_verifier() {
        let c = build_client_config().expect("the system verifier and trust store load");
        assert!(c.alpn_protocols.is_empty());
        let suites: Vec<_> = c
            .crypto_provider()
            .cipher_suites
            .iter()
            .map(|s| s.version().version)
            .collect();
        assert!(suites.contains(&rustls::ProtocolVersion::TLSv1_3));
        assert!(suites.contains(&rustls::ProtocolVersion::TLSv1_2));
    }

    /// The shared config is built once and then reused.
    #[test]
    fn client_config_is_shared() {
        let a = client_config().expect("config");
        let b = client_config().expect("config");
        assert!(Arc::ptr_eq(&a, &b));
    }

    /// End to end through the OS verifier: a publicly trusted server verifies, a self-signed and
    /// an expired one do not. Needs the network, so it is ignored by default
    /// (`cargo test -p ia-platform --features tls -- --ignored`).
    #[test]
    #[ignore = "needs the network"]
    fn a_public_https_server_verifies() {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        let config = client_config().expect("config");
        for (host, should_verify) in [
            ("crates.io", true),
            ("self-signed.badssl.com", false),
            ("expired.badssl.com", false),
        ] {
            let name = rustls::pki_types::ServerName::try_from(host.to_string()).expect("name");
            let mut conn = rustls::ClientConnection::new(config.clone(), name).expect("conn");
            let mut sock = TcpStream::connect((host, 443)).expect("tcp");
            let mut tls = rustls::Stream::new(&mut conn, &mut sock);
            let wrote = tls.write_all(
                format!("HEAD / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes(),
            );
            let mut buf = [0u8; 16];
            let verified = wrote.is_ok() && tls.read(&mut buf).is_ok();
            assert_eq!(verified, should_verify, "{host}");
        }
    }
}
