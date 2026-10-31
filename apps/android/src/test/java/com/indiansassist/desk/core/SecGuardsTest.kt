package com.indiansassist.desk.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The post-establishment DTLS fingerprint re-check (C8) and the capped channel-rebuild loop (C15). */
class SecGuardsTest {
    private val fprA = "a".repeat(64)
    private val fprB = "b".repeat(64)
    private fun sdp(fpr: String) = buildString {
        append("v=0\r\n")
        append("a=fingerprint:sha-256 ${fpr.chunked(2).joinToString(":").uppercase()}\r\n")
        append("m=video 9 UDP/TLS/RTP/SAVPF 96\r\n")
    }

    @Test
    fun fingerprintMatchesSameValue() {
        // The bound fingerprint read back from a fresh SDP carrying the same value (colons/upper-case normalised).
        assertTrue(Fingerprint.matches(fprA, sdp(fprA)))
    }

    @Test
    fun fingerprintMismatchFailsClosed() {
        // A signaling MITM re-terminating DTLS presents a different fingerprint after the SAS was confirmed.
        assertFalse(Fingerprint.matches(fprA, sdp(fprB)))
        // A missing bound value or a fingerprint-less SDP also fails closed.
        assertFalse(Fingerprint.matches(null, sdp(fprA)))
        assertFalse(Fingerprint.matches(fprA, "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n"))
        assertFalse(Fingerprint.matches(fprA, null))
    }

    @Test
    fun rebuildLimiterCapsPerWindow() {
        var now = 0L
        val lim = RebuildLimiter(cap = 3, windowMs = 600_000L) { now }
        assertTrue(lim.allow())
        assertTrue(lim.allow())
        assertTrue(lim.allow())
        // Fourth within the window is refused.
        assertFalse(lim.allow())
        // After the window slides past the earliest entries, rebuilds are allowed again.
        now += 600_001L
        assertTrue(lim.allow())
    }
}
