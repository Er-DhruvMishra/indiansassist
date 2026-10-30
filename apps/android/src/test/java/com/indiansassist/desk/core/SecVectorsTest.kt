package com.indiansassist.desk.core

import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Section 1.3 with Tink `subtle` against the cross-language vectors (contracts section 15.3). */
class SecVectorsTest {
    private fun hs(name: String) = Vectors.handshake(name)
    private fun JsonObject.o(k: String) = objOrNull(k)!!

    @Test
    fun xchacha20poly1305MatchesTheIetfDraftVector() {
        val d = Vectors.root.o("xchacha20poly1305Draft")
        val ct = SecCrypto.seal(Bytes.unhex(d.str("keyHex")!!), Bytes.unhex(d.str("nonceHex")!!), Bytes.utf8(d.str("plaintextUtf8")!!), Bytes.unhex(d.str("aadHex")!!))
        assertEquals(d.str("ciphertextAndTagHex"), Bytes.hex(ct))
    }

    @Test
    fun publicKeysAndCommitHashesMatch() {
        for (name in listOf("gen0", "gen1-rebuild")) {
            val v = hs(name)
            for (side in listOf("desk", "assist")) {
                val s = v.o(side)
                assertEquals(s.str("epk"), Bytes.b64u(SecCrypto.publicFromPrivate(Bytes.unhex(s.str("eskHex")!!))))
                val h = SecHandshake.commitHash(if (side == "desk") Side.DESK else Side.ASSIST, Sec.SUITE, s.str("epk")!!, s.str("fpr")!!)
                assertEquals(s.str("h"), h)
                assertEquals(s.str("commitPreimage"), CanonicalJson.encode(obj("side" to side, "suite" to Sec.SUITE, "epk" to s.str("epk"), "fpr" to s.str("fpr"))))
            }
        }
    }

    @Test
    fun keyScheduleSasAndMacsMatch() {
        for (name in listOf("gen0", "gen1-rebuild")) {
            val v = hs(name)
            val e = v.o("expected")
            val d = v.o("desk")
            val a = v.o("assist")
            val ss = SecCrypto.sharedSecret(Bytes.unhex(d.str("eskHex")!!), Bytes.unb64u(a.str("epk")!!)!!)!!
            assertEquals(e.str("ssHex"), Bytes.hex(ss))
            val transcript = SecHandshake.transcript(v.str("sessionId")!!, v.int("gen")!!, Triple(d.str("h")!!, d.str("epk")!!, d.str("fpr")!!), Triple(a.str("h")!!, a.str("epk")!!, a.str("fpr")!!))
            assertEquals(e.str("transcript"), transcript)
            val t = Bytes.sha256(Bytes.utf8(transcript))
            assertEquals(e.str("transcriptHashHex"), Bytes.hex(t))
            assertEquals(e.str("prkHex"), Bytes.hex(Bytes.hmacSha256(t, ss)))
            assertEquals(e.str("kD2AHex"), Bytes.hex(SecCrypto.hkdf(ss, t, "ia-sec-v1 desk->assist", 32)))
            assertEquals(e.str("kA2DHex"), Bytes.hex(SecCrypto.hkdf(ss, t, "ia-sec-v1 assist->desk", 32)))
            val kConf = SecCrypto.hkdf(ss, t, "ia-sec-v1 confirm", 32)
            assertEquals(e.str("kConfHex"), Bytes.hex(kConf))
            assertEquals(e.str("sasRawHex"), Bytes.hex(SecCrypto.hkdf(ss, t, "ia-sec-v1 sas", 4)))
            assertEquals(e.str("sas"), SecHandshake.sasFrom(SecCrypto.hkdf(ss, t, "ia-sec-v1 sas", 4)))
            assertEquals(e.o("deskConfirm").str("mac"), Bytes.b64u(SecHandshake.confirmMac(kConf, Side.DESK, t)))
            assertEquals(e.o("assistConfirm").str("mac"), Bytes.b64u(SecHandshake.confirmMac(kConf, Side.ASSIST, t)))
        }
    }

    /** The full state machine on the Desk side, fed the Assist's vector messages, derives the vector keys and SAS. */
    @Test
    fun deskHandshakeAgainstVectorAssist() {
        for (name in listOf("gen0", "gen1-rebuild")) {
            val v = hs(name)
            val d = v.o("desk")
            val a = v.o("assist")
            val e = v.o("expected")
            val desk = SecHandshake(v.str("sessionId")!!, v.int("gen")!!, Side.DESK, d.str("fpr")!!, a.str("fpr")!!, { 1L }, Bytes.unhex(d.str("eskHex")!!))
            val commit = desk.start().single()
            assertEquals(d.o("commit").str("h"), commit.str("h"))
            assertEquals(v.int("gen"), commit.int("gen"))
            val afterCommit = desk.receive(a.o("commit"))
            assertEquals("sec.hello", afterCommit.send.single().str("t"))
            assertEquals(d.o("hello").str("epk"), afterCommit.send.single().str("epk"))
            val afterHello = desk.receive(a.o("hello"))
            assertEquals(e.o("deskConfirm").str("mac"), afterHello.send.single().str("mac"))
            assertNull(afterHello.established)
            val keys = desk.receive(e.o("assistConfirm")).established
            assertNotNull(keys)
            assertEquals(e.str("sas"), keys!!.sas)
            assertEquals(e.str("sasDisplay"), keys.sasDisplay)
            assertEquals(e.str("kD2AHex"), Bytes.hex(keys.kD2A))
            assertEquals(e.str("kA2DHex"), Bytes.hex(keys.kA2D))
        }
    }

    /** Two live state machines (random keys) agree on keys and SAS: the console side mirrors the Desk side. */
    @Test
    fun twoHandshakesAgree() {
        val fd = "a".repeat(64)
        val fa = "b".repeat(64)
        val desk = SecHandshake("s1", 3, Side.DESK, fd, fa)
        val assist = SecHandshake("s1", 3, Side.ASSIST, fa, fd)
        val toAssist = ArrayDeque(desk.start())
        val toDesk = ArrayDeque(assist.start())
        var dk: SecKeys? = null
        var ak: SecKeys? = null
        repeat(10) {
            while (toAssist.isNotEmpty()) assist.receive(toAssist.removeFirst()).also { toDesk.addAll(it.send); it.established?.let { k -> ak = k } }
            while (toDesk.isNotEmpty()) desk.receive(toDesk.removeFirst()).also { toAssist.addAll(it.send); it.established?.let { k -> dk = k } }
        }
        assertEquals(dk!!.sas, ak!!.sas)
        assertArrayEquals(dk!!.kD2A, ak!!.kD2A)
        val frame = dk!!.channel("ia.chat").sealText("hi")
        assertEquals("hi", ak!!.channel("ia.chat").open(frame).text)
    }

    @Test
    fun timeoutAfterTenSeconds() {
        var now = 0L
        val h = SecHandshake("s", 0, Side.DESK, "a".repeat(64), "b".repeat(64), { now })
        h.start()
        now = 9_999
        h.checkTimeout()
        now = 10_000
        assertFails("timeout") { h.checkTimeout() }
    }

    @Test
    fun negativeHandshakeVectors() {
        val v = hs("gen0")
        val d = v.o("desk")
        val a = v.o("assist")
        for (n in Vectors.list("negative").filter { it.str("kind") in setOf("hello", "fingerprint", "key", "mac") }) {
            val expect = n.str("expect")!!
            when (n.str("kind")) {
                "hello", "fingerprint" -> {
                    val remoteFpr = n.str("observedRemoteFpr") ?: a.str("fpr")!!
                    val desk = SecHandshake(v.str("sessionId")!!, 0, Side.DESK, d.str("fpr")!!, remoteFpr, { 1L }, Bytes.unhex(d.str("eskHex")!!))
                    desk.start()
                    desk.receive(a.o("commit"))
                    assertFails(expect) { desk.receive(n.o("hello")) }
                }
                "key" -> assertNull(SecCrypto.sharedSecret(Bytes.unhex(n.str("eskHex")!!), Bytes.unb64u(n.str("peerEpk")!!)!!))
                "mac" -> {
                    val desk = SecHandshake(v.str("sessionId")!!, 0, Side.DESK, d.str("fpr")!!, a.str("fpr")!!, { 1L }, Bytes.unhex(d.str("eskHex")!!))
                    desk.start(); desk.receive(a.o("commit")); desk.receive(a.o("hello"))
                    assertFails(expect) { desk.receive(obj("t" to "sec.confirm", "mac" to n.str("mac"), "ts" to 1)) }
                }
            }
        }
    }

    @Test
    fun orderingRules() {
        val v = hs("gen0")
        val d = v.o("desk")
        val a = v.o("assist")
        fun fresh() = SecHandshake(v.str("sessionId")!!, 0, Side.DESK, d.str("fpr")!!, a.str("fpr")!!, { 1L }, Bytes.unhex(d.str("eskHex")!!)).also { it.start() }
        assertFails("commit") { fresh().receive(a.o("hello")) } // hello before commit
        assertFails("commit") { fresh().apply { receive(a.o("commit")) }.receive(a.o("commit")) } // second commit
        assertFails("commit") { fresh().receive(JsonObject(a.o("commit") + ("gen" to toJson(1)))) } // wrong gen
        assertFails("commit") { fresh().receive(JsonObject(a.o("commit") + ("side" to toJson("desk")))) } // wrong side
        assertFails("mac") { fresh().receive(v.o("expected").o("assistConfirm")) } // confirm before keys
        assertFails("timeout") { fresh().receive(obj("t" to "sec.fail", "reason" to "timeout", "ts" to 1)) }
    }

    private fun assertFails(reason: String, block: () -> Unit) {
        try {
            block()
            fail("expected sec.fail $reason")
        } catch (e: SecFailure) {
            assertEquals(reason, e.reason)
        }
        assertTrue(reason in Sec.FAIL_REASONS)
    }
}
