package com.indiansassist.desk.net

import com.indiansassist.desk.BuildConfig
import com.indiansassist.desk.core.Bytes
import com.indiansassist.desk.core.CanonicalJson
import com.indiansassist.desk.core.JoinCode
import com.indiansassist.desk.core.JoinInput
import com.indiansassist.desk.core.SecCrypto
import com.indiansassist.desk.core.Wire
import com.indiansassist.desk.core.arr
import com.indiansassist.desk.core.long
import com.indiansassist.desk.core.objOrNull
import com.indiansassist.desk.core.str
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URI
import java.util.concurrent.TimeUnit

/** The resolved `PublicToken` fields the host needs (A section 6.7, C section 13.3). */
data class ResolvedToken(val code: String, val apiOrigin: String, val signalUrl: String, val tier: String, val technician: String?, val org: String)

class ResolveError(val userMessage: String) : Exception(userMessage)

/**
 * Token resolution (contracts section 2.1 adapted to Android): a compact token is verified locally against the
 * region's published Ed25519 keys before any lookup; a 12-digit code is Luhn-checked; then
 * `POST /api/v1/tokens/public-lookup` with `X-Requested-With: IndiansAssist` and no `Origin`, following one
 * `421 region_mismatch` to another compiled origin. Only compiled origins are ever contacted.
 */
class TokenResolver(private val http: OkHttpClient = defaultClient(), private val now: () -> Long = System::currentTimeMillis) {
    private val keyCache = HashMap<String, List<Pair<String, ByteArray>>>()

    fun resolve(code: JoinCode, apiOrigin: String = BuildConfig.DEFAULT_API_ORIGIN): ResolvedToken {
        if (apiOrigin !in regionOrigins()) throw ResolveError("This IndiansAssist server is not one this app serves.")
        when (code.kind) {
            JoinCode.Kind.COMPACT -> verifyCompact(code.value, apiOrigin)
            JoinCode.Kind.SHORT_CODE -> if (!JoinInput.isValidShortCode(code.value)) throw ResolveError("Check the code: one of the digits looks wrong.")
        }
        return lookup(code.value, apiOrigin, followed = false)
    }

    private fun verifyCompact(compact: String, apiOrigin: String) {
        val parts = compact.split('.')
        if (parts.size != 4 || parts[0] != "ia1" || !parts[1].matches(Regex("^[0-9a-f]{16}$"))) throw ResolveError("This code is not valid.")
        val payloadBytes = Bytes.unb64u(parts[2]) ?: throw ResolveError("This code is not valid.")
        val sig = Bytes.unb64u(parts[3]) ?: throw ResolveError("This code is not valid.")
        val payload = Wire.parseObject(String(payloadBytes, Charsets.UTF_8)) ?: throw ResolveError("This code is not valid.")
        val canonical = try {
            CanonicalJson.encode(payload)
        } catch (_: Exception) {
            throw ResolveError("This code is not valid.")
        }
        if (!canonical.toByteArray(Charsets.UTF_8).contentEquals(payloadBytes)) throw ResolveError("This code is not valid.")
        val keys = keys(apiOrigin)
        val pub = keys.firstOrNull { it.first == parts[1] }?.second ?: throw ResolveError("This code is not valid.")
        if (!SecCrypto.ed25519Verify(pub, sig, payloadBytes)) throw ResolveError("This code is not valid.")
        val nowSec = now() / 1000
        val iat = payload.long("iat") ?: 0
        val exp = payload.long("exp") ?: 0
        if (iat > nowSec + 60 || nowSec >= exp) throw ResolveError("This code has expired.")
    }

    private fun keys(apiOrigin: String): List<Pair<String, ByteArray>> = keyCache.getOrPut(apiOrigin) {
        val body = get("$apiOrigin/.well-known/indiansassist.json") ?: throw ResolveError("Could not verify the code. Check your connection and try again.")
        body.arr("keys")?.mapNotNull { k ->
            val o = k as? JsonObject ?: return@mapNotNull null
            val kid = o.str("kid") ?: return@mapNotNull null
            val pub = o.str("pub")?.let { Bytes.unb64u(it) }?.takeIf { it.size == 32 } ?: return@mapNotNull null
            kid to pub
        } ?: emptyList()
    }

    private fun lookup(code: String, apiOrigin: String, followed: Boolean): ResolvedToken {
        val req = Request.Builder()
            .url("$apiOrigin/api/v1/tokens/public-lookup")
            .header("X-Requested-With", "IndiansAssist")
            .post(Wire.encode(com.indiansassist.desk.core.obj("code" to code)).toRequestBody("application/json".toMediaType()))
            .build()
        val (status, body) = try {
            http.newCall(req).execute().use { it.code to Wire.parseObject(it.body?.string() ?: "") }
        } catch (_: Exception) {
            throw ResolveError("Could not reach IndiansAssist. Check your connection and try again.")
        }
        if (status == 421) {
            val other = body?.objOrNull("error")?.objOrNull("details")?.str("origin")?.trimEnd('/')
            if (!followed && other != null && other in regionOrigins() && other != apiOrigin) return lookup(code, other, true)
            throw ResolveError("This code belongs to a region this app does not serve.")
        }
        if (status != 200 || body == null) throw ResolveError("This code is not valid or has expired.")
        val tier = body.str("tier") ?: ""
        if (tier != "p3_portable") throw ResolveError("This code is for a different IndiansAssist package. Ask your technician for an app code.")
        val signal = body.str("signalUrl") ?: throw ResolveError("Unexpected answer from the server.")
        return ResolvedToken(code, apiOrigin, signal, tier, body.objOrNull("technician")?.str("name"), body.objOrNull("org")?.str("displayName") ?: "")
    }

    private fun get(url: String): JsonObject? = try {
        http.newCall(Request.Builder().url(url).get().build()).execute().use { if (it.isSuccessful) Wire.parseObject(it.body?.string() ?: "") else null }
    } catch (_: Exception) {
        null
    }

    companion object {
        fun regionOrigins(): Set<String> = BuildConfig.REGION_ORIGINS.split(',').map { it.trim().trimEnd('/') }.filter { it.isNotEmpty() }.toSet()

        /** Hosts accepted in pasted / scanned links: the compiled origins' hosts plus the web host. */
        fun linkHosts(): Set<String> = regionOrigins().flatMap { o ->
            val u = URI(o)
            listOfNotNull(u.host, if (u.port > 0) "${u.host}:${u.port}" else null)
        }.toSet() + BuildConfig.WEB_HOST

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
    }
}
