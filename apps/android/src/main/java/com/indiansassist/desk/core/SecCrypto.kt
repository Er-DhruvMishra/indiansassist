package com.indiansassist.desk.core

import com.google.crypto.tink.subtle.Ed25519Verify
import com.google.crypto.tink.subtle.Hkdf
import com.google.crypto.tink.aead.internal.InsecureNonceXChaCha20Poly1305
import com.google.crypto.tink.subtle.X25519
import java.security.GeneralSecurityException

/**
 * The section 1.3 primitives through Tink (contracts section 12.1). X25519, HKDF and Ed25519 come from `subtle`; the
 * nonce-taking `InsecureNonceXChaCha20Poly1305` lives in `com.google.crypto.tink.aead.internal` in the pinned release,
 * not in `subtle` as the contract text says. These are the only Tink classes that take a caller-supplied nonce and
 * expose raw X25519 / HKDF; both packages are internal API, so the cross-language vectors
 * (packages/shared/test/fixtures/agent/sec-vectors.json) are the gate that catches a breaking Tink release.
 */
object SecCrypto {
    fun generatePrivateKey(): ByteArray = X25519.generatePrivateKey()

    fun publicFromPrivate(sk: ByteArray): ByteArray = X25519.publicFromPrivate(sk)

    /** X25519; null for a public key Tink refuses (low-order points) or an all-zero result (`sec.fail key`). */
    fun sharedSecret(sk: ByteArray, peerPub: ByteArray): ByteArray? {
        if (peerPub.size != 32) return null
        val ss = try {
            X25519.computeSharedSecret(sk, peerPub)
        } catch (_: GeneralSecurityException) {
            return null
        } catch (_: IllegalArgumentException) {
            return null
        }
        return if (ss.all { it == 0.toByte() }) null else ss
    }

    /** HKDF-SHA256 extract-and-expand: `HKDF-Expand(HKDF-Extract(salt, ikm), info, size)`. */
    fun hkdf(ikm: ByteArray, salt: ByteArray, info: String, size: Int): ByteArray =
        Hkdf.computeHkdf("HMACSHA256", ikm, salt, Bytes.utf8(info), size)

    /** XChaCha20-Poly1305 seal: returns ciphertext || 16-byte tag. */
    fun seal(key: ByteArray, nonce: ByteArray, plaintext: ByteArray, aad: ByteArray): ByteArray =
        InsecureNonceXChaCha20Poly1305(key).encrypt(nonce, plaintext, aad)

    /** XChaCha20-Poly1305 open; throws GeneralSecurityException on a bad tag. */
    fun open(key: ByteArray, nonce: ByteArray, ciphertext: ByteArray, aad: ByteArray): ByteArray =
        InsecureNonceXChaCha20Poly1305(key).decrypt(nonce, ciphertext, aad)

    /** Ed25519 verification of a compact token (A section 3.1) against a published key. */
    fun ed25519Verify(pub: ByteArray, signature: ByteArray, data: ByteArray): Boolean = try {
        Ed25519Verify(pub).verify(signature, data)
        true
    } catch (_: GeneralSecurityException) {
        false
    } catch (_: IllegalArgumentException) {
        false
    }
}
