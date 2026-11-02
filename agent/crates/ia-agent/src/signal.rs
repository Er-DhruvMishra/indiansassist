//! The `/signal` WebSocket client (contract §3.1), compiled under `media`. A native Desk
//! upgrades with no `Origin` and the `IndiansAssist-Agent/<ver>` User-Agent, sends
//! `desk.hello`, then knocks and polls while waiting (§3.1 "polls until it connects").
//!
//! TLS is rustls + webpki-roots (§11.2); `wss:` is reached without native-tls / schannel.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use ia_core::types::{
    windows_features, AgentCapabilities, ElevationLevel, PlaybookInterpreter, VideoEncoder,
};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// The write half of a split signalling socket (the serve loop sends through this while a
/// spawned reader task forwards inbound frames to an [`mpsc`] receiver).
pub struct SignalWriter {
    sink: futures_util::stream::SplitSink<Ws, Message>,
}

impl SignalWriter {
    /// Send a JSON message.
    pub async fn send(&mut self, v: Value) -> Result<(), String> {
        self.sink
            .send(Message::Text(v.to_string()))
            .await
            .map_err(|e| format!("send: {e}"))
    }
}

/// The agent's build/platform identity, carried in the User-Agent and `desk.hello.client`.
#[derive(Debug, Clone)]
pub struct AgentIdentity {
    pub version: String,
    pub os_version: String,
    pub arch: String,
}

/// A connected signaling socket.
pub struct SignalClient {
    ws: Ws,
}

/// The `desk.hello.client.capabilities` a Windows agent advertises (§3.1 example). `has_voice`
/// is false when cpal found no capture/render device, which drops the `voice` feature (§6.3).
pub fn windows_capabilities(monitors: u8, hw_encoder: bool, has_voice: bool) -> AgentCapabilities {
    AgentCapabilities {
        monitors: monitors.clamp(1, 16),
        elevation: ElevationLevel::User,
        features: windows_features(has_voice),
        encoders: vec![VideoEncoder::Vp8, VideoEncoder::Vp9, VideoEncoder::H264],
        hw_encoder,
        interpreters: vec![PlaybookInterpreter::Powershell, PlaybookInterpreter::Cmd],
    }
}

/// D §4.2: the worker's `desk.hello` body. **No `token`**: the server requires exactly one of
/// `token` and `workerCredential`, and the worker has only the credential, which it spends on
/// this one hello.
pub fn worker_hello(
    credential: &str,
    id: &AgentIdentity,
    caps: &AgentCapabilities,
) -> Result<Value, String> {
    Ok(json!({
        "t": "desk.hello",
        "workerCredential": credential,
        "client": {
            "kind": "native",
            "version": id.version,
            "os": "windows",
            "platform": { "osVersion": id.os_version, "arch": id.arch },
            "tokenSource": "service",
            "capabilities": serde_json::to_value(caps).map_err(|e| e.to_string())?,
        }
    }))
}

/// C §7.2: the elevated child's `desk.hello` body, carrying **both** the token and the one-time
/// hand-over, and reporting `elevation: 'admin'` (self-reported, which is why the server chains
/// it as `claimed`).
pub fn handover_hello(
    token: &str,
    handover: &str,
    desk_label: Option<&str>,
    id: &AgentIdentity,
    token_source: &str,
    caps: &AgentCapabilities,
) -> Result<Value, String> {
    let mut caps = caps.clone();
    caps.elevation = ElevationLevel::Admin;
    let mut hello = json!({
        "t": "desk.hello",
        "token": token,
        "handover": handover,
        "client": {
            "kind": "native",
            "version": id.version,
            "os": "windows",
            "elevation": "admin",
            "platform": { "osVersion": id.os_version, "arch": id.arch },
            "tokenSource": token_source,
            "capabilities": serde_json::to_value(&caps).map_err(|e| e.to_string())?,
        }
    });
    if let Some(label) = desk_label {
        hello["deskLabel"] = json!(label);
    }
    Ok(hello)
}

impl SignalClient {
    /// Connect to `signal_url` (`ws://` or `wss://`), sending the agent User-Agent and no
    /// `Origin` (the server accepts an Origin-less upgrade as a Desk, §3.1).
    pub async fn connect(signal_url: &str, id: &AgentIdentity) -> Result<Self, String> {
        let mut req = signal_url
            .into_client_request()
            .map_err(|e| format!("bad signal url: {e}"))?;
        let os = if cfg!(target_os = "linux") {
            "Linux"
        } else {
            "Windows"
        };
        let ua = format!(
            "IndiansAssist-Agent/{} ({os} {}; {})",
            id.version, id.os_version, id.arch
        );
        req.headers_mut().insert(
            "user-agent",
            HeaderValue::from_str(&ua).map_err(|e| e.to_string())?,
        );
        req.headers_mut().remove("origin");
        let (ws, _resp) = tokio_tungstenite::connect_async(req)
            .await
            .map_err(|e| format!("connect: {e}"))?;
        Ok(Self { ws })
    }

    /// Send a JSON message.
    pub async fn send(&mut self, v: Value) -> Result<(), String> {
        self.ws
            .send(Message::Text(v.to_string()))
            .await
            .map_err(|e| format!("send: {e}"))
    }

    /// Receive the next JSON message, answering `ping` with `pong` transparently. Returns
    /// `None` when the socket closes.
    pub async fn recv(&mut self) -> Option<Value> {
        while let Some(msg) = self.ws.next().await {
            match msg {
                Ok(Message::Text(t)) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&t) {
                        if v.get("t").and_then(|t| t.as_str()) == Some("ping") {
                            let _ = self.send(json!({ "t": "pong" })).await;
                            continue;
                        }
                        return Some(v);
                    }
                }
                Ok(Message::Ping(p)) => {
                    let _ = self.ws.send(Message::Pong(p)).await;
                }
                Ok(Message::Close(_)) | Err(_) => return None,
                _ => {}
            }
        }
        None
    }

    /// Send `desk.hello` for a native Windows Desk (§3.1).
    pub async fn desk_hello(
        &mut self,
        token: &str,
        desk_label: Option<&str>,
        id: &AgentIdentity,
        token_source: &str,
        caps: &AgentCapabilities,
    ) -> Result<(), String> {
        let mut hello = json!({
            "t": "desk.hello",
            "token": token,
            "client": {
                "kind": "native",
                "version": id.version,
                "os": crate::desk::native_os(),
                "platform": { "osVersion": id.os_version, "arch": id.arch },
                "tokenSource": token_source,
                "capabilities": serde_json::to_value(caps).map_err(|e| e.to_string())?,
            }
        });
        if let Some(label) = desk_label {
            hello["deskLabel"] = json!(label);
        }
        self.send(hello).await
    }

    /// §7.2 / §7.3 step 4: the elevated child's `desk.hello`. It carries **both** the token
    /// and the one-time `handover`, and reports `elevation: 'admin'` (self-reported, hence the
    /// server chains it as `claimed`). The server's hand-over relaxation accepts a `used` token
    /// for exactly this hello, and the previous Desk socket is closed `4411`.
    pub async fn desk_hello_handover(
        &mut self,
        token: &str,
        handover: &str,
        desk_label: Option<&str>,
        id: &AgentIdentity,
        token_source: &str,
        caps: &AgentCapabilities,
    ) -> Result<(), String> {
        self.send(handover_hello(
            token,
            handover,
            desk_label,
            id,
            token_source,
            caps,
        )?)
        .await
    }

    /// §4.2: the Phase D worker's `desk.hello`. It carries a **worker credential** instead of
    /// a token (`tokenSource: 'service'`), which is what keeps the credential single-use and
    /// bound to one session: there is no token on the device for a worker to leak, and the
    /// credential is spent the moment the server accepts this hello.
    ///
    /// `caps` is what this worker actually has; the server requires it to be a subset of the
    /// device row's advertised features (else `capability_mismatch` + close `4403`).
    pub async fn desk_hello_worker(
        &mut self,
        credential: &str,
        id: &AgentIdentity,
        caps: &AgentCapabilities,
    ) -> Result<(), String> {
        self.send(worker_hello(credential, id, caps)?).await
    }

    /// Knock, then the caller polls on a 3 s cadence (§3.1).
    pub async fn knock(&mut self, desk_label: Option<&str>) -> Result<(), String> {
        let mut m = json!({ "t": "desk.knock" });
        if let Some(l) = desk_label {
            m["deskLabel"] = json!(l);
        }
        self.send(m).await
    }

    /// `desk.poll`.
    pub async fn poll(&mut self) -> Result<(), String> {
        self.send(json!({ "t": "desk.poll" })).await
    }

    /// Split into a write half and a spawned reader that forwards inbound JSON frames. Used
    /// by the serve loop so sends and receives no longer both borrow one `&mut SignalClient`
    /// (which `tokio::select!` cannot allow). App-level `ping` is forwarded for the loop to
    /// `pong`; protocol-level frames are handled or dropped here.
    pub fn split(self) -> (SignalWriter, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        let (sink, mut stream) = self.ws.split();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        tokio::spawn(async move {
            while let Some(msg) = stream.next().await {
                match msg {
                    Ok(Message::Text(t)) => {
                        if let Ok(v) = serde_json::from_str::<Value>(&t) {
                            if tx.send(v).is_err() {
                                break;
                            }
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
        });
        (SignalWriter { sink }, rx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> AgentIdentity {
        AgentIdentity {
            version: "0.3.0".into(),
            os_version: "10.0.26100".into(),
            arch: "x64".into(),
        }
    }

    #[test]
    fn the_worker_hello_carries_the_credential_and_no_token() {
        let caps = windows_capabilities(2, false, true);
        let hello = worker_hello("A".repeat(43).as_str(), &id(), &caps).unwrap();
        assert_eq!(hello["t"], "desk.hello");
        assert_eq!(hello["workerCredential"], "A".repeat(43));
        assert!(hello.get("token").is_none(), "a worker has no token (§4.2)");
        assert!(hello.get("handover").is_none());
        assert_eq!(hello["client"]["kind"], "native");
        assert_eq!(hello["client"]["os"], "windows");
        assert_eq!(
            hello["client"]["tokenSource"], "service",
            "TOKEN_SOURCES gained `service` (§16.2)"
        );
        assert_eq!(hello["client"]["platform"]["arch"], "x64");
        // The capabilities the server checks against the device row's `features` (§4.2 subset rule).
        assert!(hello["client"]["capabilities"]["features"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f == "screen"));
    }

    #[test]
    fn the_handover_hello_carries_both_credentials_and_claims_admin() {
        let caps = windows_capabilities(1, false, false);
        let hello = handover_hello(
            "ia1.token",
            "h".repeat(43).as_str(),
            Some("DESK-01"),
            &id(),
            "filename",
            &caps,
        )
        .unwrap();
        assert_eq!(hello["token"], "ia1.token");
        assert_eq!(hello["handover"], "h".repeat(43));
        assert_eq!(hello["deskLabel"], "DESK-01");
        assert_eq!(hello["client"]["elevation"], "admin");
        assert_eq!(hello["client"]["capabilities"]["elevation"], "admin");
        assert_eq!(
            hello["client"]["tokenSource"], "filename",
            "the child reports the parent's source"
        );
        assert!(
            hello.get("workerCredential").is_none(),
            "a hand-over is not a worker credential"
        );
    }

    #[test]
    fn a_hello_without_a_desk_label_omits_it_rather_than_sending_null() {
        let caps = windows_capabilities(1, false, false);
        let hello = handover_hello("ia1.token", "h", None, &id(), "arg", &caps).unwrap();
        assert!(hello.get("deskLabel").is_none());
    }
}
