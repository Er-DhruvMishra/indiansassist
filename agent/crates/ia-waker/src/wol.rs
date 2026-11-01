//! Wake on LAN (rule 8.2b): the magic packet, where it is sent, and how the target's MAC
//! arrives.
//!
//! The MAC is the sensitive part. It arrives sealed to this device's X25519 key (purpose
//! `wake-mac`), is opened into a [`Zeroizing`] buffer, used to build one packet, and wiped.
//! A waker learns exactly the one MAC it was asked to wake and keeps nothing: there is no
//! org-wide key or address list on any device (rule 8.2c).

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use ia_core::seal::{open_sealed_text, SealPurpose, Sealed};
use zeroize::Zeroizing;

/// The magic packet is 6 × `0xFF` then the 6-byte MAC repeated 16 times.
pub const MAGIC_PACKET_LEN: usize = 6 + 16 * 6;
/// The port the packet is sent to (rule 8.2b: UDP 9).
pub const WOL_PORT: u16 = 9;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WolError {
    #[error("a wake MAC is 12 lower-case hex characters")]
    BadMac,
    #[error("the sealed MAC did not open for this device")]
    Sealed,
}

/// Parses the `wakeMac` wire form: 12 lower-case hex characters, no separators (the shape
/// `WAKE_MAC_RE` enforces on the server).
pub fn parse_mac(mac: &str) -> Result<[u8; 6], WolError> {
    if mac.len() != 12
        || !mac
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(WolError::BadMac);
    }
    let bytes = hex::decode(mac).map_err(|_| WolError::BadMac)?;
    bytes.try_into().map_err(|_| WolError::BadMac)
}

/// The 102-byte magic packet for `mac`.
pub fn magic_packet(mac: &[u8; 6]) -> [u8; MAGIC_PACKET_LEN] {
    let mut p = [0xFFu8; MAGIC_PACKET_LEN];
    for i in 0..16 {
        p[6 + i * 6..6 + i * 6 + 6].copy_from_slice(mac);
    }
    p
}

/// Opens a `wake.send` target MAC and builds the packet, wiping the MAC text on the way out.
pub fn packet_from_sealed(
    kex_secret: &[u8; 32],
    device_id: &str,
    sealed: &Sealed,
) -> Result<[u8; MAGIC_PACKET_LEN], WolError> {
    let text: Zeroizing<String> =
        open_sealed_text(kex_secret, device_id, SealPurpose::WakeMac, sealed)
            .map_err(|_| WolError::Sealed)?;
    let mac = parse_mac(text.trim())?;
    let packet = magic_packet(&mac);
    // `mac` is a copy of the address; the packet is the only thing that leaves.
    drop(text);
    Ok(packet)
}

/// The IPv4 directed-broadcast address of `addr` under `prefix_len` (`/24` → `x.y.z.255`).
pub fn broadcast_of(addr: Ipv4Addr, prefix_len: u8) -> Ipv4Addr {
    let bits = u32::from(addr);
    let host_bits = 32u32.saturating_sub(prefix_len.min(32) as u32);
    let mask = if host_bits >= 32 {
        u32::MAX
    } else {
        (1u32 << host_bits) - 1
    };
    Ipv4Addr::from(bits | mask)
}

/// Where one wake is sent (rule 8.2b): the subnet broadcast address of each usable interface
/// **and** the limited broadcast `255.255.255.255`. Both, because a switch or host firewall may
/// drop one and not the other, and a wake that silently reaches nothing is the failure mode
/// this list exists to avoid.
pub fn wol_targets(interfaces: &[(Ipv4Addr, u8)]) -> Vec<SocketAddr> {
    let mut out: Vec<SocketAddr> = Vec::new();
    for (addr, prefix) in interfaces {
        if addr.is_loopback() || addr.is_unspecified() {
            continue;
        }
        let b = broadcast_of(*addr, *prefix);
        let sa = SocketAddr::new(IpAddr::V4(b), WOL_PORT);
        if !out.contains(&sa) {
            out.push(sa);
        }
    }
    let limited = SocketAddr::new(IpAddr::V4(Ipv4Addr::BROADCAST), WOL_PORT);
    if !out.contains(&limited) {
        out.push(limited);
    }
    out
}

/// Sends one packet to every target. Returns the number of targets that accepted it; a wake is
/// reported `ok: true` when at least one did (rule 8.2b `wake.sent`).
#[cfg(feature = "net")]
pub fn broadcast(packet: &[u8], targets: &[SocketAddr]) -> std::io::Result<usize> {
    use std::net::UdpSocket;
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))?;
    socket.set_broadcast(true)?;
    let mut sent = 0usize;
    for t in targets {
        if socket.send_to(packet, t).is_ok() {
            sent += 1;
        }
    }
    Ok(sent)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The vector (§15.2 "the magic-packet builder (bytes against a vector)"): the packet for
    // 0a:1b:2c:3d:4e:5f, which is the MAC the shared seal fixture carries.
    const MAC: &str = "0a1b2c3d4e5f";
    const EXPECTED: &str = concat!(
        "ffffffffffff",
        "0a1b2c3d4e5f0a1b2c3d4e5f0a1b2c3d4e5f0a1b2c3d4e5f",
        "0a1b2c3d4e5f0a1b2c3d4e5f0a1b2c3d4e5f0a1b2c3d4e5f",
        "0a1b2c3d4e5f0a1b2c3d4e5f0a1b2c3d4e5f0a1b2c3d4e5f",
        "0a1b2c3d4e5f0a1b2c3d4e5f0a1b2c3d4e5f0a1b2c3d4e5f",
    );

    #[test]
    fn the_packet_matches_the_vector_byte_for_byte() {
        let p = magic_packet(&parse_mac(MAC).unwrap());
        assert_eq!(p.len(), 102);
        assert_eq!(hex::encode(p), EXPECTED);
    }

    #[test]
    fn a_malformed_mac_is_refused() {
        for bad in [
            "",
            "0A1B2C3D4E5F",
            "0a1b2c3d4e",
            "0a1b2c3d4e5f0",
            "0a:1b:2c:3d:4e:5f",
            "zz1b2c3d4e5f",
        ] {
            assert_eq!(parse_mac(bad), Err(WolError::BadMac), "{bad} must not pass");
        }
    }

    #[test]
    fn a_sealed_mac_opens_into_a_packet_and_a_wrong_device_does_not() {
        let kex = [0x33u8; 32];
        let device = "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a";
        let sealed = ia_core::seal::seal_to_device(
            &ia_core::seal::kex_public_key_of(&kex),
            device,
            SealPurpose::WakeMac,
            MAC.as_bytes(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            hex::encode(packet_from_sealed(&kex, device, &sealed).unwrap()),
            EXPECTED
        );
        assert_eq!(
            packet_from_sealed(&kex, "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b", &sealed),
            Err(WolError::Sealed)
        );
        assert_eq!(
            packet_from_sealed(&[0x44; 32], device, &sealed),
            Err(WolError::Sealed)
        );
    }

    #[test]
    fn a_sealed_value_that_is_not_a_mac_is_refused_as_a_mac_not_as_a_seal_failure() {
        let kex = [0x33u8; 32];
        let device = "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a";
        let sealed = ia_core::seal::seal_to_device(
            &ia_core::seal::kex_public_key_of(&kex),
            device,
            SealPurpose::WakeMac,
            b"not-a-mac",
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            packet_from_sealed(&kex, device, &sealed),
            Err(WolError::BadMac)
        );
    }

    #[test]
    fn the_broadcast_address_follows_the_prefix() {
        assert_eq!(
            broadcast_of(Ipv4Addr::new(10, 1, 2, 7), 24),
            Ipv4Addr::new(10, 1, 2, 255)
        );
        assert_eq!(
            broadcast_of(Ipv4Addr::new(10, 1, 2, 7), 16),
            Ipv4Addr::new(10, 1, 255, 255)
        );
        assert_eq!(
            broadcast_of(Ipv4Addr::new(192, 168, 5, 3), 30),
            Ipv4Addr::new(192, 168, 5, 3)
        );
        assert_eq!(
            broadcast_of(Ipv4Addr::new(10, 0, 0, 1), 32),
            Ipv4Addr::new(10, 0, 0, 1)
        );
    }

    #[test]
    fn every_wake_goes_to_the_subnet_and_the_limited_broadcast_and_never_to_loopback() {
        let targets = wol_targets(&[
            (Ipv4Addr::new(10, 1, 2, 7), 24),
            (Ipv4Addr::new(127, 0, 0, 1), 8),
            (Ipv4Addr::new(10, 1, 2, 9), 24),
        ]);
        assert_eq!(
            targets,
            vec![
                SocketAddr::new(IpAddr::V4(Ipv4Addr::new(10, 1, 2, 255)), 9),
                SocketAddr::new(IpAddr::V4(Ipv4Addr::BROADCAST), 9),
            ],
            "one entry per distinct subnet, plus 255.255.255.255, port 9"
        );
        assert_eq!(
            wol_targets(&[]).len(),
            1,
            "with no interface the limited broadcast is still tried"
        );
    }
}
