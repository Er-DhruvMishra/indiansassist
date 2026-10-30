package com.indiansassist.desk.core

import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Encoding and hashing helpers (conventions: lower-case hex, base64url without padding). */
object Bytes {
    private val HEX = "0123456789abcdef".toCharArray()

    fun hex(b: ByteArray): String {
        val out = CharArray(b.size * 2)
        for (i in b.indices) {
            val v = b[i].toInt() and 0xff
            out[i * 2] = HEX[v ushr 4]
            out[i * 2 + 1] = HEX[v and 0x0f]
        }
        return String(out)
    }

    fun unhex(s: String): ByteArray {
        require(s.length % 2 == 0) { "odd hex length" }
        return ByteArray(s.length / 2) { i -> s.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }

    fun b64u(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)

    /** Strict base64url decode: no padding, url alphabet only; null on any other input. */
    fun unb64u(s: String): ByteArray? {
        if (s.contains('=') || s.contains('+') || s.contains('/')) return null
        return try {
            Base64.getUrlDecoder().decode(s)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

    fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)

    fun sha256Hex(s: String): String = hex(sha256(utf8(s)))

    fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    /** Constant-time comparison (section 1.3 steps 3a, 3b, 6). */
    fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

    fun constantTimeEquals(a: String, b: String): Boolean = MessageDigest.isEqual(utf8(a), utf8(b))

    fun concat(vararg parts: ByteArray): ByteArray {
        val out = ByteArray(parts.sumOf { it.size })
        var o = 0
        for (p in parts) {
            System.arraycopy(p, 0, out, o, p.size)
            o += p.size
        }
        return out
    }

    fun u32be(b: ByteArray, off: Int = 0): Long =
        ((b[off].toLong() and 0xff) shl 24) or ((b[off + 1].toLong() and 0xff) shl 16) or
            ((b[off + 2].toLong() and 0xff) shl 8) or (b[off + 3].toLong() and 0xff)

    fun putU32be(b: ByteArray, off: Int, v: Long) {
        b[off] = (v ushr 24).toByte(); b[off + 1] = (v ushr 16).toByte(); b[off + 2] = (v ushr 8).toByte(); b[off + 3] = v.toByte()
    }

    fun putU64be(b: ByteArray, off: Int, v: Long) {
        for (i in 0 until 8) b[off + i] = (v ushr (56 - 8 * i)).toByte()
    }

    fun u64be(b: ByteArray, off: Int): Long {
        var v = 0L
        for (i in 0 until 8) v = (v shl 8) or (b[off + i].toLong() and 0xff)
        return v
    }

    fun zeroise(vararg arrays: ByteArray?) {
        for (a in arrays) a?.fill(0)
    }
}
