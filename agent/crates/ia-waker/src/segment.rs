//! Rule 8.2a: the `LanSegment` a device reports, computed locally so that **no raw address
//! ever leaves the machine**.
//!
//! ```text
//! subnetHash     = sha256Hex(utf8("ia-seg-v1/" + orgId + "/" + <IPv4 /24 CIDR> + "/" + <gateway MAC>))
//! gatewayMacHash = sha256Hex(utf8("ia-gw-v1/"  + orgId + "/" + <gateway MAC>))
//! ```
//!
//! The gateway MAC is in lower-case colon form. The `orgId` salt is what stops one org's
//! segment hashes from being correlated with another's: two devices in the same building but
//! different orgs look unrelated, while two in the same org and subnet match and can wake each
//! other (rule 8.2b).

use std::net::Ipv4Addr;

use ia_core::fleet::LanSegment;
use sha2::{Digest, Sha256};

/// The `/24` CIDR of an address, as the hash input spells it (`10.1.2.0/24`).
pub fn cidr24(addr: Ipv4Addr) -> String {
    let o = addr.octets();
    format!("{}.{}.{}.0/24", o[0], o[1], o[2])
}

/// Normalises a gateway MAC to the lower-case colon form the hash inputs use. Accepts the
/// colon, dash and bare hex forms Windows reports in.
pub fn gateway_mac_form(mac: &str) -> Option<String> {
    let hexes: String = mac
        .chars()
        .filter(|c| !matches!(c, ':' | '-' | '.' | ' '))
        .collect::<String>()
        .to_lowercase();
    if hexes.len() != 12 || !hexes.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(
        hexes
            .as_bytes()
            .chunks(2)
            .map(|c| String::from_utf8_lossy(c).to_string())
            .collect::<Vec<_>>()
            .join(":"),
    )
}

fn sha256_hex(input: &str) -> String {
    hex::encode(Sha256::digest(input.as_bytes()))
}

/// `subnetHash` (rule 8.2a).
pub fn subnet_hash(org_id: &str, addr: Ipv4Addr, gateway_mac_colon: &str) -> String {
    sha256_hex(&format!(
        "ia-seg-v1/{org_id}/{}/{gateway_mac_colon}",
        cidr24(addr)
    ))
}

/// `gatewayMacHash` (rule 8.2a).
pub fn gateway_mac_hash(org_id: &str, gateway_mac_colon: &str) -> String {
    sha256_hex(&format!("ia-gw-v1/{org_id}/{gateway_mac_colon}"))
}

/// The whole reported object. `dhcp_domain` is reported when the adapter has one (it helps an
/// admin recognise a segment in the fleet view); it is not part of either hash.
pub fn lan_segment(
    org_id: &str,
    addr: Ipv4Addr,
    gateway_mac: &str,
    dhcp_domain: Option<&str>,
) -> Option<LanSegment> {
    let mac = gateway_mac_form(gateway_mac)?;
    Some(LanSegment {
        subnet_hash: subnet_hash(org_id, addr, &mac),
        gateway_mac_hash: gateway_mac_hash(org_id, &mac),
        dhcp_domain: dhcp_domain.map(|d| d.chars().take(255).collect()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG: &str = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
    const GW: &str = "aa:bb:cc:dd:ee:ff";

    // The vector (§15.2 "segment hashing against a vector"): these two digests are the exact
    // SHA-256 of the rule 8.2a strings for org 5e6f..., 10.1.2.7/24 and gateway aa:bb:cc:dd:ee:ff.
    const SUBNET: &str =
        "ia-seg-v1/5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b/10.1.2.0/24/aa:bb:cc:dd:ee:ff";
    const GATEWAY: &str = "ia-gw-v1/5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b/aa:bb:cc:dd:ee:ff";

    #[test]
    fn the_hash_inputs_are_the_contract_strings() {
        let seg = lan_segment(ORG, Ipv4Addr::new(10, 1, 2, 7), GW, None).unwrap();
        assert_eq!(seg.subnet_hash, sha256_hex(SUBNET));
        assert_eq!(seg.gateway_mac_hash, sha256_hex(GATEWAY));
        assert_eq!(seg.subnet_hash.len(), 64);
        assert!(seg
            .subnet_hash
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn two_devices_on_one_subnet_in_one_org_share_a_segment() {
        let a = lan_segment(ORG, Ipv4Addr::new(10, 1, 2, 7), GW, None).unwrap();
        let b = lan_segment(ORG, Ipv4Addr::new(10, 1, 2, 90), "AA-BB-CC-DD-EE-FF", None).unwrap();
        assert_eq!(
            a.subnet_hash, b.subnet_hash,
            "the host part and the MAC spelling do not matter"
        );
    }

    #[test]
    fn another_org_on_the_same_wire_looks_unrelated() {
        let a = lan_segment(ORG, Ipv4Addr::new(10, 1, 2, 7), GW, None).unwrap();
        let other = lan_segment(
            "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
            Ipv4Addr::new(10, 1, 2, 7),
            GW,
            None,
        )
        .unwrap();
        assert_ne!(a.subnet_hash, other.subnet_hash);
        assert_ne!(a.gateway_mac_hash, other.gateway_mac_hash);
    }

    #[test]
    fn a_different_subnet_or_gateway_is_a_different_segment() {
        let a = lan_segment(ORG, Ipv4Addr::new(10, 1, 2, 7), GW, None).unwrap();
        let other_subnet = lan_segment(ORG, Ipv4Addr::new(10, 1, 3, 7), GW, None).unwrap();
        let other_gw =
            lan_segment(ORG, Ipv4Addr::new(10, 1, 2, 7), "aa:bb:cc:dd:ee:00", None).unwrap();
        assert_ne!(a.subnet_hash, other_subnet.subnet_hash);
        assert_ne!(
            a.subnet_hash, other_gw.subnet_hash,
            "the gateway MAC is part of the segment identity"
        );
    }

    #[test]
    fn no_raw_address_appears_anywhere_in_the_reported_object() {
        let seg = lan_segment(ORG, Ipv4Addr::new(10, 1, 2, 7), GW, Some("corp.example")).unwrap();
        let text = serde_json::to_string(&seg).unwrap();
        for raw in ["10.1.2", "aa:bb", "aabb"] {
            assert!(!text.contains(raw), "{raw} must not be in {text}");
        }
        assert!(
            text.contains("corp.example"),
            "the DHCP domain is reported as-is, by design"
        );
    }

    #[test]
    fn a_malformed_gateway_mac_reports_nothing_rather_than_a_wrong_segment() {
        assert!(lan_segment(ORG, Ipv4Addr::new(10, 1, 2, 7), "", None).is_none());
        assert!(lan_segment(ORG, Ipv4Addr::new(10, 1, 2, 7), "aa:bb:cc", None).is_none());
        assert!(lan_segment(ORG, Ipv4Addr::new(10, 1, 2, 7), "zz:bb:cc:dd:ee:ff", None).is_none());
    }

    #[test]
    fn the_cidr_is_the_slash_24_of_the_address() {
        assert_eq!(cidr24(Ipv4Addr::new(192, 168, 1, 200)), "192.168.1.0/24");
    }
}
