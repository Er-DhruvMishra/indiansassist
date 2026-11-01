//! The machine's current network and session facts, read fresh each time they are reported.
//!
//! Rule 8.2a is the reason this is its own module: the service must turn the raw address and
//! gateway MAC into **hashes** before anything leaves, and it must do it the same way every
//! time. Nothing here keeps a raw address beyond the call that computes the hash.

use std::net::Ipv4Addr;

use ia_core::fleet::LanSegment;
use ia_session0::desktop::SessionFacts;

/// The §5.3 facts. On a build without the Win32 layer this is the "nobody logged on" shape,
/// which is the safe reading (no session is opened onto a desktop we cannot see).
#[cfg(feature = "service")]
pub fn read_facts() -> SessionFacts {
    ia_session0::win::read_facts()
}

#[cfg(not(feature = "service"))]
pub fn read_facts() -> SessionFacts {
    SessionFacts {
        console_session_id: None,
        logged_on: false,
        locked: false,
        connected: false,
        secure_desktop_input: true,
        idle_sec: None,
        at: crate::runtime_now_ms(),
    }
}

/// A segment hash the server can group by even when the gateway MAC cannot be read.
///
/// The honest case: `GetIpNetTable2` usually has the default gateway, because the machine has
/// just talked to it. When it does not, two devices on the same wire would otherwise compute
/// different segments and fail to wake each other. Using a fixed marker in place of the MAC
/// keeps them matching each other (and separate from devices that *did* read it) rather than
/// splitting every such device into a segment of one.
const UNKNOWN_GATEWAY: &str = "00:00:00:00:00:00";

/// The reported `LanSegment` and this device's own wake MAC (rule 8.2a, 8.2c).
#[cfg(feature = "service")]
pub fn segment_and_mac(org_id: &str) -> (LanSegment, Option<String>) {
    let interfaces = crate::win::netfacts::interfaces();
    let primary = interfaces
        .iter()
        .find(|i| i.gateway.is_some())
        .or_else(|| interfaces.first());
    let Some(iface) = primary else {
        return (empty_segment(org_id), None);
    };
    let gateway_mac = iface
        .gateway
        .and_then(crate::win::netfacts::gateway_mac)
        .unwrap_or_else(|| {
            tracing::debug!("the default gateway's MAC could not be read; the segment hash uses the unknown marker");
            UNKNOWN_GATEWAY.to_string()
        });
    let segment = ia_waker::segment::lan_segment(
        org_id,
        iface.addr,
        &gateway_mac,
        iface.dns_suffix.as_deref(),
    )
    .unwrap_or_else(|| empty_segment(org_id));
    (segment, iface.mac.clone())
}

#[cfg(not(feature = "service"))]
pub fn segment_and_mac(org_id: &str) -> (LanSegment, Option<String>) {
    (empty_segment(org_id), None)
}

/// The segment of a machine whose network could not be read: still salted by the org, so it
/// matches nothing from another org, and stable, so the row does not churn.
fn empty_segment(org_id: &str) -> LanSegment {
    ia_waker::segment::lan_segment(org_id, Ipv4Addr::new(0, 0, 0, 0), UNKNOWN_GATEWAY, None)
        .expect("the marker gateway is a valid MAC")
}

/// The interfaces a wake is broadcast on (rule 8.2b).
#[cfg(feature = "service")]
pub fn wake_interfaces() -> Vec<(Ipv4Addr, u8)> {
    crate::win::netfacts::interfaces()
        .into_iter()
        .map(|i| (i.addr, i.prefix_len))
        .collect()
}

#[cfg(not(feature = "service"))]
pub fn wake_interfaces() -> Vec<(Ipv4Addr, u8)> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unreadable_network_still_reports_a_stable_org_salted_segment() {
        let a = empty_segment("5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b");
        let b = empty_segment("5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b");
        let other = empty_segment("9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d");
        assert_eq!(
            a.subnet_hash, b.subnet_hash,
            "stable, so the device row does not churn"
        );
        assert_ne!(a.subnet_hash, other.subnet_hash, "still salted by the org");
        assert_eq!(a.subnet_hash.len(), 64);
        assert!(a.dhcp_domain.is_none());
    }
}
