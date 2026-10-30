package com.indiansassist.desk.core

import java.net.URI
import java.net.URLDecoder

/** A normalised join code (A section 3.3 `normaliseTokenInput`). */
data class JoinCode(val kind: Kind, val value: String) {
    enum class Kind(val wire: String) { COMPACT("compact"), SHORT_CODE("short_code") }
}

/** Where the code came from (`TOKEN_SOURCES`, sent as `desk.hello.client.tokenSource`). */
enum class TokenSource(val wire: String) { DEEPLINK("deeplink"), MANUAL("manual") }

/** Token entry parsing for the Android host (contracts section 12.3): pasted text, QR payloads, App Links, deep links. */
object JoinInput {
    private val WS = Regex("\\s+")
    private val NON_DIGITS = Regex("\\D+")
    private val SHORT_CODE = Regex("^[1-9]\\d{11}$")

    /** Trim; `ia1.` => compact with whitespace removed; else exactly 12 digits => short code; else null. */
    fun normalise(s: String): JoinCode? {
        val t = s.trim()
        if (t.startsWith("ia1.")) return JoinCode(JoinCode.Kind.COMPACT, t.replace(WS, ""))
        val digits = t.replace(NON_DIGITS, "")
        return if (digits.length == 12) JoinCode(JoinCode.Kind.SHORT_CODE, digits) else null
    }

    /** `isValidShortCode`: 12 digits, first 1-9, Luhn-valid. */
    fun isValidShortCode(code: String): Boolean {
        if (!SHORT_CODE.matches(code)) return false
        var sum = 0
        for ((i, ch) in code.reversed().withIndex()) {
            var d = ch - '0'
            if (i % 2 == 1) {
                d *= 2
                if (d > 9) d -= 9
            }
            sum += d
        }
        return sum % 10 == 0
    }

    /**
     * Accepts what a person pastes or a QR encodes: a bare code, `https://<host>/join#t=<code>` (or `?t=`), or
     * `indiansassist://join?t=<compact>` / `?c=<12 digits>`. For web links the host must be one of [allowedHosts]
     * (the compiled region hosts); anything else is null. Nothing is ever executed from the input.
     */
    fun parseAny(raw: String, allowedHosts: Set<String>): JoinCode? {
        val s = raw.trim()
        if (s.startsWith("indiansassist:", ignoreCase = true) || s.startsWith("http://", true) || s.startsWith("https://", true)) {
            return parseLink(s, allowedHosts)
        }
        return normalise(s)
    }

    /** Strict link grammar (A section 3.6, C section 2.5 L2 adapted to Android). */
    fun parseLink(link: String, allowedHosts: Set<String>): JoinCode? {
        val uri = try {
            URI(link)
        } catch (_: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        return when (scheme) {
            "indiansassist" -> {
                if (uri.host?.lowercase() != "join" && uri.rawSchemeSpecificPart?.startsWith("//join") != true) return null
                val q = params(uri.rawQuery)
                if (q.keys.any { it != "t" && it != "c" }) return null
                q["t"]?.let { normalise(it)?.takeIf { c -> c.kind == JoinCode.Kind.COMPACT } }
                    ?: q["c"]?.let { normalise(it)?.takeIf { c -> c.kind == JoinCode.Kind.SHORT_CODE } }
            }
            "https", "http" -> {
                val host = uri.host?.lowercase() ?: return null
                val hostPort = if (uri.port > 0) "$host:${uri.port}" else host
                if (host !in allowedHosts && hostPort !in allowedHosts) return null
                if (uri.path?.trimEnd('/') !in setOf("/join", "/download")) return null
                val t = params(uri.rawFragment)["t"] ?: params(uri.rawQuery)["t"] ?: return null
                normalise(t)
            }
            else -> null
        }
    }

    private fun params(raw: String?): Map<String, String> {
        if (raw.isNullOrEmpty()) return emptyMap()
        val out = LinkedHashMap<String, String>()
        for (part in raw.split('&')) {
            if (part.isEmpty()) continue
            val eq = part.indexOf('=')
            val k = if (eq < 0) part else part.substring(0, eq)
            val v = if (eq < 0) "" else part.substring(eq + 1)
            out[decode(k)] = decode(v)
        }
        return out
    }

    private fun decode(s: String): String = try {
        URLDecoder.decode(s, "UTF-8")
    } catch (_: Exception) {
        s
    }

    /** `4821 9365 7715` for display. */
    fun formatShortCode(code: String): String = if (code.length == 12) "${code.substring(0, 4)} ${code.substring(4, 8)} ${code.substring(8)}" else code
}

/** `fingerprintFromSdp` (section 1.3 step 1): session-level `a=fingerprint:sha-256`, else the first media level. */
object Fingerprint {
    private val LINE = Regex("^a=fingerprint:sha-256\\s+([0-9A-Fa-f:]+)\\s*$", RegexOption.IGNORE_CASE)

    fun fromSdp(sdp: String): String? {
        var session: String? = null
        var media: String? = null
        var inMedia = false
        for (raw in sdp.split('\n')) {
            val line = raw.trimEnd('\r')
            if (line.startsWith("m=")) inMedia = true
            val m = LINE.find(line) ?: continue
            val norm = m.groupValues[1].replace(":", "").lowercase()
            if (norm.length != 64) continue
            if (!inMedia && session == null) session = norm
            if (inMedia && media == null) media = norm
        }
        return session ?: media
    }
}
