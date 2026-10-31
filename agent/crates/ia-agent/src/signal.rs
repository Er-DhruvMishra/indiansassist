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

impl SignalClient {
    /// Connect to `signal_url` (`ws://` or `wss://`), sending the agent User-Agent and no
    /// `Origin` (the server accepts an Origin-less upgrade as a Desk, §3.1).
    pub async fn connect(signal_url: &str, id: &AgentIdentity) -> Result<Self, String> {
        let mut req = signal_url
            .into_client_request()
            .map_err(|e| format!("bad signal url: {e}"))?;
        let ua = format!(
            "IndiansAssist-Agent/{} (Windows {}; {})",
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
                "os": "windows",
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
