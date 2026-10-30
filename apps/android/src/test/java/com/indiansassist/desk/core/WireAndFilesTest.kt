package com.indiansassist.desk.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File

/** kotlinx.serialization parity of the wire types, the outbox and audit aggregates, and the file receiver rules. */
class WireAndFilesTest {
    @Test
    fun deskClientRoundTripsWithContractKeys() {
        val c = DeskClient(version = "0.3.0", platform = ClientPlatform("14", DeskClient.archOf("arm64-v8a")), tokenSource = TokenSource.DEEPLINK.wire, capabilities = AgentCapabilities())
        val j = DeskSignal.clientJson(c)
        assertEquals(setOf("kind", "version", "os", "platform", "tokenSource", "capabilities"), j.keys)
        assertEquals(setOf("monitors", "elevation", "features", "encoders", "hwEncoder", "interpreters"), j.objOrNull("capabilities")!!.keys)
        assertEquals(c, Wire.json.decodeFromJsonElement<DeskClient>(j))
        assertEquals("x64", DeskClient.archOf("x86_64"))
        assertEquals("other", DeskClient.archOf("armeabi-v7a"))
        assertEquals("IndiansAssist-Android/0.3.0 (Android 35; x86_64)", DeskClient.userAgent("0.3.0", 35, "x86_64"))
    }

    /** When the shared stream publishes JSON fixtures under packages/shared/test/fixtures/agent, each must re-encode losslessly. */
    @Test
    fun sharedFixturesReencodeWhenPresent() {
        val dir = File(System.getProperty("ia.sharedFixtures") ?: "../../packages/shared/test/fixtures/agent")
        val files = dir.listFiles { f -> f.name.endsWith(".json") } ?: return
        for (f in files) {
            val parsed = Wire.json.parseToJsonElement(f.readText())
            assertEquals(f.name, parsed, Wire.json.parseToJsonElement(parsed.toString()))
        }
    }

    @Test
    fun iceServersAcceptStringOrList() {
        val l = IceServer.parseList(kotlinx.serialization.json.JsonArray(listOf(obj("urls" to "stun:a"), obj("urls" to listOf("turn:b", "turns:c"), "username" to "u", "credential" to "p"), obj("x" to 1))))
        assertEquals(listOf("stun:a"), l[0].urls)
        assertEquals("p", l[1].credential)
        assertEquals(2, l.size)
    }

    @Test
    fun outboxDrainsAt4PerSecondWithBurst15AndNeverDrops() {
        var now = 0L
        val ob = AttestOutbox { now }
        repeat(50) { ob.add(OutboxEntry("control.input", obj("n" to it))) }
        val frames = mutableListOf<JsonObject>()
        ob.drain("s") { frames += it; true }
        assertEquals(15, frames.size)
        var t = 0
        while (ob.size > 0 && t < 20) {
            now += 1000; t++
            ob.drain("s") { frames += it; true }
        }
        assertEquals(50, frames.size)
        assertTrue("all 50 within 10 s", now <= 10_000)
        // rate_limited re-queues at the head without loss.
        val first = frames.last().str("id")!!
        ob.rateLimited(first)
        assertEquals(1, ob.size)
        now += 1000
        val again = mutableListOf<JsonObject>()
        ob.drain("s") { again += it; true }
        assertEquals(first, again.single().str("id"))
        // A closed socket keeps the entry.
        ob.add(OutboxEntry("a11y.state", obj("enabled" to true)))
        ob.drain("s") { false }
        assertEquals(1, ob.size)
    }

    @Test
    fun textBurstAboveTwoHundredChars() {
        val a = InputAudit { 0L }
        a.op("text"); a.text(150); a.op("text"); a.text(60)
        val out = a.flush(force = true)
        assertEquals(listOf("control.input", "input.text_burst"), out.map { it.action })
        assertEquals(210, out[1].data.int("chars"))
        assertTrue(a.flush(force = true).isEmpty())
    }

    private class MemSink : FileSink {
        val buf = ByteArrayOutputStream()
        var committed = false
        var aborted = false
        override fun write(bytes: ByteArray, off: Int, len: Int) = buf.write(bytes, off, len)
        override fun commit(): String { committed = true; return "Download/IndiansAssist/x" }
        override fun abort() { aborted = true }
    }

    private fun offer(fileId: Long, name: String, data: ByteArray) = obj(
        "t" to "file.offer", "fileId" to fileId, "name" to name, "size" to data.size, "mime" to "text/plain",
        "sha256" to Bytes.hex(Bytes.sha256(data)), "chunkSize" to 16384, "chunks" to (data.size + 16383) / 16384, "ts" to 1,
    )

    @Test
    fun receivesAFileInChunksAndAttests() {
        var sink: MemSink? = null
        val r = FileReceiver({ MemSink().also { s -> sink = s } }) { 1L }
        val data = ByteArray(40_000) { (it % 251).toByte() }
        val p = r.onOffer(offer(1, "../report.txt", data))
        assertEquals("_report.txt", p.prompt!!.name)
        assertEquals("file.accept", r.accept(1).send.single().str("t"))
        for (i in 0 until 3) {
            val end = minOf(data.size, (i + 1) * 16384)
            assertTrue(r.onChunk(FileReceiver.chunk(1, i.toLong(), data.copyOfRange(i * 16384, end))).send.isEmpty())
        }
        val done = r.onDone(obj("t" to "file.done", "fileId" to 1))
        assertEquals(true, done.send.single().bool("ok"))
        assertEquals("file.received", done.attest!!.action)
        assertEquals("assist_to_desk", done.attest!!.data.str("direction"))
        assertTrue(sink!!.committed)
        assertTrue(sink!!.buf.toByteArray().contentEquals(data))
    }

    @Test
    fun offerRulesAndChunkRules() {
        val r = FileReceiver({ MemSink() }, maxBytes = 1000) { 1L }
        assertEquals("bad_name", r.onOffer(offer(1, "evil.url", ByteArray(3))).send.single().str("reason"))
        assertEquals("bad_name", r.onOffer(offer(1, "", ByteArray(3))).send.single().str("reason"))
        assertEquals("too_large", r.onOffer(offer(1, "big.bin", ByteArray(1001))).send.single().str("reason"))
        assertNotNull(r.onOffer(offer(2, "a.exe", ByteArray(10))).prompt!!.takeIf { it.executable })
        assertEquals("busy", r.onOffer(offer(3, "b.txt", ByteArray(1))).send.single().str("reason"))
        // A chunk before accept is bad_chunk.
        assertEquals("bad_chunk", r.onChunk(FileReceiver.chunk(2, 0, ByteArray(10))).send.single().str("reason"))
        assertNotNull(r.onOffer(offer(4, "c.txt", ByteArray(20))).prompt)
        r.accept(4)
        assertEquals("bad_chunk", r.onChunk(FileReceiver.chunk(4, 5, ByteArray(20))).send.single().str("reason"))
        val r2 = FileReceiver({ MemSink() }) { 1L }
        r2.onOffer(offer(9, "x.txt", ByteArray(20))); r2.accept(9)
        assertEquals("overflow", r2.onChunk(FileReceiver.chunk(9, 0, ByteArray(21))).send.single().str("reason"))
        val r3 = FileReceiver({ MemSink() }) { 1L }
        r3.onOffer(offer(7, "y.txt", ByteArray(5))); r3.accept(7)
        r3.onChunk(FileReceiver.chunk(7, 0, byteArrayOf(1, 2, 3, 4, 5).reversedArray()))
        assertEquals(false, r3.onDone(obj("t" to "file.done", "fileId" to 7)).send.single().bool("ok"))
        val r4 = FileReceiver({ MemSink() }) { 1L }
        r4.onOffer(offer(8, "z.txt", ByteArray(5)))
        assertEquals("declined", r4.decline(8).send.single().str("reason"))
    }
}
