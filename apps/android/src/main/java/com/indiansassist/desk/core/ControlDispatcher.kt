package com.indiansassist.desk.core

import kotlinx.serialization.json.JsonObject

enum class InputResult { OK, OWN_WINDOW, SECURE_WINDOW, NO_TARGET, FAILED }

/** What the Accessibility service can do (implemented by the Android layer, faked in tests). */
interface InputBackend {
    fun gesture(plan: GesturePlan): InputResult
    fun stroke(cmd: StrokeCommand): InputResult
    fun nav(action: String): InputResult
    /** Reads the focused editable node, applies [edit] and writes the result back (ACTION_SET_TEXT + selection). */
    fun editFocused(edit: (text: String, selStart: Int, selEnd: Int) -> TextEdit?): InputResult
    fun imeEnter(): InputResult
    fun focusMove(forward: Boolean): InputResult
}

/** The one Android display and the encoder controls. */
interface ScreenInfo {
    val width: Int
    val height: Int
    val densityDpi: Int
    val mid: String?
    fun applyQuality(preset: String)
}

sealed interface ControlOutcome {
    data class Reply(val res: JsonObject) : ControlOutcome
    /** `level.request`: the service shows the prompt and answers within 60 s (B prompt timing). */
    data class LevelPrompt(val id: String, val reason: String?) : ControlOutcome
}

/**
 * Executes `ia.control` requests for the Android op subset (contracts section 12.4) behind [InputGuard], the level
 * rules of section 5.1 and the agent rate limits (moves coalesced at 20 Hz by [StrokeTracker], other ops 30 / s
 * burst 60, `os.text` 400 chars / s with a 2048-unit bound => `busy`).
 */
class ControlDispatcher(
    private val input: InputBackend,
    private val screen: ScreenInfo,
    private val guard: InputGuard,
    private val audit: InputAudit,
    clock: () -> Long = System::currentTimeMillis,
) {
    val strokes = StrokeTracker(clock)
    private val ops = TokenBucket(30.0, 60.0, clock)
    private val textBudget = TokenBucket(400.0, 2048.0, clock)
    private var quality = "auto"
    private val modifierCodes = setOf("ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight")

    fun handle(req: ControlRequest): ControlOutcome {
        val op = req.parsed
        if (op is AgentOp.Unsupported) return reply(req, "not_supported", op.message)
        val isMove = op is AgentOp.Pointer && op.kind == "move"
        if (!isMove && !ops.tryTake()) return reply(req, "rate_limited", "too many requests")
        if (AgentControl.isInputOp(req.op)) {
            if (!AgentControl.levelAtLeast(guard.state.level, AgentControl.minLevelFor(req.op)) || !guard.allow()) {
                audit.refused()
                return reply(req, "not_allowed", "input is not allowed now")
            }
        }
        return when (op) {
            AgentOp.Monitors -> ok(req, monitors())
            is AgentOp.MonitorSelect -> if (op.ids != listOf(1)) reply(req, "no_such_monitor", "only monitor 1 exists") else ok(req, obj("selected" to listOf(1)))
            is AgentOp.Quality -> { quality = op.preset; screen.applyQuality(op.preset); ok(req, obj("preset" to op.preset, "rung" to kotlinx.serialization.json.JsonNull)) }
            is AgentOp.Pointer -> pointer(req, op)
            is AgentOp.Scroll -> {
                val plan = GestureMapper(screen.width, screen.height).scroll(op.nx, op.ny, op.dx, op.dy)
                if (plan == null) ok(req) else result(req, input.gesture(plan), "scroll")
            }
            is AgentOp.Key -> key(req, op)
            is AgentOp.Text -> text(req, op)
            is AgentOp.Nav -> result(req, input.nav(op.action), "key")
            is AgentOp.LevelRequest -> ControlOutcome.LevelPrompt(req.id, op.reason)
            is AgentOp.Unsupported -> reply(req, "not_supported", op.message)
        }
    }

    fun monitors(): JsonObject = obj("monitors" to listOf(AgentControl.monitorInfo(screen.width, screen.height, screen.densityDpi, screen.mid)), "selected" to listOf(1))

    private fun pointer(req: ControlRequest, op: AgentOp.Pointer): ControlOutcome {
        if (op.monitorId != 1) return reply(req, "no_such_monitor", "only monitor 1 exists")
        val g = GestureMapper(screen.width, screen.height)
        val p = g.point(op.nx, op.ny)
        return when (op.kind) {
            "click" -> when (op.button) {
                0, 1 -> result(req, input.gesture(g.tap(op.nx, op.ny)), "pointer")
                2 -> result(req, input.gesture(g.longPress(op.nx, op.ny)), "pointer")
                3 -> result(req, input.nav("back"), "pointer")
                else -> reply(req, "not_supported", "button ${op.button}")
            }
            "dblclick" -> result(req, input.gesture(g.doubleTap(op.nx, op.ny)), "pointer")
            "down" -> if (op.button != 0) reply(req, "not_supported", "drag with button ${op.button}") else strokeResult(req, strokes.down(p))
            "move" -> strokeResult(req, strokes.move(p), countAs = strokes.isActive)
            "up" -> strokeResult(req, strokes.up(p))
            else -> reply(req, "bad_args", "kind")
        }
    }

    private fun strokeResult(req: ControlRequest, cmds: List<StrokeCommand>, countAs: Boolean = true): ControlOutcome {
        var r = InputResult.OK
        for (c in cmds) {
            val x = input.stroke(c)
            if (x != InputResult.OK) r = x
        }
        if (!countAs) return ok(req)
        return result(req, r, "pointer")
    }

    /** Ticks the drag tracker (coalesced moves, 55 s split, 2 s dangling). */
    fun tick() {
        if (!strokes.isActive) return
        if (!guard.allow()) {
            strokes.cancel().forEach { input.stroke(it) }
            return
        }
        strokes.tick().forEach { input.stroke(it) }
    }

    private fun key(req: ControlRequest, op: AgentOp.Key): ControlOutcome {
        if (op.code in modifierCodes) return ok(req) // tracked by the console; there is no modifier injection on Android
        if (op.kind == "up") return ok(req)
        val r = when (op.code) {
            "Enter", "NumpadEnter" -> input.imeEnter()
            "Tab" -> input.focusMove(forward = op.key != "ShiftTab")
            "ArrowDown", "ArrowRight" -> input.focusMove(forward = true)
            "ArrowUp", "ArrowLeft" -> input.focusMove(forward = false)
            "Backspace" -> input.editFocused { t, a, b -> TextEditing.backspace(t, a, b) }
            "Delete" -> input.editFocused { t, a, b -> TextEditing.delete(t, a, b) }
            else -> return reply(req, "not_supported", "no key injection for ${op.code} on Android")
        }
        return result(req, r, "key")
    }

    private fun text(req: ControlRequest, op: AgentOp.Text): ControlOutcome {
        if (!textBudget.tryTake(op.text.length.toDouble())) return reply(req, "busy", "text queue is full")
        val r = input.editFocused { t, a, b -> TextEditing.insert(t, a, b, op.text) }
        if (r == InputResult.OK) audit.text(op.text.length)
        return result(req, r, "text")
    }

    private fun result(req: ControlRequest, r: InputResult, kind: String): ControlOutcome = when (r) {
        InputResult.OK -> {
            audit.op(kind)
            ok(req)
        }
        InputResult.OWN_WINDOW -> { audit.refused(); reply(req, "not_allowed", "target is an IndiansAssist window") }
        InputResult.SECURE_WINDOW -> reply(req, "secure_window", "this app blocks remote input")
        InputResult.NO_TARGET -> reply(req, "not_supported", "no focused text field")
        InputResult.FAILED -> reply(req, "internal", "the gesture was cancelled")
    }

    private fun ok(req: ControlRequest, result: JsonObject = obj()) = ControlOutcome.Reply(AgentControl.ok(req.id, result))
    private fun reply(req: ControlRequest, code: String, message: String) = ControlOutcome.Reply(AgentControl.err(req.id, code, message))
}
