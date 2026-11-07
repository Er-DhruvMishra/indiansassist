//! The one way the installed service builds a ureq agent (licence audit F1): ureq 2's own rustls
//! backend (its `tls` feature) always compiles in the `webpki-roots` root list, so the feature is
//! off and this module plugs the OS-verified rustls config of [`ia_platform::tls`] in through
//! ureq's [`ureq::TlsConnector`] seam. Without it ureq refuses `https://` outright, so a call
//! site that forgot to use [`agent`] fails loudly instead of trusting a bundled list.
//!
//! Plain `http://` (a dev build against localhost, an AMT port without TLS) is unaffected.

use std::fmt;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::ServerName;
use ureq::{ReadWrite, TlsConnector};

/// A ureq agent with the OS-verified TLS config and the given overall timeout. When the system
/// verifier cannot load (Linux with an empty store), `https://` calls through it fail with that
/// reason and `http://` still works.
pub fn agent(timeout: Duration) -> ureq::Agent {
    builder().timeout(timeout).build()
}

/// The builder behind [`agent`], for a caller that sets more than the timeout.
pub fn builder() -> ureq::AgentBuilder {
    ureq::AgentBuilder::new().tls_connector(Arc::new(OsTls))
}

/// The [`TlsConnector`] over [`ia_platform::tls::client_config`].
struct OsTls;

impl TlsConnector for OsTls {
    fn connect(
        &self,
        dns_name: &str,
        mut io: Box<dyn ReadWrite>,
    ) -> Result<Box<dyn ReadWrite>, ureq::Error> {
        let config = ia_platform::tls::client_config().map_err(transport)?;
        // rustls takes an IPv6 literal without the brackets a URL carries.
        let host = dns_name
            .strip_prefix('[')
            .and_then(|h| h.strip_suffix(']'))
            .unwrap_or(dns_name);
        let name = ServerName::try_from(host.to_string())
            .map_err(|e| transport(format!("tls: bad server name {host:?}: {e}")))?;
        let mut conn = rustls::ClientConnection::new(config, name)
            .map_err(|e| transport(format!("tls: {e}")))?;
        conn.complete_io(&mut io)
            .map_err(|e| transport(format!("tls handshake: {e}")))?;
        Ok(Box::new(OsTlsStream(rustls::StreamOwned::new(conn, io))))
    }
}

/// A ureq transport error carrying `msg` (ureq 2 has no public constructor for its error kinds,
/// so the message rides on an `io::Error`, which ureq reports as a transport failure).
fn transport(msg: String) -> ureq::Error {
    ureq::Error::from(io::Error::other(msg))
}

struct OsTlsStream(rustls::StreamOwned<rustls::ClientConnection, Box<dyn ReadWrite>>);

impl ReadWrite for OsTlsStream {
    fn socket(&self) -> Option<&TcpStream> {
        self.0.get_ref().socket()
    }
}

impl Read for OsTlsStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}

impl Write for OsTlsStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

impl fmt::Debug for OsTlsStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("OsTlsStream").finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Plain http still goes straight through the agent (a dev build against localhost): a
    /// one-shot local server answers and the agent reads the body.
    #[test]
    fn plain_http_to_localhost_still_works() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);
            s.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
                .expect("write");
        });
        let body = agent(Duration::from_secs(10))
            .get(&format!("http://127.0.0.1:{port}/"))
            .call()
            .expect("call")
            .into_string()
            .expect("body");
        assert_eq!(body, "ok");
        server.join().expect("server");
    }

    /// An `https://` call reaches the OS-verified connector rather than ureq's "TLS not enabled"
    /// refusal: a local listener that speaks no TLS makes the handshake itself fail.
    #[test]
    fn https_goes_through_the_os_verified_connector() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\n\r\n");
        });
        let err = agent(Duration::from_secs(10))
            .get(&format!("https://localhost:{port}/"))
            .call()
            .expect_err("a non-TLS peer cannot complete a handshake");
        let text = err.to_string();
        assert!(text.contains("tls handshake"), "{text}");
        server.join().expect("server");
    }

    /// A publicly trusted server answers over https through the OS verifier; a self-signed one
    /// is refused. Needs the network, so it is ignored by default.
    #[test]
    #[ignore = "needs the network"]
    fn public_https_verifies_and_self_signed_does_not() {
        let a = agent(Duration::from_secs(20));
        // Any HTTP answer (even a 403 for a bare client) means the TLS handshake verified.
        let tls_ok = |url: &str| !matches!(a.get(url).call(), Err(ureq::Error::Transport(_)));
        assert!(tls_ok("https://crates.io/"));
        assert!(tls_ok("https://github.com/"));
        assert!(!tls_ok("https://self-signed.badssl.com/"));
        assert!(!tls_ok("https://expired.badssl.com/"));
    }
}
