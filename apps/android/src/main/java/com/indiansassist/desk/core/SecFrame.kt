package com.indiansassist.desk.core

import java.security.GeneralSecurityException

/** One decrypted frame: [text] for a JSON text frame (flags bit 0), else [binary]. */
class SecPlain(val text: String?, val binary: ByteArray?)

/** The section 1.3 frame codec: header (version, flags, uint64 BE seq) then XChaCha20-Poly1305 ciphertext. */
object SecFrame {
    const val VERSION = 1
    const val FLAG_TEXT = 1

    fun nonce(labelId: Int, direction: Direction, gen: Int, seq: Long): ByteArray {
        val n = ByteArray(24)
        n[0] = labelId.toByte()
        n[1] = direction.byte.toByte()
        n[2] = (gen ushr 8).toByte()
        n[3] = gen.toByte()
        Bytes.putU64be(n, 16, seq)
        return n
    }

    fun aad(sessionId: String, label: String, flags: Int): ByteArray = Bytes.concat(
        Bytes.utf8("ia-sec-v1"), Bytes.utf8(sessionId), byteArrayOf(0), Bytes.utf8(label), byteArrayOf(0),
        byteArrayOf(VERSION.toByte(), flags.toByte()),
    )

    fun seal(key: ByteArray, sessionId: String, label: String, direction: Direction, gen: Int, seq: Long, flags: Int, plaintext: ByteArray): ByteArray {
        if (plaintext.size > Sec.MAX_PLAINTEXT) throw SecFailure("oversize")
        val labelId = Sec.LABEL_IDS[label] ?: throw IllegalArgumentException("not an encrypted label: $label")
        val header = ByteArray(Sec.HEADER_BYTES)
        header[0] = VERSION.toByte()
        header[1] = flags.toByte()
        Bytes.putU64be(header, 2, seq)
        val ct = SecCrypto.seal(key, nonce(labelId, direction, gen, seq), plaintext, aad(sessionId, label, flags))
        return Bytes.concat(header, ct)
    }

    /**
     * Opens a frame expected at [expectedSeq]. Order of checks: size (`oversize`), header (`decrypt`), sequence
     * (`replay`: channels are ordered and reliable, so any other value is an attack or a bug), then the tag (`decrypt`).
     */
    fun open(key: ByteArray, sessionId: String, label: String, direction: Direction, gen: Int, expectedSeq: Long, frame: ByteArray): SecPlain {
        if (frame.size > Sec.FRAME_MAX_BYTES) throw SecFailure("oversize")
        if (frame.size < Sec.HEADER_BYTES + Sec.TAG_BYTES) throw SecFailure("decrypt", "short frame")
        if (frame[0].toInt() != VERSION) throw SecFailure("decrypt", "bad version")
        val flags = frame[1].toInt() and 0xff
        if (flags and 0xfe != 0) throw SecFailure("decrypt", "reserved flag bits")
        val seq = Bytes.u64be(frame, 2)
        if (seq != expectedSeq) throw SecFailure("replay", "seq $seq, expected $expectedSeq")
        val labelId = Sec.LABEL_IDS[label] ?: throw SecFailure("channel", "not an encrypted label")
        val pt = try {
            SecCrypto.open(key, nonce(labelId, direction, gen, seq), frame.copyOfRange(Sec.HEADER_BYTES, frame.size), aad(sessionId, label, flags))
        } catch (_: GeneralSecurityException) {
            throw SecFailure("decrypt")
        }
        return if (flags and FLAG_TEXT != 0) SecPlain(String(pt, Charsets.UTF_8), null) else SecPlain(null, pt)
    }
}

/**
 * One encrypted data channel under one key generation: a send counter and a receive counter, both starting at 0,
 * never reset or reused (obtain it through [SecKeys.channel]).
 */
class SecChannel internal constructor(private val keys: SecKeys, val label: String) {
    private var sendSeq = 0L
    private var recvSeq = 0L
    private val outDir = if (keys.localSide == Side.DESK) Direction.DESK_TO_ASSIST else Direction.ASSIST_TO_DESK
    private val inDir = if (keys.localSide == Side.DESK) Direction.ASSIST_TO_DESK else Direction.DESK_TO_ASSIST
    private val outKey get() = if (keys.localSide == Side.DESK) keys.kD2A else keys.kA2D
    private val inKey get() = if (keys.localSide == Side.DESK) keys.kA2D else keys.kD2A

    @Synchronized
    fun sealText(text: String): ByteArray = seal(SecFrame.FLAG_TEXT, Bytes.utf8(text))

    @Synchronized
    fun sealBinary(data: ByteArray): ByteArray = seal(0, data)

    private fun seal(flags: Int, pt: ByteArray): ByteArray {
        val f = SecFrame.seal(outKey, keys.sessionId, label, outDir, keys.gen, sendSeq, flags, pt)
        sendSeq++
        return f
    }

    /** Opens the next inbound frame; throws [SecFailure] (the caller then runs section 1.3 step 9). */
    @Synchronized
    fun open(frame: ByteArray): SecPlain {
        val p = SecFrame.open(inKey, keys.sessionId, label, inDir, keys.gen, recvSeq, frame)
        recvSeq++
        return p
    }
}
