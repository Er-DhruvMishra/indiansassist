package com.indiansassist.desk.core

import kotlinx.serialization.json.JsonObject
import java.security.MessageDigest
import java.util.BitSet

/** Where a received file is streamed (MediaStore Downloads on the device, memory in tests). */
interface FileSink {
    fun write(bytes: ByteArray, off: Int, len: Int)
    /** Publishes the file; returns where it was saved. */
    fun commit(): String
    fun abort()
}

/** An offer waiting for the Desk's decision (section 6.1 F4 prompt). */
data class IncomingOffer(val fileId: Long, val name: String, val size: Long, val mime: String, val executable: Boolean)

/** Results of receiver steps: frames to send on `ia.file`, the prompt to show, attestation, and the saved place. */
data class FileStep(
    val send: List<JsonObject> = emptyList(),
    val prompt: IncomingOffer? = null,
    val attest: OutboxEntry? = null,
    val savedTo: String? = null,
)

/**
 * The receiving half of A section 8.3 for the host (C section 6.1): offer validation (`bad_name` for an empty or
 * over-long name and for passive-risk extensions, `too_large` above 2 GiB, `busy` for a second transfer), the F4
 * chunk rules, streaming sha256, and `file.ack` with `desk.event file.received` attestation.
 */
class FileReceiver(private val openSink: (IncomingOffer) -> FileSink, private val maxBytes: Long = MAX_NATIVE_BYTES, private val clock: () -> Long = System::currentTimeMillis) {
    private class Rx(val offer: IncomingOffer, val sha256: String, val chunks: Long) {
        var accepted = false
        var sink: FileSink? = null
        val seen = BitSet()
        var bytes = 0L
        val digest: MessageDigest = MessageDigest.getInstance("SHA-256")
    }

    private var rx: Rx? = null

    val busy: Boolean get() = rx != null

    private fun msg(vararg p: Pair<String, Any?>) = obj(*p, "ts" to clock())

    fun onOffer(m: JsonObject): FileStep {
        val fileId = m.long("fileId")?.takeIf { it in 1..0xffffffffL } ?: return FileStep()
        val reject = { reason: String -> FileStep(send = listOf(msg("t" to "file.reject", "fileId" to fileId, "reason" to reason))) }
        if (rx != null) return reject("busy")
        val rawName = m.str("name") ?: ""
        if (rawName.isEmpty() || rawName.length > 255) return reject("bad_name")
        val name = FileNames.sanitise(rawName, fileId)
        if (FileNames.isPassiveRisk(name) || name.contains('/') || name.contains('\\')) return reject("bad_name")
        val size = m.long("size")?.takeIf { it >= 0 } ?: return reject("bad_name")
        if (size > maxBytes) return reject("too_large")
        val sha = m.str("sha256")?.lowercase()?.takeIf { it.matches(Regex("^[0-9a-f]{64}$")) } ?: return reject("bad_name")
        val chunks = (size + CHUNK - 1) / CHUNK
        if (m.long("chunkSize") != CHUNK || m.long("chunks") != chunks) return reject("bad_name")
        val offer = IncomingOffer(fileId, name, size, m.str("mime") ?: "application/octet-stream", FileNames.isExecutable(name))
        rx = Rx(offer, sha, chunks)
        return FileStep(prompt = offer)
    }

    fun accept(fileId: Long): FileStep {
        val r = rx?.takeIf { it.offer.fileId == fileId && !it.accepted } ?: return FileStep()
        r.sink = openSink(r.offer)
        r.accepted = true
        return FileStep(send = listOf(msg("t" to "file.accept", "fileId" to fileId)))
    }

    /** Declined in the prompt, or no answer in 60 s. */
    fun decline(fileId: Long): FileStep {
        val r = rx?.takeIf { it.offer.fileId == fileId && !it.accepted } ?: return FileStep()
        rx = null
        return FileStep(send = listOf(msg("t" to "file.reject", "fileId" to r.offer.fileId, "reason" to "declined")))
    }

    /** A binary chunk: `[0,4)` fileId, `[4,8)` chunkIndex, payload. */
    fun onChunk(frame: ByteArray): FileStep {
        if (frame.size < 8) return FileStep()
        val fileId = Bytes.u32be(frame, 0)
        val index = Bytes.u32be(frame, 4)
        val r = rx
        if (r == null || r.offer.fileId != fileId || !r.accepted) return cancel(fileId, "bad_chunk")
        val n = frame.size - 8
        val last = index == r.chunks - 1
        when {
            index >= r.chunks || r.seen.get(index.toInt()) -> return cancel(fileId, "bad_chunk")
            n > CHUNK || (!last && n < CHUNK) -> return cancel(fileId, "bad_chunk")
            r.bytes + n > r.offer.size -> return cancel(fileId, "overflow")
        }
        r.seen.set(index.toInt())
        r.bytes += n
        r.digest.update(frame, 8, n)
        r.sink!!.write(frame, 8, n)
        return FileStep()
    }

    fun onDone(m: JsonObject): FileStep {
        val r = rx ?: return FileStep()
        if (m.long("fileId") != r.offer.fileId || !r.accepted) return FileStep()
        if (r.seen.cardinality().toLong() != r.chunks || r.bytes != r.offer.size) return cancel(r.offer.fileId, "bad_chunk")
        val got = Bytes.hex(r.digest.digest())
        val ok = got == r.sha256
        rx = null
        val saved = if (ok) r.sink!!.commit() else { r.sink!!.abort(); null }
        val ack = msg("t" to "file.ack", "fileId" to r.offer.fileId, "ok" to ok, "sha256" to got)
        val attest = if (ok) OutboxEntry("file.received", obj("fileId" to r.offer.fileId, "direction" to "assist_to_desk", "name" to r.offer.name, "bytes" to r.bytes, "sha256" to got)) else null
        return FileStep(send = listOf(ack), attest = attest, savedTo = saved)
    }

    fun onCancel(m: JsonObject): FileStep {
        val r = rx ?: return FileStep()
        if (m.long("fileId") == r.offer.fileId) {
            r.sink?.abort()
            rx = null
        }
        return FileStep()
    }

    /** Teardown or Stop: discard any partial file. */
    fun abortAll() {
        rx?.sink?.abort()
        rx = null
    }

    private fun cancel(fileId: Long, reason: String): FileStep {
        rx?.takeIf { it.offer.fileId == fileId }?.let { it.sink?.abort(); rx = null }
        return FileStep(send = listOf(msg("t" to "file.cancel", "fileId" to fileId, "reason" to reason)))
    }

    companion object {
        const val CHUNK = 16_384L
        const val MAX_NATIVE_BYTES = 2_147_483_648L

        /** The binary chunk plaintext of A section 8.3. */
        fun chunk(fileId: Long, index: Long, payload: ByteArray, len: Int = payload.size): ByteArray {
            val out = ByteArray(8 + len)
            Bytes.putU32be(out, 0, fileId)
            Bytes.putU32be(out, 4, index)
            System.arraycopy(payload, 0, out, 8, len)
            return out
        }
    }
}
