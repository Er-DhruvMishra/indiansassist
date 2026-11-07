//! The transports behind the `net` feature: UDP broadcast for a wake, and a digest-authenticated
//! HTTPS client for AMT. No automated test reaches either (§15.2); the manual checks in
//! `docs/release.md` cover them.

use std::net::Ipv4Addr;
use std::time::Duration;

use ia_core::fleet::{AmtInventory, LanSegment};
use ia_platform::{Amt, AmtError, AmtOutcome, AmtProxyOp, AmtRequest, Waker, WakerError};

use crate::amt as wsman;

/// The real [`Waker`]: one UDP socket, one packet, nothing kept.
pub struct LocalWaker {
    /// The org this device enrolled into (the rule 8.2a salt).
    pub org_id: String,
    /// `(address, prefix length)` of every usable IPv4 interface, and the gateway MAC. The
    /// service fills these in from the OS and refreshes them on each heartbeat; keeping them
    /// here rather than re-reading per call keeps the wake path short.
    pub interfaces: Vec<(Ipv4Addr, u8)>,
    pub gateway_mac: Option<String>,
    pub own_mac: Option<String>,
}

impl Waker for LocalWaker {
    fn send_magic_packet(&self, packet: &[u8]) -> Result<(), WakerError> {
        let targets = crate::wol::wol_targets(&self.interfaces);
        let sent =
            crate::wol::broadcast(packet, &targets).map_err(|e| WakerError::Send(e.to_string()))?;
        if sent == 0 {
            return Err(WakerError::Send(
                "no broadcast address accepted the packet".into(),
            ));
        }
        Ok(())
    }

    fn lan_segment(&self, org_id: &str) -> Result<LanSegment, WakerError> {
        let addr = self
            .interfaces
            .iter()
            .map(|(a, _)| *a)
            .find(|a| !a.is_loopback() && !a.is_unspecified())
            .ok_or(WakerError::NoInterface)?;
        let gw = self.gateway_mac.as_deref().ok_or(WakerError::NoInterface)?;
        crate::segment::lan_segment(org_id, addr, gw, None).ok_or(WakerError::NoInterface)
    }

    fn own_wake_mac(&self) -> Option<String> {
        self.own_mac.clone()
    }
}

/// The real [`Amt`]: a WS-Management client over the firmware's own port.
pub struct AmtClient {
    /// What this machine sees of its own AMT (reported at enrollment and on each heartbeat).
    pub inventory: AmtInventory,
    pub timeout: Duration,
}

impl Default for AmtClient {
    fn default() -> Self {
        Self {
            inventory: AmtInventory {
                present: false,
                provisioned: false,
                version: None,
                host: None,
                tls: false,
                power_state: None,
            },
            timeout: Duration::from_secs(20),
        }
    }
}

impl AmtClient {
    /// POST one WS-Man envelope, answering the firmware's digest challenge. Returns the
    /// response body.
    fn post(&self, req: &AmtRequest<'_>, body: &str, message_id: &str) -> Result<String, AmtError> {
        let url = wsman::wsman_url(req.host, req.tls);
        let agent = crate::https::agent(self.timeout);
        // First attempt: no credentials, to collect the challenge (what every digest client does).
        let challenge = match agent
            .post(&url)
            .set("Content-Type", "application/soap+xml;charset=UTF-8")
            .send_string(body)
        {
            Ok(r) => return Ok(r.into_string().unwrap_or_default()),
            Err(ureq::Error::Status(401, r)) => r
                .header("WWW-Authenticate")
                .and_then(wsman::parse_challenge)
                .ok_or(AmtError::AuthFailed)?,
            Err(ureq::Error::Status(405 | 501, _)) => return Err(AmtError::Unsupported),
            Err(ureq::Error::Status(_, r)) => {
                return Err(AmtError::Unreachable(format!("HTTP {}", r.status())))
            }
            Err(ureq::Error::Transport(t)) => {
                let text = t.to_string();
                return Err(if req.tls && text.to_lowercase().contains("tls") {
                    AmtError::TlsFailed(text)
                } else {
                    AmtError::Unreachable(text)
                });
            }
        };
        let cnonce = ia_core::rnd::hex(8);
        let auth = wsman::digest_authorization(
            &challenge,
            "POST",
            wsman::WSMAN_PATH,
            req.user,
            &req.password,
            1,
            &cnonce,
        );
        match agent
            .post(&url)
            .set("Content-Type", "application/soap+xml;charset=UTF-8")
            .set("Authorization", &auth)
            .send_string(body)
        {
            Ok(r) => Ok(r.into_string().unwrap_or_default()),
            Err(ureq::Error::Status(401, _)) => Err(AmtError::AuthFailed),
            Err(ureq::Error::Status(405 | 501, _)) => Err(AmtError::Unsupported),
            Err(ureq::Error::Status(s, _)) => Err(AmtError::Unreachable(format!("HTTP {s}"))),
            Err(ureq::Error::Transport(t)) => Err(AmtError::Unreachable(t.to_string())),
        }
        .inspect(|_| tracing::debug!(message_id, "amt wsman answered"))
    }
}

impl Amt for AmtClient {
    fn inventory(&self) -> AmtInventory {
        self.inventory.clone()
    }

    fn command(&self, req: &AmtRequest<'_>) -> Result<AmtOutcome, AmtError> {
        // SOL byte forwarding is not built (see the `amt` module note): enabling the
        // redirection service would leave a console pane with nothing in it, so the proxy says
        // `unsupported` and the console stays honest.
        if matches!(req.op, AmtProxyOp::SolOpen) {
            return Ok(AmtOutcome {
                ok: false,
                error: Some("unsupported".into()),
                power_state: None,
            });
        }
        let (op, target) = match req.op {
            AmtProxyOp::PowerOn => (ia_core::fleet::AmtOp::PowerOn, None),
            AmtProxyOp::BootRedirect { target } => {
                (ia_core::fleet::AmtOp::BootRedirect, Some(target))
            }
            AmtProxyOp::SolOpen => (ia_core::fleet::AmtOp::SolOpen, None),
            AmtProxyOp::SolClose => (ia_core::fleet::AmtOp::SolClose, None),
        };
        let steps = wsman::plan(op, target);
        let message_id = ia_core::rnd::hex(16);
        for (i, step) in steps.iter().enumerate() {
            let selector = selector_for(step);
            let xml = wsman::envelope(step, &message_id, selector);
            let answer = self.post(req, &xml, &message_id)?;
            match wsman::return_value(&answer) {
                Some(0) | None => {}
                Some(code) => {
                    tracing::warn!(step = i, code, "amt refused a step");
                    return Ok(AmtOutcome {
                        ok: false,
                        error: Some("unsupported".into()),
                        power_state: None,
                    });
                }
            }
        }
        // Report the firmware's own view of the power state, when it will give one.
        let get = wsman::get_power_state();
        let power_state = self
            .post(req, &wsman::envelope(&get, &message_id, None), &message_id)
            .ok()
            .and_then(|x| wsman::power_state_of(&x));
        Ok(AmtOutcome {
            ok: true,
            error: None,
            power_state,
        })
    }
}

/// The `SelectorSet` a request needs, if any (the power service is selected by name).
fn selector_for(step: &wsman::WsmanRequest) -> Option<(&'static str, &'static str)> {
    if step.resource_uri.ends_with("CIM_PowerManagementService") {
        Some(("Name", "Intel(r) AMT Power Management Service"))
    } else if step.resource_uri.ends_with("CIM_BootService") {
        Some(("Name", "Intel(r) AMT Boot Service"))
    } else if step.resource_uri.ends_with("CIM_BootConfigSetting") {
        Some(("InstanceID", "Intel(r) AMT: Boot Configuration 0"))
    } else {
        None
    }
}
