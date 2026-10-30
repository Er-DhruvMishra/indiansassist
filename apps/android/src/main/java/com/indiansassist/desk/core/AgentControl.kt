package com.indiansassist.desk.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A validated `ctl.req` on `ia.control` (B section 5.1 envelope, C section 5.1 ops). */
sealed interface AgentOp {
    data object Monitors : AgentOp
    data class MonitorSelect(val ids: List<Int>) : AgentOp
    data class Quality(val preset: String) : AgentOp
    data class Pointer(val monitorId: Int, val kind: String, val nx: Double, val ny: Double, val button: Int) : AgentOp
    data class Scroll(val monitorId: Int, val nx: Double, val ny: Double, val dx: Int, val dy: Int) : AgentOp
    data class Key(val kind: String, val key: String, val code: String) : AgentOp
    data class Text(val text: String) : AgentOp
    data class Nav(val action: String) : AgentOp
    data class LevelRequest(val level: String, val reason: String?) : AgentOp
    /** Defined ops the Android host does not implement (section 12.4) and every Phase B op. */
    data class Unsupported(val op: String, val message: String) : AgentOp
}

class ControlRequest(val id: String, val op: String, val parsed: AgentOp)

class ControlError(val code: String, message: String) : Exception(message)

object AgentControl {
    val LEVEL_ORDER = mapOf("view" to 0, "control" to 1, "elevated" to 2)
    val QUALITY_PRESETS = setOf("auto", "sharp", "smooth", "floor")
    val NAV_ACTIONS = setOf("back", "home", "recents", "notifications")
    private val POINTER_KINDS = setOf("move", "down", "up", "click", "dblclick")
    private val KEY_KINDS = setOf("down", "up", "press")
    private val MODIFIER_KEYS = setOf("alt", "ctrl", "meta", "shift")

    /** B section 5.1 `opIdFor(sessionId, id)` = first 16 hex of sha256("<sessionId>:<id>"). */
    fun opIdFor(sessionId: String, reqId: String): String = Bytes.sha256Hex("$sessionId:$reqId").substring(0, 16)

    fun levelAtLeast(a: String, b: String): Boolean {
        val x = LEVEL_ORDER[a] ?: throw IllegalArgumentException("not an agent level: $a")
        val y = LEVEL_ORDER[b] ?: throw IllegalArgumentException("not an agent level: $b")
        return x >= y
    }

    /** `agentMinLevelFor(op)` (section 5.1 table). */
    fun minLevelFor(op: String): String = when (op) {
        "os.monitors", "os.monitor.select", "os.quality", "level.request" -> "view"
        "os.input_lock", "os.privacy_screen" -> "elevated"
        else -> "control"
    }

    /** True for the ops that inject input (refused below `control` and outside [InputGuard]). */
    fun isInputOp(op: String) = op in setOf("os.pointer", "os.scroll", "os.key", "os.text", "os.nav")

    /** Parses and validates a decrypted `ia.control` text; throws [ControlError] `bad_args` with the request id when possible. */
    fun parse(m: JsonObject): ControlRequest {
        if (m.str("t") != "ctl.req") throw ControlError("bad_args", "not a ctl.req")
        val id = m.str("id")?.takeIf { it.isNotEmpty() && it.length <= 40 } ?: throw ControlError("bad_args", "bad id")
        val op = m.str("op") ?: throw ControlError("bad_args", "missing op")
        val args = m.objOrNull("args") ?: JsonObject(emptyMap())
        return ControlRequest(id, op, parseOp(op, args))
    }

    private fun parseOp(op: String, a: JsonObject): AgentOp = when (op) {
        "os.monitors" -> { strict(a); AgentOp.Monitors }
        "os.monitor.select" -> {
            strict(a, "monitorIds")
            val ids = (a["monitorIds"] as? JsonArray)?.map { (it as? JsonPrimitive)?.content?.toIntOrNull() ?: bad("monitorIds") } ?: bad("monitorIds")
            if (ids.isEmpty() || ids.size > 16 || ids.toSet().size != ids.size || ids.any { it !in 1..16 }) bad("monitorIds")
            AgentOp.MonitorSelect(ids)
        }
        "os.quality" -> { strict(a, "preset"); AgentOp.Quality(a.str("preset")?.takeIf { it in QUALITY_PRESETS } ?: bad("preset")) }
        "os.pointer" -> {
            strict(a, "monitorId", "kind", "nx", "ny", "button", "modifiers")
            modifiers(a)
            val button = if (a.containsKey("button")) a.int("button")?.takeIf { it in 0..4 } ?: bad("button") else 0
            AgentOp.Pointer(monitor(a), a.str("kind")?.takeIf { it in POINTER_KINDS } ?: bad("kind"), coord(a, "nx"), coord(a, "ny"), button)
        }
        "os.scroll" -> {
            strict(a, "monitorId", "nx", "ny", "dx", "dy")
            AgentOp.Scroll(monitor(a), coord(a, "nx"), coord(a, "ny"), a.int("dx")?.takeIf { it in -20..20 } ?: bad("dx"), a.int("dy")?.takeIf { it in -20..20 } ?: bad("dy"))
        }
        "os.key" -> {
            strict(a, "kind", "key", "code", "modifiers")
            modifiers(a)
            AgentOp.Key(
                a.str("kind")?.takeIf { it in KEY_KINDS } ?: bad("kind"),
                a.str("key")?.takeIf { it.length in 1..64 } ?: bad("key"),
                a.str("code")?.takeIf { it.length in 1..64 } ?: bad("code"),
            )
        }
        "os.text" -> { strict(a, "text"); AgentOp.Text(a.str("text")?.takeIf { it.length in 1..1024 } ?: bad("text")) }
        "os.nav" -> { strict(a, "action"); AgentOp.Nav(a.str("action")?.takeIf { it in NAV_ACTIONS } ?: bad("action")) }
        "level.request" -> {
            val level = a.str("level") ?: bad("level")
            // Both level families are accepted on the wire; only `control` can be granted here (section 3.4).
            if (level != "control") throw ControlError("bad_args", "level $level cannot be requested")
            AgentOp.LevelRequest(level, a.str("reason"))
        }
        "os.input_lock", "os.privacy_screen" -> AgentOp.Unsupported(op, "phase_d")
        "clipboard.set", "elevation.request", "playbook.run", "playbook.cancel" -> AgentOp.Unsupported(op, "feature absent on Android")
        // Every Phase B tab op and anything unknown: the host answers not_supported (section 5.1).
        else -> AgentOp.Unsupported(op, "not a native op")
    }

    private fun bad(field: String): Nothing = throw ControlError("bad_args", "bad $field")

    private fun strict(a: JsonObject, vararg allowed: String) {
        val extra = a.keys - allowed.toSet()
        if (extra.isNotEmpty()) throw ControlError("bad_args", "unknown args ${extra.joinToString()}")
    }

    private fun monitor(a: JsonObject): Int = a.int("monitorId")?.takeIf { it in 1..16 } ?: bad("monitorId")

    private fun coord(a: JsonObject, k: String): Double = a.num(k)?.takeIf { it in 0.0..1.0 } ?: bad(k)

    private fun modifiers(a: JsonObject) {
        val m = a["modifiers"] ?: return
        val o = m as? JsonObject ?: bad("modifiers")
        if (o.keys != MODIFIER_KEYS || MODIFIER_KEYS.any { o.bool(it) == null }) bad("modifiers")
    }

    fun ok(id: String, result: JsonObject = obj(), ts: Long = System.currentTimeMillis()) = obj("t" to "ctl.res", "id" to id, "ok" to true, "result" to result, "ts" to ts)

    fun err(id: String, code: String, message: String, ts: Long = System.currentTimeMillis()) =
        obj("t" to "ctl.res", "id" to id, "ok" to false, "error" to obj("code" to code, "message" to message.take(200)), "ts" to ts)

    fun event(kind: String, vararg fields: Pair<String, Any?>) = obj("t" to "ctl.event", "kind" to kind, *fields, "ts" to System.currentTimeMillis())

    /** `MonitorInfo` of the single Android display (section 3.6 M3, section 12.2). */
    fun monitorInfo(width: Int, height: Int, densityDpi: Int, mid: String?) = obj(
        "id" to 1, "name" to "Phone screen", "primary" to true, "x" to 0, "y" to 0, "width" to width, "height" to height,
        "scale" to Math.round(densityDpi / 96.0 * 100) / 100.0, "mid" to (mid ?: kotlinx.serialization.json.JsonNull),
    )
}
