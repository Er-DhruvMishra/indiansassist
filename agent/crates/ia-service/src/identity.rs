//! The device identity (§3.3): an Ed25519 signing key and an X25519 sealing key, generated on
//! first start and sealed at rest with DPAPI machine scope.
//!
//! The rules this module exists to keep:
//!
//! * **The private keys never leave sealed storage except to be used.** They are unsealed into
//!   [`Zeroizing`] buffers, used to sign or open, and wiped. Nothing returns them, nothing logs
//!   them, and `Debug` prints the key **id**, never the key.
//! * **DPAPI machine scope binds the blob to this machine**, so a copied disk cannot unseal it
//!   on another host. It is not a defence against an administrator on *this* machine — that is
//!   §10.4's honest position — and it is not a substitute for the re-enrollment detection of
//!   rule 3.7a.
//! * **The sealing is behind a trait.** The real one is DPAPI through
//!   `ia_platform::sys_lib("crypt32")` (§14 late binding); tests use a mock, and one gated test
//!   exercises the real DPAPI on a Windows host (§15.2).

use std::path::Path;

use ia_core::devsig::{device_public_key_of, kid_of_b64u, sign_device_input};
use ia_core::seal::kex_public_key_of;
use zeroize::{Zeroize, Zeroizing};

/// How a private key blob is protected at rest.
pub trait BlobSealer: Send + Sync {
    /// Seal `plaintext` so only this machine can open it.
    fn seal(&self, plaintext: &[u8]) -> std::io::Result<Vec<u8>>;
    /// Open a blob this machine sealed.
    fn unseal(&self, blob: &[u8]) -> std::io::Result<Zeroizing<Vec<u8>>>;
    /// A word for the log, so an operator can see which protection is in force.
    fn kind(&self) -> &'static str;
}

/// The device's key pair, in memory.
pub struct Identity {
    /// The 32-byte Ed25519 seed (the identity key).
    seed: Zeroizing<[u8; 32]>,
    /// The 32-byte X25519 secret (the sealing key).
    kex: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity")
            .field("keyId", &self.key_id())
            .field("publicKey", &self.public_key())
            .finish_non_exhaustive()
    }
}

impl Identity {
    /// Generate a fresh pair (first start, and rule 3.7b rotation).
    pub fn generate() -> Self {
        Self {
            seed: Zeroizing::new(ia_core::rnd::bytes::<32>()),
            kex: Zeroizing::new(ia_core::rnd::bytes::<32>()),
        }
    }

    pub fn from_parts(seed: [u8; 32], kex: [u8; 32]) -> Self {
        Self {
            seed: Zeroizing::new(seed),
            kex: Zeroizing::new(kex),
        }
    }

    /// The base64url Ed25519 public key (`device.public_key`).
    pub fn public_key(&self) -> String {
        device_public_key_of(&self.seed)
    }

    /// The base64url X25519 public key (`device.kex_public_key`): what the server seals to.
    pub fn kex_public_key(&self) -> String {
        kex_public_key_of(&self.kex)
    }

    /// `keyId` = the first 16 hex of sha256 over the Ed25519 public key.
    pub fn key_id(&self) -> String {
        kid_of_b64u(&self.public_key()).unwrap_or_default()
    }

    /// Sign one §3.8 signing input. The only way the identity key is used.
    pub fn sign(&self, input: &[u8]) -> String {
        sign_device_input(input, &self.seed)
    }

    /// Signs one rule 10.5 tamper event. The seed stays inside this type: a caller that wants
    /// a signed event asks for one rather than borrowing the key.
    pub fn sign_tamper_event(
        &self,
        device_id: &str,
        event_id: &str,
        cause: ia_core::fleet::TamperCause,
        at: &str,
        detail: Option<&str>,
    ) -> ia_core::CoreResult<ia_core::fleet::TamperEvent> {
        ia_core::tamper::sign_event(device_id, &self.seed, event_id, cause, at, detail)
    }

    /// The sealing secret, for `openSealed` (wake MACs, AMT credentials, vault secrets). The
    /// borrow is short-lived by construction: callers pass it straight to `ia_core::seal`.
    pub fn kex_secret(&self) -> &[u8; 32] {
        &self.kex
    }

    /// The two sealed blobs, ready to write to `device.key` and `device.kex`.
    pub fn seal_with(&self, sealer: &dyn BlobSealer) -> std::io::Result<(Vec<u8>, Vec<u8>)> {
        Ok((sealer.seal(&self.seed[..])?, sealer.seal(&self.kex[..])?))
    }

    /// Write both sealed blobs (§3.3), replacing whatever was there.
    pub fn store(&self, sealer: &dyn BlobSealer, key: &Path, kex: &Path) -> std::io::Result<()> {
        let (a, b) = self.seal_with(sealer)?;
        write_replace(key, &a)?;
        write_replace(kex, &b)
    }

    /// Load both sealed blobs. `Ok(None)` when the files are not there yet (first start);
    /// `Err` when they exist but cannot be opened on this machine — which is a real problem
    /// (a restored disk, a changed machine key) and must not be mistaken for "not enrolled".
    pub fn load(sealer: &dyn BlobSealer, key: &Path, kex: &Path) -> std::io::Result<Option<Self>> {
        if !key.exists() || !kex.exists() {
            return Ok(None);
        }
        let seed = exactly_32(sealer.unseal(&std::fs::read(key)?)?)?;
        let kexs = exactly_32(sealer.unseal(&std::fs::read(kex)?)?)?;
        Ok(Some(Self::from_parts(seed, kexs)))
    }

    /// Overwrite then delete both blobs: the uninstall and a rule 3.7b rotation's old keys
    /// (§4.1 "deletes the key blobs").
    pub fn shred(key: &Path, kex: &Path) -> std::io::Result<()> {
        for p in [key, kex] {
            if p.exists() {
                if let Ok(meta) = std::fs::metadata(p) {
                    let zeros = vec![0u8; meta.len() as usize];
                    let _ = std::fs::write(p, &zeros);
                }
                std::fs::remove_file(p)?;
            }
        }
        Ok(())
    }
}

fn exactly_32(mut v: Zeroizing<Vec<u8>>) -> std::io::Result<[u8; 32]> {
    if v.len() != 32 {
        v.zeroize();
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "a sealed device key must be 32 bytes",
        ));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&v[..]);
    Ok(out)
}

fn write_replace(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("new");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// DPAPI machine scope (`CryptProtectData` with `CRYPTPROTECT_LOCAL_MACHINE`), reached through
/// `ia_platform::sys_lib("crypt32")` so the import table stays KnownDLL-only (§14).
///
/// The extra entropy blob of §3.3 is passed as the optional entropy argument; the service keeps
/// it under `HKLM\SOFTWARE\IndiansAssist\Device`, whose ACL grants `SYSTEM` and
/// `Administrators`. A copied disk without that registry value cannot unseal even on a machine
/// that could otherwise run DPAPI.
#[cfg(all(windows, feature = "service"))]
pub struct DpapiSealer {
    entropy: Zeroizing<Vec<u8>>,
}

#[cfg(all(windows, feature = "service"))]
impl DpapiSealer {
    /// `entropy` is the per-install blob from the registry (`[]` when there is none, which is
    /// how a pre-§3.3 install upgrades).
    pub fn new(entropy: Vec<u8>) -> Self {
        Self {
            entropy: Zeroizing::new(entropy),
        }
    }
}

#[cfg(all(windows, feature = "service"))]
impl BlobSealer for DpapiSealer {
    fn seal(&self, plaintext: &[u8]) -> std::io::Result<Vec<u8>> {
        crate::win::dpapi::protect(plaintext, &self.entropy)
    }

    fn unseal(&self, blob: &[u8]) -> std::io::Result<Zeroizing<Vec<u8>>> {
        crate::win::dpapi::unprotect(blob, &self.entropy)
    }

    fn kind(&self) -> &'static str {
        "dpapi-machine"
    }
}

/// A sealer for tests: it does not protect anything and says so. Using it outside a test is a
/// mistake the name is meant to prevent.
#[derive(Debug, Default)]
pub struct InsecureTestSealer;

impl BlobSealer for InsecureTestSealer {
    fn seal(&self, plaintext: &[u8]) -> std::io::Result<Vec<u8>> {
        let mut out = b"TEST-UNSEALED:".to_vec();
        out.extend_from_slice(plaintext);
        Ok(out)
    }

    fn unseal(&self, blob: &[u8]) -> std::io::Result<Zeroizing<Vec<u8>>> {
        blob.strip_prefix(b"TEST-UNSEALED:".as_slice())
            .map(|b| Zeroizing::new(b.to_vec()))
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "not a test blob"))
    }

    fn kind(&self) -> &'static str {
        "insecure-test"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_generated_identity_has_a_key_id_derived_from_its_public_key() {
        let id = Identity::generate();
        assert_eq!(id.key_id().len(), 16);
        assert_eq!(id.key_id(), kid_of_b64u(&id.public_key()).unwrap());
        assert_eq!(id.public_key().len(), 43);
        assert_eq!(id.kex_public_key().len(), 43);
        assert_ne!(id.public_key(), Identity::generate().public_key());
    }

    #[test]
    fn it_signs_what_the_server_will_verify() {
        let id = Identity::generate();
        let input = ia_core::devsig::input::deregister(
            "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a",
            1_793_520_000_000,
            &base64_16(),
        )
        .unwrap();
        let sig = id.sign(&input);
        assert!(ia_core::devsig::verify_device_signature(
            &input,
            &sig,
            &id.public_key()
        ));
    }

    fn base64_16() -> String {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;
        URL_SAFE_NO_PAD.encode([0x66u8; 16])
    }

    #[test]
    fn the_sealed_blobs_round_trip_through_the_trait() {
        let dir = tempfile::tempdir().unwrap();
        let (key, kex) = (dir.path().join("device.key"), dir.path().join("device.kex"));
        let sealer = InsecureTestSealer;
        let id = Identity::generate();
        let (pk, kpk) = (id.public_key(), id.kex_public_key());
        id.store(&sealer, &key, &kex).unwrap();
        let back = Identity::load(&sealer, &key, &kex)
            .unwrap()
            .expect("stored");
        assert_eq!(back.public_key(), pk);
        assert_eq!(back.kex_public_key(), kpk);
    }

    #[test]
    fn no_keys_on_disk_means_first_start_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let r = Identity::load(
            &InsecureTestSealer,
            &dir.path().join("device.key"),
            &dir.path().join("device.kex"),
        );
        assert!(matches!(r, Ok(None)));
    }

    #[test]
    fn a_blob_this_machine_cannot_open_is_an_error_not_a_fresh_start() {
        let dir = tempfile::tempdir().unwrap();
        let (key, kex) = (dir.path().join("device.key"), dir.path().join("device.kex"));
        std::fs::write(&key, b"sealed on another machine").unwrap();
        std::fs::write(&kex, b"sealed on another machine").unwrap();
        assert!(Identity::load(&InsecureTestSealer, &key, &kex).is_err());
    }

    #[test]
    fn a_blob_of_the_wrong_length_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let (key, kex) = (dir.path().join("device.key"), dir.path().join("device.kex"));
        let sealer = InsecureTestSealer;
        std::fs::write(&key, sealer.seal(b"short").unwrap()).unwrap();
        std::fs::write(&kex, sealer.seal(&[0u8; 32]).unwrap()).unwrap();
        assert!(Identity::load(&sealer, &key, &kex).is_err());
    }

    #[test]
    fn shredding_overwrites_and_removes_both_blobs() {
        let dir = tempfile::tempdir().unwrap();
        let (key, kex) = (dir.path().join("device.key"), dir.path().join("device.kex"));
        Identity::generate()
            .store(&InsecureTestSealer, &key, &kex)
            .unwrap();
        Identity::shred(&key, &kex).unwrap();
        assert!(!key.exists() && !kex.exists());
        // Shredding again is not an error (the uninstall may run twice).
        assert!(Identity::shred(&key, &kex).is_ok());
    }

    #[test]
    fn a_debug_dump_shows_the_key_id_and_never_the_key() {
        let id = Identity::generate();
        let dump = format!("{id:?}");
        assert!(dump.contains(&id.key_id()));
        assert!(!dump.contains("seed"), "{dump}");
        let seed_hex = hex::encode(id.kex_secret());
        assert!(!dump.contains(&seed_hex));
    }
}
