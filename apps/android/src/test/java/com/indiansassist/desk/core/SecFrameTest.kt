package com.indiansassist.desk.core

import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

/** Section 1.3 frame format: every vector frame for all six label ids, sequence and replay rules, size limit. */
class SecFrameTest {
    private fun keysFor(gen: Int): Pair<ByteArray, ByteArray> {
        val e = Vectors.list("handshakes").first { it.int("gen") == gen }.objOrNull("expected")!!
        return Bytes.unhex(e.str("kD2AHex")!!) to Bytes.unhex(e.str("kA2DHex")!!)
    }

    private val sessionId get() = Vectors.handshake("gen0").str("sessionId")!!

    private fun dir(s: String) = if (s == "desk_to_assist") Direction.DESK_TO_ASSIST else Direction.ASSIST_TO_DESK

    private fun plaintext(f: JsonObject): ByteArray = f.str("plaintextUtf8")?.let { Bytes.utf8(it) } ?: Bytes.unhex(f.str("plaintextHex")!!)

    @Test
    fun sealMatchesEveryVectorFrame() {
        val labelsSeen = HashSet<Int>()
        for (f in Vectors.list("frames")) {
            val (d2a, a2d) = keysFor(f.int("gen")!!)
            val direction = dir(f.str("direction")!!)
            val key = if (direction == Direction.DESK_TO_ASSIST) d2a else a2d
            val label = f.str("label")!!
            val seq = f.long("seq")!!
            assertEquals(f.str("nonceHex"), Bytes.hex(SecFrame.nonce(Sec.LABEL_IDS[label]!!, direction, f.int("gen")!!, seq)))
            assertEquals(f.str("aadHex"), Bytes.hex(SecFrame.aad(sessionId, label, f.int("flags")!!)))
            val sealed = SecFrame.seal(key, sessionId, label, direction, f.int("gen")!!, seq, f.int("flags")!!, plaintext(f))
            assertEquals(f.str("frameHex"), Bytes.hex(sealed))
            val opened = SecFrame.open(key, sessionId, label, direction, f.int("gen")!!, seq, Bytes.unhex(f.str("frameHex")!!))
            if (f.int("flags") == 1) assertEquals(f.str("plaintextUtf8"), opened.text) else assertArrayEquals(plaintext(f), opened.binary)
            labelsSeen += f.int("labelId")!!
        }
        assertEquals(setOf(1, 2, 3, 4, 5, 6), labelsSeen)
    }

    @Test
    fun negativeFrameVectors() {
        for (n in Vectors.list("negative").filter { it.str("kind") == "frame" }) {
            val (d2a, a2d) = keysFor(n.int("gen")!!)
            val direction = dir(n.str("direction")!!)
            val key = if (direction == Direction.DESK_TO_ASSIST) d2a else a2d
            try {
                SecFrame.open(key, sessionId, n.str("label")!!, direction, n.int("gen")!!, n.long("expectedSeq")!!, Bytes.unhex(n.str("frameHex")!!))
                fail("${n.str("name")}: expected ${n.str("expect")}")
            } catch (e: SecFailure) {
                assertEquals(n.str("name"), n.str("expect"), e.reason)
            }
        }
    }

    private fun pair(gen: Int = 0): Pair<SecKeys, SecKeys> {
        val k1 = ByteArray(32) { 1 }
        val k2 = ByteArray(32) { 2 }
        return SecKeys("s", gen, k1.copyOf(), k2.copyOf(), "000001", Side.DESK) to SecKeys("s", gen, k1.copyOf(), k2.copyOf(), "000001", Side.ASSIST)
    }

    @Test
    fun channelSequenceAndReplay() {
        val (desk, assist) = pair()
        val tx = desk.channel("ia.control")
        val rx = assist.channel("ia.control")
        val f0 = tx.sealText("{\"a\":0}")
        val f1 = tx.sealBinary(byteArrayOf(9, 8, 7))
        assertEquals("{\"a\":0}", rx.open(f0).text)
        assertNull(rx.open(f1).text)
        try {
            rx.open(f1)
            fail("replay accepted")
        } catch (e: SecFailure) {
            assertEquals("replay", e.reason)
        }
        // The other direction uses the other key and its own counter.
        assertEquals("pong", tx.open(rx.sealText("pong")).text)
    }

    @Test
    fun secondChannelUnderSameKeysRefusesToRestartAtZero() {
        val (desk, _) = pair()
        desk.channel("ia.file")
        try {
            desk.channel("ia.file")
            fail("second SecChannel allowed")
        } catch (_: IllegalStateException) {
        }
        // A new key generation may open the label again.
        pair(1).first.channel("ia.file")
    }

    @Test
    fun oversizeOnSendAndReceive() {
        val (desk, _) = pair()
        val ch = desk.channel("ia.file")
        ch.sealBinary(ByteArray(Sec.MAX_PLAINTEXT))
        try {
            ch.sealBinary(ByteArray(Sec.MAX_PLAINTEXT + 1))
            fail("oversize accepted")
        } catch (e: SecFailure) {
            assertEquals("oversize", e.reason)
        }
        try {
            SecFrame.open(ByteArray(32), "s", "ia.file", Direction.DESK_TO_ASSIST, 0, 0, ByteArray(Sec.FRAME_MAX_BYTES + 1))
            fail("oversize frame accepted")
        } catch (e: SecFailure) {
            assertEquals("oversize", e.reason)
        }
    }

    @Test
    fun wrongGenerationOrSessionFailsToDecrypt() {
        val f = Vectors.list("frames").first()
        val (_, a2d) = keysFor(0)
        for ((sid, gen) in listOf("other-session" to 0, sessionId to 1)) {
            try {
                SecFrame.open(a2d, sid, f.str("label")!!, Direction.ASSIST_TO_DESK, gen, 0, Bytes.unhex(f.str("frameHex")!!))
                fail("decrypted under $sid/$gen")
            } catch (e: SecFailure) {
                assertEquals("decrypt", e.reason)
            }
        }
    }
}
