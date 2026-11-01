//! Phase D sealing (`docs/specs/phase-d-contracts.md` conventions table "Device sealing
//! key"): the server seals a one-use secret — a wake target's MAC, AMT credentials, a vault
//! secret — to exactly one device's X25519 key, and only that device can open it.
//!
//! `key = HKDF-SHA256(ikm = X25519(eph, kex), salt = nonce, info = utf8("ia-seal-v1") || purpose)`,
//! `ct  = XChaCha20-Poly1305(key, nonce, plaintext, aad = utf8(deviceId))`.
//!
//! The TypeScript authority is `packages/shared/src/fleet/seal.ts`; both sides are checked
//! against `packages/shared/test/fixtures/fleet/seal.json` (`tests/fleet_vectors.rs`). The
//! device side is [`open_sealed`]; [`seal_to_device`] exists for tests and loopbacks.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::{CoreError, CoreResult};

/// The `info` prefix of the sealing HKDF.
pub const SEAL_INFO_PREFIX: &str = "ia-seal-v1";

/// `SEAL_PURPOSES`: what a sealed value is for. The purpose is bound into the key, so a
/// value sealed for one purpose never opens as another.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SealPurpose {
    #[serde(rename = "wake-mac")]
    WakeMac,
    #[serde(rename = "amt-cred")]
    AmtCred,
    #[serde(rename = "vault-secret")]
    VaultSecret,
}

impl SealPurpose {
    pub fn as_str(self) -> &'static str {
        match self {
            SealPurpose::WakeMac => "wake-mac",
            SealPurpose::AmtCred => "amt-cred",
            SealPurpose::VaultSecret => "vault-secret",
        }
    }
}

/// All purposes, in the shared `SEAL_PURPOSES` order.
pub const SEAL_PURPOSES: [SealPurpose; 3] = [
    SealPurpose::WakeMac,
    SealPurpose::AmtCred,
    SealPurpose::VaultSecret,
];

/// `Sealed` (base64url): the ephemeral public key, the 24-byte nonce, and the ciphertext
/// with its 16-byte tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sealed {
    pub epk: String,
    pub nonce: String,
    pub ct: String,
}

fn b64u(value: &str, what: &str) -> CoreResult<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| CoreError::BadInput(format!("{what} is not base64url")))
}

fn seal_key(shared: &[u8], nonce: &[u8], purpose: SealPurpose) -> Zeroizing<[u8; 32]> {
    let info = format!("{SEAL_INFO_PREFIX}{}", purpose.as_str());
    let hk = Hkdf::<Sha256>::new(Some(nonce), shared);
    let mut key = Zeroizing::new([0u8; 32]);
    hk.expand(info.as_bytes(), key.as_mut())
        .expect("32 bytes is a valid HKDF length");
    key
}

/// Opens a `Sealed` with the device's 32-byte X25519 secret. Fails on any tampering and on a
/// wrong device id or purpose (both are bound into the key / AAD).
pub fn open_sealed(
    kex_secret: &[u8; 32],
    device_id: &str,
    purpose: SealPurpose,
    sealed: &Sealed,
) -> CoreResult<Zeroizing<Vec<u8>>> {
    let nonce = b64u(&sealed.nonce, "seal nonce")?;
    if nonce.len() != 24 {
        return Err(CoreError::BadInput("seal nonce must be 24 bytes".into()));
    }
    let epk: [u8; 32] = b64u(&sealed.epk, "seal epk")?
        .try_into()
        .map_err(|_| CoreError::BadInput("seal epk must be 32 bytes".into()))?;
    let ct = b64u(&sealed.ct, "seal ciphertext")?;
    let shared = StaticSecret::from(*kex_secret).diffie_hellman(&PublicKey::from(epk));
    let key = seal_key(shared.as_bytes(), &nonce, purpose);
    let aead = XChaCha20Poly1305::new(key.as_ref().into());
    let pt = aead
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ct,
                aad: device_id.as_bytes(),
            },
        )
        .map_err(|_| CoreError::Crypto("sealed value did not open".into()))?;
    Ok(Zeroizing::new(pt))
}

/// Opens a sealed value expected to be UTF-8 text (a MAC, a JSON credential, a secret).
pub fn open_sealed_text(
    kex_secret: &[u8; 32],
    device_id: &str,
    purpose: SealPurpose,
    sealed: &Sealed,
) -> CoreResult<Zeroizing<String>> {
    let pt = open_sealed(kex_secret, device_id, purpose, sealed)?;
    let text = String::from_utf8(pt.to_vec())
        .map_err(|_| CoreError::BadInput("sealed value is not UTF-8".into()))?;
    Ok(Zeroizing::new(text))
}

/// Seals `plaintext` to the device whose X25519 public key is `kex_public_key` (base64url).
/// `eph_secret` / `nonce` are fixed by the test vectors; pass `None` in real use.
pub fn seal_to_device(
    kex_public_key: &str,
    device_id: &str,
    purpose: SealPurpose,
    plaintext: &[u8],
    eph_secret: Option<[u8; 32]>,
    nonce: Option<[u8; 24]>,
) -> CoreResult<Sealed> {
    let kex: [u8; 32] = b64u(kex_public_key, "kex public key")?
        .try_into()
        .map_err(|_| CoreError::BadInput("kex public key must be 32 bytes".into()))?;
    let eph = match eph_secret {
        Some(s) => s,
        None => {
            let mut s = [0u8; 32];
            crate::rnd::fill(&mut s);
            s
        }
    };
    let nonce = match nonce {
        Some(n) => n,
        None => {
            let mut n = [0u8; 24];
            crate::rnd::fill(&mut n);
            n
        }
    };
    let eph_secret = StaticSecret::from(eph);
    let shared = eph_secret.diffie_hellman(&PublicKey::from(kex));
    let key = seal_key(shared.as_bytes(), &nonce, purpose);
    let aead = XChaCha20Poly1305::new(key.as_ref().into());
    let ct = aead
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: device_id.as_bytes(),
            },
        )
        .map_err(|_| CoreError::Crypto("seal failed".into()))?;
    Ok(Sealed {
        epk: URL_SAFE_NO_PAD.encode(PublicKey::from(&eph_secret).to_bytes()),
        nonce: URL_SAFE_NO_PAD.encode(nonce),
        ct: URL_SAFE_NO_PAD.encode(ct),
    })
}

/// The base64url X25519 public key of a 32-byte secret (what the device enrols with).
pub fn kex_public_key_of(secret: &[u8; 32]) -> String {
    URL_SAFE_NO_PAD.encode(PublicKey::from(&StaticSecret::from(*secret)).to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEX: [u8; 32] = [0x33; 32];
    const DEV: &str = "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a";

    fn sealed_for(purpose: SealPurpose, text: &str) -> Sealed {
        seal_to_device(
            &kex_public_key_of(&KEX),
            DEV,
            purpose,
            text.as_bytes(),
            Some([0x81; 32]),
            Some([0x91; 24]),
        )
        .unwrap()
    }

    #[test]
    fn round_trips_for_every_purpose() {
        for p in SEAL_PURPOSES {
            let s = sealed_for(p, "value");
            assert_eq!(&*open_sealed_text(&KEX, DEV, p, &s).unwrap(), "value");
        }
    }

    #[test]
    fn a_wrong_device_purpose_key_or_flipped_byte_fails() {
        let s = sealed_for(SealPurpose::WakeMac, "0a1b2c3d4e5f");
        assert!(open_sealed(
            &KEX,
            "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
            SealPurpose::WakeMac,
            &s
        )
        .is_err());
        assert!(open_sealed(&KEX, DEV, SealPurpose::AmtCred, &s).is_err());
        assert!(open_sealed(&[0x44; 32], DEV, SealPurpose::WakeMac, &s).is_err());
        let mut ct = URL_SAFE_NO_PAD.decode(&s.ct).unwrap();
        ct[0] ^= 1;
        let flipped = Sealed {
            ct: URL_SAFE_NO_PAD.encode(ct),
            ..s.clone()
        };
        assert!(open_sealed(&KEX, DEV, SealPurpose::WakeMac, &flipped).is_err());
    }

    #[test]
    fn a_malformed_sealed_value_is_an_error_not_a_panic() {
        let bad = Sealed {
            epk: "AAAA".into(),
            nonce: "AAAA".into(),
            ct: "AAAA".into(),
        };
        assert!(open_sealed(&KEX, DEV, SealPurpose::WakeMac, &bad).is_err());
    }
}
