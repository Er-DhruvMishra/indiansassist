package com.indiansassist.desk.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The ported shared helpers produce exactly what the TypeScript build produced into the vectors file. */
class HelpersParityTest {
    @Test
    fun canonicalJsonMatchesShared() {
        for (c in Vectors.list("canonicalJson")) assertEquals(c.str("canonical"), CanonicalJson.encode(c["value"]!!))
    }

    @Test
    fun canonicalJsonRejectsNonIntegers() {
        try {
            CanonicalJson.encode(obj("x" to 1.5))
            throw AssertionError("accepted 1.5")
        } catch (_: CanonicalJson.CanonicalJsonError) {
        }
    }

    @Test
    fun sanitiseFileNameMatchesShared() {
        for (c in Vectors.list("fileNames")) {
            assertEquals("input ${c.str("name")}", c.str("sanitised"), FileNames.sanitise(c.str("name")!!, c.long("fileId")!!))
        }
    }

    @Test
    fun normaliseTokenInputMatchesShared() {
        for (c in Vectors.list("joinInput")) {
            val got = JoinInput.normalise(c.str("input")!!)
            val want = c.objOrNull("normalised")
            if (want == null) assertNull(c.str("input"), got) else {
                assertEquals(want.str("kind"), got!!.kind.wire)
                assertEquals(want.str("value"), got.value)
            }
        }
    }

    @Test
    fun shortCodeLuhnMatchesShared() {
        for (c in Vectors.list("shortCodes")) assertEquals(c.str("code"), c.bool("valid"), JoinInput.isValidShortCode(c.str("code")!!))
    }

    @Test
    fun fingerprintFromSdpMatches() {
        for (c in Vectors.list("fingerprintFromSdp")) assertEquals(c.str("name"), c.str("fpr"), Fingerprint.fromSdp(c.str("sdp")!!))
    }

    @Test
    fun opIdForMatchesShared() {
        for (c in Vectors.list("opIds")) assertEquals(c.str("opId"), AgentControl.opIdFor(c.str("sessionId")!!, c.str("id")!!))
    }

    @Test
    fun maxMessageSizeIsAdvertised() {
        val offer = "v=0\r\ns=-\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:1\r\na=sctp-port:5000\r\n"
        val munged = SdpMunge.withMaxMessageSize(offer)
        assertTrue(munged.contains("a=sctp-port:5000\r\na=max-message-size:131072\r\n"))
        assertTrue(munged.startsWith("v=0\r\ns=-\r\nm=video"))
        val replaced = SdpMunge.withMaxMessageSize(munged.replace("131072", "65536"))
        assertEquals(1, Regex("a=max-message-size:131072").findAll(replaced).count())
        assertEquals("v=0\r\nm=video 9 X 96\r\n", SdpMunge.withMaxMessageSize("v=0\r\nm=video 9 X 96\r\n"))
        assertTrue(SdpMunge.hasApplication(offer))
        assertFalse(SdpMunge.hasApplication("v=0\r\nm=video 9 X 96\r\n"))
    }

    @Test
    fun extensionLists() {
        assertTrue(FileNames.isExecutable("setup.EXE"))
        assertTrue(FileNames.isExecutable("x.appref-ms"))
        assertTrue(FileNames.isPassiveRisk("desktop.searchConnector-ms"))
        assertFalse(FileNames.isExecutable("notes.txt"))
        assertNull(FileNames.extension(".bashrc"))
    }

    @Test
    fun linksAndDeepLinks() {
        val hosts = setOf("in.indiansassist.example", "10.0.2.2:4000")
        val compact = "ia1.3f9a1c2b4d5e6f70.eyJ2IjoxfQ.c2ln"
        assertEquals(compact, JoinInput.parseAny("https://in.indiansassist.example/join#t=$compact", hosts)!!.value)
        assertEquals(compact, JoinInput.parseAny("https://in.indiansassist.example/join?t=$compact", hosts)!!.value)
        assertEquals(compact, JoinInput.parseAny("indiansassist://join?t=$compact", hosts)!!.value)
        assertEquals("482193657715", JoinInput.parseAny("indiansassist://join?c=4821-9365-7715", hosts)!!.value)
        assertEquals(compact, JoinInput.parseAny("http://10.0.2.2:4000/join#t=$compact", hosts)!!.value)
        assertNull(JoinInput.parseAny("https://evil.example/join#t=$compact", hosts))
        assertNull(JoinInput.parseAny("https://in.indiansassist.example/other#t=$compact", hosts))
        assertNull(JoinInput.parseAny("indiansassist://join?t=$compact&api-origin=http://attacker", hosts))
        assertNull(JoinInput.parseAny("indiansassist://evil?t=$compact", hosts))
        assertNull(JoinInput.parseAny("indiansassist://join?c=$compact", hosts))
        assertNull(JoinInput.parseAny("javascript:alert(1)", hosts))
        assertEquals("482193657715", JoinInput.parseAny(" 4821 9365 7715 ", hosts)!!.value)
    }
}
