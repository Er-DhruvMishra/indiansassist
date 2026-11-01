//! CSPRNG helpers. Every secret the service mints — key seeds, signature nonces, sealing
//! nonces, pipe-name suffixes — comes from the OS generator through here, so there is one
//! place to audit (`rand_core::OsRng`, which is `BCryptGenRandom` on Windows).

use rand_core::{OsRng, RngCore};

/// Fills `buf` with CSPRNG bytes.
pub fn fill(buf: &mut [u8]) {
    OsRng.fill_bytes(buf);
}

/// `N` CSPRNG bytes.
pub fn bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    fill(&mut b);
    b
}

/// A lower-case hex string of `n` CSPRNG bytes (pipe-name suffixes, file suffixes).
pub fn hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    fill(&mut b);
    hex::encode(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draws_differ_and_have_the_asked_length() {
        let a: [u8; 32] = bytes();
        let b: [u8; 32] = bytes();
        assert_ne!(a, b);
        assert_eq!(hex(16).len(), 32);
    }
}
