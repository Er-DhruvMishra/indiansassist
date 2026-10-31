package com.indiansassist.desk.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject

/** `AgentCapabilities` (contracts section 3.1, Android subset of section 12.4). */
@Serializable
data class AgentCapabilities(
    val monitors: Int = 1,
    val elevation: String = "user",
    val features: List<String> = ANDROID_FEATURES,
    val encoders: List<String> = listOf("vp8", "h264"),
    val hwEncoder: Boolean = true,
    val interpreters: List<String> = emptyList(),
) {
    companion object {
        /**
         * Section 12.4: `multi_monitor`, `clipboard`, `elevation`, `playbooks` are absent so the console greys them.
         * `recorder`: the host answers the A.2 server recorder's offer (RecorderPeer), so the API may assign one.
         */
        val ANDROID_FEATURES = listOf("screen", "input", "input_text", "nav", "files", "chat", "voice", "recorder")

        /** `AGENT_FEATURES` (+ `nav`). */
        val AGENT_FEATURES = setOf(
            "screen", "multi_monitor", "input", "input_text", "clipboard", "files", "chat", "voice", "elevation", "playbooks",
            "input_lock", "privacy_screen", "nav", "recorder",
        )
    }
}

@Serializable
data class ClientPlatform(val osVersion: String, val arch: String)

/** `desk.hello.client` for `kind: 'native'`, `os: 'android'`. */
@Serializable
data class DeskClient(
    val kind: String = "native",
    val version: String,
    val os: String = "android",
    val platform: ClientPlatform,
    val tokenSource: String,
    val capabilities: AgentCapabilities,
) {
    companion object {
        /** Maps `Build.SUPPORTED_ABIS[0]` to the wire `arch` enum (`x64 | arm64 | x86 | other`). */
        fun archOf(abi: String): String = when (abi) {
            "arm64-v8a" -> "arm64"
            "x86_64" -> "x64"
            "x86" -> "x86"
            else -> "other"
        }

        /** `IndiansAssist-Android/<version> (Android <sdk>; <abi>)` (section 3.1). */
        fun userAgent(version: String, sdk: Int, abi: String) = "IndiansAssist-Android/$version (Android $sdk; $abi)"
    }
}

/** An `RTCIceServer` as the server sends it (`urls` may be a string or a list). */
data class IceServer(val urls: List<String>, val username: String?, val credential: String?) {
    companion object {
        fun parseList(arr: JsonArray?): List<IceServer> = arr?.mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            val urls = when (val u = o["urls"]) {
                is JsonPrimitive -> listOfNotNull(u.content.takeIf { u.isString })
                is JsonArray -> u.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
                else -> emptyList()
            }
            if (urls.isEmpty()) null else IceServer(urls, o.str("username"), o.str("credential"))
        } ?: emptyList()
    }
}

/** Builders for every Desk -> server `/signal` frame the host sends (A section 7.3, C sections 3.1, 3.4). */
object DeskSignal {
    private fun client(c: DeskClient): JsonElement = Wire.json.encodeToJsonElement(c)

    fun hello(token: String, client: DeskClient, deskLabel: String?, resumeKey: String?): JsonObject =
        obj("t" to "desk.hello", "token" to token, "deskLabel" to deskLabel, "resumeKey" to resumeKey, "client" to client(client))

    fun knock(deskLabel: String?) = obj("t" to "desk.knock", "deskLabel" to deskLabel)
    fun poll() = obj("t" to "desk.poll")
    fun pong(re: String?) = obj("t" to "pong", "re" to re)

    fun consentGranted(sessionId: String, level: String) = obj(
        "t" to "desk.consent", "sessionId" to sessionId, "state" to "granted", "surface" to "monitor",
        "native" to obj("level" to level, "monitors" to listOf(1), "clipboard" to false),
    )

    fun consentRevoked(sessionId: String) = obj("t" to "desk.consent", "sessionId" to sessionId, "state" to "revoked")

    fun consentLevel(sessionId: String, level: String, id: String? = null, requested: Boolean? = null, opId: String? = null) =
        obj("t" to "desk.consent_level", "id" to id, "sessionId" to sessionId, "level" to level, "requested" to requested, "opId" to opId)

    fun offer(sessionId: String, sdp: String, restart: Boolean?, gen: Int?) =
        obj("t" to "webrtc.offer", "sessionId" to sessionId, "sdp" to sdp, "restart" to restart, "gen" to gen)

    fun answer(sessionId: String, sdp: String, peer: String?) = obj("t" to "webrtc.answer", "sessionId" to sessionId, "sdp" to sdp, "peer" to peer)

    fun ice(sessionId: String, candidate: JsonObject?, peer: String?) =
        JsonObject(obj("t" to "webrtc.ice", "sessionId" to sessionId, "peer" to peer) + ("candidate" to (candidate ?: kotlinx.serialization.json.JsonNull)))

    fun end(sessionId: String, note: String?) = obj("t" to "session.end", "sessionId" to sessionId, "note" to note)

    fun event(sessionId: String, action: String, data: JsonObject, id: String? = null, reason: String? = null) =
        obj("t" to "desk.event", "id" to id, "sessionId" to sessionId, "action" to action, "data" to data, "reason" to reason)

    fun chatRelay(sessionId: String, msgId: String, text: String, ts: Long) =
        obj("t" to "chat.message", "sessionId" to sessionId, "msgId" to msgId, "from" to "desk", "text" to text, "ts" to ts)

    fun clientJson(c: DeskClient): JsonObject = client(c).jsonObject
}
