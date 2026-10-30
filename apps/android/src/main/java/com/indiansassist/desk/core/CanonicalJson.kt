package com.indiansassist.desk.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Canonical JSON (Phase A contracts section 5.1, the shared `canonicalJson`): keys sorted by UTF-16 code unit,
 * no whitespace, strings escaped exactly as ECMAScript `JSON.stringify`, integers only, arrays keep order.
 */
object CanonicalJson {
    class CanonicalJsonError(message: String) : IllegalArgumentException(message)

    private const val MAX_SAFE = 9007199254740991L

    fun encode(value: JsonElement): String = StringBuilder().also { write(it, value, "$") }.toString()

    private fun write(sb: StringBuilder, v: JsonElement, path: String) {
        when (v) {
            is JsonNull -> sb.append("null")
            is JsonPrimitive -> when {
                v.isString -> quote(sb, v.content)
                v.booleanOrNull != null -> sb.append(if (v.booleanOrNull == true) "true" else "false")
                else -> {
                    val n = v.longOrNull ?: throw CanonicalJsonError("non-integer number at $path")
                    if (n > MAX_SAFE || n < -MAX_SAFE) throw CanonicalJsonError("unsafe integer at $path")
                    sb.append(n.toString())
                }
            }
            is JsonArray -> {
                sb.append('[')
                v.forEachIndexed { i, e ->
                    if (i > 0) sb.append(',')
                    write(sb, e, "$path[$i]")
                }
                sb.append(']')
            }
            is JsonObject -> {
                sb.append('{')
                // Kotlin String.compareTo compares UTF-16 code units, as JCS requires.
                v.keys.sorted().forEachIndexed { i, k ->
                    if (i > 0) sb.append(',')
                    quote(sb, k)
                    sb.append(':')
                    write(sb, v.getValue(k), "$path.$k")
                }
                sb.append('}')
            }
        }
    }

    /** `JSON.stringify` string escaping (ES2019 well-formed: lone surrogates as `\uXXXX`). */
    fun quote(sb: StringBuilder, s: String) {
        sb.append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i]
            val code = c.code
            when {
                code == 0x22 -> sb.append('\\').append('"')
                code == 0x5c -> sb.append('\\').append('\\')
                code == 0x08 -> sb.append('\\').append('b')
                code == 0x0c -> sb.append('\\').append('f')
                code == 0x0a -> sb.append('\\').append('n')
                code == 0x0d -> sb.append('\\').append('r')
                code == 0x09 -> sb.append('\\').append('t')
                code < 0x20 -> sb.append('\\').append('u').append(String.format("%04x", code))
                Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> {
                    sb.append(c).append(s[i + 1])
                    i++
                }
                Character.isSurrogate(c) -> sb.append('\\').append('u').append(String.format("%04x", code))
                else -> sb.append(c)
            }
            i++
        }
        sb.append('"')
    }
}
