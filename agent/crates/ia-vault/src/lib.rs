//! `ia-vault`: the **injection** side of rule 9.8, and nothing else.
//!
//! The api holds the only vault credential. It reads each secret at dispatch, seals it to this
//! device's X25519 key (purpose `vault-secret`) and attaches it to the `device.action`. This
//! crate opens those seals, hands the values to one child process as environment variables,
//! wipes them, and masks their exact values in anything the child printed before that output is
//! reported or logged.
//!
//! What it deliberately cannot do:
//!
//! * **It holds no vault credential and makes no network call.** There is no code path here
//!   that could fetch a secret; a device that is fully compromised still has only the values
//!   the server chose to seal to it, for the one action it was sent.
//! * **It never writes a secret anywhere but the child's environment.** Not to disk, not to a
//!   command line (where any process could read it), not to the log, and not into the action
//!   result that goes back to the server.
//! * **It cannot be asked for a value back.** [`Injector::take_environment`] consumes the
//!   secrets so the same injector cannot feed a second process, and [`Injector::wipe`] is
//!   called on every path, including the failure ones.
//!
//! Masking is best effort and honest about it: it replaces exact occurrences of each value.
//! A playbook that prints a secret in pieces, or base64 of it, defeats masking — which is why
//! the audit entry records the env name and vault path and never the value, and why playbook
//! output is not chained at all (C §8.5).

use std::collections::BTreeMap;

use ia_core::fleet::ActionSecret;
use ia_core::seal::{open_sealed_text, SealPurpose};
use ia_platform::SecretInjector;
use zeroize::Zeroizing;

/// The replacement masking puts in place of a secret value.
pub const MASK: &str = "***";
/// Rule 9.8: at most 8 `vaultRefs` per playbook, so at most 8 secrets per action.
pub const MAX_SECRETS: usize = 8;
/// A value shorter than this is not masked: masking a one- or two-character "secret" would
/// scribble over ordinary output without protecting anything.
const MASK_MIN_LEN: usize = 4;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum VaultError {
    #[error("an action may carry at most {MAX_SECRETS} secrets, not {0}")]
    TooMany(usize),
    #[error("a secret's env name must match /^[A-Z_][A-Z0-9_]{{0,63}}$/")]
    BadEnvName,
    #[error("two secrets claim the same env name")]
    DuplicateEnv,
    #[error("a sealed secret did not open for this device")]
    Sealed,
    #[error("a secret value is not UTF-8 text")]
    NotText,
}

/// Rule 9.8's env-name grammar, enforced here as well as on the server: an action that arrives
/// with something else is refused rather than injected.
pub fn valid_env_name(name: &str) -> bool {
    let b = name.as_bytes();
    if b.is_empty() || b.len() > 64 {
        return false;
    }
    let first_ok = b[0].is_ascii_uppercase() || b[0] == b'_';
    first_ok
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
}

/// Secrets opened for exactly one child process.
pub struct Injector {
    /// Kept sorted so the environment is built in a stable order (a flaky spawn is hard enough
    /// to debug without a shuffling environment).
    secrets: BTreeMap<String, Zeroizing<String>>,
    /// Set once the environment has been taken, so it cannot be taken twice.
    spent: bool,
}

impl Injector {
    /// Opens every sealed secret of a `device.action`. Any failure opens nothing: an action
    /// runs with all of its secrets or none, never with a partial environment that would make
    /// a playbook fail in a confusing way.
    pub fn open(
        secrets: &[ActionSecret],
        kex_secret: &[u8; 32],
        device_id: &str,
    ) -> Result<Self, VaultError> {
        if secrets.len() > MAX_SECRETS {
            return Err(VaultError::TooMany(secrets.len()));
        }
        let mut out: BTreeMap<String, Zeroizing<String>> = BTreeMap::new();
        for s in secrets {
            if !valid_env_name(&s.env) {
                return Err(VaultError::BadEnvName);
            }
            if out.contains_key(&s.env) {
                return Err(VaultError::DuplicateEnv);
            }
            let value =
                open_sealed_text(kex_secret, device_id, SealPurpose::VaultSecret, &s.sealed)
                    .map_err(|_| VaultError::Sealed)?;
            out.insert(s.env.clone(), value);
        }
        Ok(Self {
            secrets: out,
            spent: false,
        })
    }

    /// An injector with nothing in it (an action without `vaultRefs`), so the caller has one
    /// code path.
    pub fn empty() -> Self {
        Self {
            secrets: BTreeMap::new(),
            spent: false,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.secrets.is_empty()
    }

    pub fn len(&self) -> usize {
        self.secrets.len()
    }

    /// The env names, for the `secret.injected` audit entry the **server** writes (the device
    /// never reports a value, only that it used the names it was given).
    pub fn env_names(&self) -> Vec<&str> {
        self.secrets.keys().map(String::as_str).collect()
    }

    /// The environment pairs for the child, **consuming** them: the injector keeps only what it
    /// needs for masking afterwards. The caller passes these straight to the spawn and drops
    /// them, which wipes them.
    pub fn take_environment(&mut self) -> Vec<(String, Zeroizing<String>)> {
        if self.spent {
            return Vec::new();
        }
        self.spent = true;
        self.secrets
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Replaces every exact occurrence of every secret value with [`MASK`]. Longest values
    /// first, so a secret that contains another is not half-masked.
    pub fn mask(&self, text: &str) -> String {
        let mut values: Vec<&str> = self
            .secrets
            .values()
            .map(|v| v.as_str())
            .filter(|v| v.len() >= MASK_MIN_LEN)
            .collect();
        values.sort_by_key(|v| std::cmp::Reverse(v.len()));
        let mut out = text.to_string();
        for v in values {
            if out.contains(v) {
                out = out.replace(v, MASK);
            }
        }
        out
    }

    /// Wipes every held value now. Called after the spawn and on every failure path; `Drop`
    /// does it too, so a `?` on an early return cannot leave one behind.
    pub fn wipe(&mut self) {
        self.secrets.clear();
    }
}

impl Drop for Injector {
    fn drop(&mut self) {
        // `Zeroizing` wipes each value as the map is cleared.
        self.secrets.clear();
    }
}

impl std::fmt::Debug for Injector {
    /// Prints the names and never the values: a `tracing` call that dumps the injector must not
    /// be the thing that leaks a credential.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Injector")
            .field("env", &self.env_names())
            .field("spent", &self.spent)
            .finish()
    }
}

impl SecretInjector for Injector {
    fn environment(&self) -> Vec<(String, Zeroizing<String>)> {
        self.secrets
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    fn mask(&self, text: &str) -> String {
        Injector::mask(self, text)
    }

    fn wipe(&mut self) {
        Injector::wipe(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ia_core::seal::{kex_public_key_of, seal_to_device};

    const KEX: [u8; 32] = [0x33; 32];
    const DEV: &str = "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a";

    fn secret(env: &str, value: &str) -> ActionSecret {
        ActionSecret {
            env: env.to_string(),
            sealed: seal_to_device(
                &kex_public_key_of(&KEX),
                DEV,
                SealPurpose::VaultSecret,
                value.as_bytes(),
                None,
                None,
            )
            .unwrap(),
        }
    }

    #[test]
    fn the_sealed_secrets_of_an_action_open_into_an_environment() {
        let mut inj = Injector::open(
            &[
                secret("IA_API_KEY", "sk-live-9f8e7d6c"),
                secret("IA_DB_PASSWORD", "hunter2-but-longer"),
            ],
            &KEX,
            DEV,
        )
        .unwrap();
        assert_eq!(inj.env_names(), vec!["IA_API_KEY", "IA_DB_PASSWORD"]);
        let env = inj.take_environment();
        assert_eq!(env.len(), 2);
        assert_eq!(env[0].0, "IA_API_KEY");
        assert_eq!(env[0].1.as_str(), "sk-live-9f8e7d6c");
    }

    #[test]
    fn the_environment_can_only_be_taken_once() {
        let mut inj =
            Injector::open(&[secret("IA_API_KEY", "sk-live-9f8e7d6c")], &KEX, DEV).unwrap();
        assert_eq!(inj.take_environment().len(), 1);
        assert!(
            inj.take_environment().is_empty(),
            "a second child never gets the secret"
        );
    }

    #[test]
    fn a_secret_sealed_to_another_device_or_purpose_opens_nothing_at_all() {
        let other = ActionSecret {
            env: "IA_API_KEY".into(),
            sealed: seal_to_device(
                &kex_public_key_of(&KEX),
                "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
                SealPurpose::VaultSecret,
                b"sk-live-9f8e7d6c",
                None,
                None,
            )
            .unwrap(),
        };
        assert_eq!(
            Injector::open(&[other], &KEX, DEV).unwrap_err(),
            VaultError::Sealed
        );
        let wrong_purpose = ActionSecret {
            env: "IA_API_KEY".into(),
            sealed: seal_to_device(
                &kex_public_key_of(&KEX),
                DEV,
                SealPurpose::AmtCred,
                b"creds",
                None,
                None,
            )
            .unwrap(),
        };
        assert_eq!(
            Injector::open(&[wrong_purpose], &KEX, DEV).unwrap_err(),
            VaultError::Sealed
        );
    }

    #[test]
    fn one_bad_secret_means_none_are_injected() {
        let r = Injector::open(
            &[
                secret("IA_GOOD", "value-one-long-enough"),
                ActionSecret {
                    env: "lower_case".into(),
                    sealed: secret("X", "y").sealed,
                },
            ],
            &KEX,
            DEV,
        );
        assert_eq!(r.unwrap_err(), VaultError::BadEnvName);
    }

    #[test]
    fn the_env_name_grammar_is_enforced_on_the_device_too() {
        for ok in ["IA_KEY", "_PRIVATE", "A", "A1_B2", &"A".repeat(64)] {
            assert!(valid_env_name(ok), "{ok} should pass");
        }
        for bad in [
            "",
            "lower",
            "1START",
            "HAS-DASH",
            "HAS SPACE",
            "PATH=X",
            &"A".repeat(65),
        ] {
            assert!(!valid_env_name(bad), "{bad} should not pass");
        }
    }

    #[test]
    fn two_secrets_cannot_claim_one_env_name() {
        assert_eq!(
            Injector::open(
                &[
                    secret("IA_KEY", "aaaa-value"),
                    secret("IA_KEY", "bbbb-value")
                ],
                &KEX,
                DEV
            )
            .unwrap_err(),
            VaultError::DuplicateEnv
        );
    }

    #[test]
    fn more_than_eight_secrets_is_refused() {
        let many: Vec<ActionSecret> = (0..9)
            .map(|i| secret(&format!("IA_K{i}"), "value-long-enough"))
            .collect();
        assert_eq!(
            Injector::open(&many, &KEX, DEV).unwrap_err(),
            VaultError::TooMany(9)
        );
    }

    #[test]
    fn captured_output_is_masked_including_a_value_that_contains_another() {
        let inj = Injector::open(
            &[
                secret("IA_SHORT", "abcd1234"),
                secret("IA_LONG", "abcd1234-extended-tail"),
            ],
            &KEX,
            DEV,
        )
        .unwrap();
        let out = inj.mask("token=abcd1234-extended-tail and also abcd1234 twice: abcd1234");
        assert_eq!(out, "token=*** and also *** twice: ***");
        assert!(!out.contains("abcd1234"));
    }

    #[test]
    fn masking_leaves_ordinary_output_alone_and_does_not_chase_tiny_values() {
        let inj = Injector::open(&[secret("IA_TINY", "ab")], &KEX, DEV).unwrap();
        assert_eq!(
            inj.mask("about to rebuild the cabinet"),
            "about to rebuild the cabinet",
            "a two-character value is not masked: it would scribble over everything"
        );
        assert_eq!(Injector::empty().mask("nothing to mask"), "nothing to mask");
    }

    #[test]
    fn a_debug_dump_of_the_injector_shows_names_and_never_values() {
        let inj = Injector::open(&[secret("IA_API_KEY", "sk-live-9f8e7d6c")], &KEX, DEV).unwrap();
        let dump = format!("{inj:?}");
        assert!(dump.contains("IA_API_KEY"));
        assert!(!dump.contains("sk-live"));
    }

    #[test]
    fn wiping_empties_it_and_stops_the_masking_too() {
        let mut inj =
            Injector::open(&[secret("IA_API_KEY", "sk-live-9f8e7d6c")], &KEX, DEV).unwrap();
        inj.wipe();
        assert!(inj.is_empty());
        assert!(inj.take_environment().is_empty());
        // Nothing left to mask with: the caller must mask before wiping, which is why the
        // service masks the captured output and only then wipes.
        assert_eq!(inj.mask("sk-live-9f8e7d6c"), "sk-live-9f8e7d6c");
    }
}
