//! The `ia.sec` handshake: commit/hello/confirm/fail messages, the commit hash, the
//! X25519 key agreement, HKDF-SHA256 key derivation, the SAS, and the confirmation MAC
//! (contract §1.3 steps 1-6). Frame sealing/opening lives in [`crate::secchan`].

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroize;

use crate::canonical::canonical_json;
use crate::types::SecFailReason;
use crate::{CoreError, CoreResult};

/// `SEC_SUITE` (contract §1.3 step 2b).
pub const SEC_SUITE: &str = "x25519-xchacha20poly1305-hkdfsha256";

type HmacSha256 = Hmac<Sha256>;

/// `side` in the handshake.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Desk,
    Assist,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Desk => "desk",
            Side::Assist => "assist",
        }
    }
    pub fn peer(self) -> Side {
        match self {
            Side::Desk => Side::Assist,
            Side::Assist => Side::Desk,
        }
    }
}

/// `sec.commit` (contract §1.3 step 2a).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecCommit {
    pub t: String, // "sec.commit"
    pub v: u8,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub side: Side,
    pub h: String,
    pub gen: u16,
    pub ts: i64,
}

/// `sec.hello` (contract §1.3 step 2b).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecHello {
    pub t: String, // "sec.hello"
    pub v: u8,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub side: Side,
    pub suite: String,
    pub epk: String,
    pub fpr: String,
    pub ts: i64,
}

/// `sec.confirm` (contract §1.3 step 6).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecConfirm {
    pub t: String, // "sec.confirm"
    pub mac: String,
    pub ts: i64,
}

/// `sec.fail` (contract §1.3 row 9).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecFail {
    pub t: String, // "sec.fail"
    pub reason: SecFailReason,
    pub ts: i64,
}

/// An ephemeral X25519 key pair for one handshake (one key generation).
pub struct EphemeralKey {
    secret: StaticSecret,
    pub public: PublicKey,
}

impl EphemeralKey {
    /// Generate a fresh key pair (contract §1.3 step 1).
    pub fn generate() -> Self {
        let secret = StaticSecret::random_from_rng(OsRng);
        let public = PublicKey::from(&secret);
        Self { secret, public }
    }

    /// A key pair from a raw 32-byte private key (cross-language test vectors).
    pub fn from_secret_bytes(esk: [u8; 32]) -> Self {
        let secret = StaticSecret::from(esk);
        let public = PublicKey::from(&secret);
        Self { secret, public }
    }

    /// base64url(32-byte public key) — the `epk` field.
    pub fn epk_b64(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.public.as_bytes())
    }

    /// `ss = X25519(esk, peer.epk)` with the all-zero-output check (contract §1.3 step 4).
    pub fn diffie_hellman(&self, peer_epk_b64: &str) -> CoreResult<[u8; 32]> {
        let bytes = URL_SAFE_NO_PAD
            .decode(peer_epk_b64)
            .map_err(|_| CoreError::Crypto("peer epk not base64url".into()))?;
        let arr: [u8; 32] = bytes
            .try_into()
            .map_err(|_| CoreError::Crypto("peer epk not 32 bytes".into()))?;
        let peer = PublicKey::from(arr);
        let ss = self.secret.diffie_hellman(&peer);
        // All-zero shared secret => a low-order point was sent (contract: reason `key`).
        if ss.as_bytes().ct_eq(&[0u8; 32]).into() {
            return Err(CoreError::Crypto("all-zero shared secret".into()));
        }
        Ok(*ss.as_bytes())
    }
}

/// `sha256(utf8(canonicalJson({ side, suite, epk, fpr })))` base64url (contract §1.3 step 2a).
pub fn commit_hash(side: Side, suite: &str, epk_b64: &str, fpr: &str) -> String {
    let v = json!({ "side": side.as_str(), "suite": suite, "epk": epk_b64, "fpr": fpr });
    let digest = Sha256::digest(canonical_json(&v).as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

/// Verify a peer's revealed hello against its earlier commit, constant time
/// (contract §1.3 step 3a). `Err(Commit)` on mismatch.
pub fn verify_commit(
    peer_side: Side,
    suite: &str,
    peer_epk_b64: &str,
    peer_fpr: &str,
    committed_h: &str,
) -> Result<(), SecFailReason> {
    let recomputed = commit_hash(peer_side, suite, peer_epk_b64, peer_fpr);
    if recomputed.as_bytes().ct_eq(committed_h.as_bytes()).into() {
        Ok(())
    } else {
        Err(SecFailReason::Commit)
    }
}

/// Steps 2b then 3a for a received hello: an unknown suite is `Suite` (checked on receipt),
/// then the revealed `{ side, suite, epk, fpr }` must hash to the sender's commit (`Commit`).
/// Same order as the shared `verifyHelloAgainstCommit`.
pub fn verify_hello(hello: &SecHello, committed_h: &str) -> Result<(), SecFailReason> {
    if hello.suite != SEC_SUITE {
        return Err(SecFailReason::Suite);
    }
    verify_commit(
        hello.side,
        &hello.suite,
        &hello.epk,
        &hello.fpr,
        committed_h,
    )
}

/// One peer's transcript contribution: `{ h, epk, fpr }` as the base64url/hex strings sent.
#[derive(Debug, Clone)]
pub struct SideInfo {
    pub h: String,
    pub epk: String,
    pub fpr: String,
}

/// Derived session keys and the SAS (contract §1.3 steps 4-6). Material is zeroised on drop.
pub struct SessionKeys {
    pub k_d2a: [u8; 32],
    pub k_a2d: [u8; 32],
    k_conf: [u8; 32],
    /// The 6-digit security code, zero-padded.
    pub sas: String,
}

impl Drop for SessionKeys {
    fn drop(&mut self) {
        self.k_d2a.zeroize();
        self.k_a2d.zeroize();
        self.k_conf.zeroize();
    }
}

impl SessionKeys {
    /// Derive from the transcript and shared secret (contract §1.3 steps 4-5).
    /// `ss` is zeroised by the caller after this returns.
    pub fn derive(
        session_id: &str,
        suite: &str,
        gen: u16,
        desk: &SideInfo,
        assist: &SideInfo,
        ss: &[u8; 32],
    ) -> Self {
        let transcript = json!({
            "v": 1,
            "sessionId": session_id,
            "suite": suite,
            "gen": gen,
            "desk": { "h": desk.h, "epk": desk.epk, "fpr": desk.fpr },
            "assist": { "h": assist.h, "epk": assist.epk, "fpr": assist.fpr },
        });
        let t = Sha256::digest(canonical_json(&transcript).as_bytes());

        let hk = Hkdf::<Sha256>::new(Some(&t), ss);
        let mut k_d2a = [0u8; 32];
        let mut k_a2d = [0u8; 32];
        let mut k_conf = [0u8; 32];
        let mut sas_bytes = [0u8; 4];
        hk.expand(b"ia-sec-v1 desk->assist", &mut k_d2a)
            .expect("32 <= 255*32");
        hk.expand(b"ia-sec-v1 assist->desk", &mut k_a2d)
            .expect("32 <= 255*32");
        hk.expand(b"ia-sec-v1 confirm", &mut k_conf)
            .expect("32 <= 255*32");
        hk.expand(b"ia-sec-v1 sas", &mut sas_bytes)
            .expect("4 <= 255*32");

        let sas_num = u32::from_be_bytes(sas_bytes) % 1_000_000;
        let sas = format!("{sas_num:06}");

        Self {
            k_d2a,
            k_a2d,
            k_conf,
            sas,
        }
    }

    /// `HMAC-SHA256(kConf, utf8(side) || T)` — but we keep `T` out of the public API by
    /// computing the confirm MAC with the stored transcript hash. Callers pass the
    /// transcript hash they computed in [`Self::derive`] via [`transcript_hash`].
    pub fn confirm_mac(&self, side: Side, transcript_hash: &[u8; 32]) -> String {
        let mut mac = HmacSha256::new_from_slice(&self.k_conf).expect("hmac key");
        mac.update(side.as_str().as_bytes());
        mac.update(transcript_hash);
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    }

    /// Verify the peer's confirm MAC constant time (contract §1.3 step 6).
    pub fn verify_confirm(
        &self,
        peer_side: Side,
        transcript_hash: &[u8; 32],
        peer_mac_b64: &str,
    ) -> Result<(), SecFailReason> {
        let expected = self.confirm_mac(peer_side, transcript_hash);
        if expected.as_bytes().ct_eq(peer_mac_b64.as_bytes()).into() {
            Ok(())
        } else {
            Err(SecFailReason::Mac)
        }
    }

    /// The SAS formatted for display as `483 920` (contract §1.3 step 7).
    pub fn sas_display(&self) -> String {
        format!("{} {}", &self.sas[..3], &self.sas[3..])
    }
}

/// `T = sha256(utf8(canonicalJson({ v, sessionId, suite, gen, desk, assist })))`
/// (contract §1.3 step 4). Returned so the caller can compute confirm MACs.
pub fn transcript_hash(
    session_id: &str,
    suite: &str,
    gen: u16,
    desk: &SideInfo,
    assist: &SideInfo,
) -> [u8; 32] {
    let transcript = json!({
        "v": 1,
        "sessionId": session_id,
        "suite": suite,
        "gen": gen,
        "desk": { "h": desk.h, "epk": desk.epk, "fpr": desk.fpr },
        "assist": { "h": assist.h, "epk": assist.epk, "fpr": assist.fpr },
    });
    Sha256::digest(canonical_json(&transcript).as_bytes()).into()
}

/// `fingerprintFromSdp(sdp)`: the first `a=fingerprint:sha-256` line normalised to 64
/// lower-case hex chars without colons (contract §1.3 step 1).
pub fn fingerprint_from_sdp(sdp: &str) -> Option<String> {
    for line in sdp.lines() {
        let line = line.trim();
        // Only `a=fingerprint:sha-256 <hex>` lines (case-insensitive algorithm); every other
        // line, including a sha-1 fingerprint, is skipped rather than ending the search.
        let Some(rest) = line
            .get(..22)
            .filter(|p| p.eq_ignore_ascii_case("a=fingerprint:sha-256 "))
            .map(|_| line[22..].trim())
        else {
            continue;
        };
        let hex: String = rest
            .chars()
            .filter(|c| *c != ':')
            .map(|c| c.to_ascii_lowercase())
            .collect();
        if hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(hex);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fpr(byte: u8) -> String {
        hex::encode([byte; 32])
    }

    /// End-to-end: two in-process parties run the §1.3 handshake and derive matching
    /// keys and SAS. This is the deterministic core the webrtc loopback test (gated by
    /// the `media` feature, unbuildable without a C toolchain here) exercises over a
    /// real data channel.
    #[test]
    fn handshake_derives_matching_keys_and_sas() {
        let session_id = "sess-123";
        let gen = 0u16;

        let desk_key = EphemeralKey::generate();
        let assist_key = EphemeralKey::generate();
        let desk_fpr = fpr(0xAA);
        let assist_fpr = fpr(0xBB);

        let desk = SideInfo {
            epk: desk_key.epk_b64(),
            fpr: desk_fpr.clone(),
            h: commit_hash(Side::Desk, SEC_SUITE, &desk_key.epk_b64(), &desk_fpr),
        };
        let assist = SideInfo {
            epk: assist_key.epk_b64(),
            fpr: assist_fpr.clone(),
            h: commit_hash(Side::Assist, SEC_SUITE, &assist_key.epk_b64(), &assist_fpr),
        };

        // Each side verifies the other's commit against the revealed hello.
        verify_commit(Side::Assist, SEC_SUITE, &assist.epk, &assist.fpr, &assist.h).unwrap();
        verify_commit(Side::Desk, SEC_SUITE, &desk.epk, &desk.fpr, &desk.h).unwrap();

        let ss_desk = desk_key.diffie_hellman(&assist.epk).unwrap();
        let ss_assist = assist_key.diffie_hellman(&desk.epk).unwrap();
        assert_eq!(ss_desk, ss_assist, "X25519 agreement");

        let keys_desk = SessionKeys::derive(session_id, SEC_SUITE, gen, &desk, &assist, &ss_desk);
        let keys_assist =
            SessionKeys::derive(session_id, SEC_SUITE, gen, &desk, &assist, &ss_assist);

        assert_eq!(keys_desk.k_d2a, keys_assist.k_d2a);
        assert_eq!(keys_desk.k_a2d, keys_assist.k_a2d);
        assert_eq!(keys_desk.sas, keys_assist.sas);
        assert_eq!(keys_desk.sas.len(), 6);

        let th = transcript_hash(session_id, SEC_SUITE, gen, &desk, &assist);
        let desk_conf = keys_desk.confirm_mac(Side::Desk, &th);
        let assist_conf = keys_assist.confirm_mac(Side::Assist, &th);
        keys_assist
            .verify_confirm(Side::Desk, &th, &desk_conf)
            .unwrap();
        keys_desk
            .verify_confirm(Side::Assist, &th, &assist_conf)
            .unwrap();
    }

    #[test]
    fn commit_mismatch_is_detected() {
        let epk = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let good = commit_hash(Side::Desk, SEC_SUITE, epk, &fpr(1));
        // A different fpr than was committed => commit reason.
        assert_eq!(
            verify_commit(Side::Desk, SEC_SUITE, epk, &fpr(2), &good),
            Err(SecFailReason::Commit)
        );
    }

    #[test]
    fn wrong_confirm_mac_is_mac_reason() {
        let desk_key = EphemeralKey::generate();
        let assist_key = EphemeralKey::generate();
        let desk = SideInfo {
            epk: desk_key.epk_b64(),
            fpr: fpr(1),
            h: "x".into(),
        };
        let assist = SideInfo {
            epk: assist_key.epk_b64(),
            fpr: fpr(2),
            h: "y".into(),
        };
        let ss = desk_key.diffie_hellman(&assist.epk).unwrap();
        let keys = SessionKeys::derive("s", SEC_SUITE, 0, &desk, &assist, &ss);
        let th = transcript_hash("s", SEC_SUITE, 0, &desk, &assist);
        assert_eq!(
            keys.verify_confirm(Side::Assist, &th, "not-the-right-mac"),
            Err(SecFailReason::Mac)
        );
    }

    #[test]
    fn different_gen_yields_different_keys() {
        let desk_key = EphemeralKey::generate();
        let assist_key = EphemeralKey::generate();
        let desk = SideInfo {
            epk: desk_key.epk_b64(),
            fpr: fpr(1),
            h: "h1".into(),
        };
        let assist = SideInfo {
            epk: assist_key.epk_b64(),
            fpr: fpr(2),
            h: "h2".into(),
        };
        let ss = desk_key.diffie_hellman(&assist.epk).unwrap();
        let g0 = SessionKeys::derive("s", SEC_SUITE, 0, &desk, &assist, &ss);
        let g1 = SessionKeys::derive("s", SEC_SUITE, 1, &desk, &assist, &ss);
        assert_ne!(g0.k_d2a, g1.k_d2a);
        assert_ne!(g0.sas, g1.sas);
    }

    #[test]
    fn fingerprint_parsing() {
        let sdp = "v=0\r\na=group:BUNDLE 0\r\na=fingerprint:sha-256 AB:CD:ef:12:34\r\n";
        // too short -> None
        assert_eq!(fingerprint_from_sdp(sdp), None);
        let full = format!("a=fingerprint:sha-256 {}", "AB:".repeat(31) + "CD");
        let got = fingerprint_from_sdp(&full).unwrap();
        assert_eq!(got.len(), 64);
        assert_eq!(got, got.to_lowercase());
        assert!(!got.contains(':'));
    }

    #[test]
    fn sas_display_format() {
        let desk_key = EphemeralKey::generate();
        let assist_key = EphemeralKey::generate();
        let desk = SideInfo {
            epk: desk_key.epk_b64(),
            fpr: fpr(1),
            h: "h".into(),
        };
        let assist = SideInfo {
            epk: assist_key.epk_b64(),
            fpr: fpr(2),
            h: "h".into(),
        };
        let ss = desk_key.diffie_hellman(&assist.epk).unwrap();
        let keys = SessionKeys::derive("s", SEC_SUITE, 0, &desk, &assist, &ss);
        let disp = keys.sas_display();
        assert_eq!(disp.len(), 7);
        assert_eq!(disp.as_bytes()[3], b' ');
    }
}
