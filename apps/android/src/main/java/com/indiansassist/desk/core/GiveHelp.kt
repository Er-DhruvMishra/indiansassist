package com.indiansassist.desk.core

import java.net.URI

/**
 * Phase F section 7.8 (W128): **Give help** opens the mobile Assist console (`<origin>/app/`) in an Android Custom Tab,
 * so one app per platform both gets and gives help. The tab shares Chrome's cookies, so a technician signed in there
 * stays signed in, and the installable console works unchanged. The origin is the app's compiled default
 * (`BuildConfig.DEFAULT_API_ORIGIN`) or, when several regions are compiled in, the one the technician picks from
 * `BuildConfig.REGION_ORIGINS`; nothing else is configured. No Trusted Web Activity (it would need a Digital Asset
 * Links file on every self-hosted origin) and no native controller UI. Without a Custom Tabs provider the default
 * browser opens the same URL.
 *
 * Pure (no Android types), so the origin choice and the launch plan are JVM unit-tested (`GiveHelpTest`).
 */
object GiveHelp {
    enum class Mode { CUSTOM_TAB, BROWSER }

    data class Plan(val url: String, val mode: Mode)

    /** The compiled origins, the default first, without duplicates or trailing slashes; only http(s) with a host. */
    fun origins(defaultOrigin: String, regionOrigins: String): List<String> =
        (listOf(defaultOrigin) + regionOrigins.split(','))
            .map { it.trim().trimEnd('/') }
            .filter { valid(it) }
            .distinct()

    /** A picker is shown only when more than one origin is compiled in. */
    fun needsPicker(origins: List<String>): Boolean = origins.size > 1

    /** The mobile console: `<origin>/app/` (the manifest's `start_url`, inside its scope). */
    fun consoleUrl(origin: String): String = origin.trim().trimEnd('/') + "/app/"

    fun plan(origin: String, customTabsAvailable: Boolean): Plan =
        Plan(consoleUrl(origin), if (customTabsAvailable) Mode.CUSTOM_TAB else Mode.BROWSER)

    /** A picker row: the host, with the port when it is not the scheme's default. */
    fun label(origin: String): String {
        val u = URI(origin)
        return if (u.port > 0) "${u.host}:${u.port}" else u.host
    }

    private fun valid(o: String): Boolean = try {
        val u = URI(o)
        (u.scheme == "https" || u.scheme == "http") && !u.host.isNullOrEmpty() && (u.path.isNullOrEmpty() || u.path == "/") && u.query == null && u.fragment == null
    } catch (_: Exception) {
        false
    }
}

/**
 * Phase F section 6.1: in the host's chat a phone-camera link (`${origin}/c/<12 Crockford characters>`, the link the
 * technician sends) is tappable, because this phone is the camera already. Only links to an origin the app serves
 * are made tappable; anything else stays plain text.
 */
object ChatLinks {
    private const val CROCKFORD = "[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]"

    /** The character ranges of camera links in `text` whose origin is one of `origins` (scheme://host[:port]). */
    fun cameraLinks(text: String, origins: Collection<String>): List<IntRange> {
        val allowed = origins.map { it.trim().trimEnd('/').lowercase() }.filter { it.isNotEmpty() }.toSet()
        if (allowed.isEmpty()) return emptyList()
        val re = Regex("""https?://[A-Za-z0-9.-]+(?::\d{1,5})?/c/$CROCKFORD{12}(?![0-9A-Za-z])""")
        return re.findAll(text)
            .filter { m -> m.value.substringBefore("/c/").lowercase() in allowed }
            .map { it.range }
            .toList()
    }
}
