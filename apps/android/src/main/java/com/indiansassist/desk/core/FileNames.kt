package com.indiansassist.desk.core

import java.text.Normalizer
import java.util.Locale

/** Port of the shared `sanitiseFileName` (A section 8.3 F5) and the extension lists of C section 6.1 F4. */
object FileNames {
    const val MAX_NAME = 200

    // ECMAScript `\s` (WhiteSpace + LineTerminator), which Java's `\s` does not cover.
    private const val JS_WS = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
    private val STRIP = Regex("[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]")
    private val UNSAFE = Regex("[/\\\\:*?\"<>|]")
    private val WS_RUN = Regex("[$JS_WS]+")
    private val LEADING = Regex("^[.$JS_WS]+")
    private val TRAILING = Regex("[$JS_WS]+$")
    private val RESERVED = setOf("CON", "PRN", "AUX", "NUL") + (1..9).map { "COM$it" } + (1..9).map { "LPT$it" }

    val EXECUTABLE_EXTENSIONS = setOf(
        "exe", "com", "scr", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi", "msp", "msc",
        "dll", "hta", "cpl", "jar", "reg", "lnk", "app", "pkg", "dmg", "sh", "command", "apk",
        "pif", "application", "gadget", "inf", "ins", "isp", "msh", "msh1", "msh2", "mshxml", "msh1xml", "msh2xml",
        "ps1xml", "psd1", "psc1", "appref-ms", "diagcab",
    )
    val PASSIVE_RISK_EXTENSIONS = setOf("url", "scf", "library-ms", "settingcontent-ms", "website", "theme", "deskthemepack", "searchconnector-ms")

    fun sanitise(name: String, fileId: Long): String {
        var s = STRIP.replace(Normalizer.normalize(dropLoneSurrogates(name), Normalizer.Form.NFC), "")
        s = UNSAFE.replace(s, "_")
        s = WS_RUN.replace(s, " ")
        s = LEADING.replace(s, "")
        s = TRAILING.replace(s, "")
        if (codePoints(s) > MAX_NAME) {
            val dot = s.lastIndexOf('.')
            val ext = if (dot > 0) s.substring(dot) else ""
            val extLen = codePoints(ext)
            s = if (ext.isNotEmpty() && extLen < MAX_NAME) {
                TRAILING.replace(truncate(s.substring(0, dot), MAX_NAME - extLen), "") + ext
            } else {
                truncate(s, MAX_NAME)
            }
        }
        val stem = jsTrim(s.split('.')[0]).uppercase(Locale.ROOT)
        if (stem in RESERVED) s = truncate("_$s", MAX_NAME)
        if (s.isEmpty()) s = "file-$fileId"
        return s
    }

    /** Last suffix, lower-case, without the dot; null when none (`fileExtension`). */
    fun extension(name: String): String? {
        val dot = name.lastIndexOf('.')
        if (dot <= 0 || dot == name.length - 1) return null
        return name.substring(dot + 1).lowercase(Locale.ROOT)
    }

    fun isExecutable(name: String): Boolean = extension(name)?.let { it in EXECUTABLE_EXTENSIONS } ?: false

    fun isPassiveRisk(name: String): Boolean = extension(name)?.let { it in PASSIVE_RISK_EXTENSIONS } ?: false

    fun codePoints(s: String): Int = s.codePointCount(0, s.length)

    fun truncate(s: String, max: Int): String {
        if (codePoints(s) <= max) return s
        return s.substring(0, s.offsetByCodePoints(0, max))
    }

    private fun jsTrim(s: String): String = TRAILING.replace(Regex("^[$JS_WS]+").replace(s, ""), "")

    private fun dropLoneSurrogates(s: String): String {
        val sb = StringBuilder(s.length)
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (Character.isHighSurrogate(c)) {
                if (i + 1 < s.length && Character.isLowSurrogate(s[i + 1])) {
                    sb.append(c).append(s[i + 1]); i += 2; continue
                }
            } else if (!Character.isLowSurrogate(c)) {
                sb.append(c)
            }
            i++
        }
        return sb.toString()
    }
}
