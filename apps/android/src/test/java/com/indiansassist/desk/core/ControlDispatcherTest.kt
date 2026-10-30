package com.indiansassist.desk.core

import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** `ia.control` for the Android op subset: validation, levels, guard, capability flags and op results. */
class ControlDispatcherTest {
    private class FakeInput : InputBackend {
        val log = mutableListOf<String>()
        var text = ""
        var caret = 0
        var next = InputResult.OK
        override fun gesture(plan: GesturePlan) = next.also { log += "gesture:${plan.strokes.size}:${plan.strokes[0].durationMs}" }
        override fun stroke(cmd: StrokeCommand) = next.also { log += "stroke:${cmd::class.simpleName}" }
        override fun nav(action: String) = next.also { log += "nav:$action" }
        override fun imeEnter() = next.also { log += "enter" }
        override fun focusMove(forward: Boolean) = next.also { log += "focus:$forward" }
        override fun editFocused(edit: (String, Int, Int) -> TextEdit?): InputResult {
            val e = edit(text, caret, caret) ?: return InputResult.OK
            text = e.text
            caret = e.caret
            return next
        }
    }

    private class FakeScreen : ScreenInfo {
        var quality = ""
        override val width = 1080
        override val height = 2400
        override val densityDpi = 420
        override val mid: String? = "0"
        override fun applyQuality(preset: String) { quality = preset }
    }

    private val input = FakeInput()
    private val screen = FakeScreen()
    private val guard = InputGuard().apply { state = GuardState(active = true, level = "control", established = true, inPromptWindow = false) }
    private val audit = InputAudit { 0L }
    private val d = ControlDispatcher(input, screen, guard, audit) { 0L }

    private fun req(op: String, args: JsonObject = obj(), id: String = "r1") = AgentControl.parse(obj("t" to "ctl.req", "id" to id, "op" to op, "args" to args, "ts" to 1))

    private fun res(op: String, args: JsonObject = obj()): JsonObject = (d.handle(req(op, args)) as ControlOutcome.Reply).res

    private fun code(r: JsonObject) = r.objOrNull("error")?.str("code")

    @Test
    fun capabilitiesMatchSection12_4() {
        val c = AgentCapabilities()
        assertEquals(1, c.monitors)
        assertEquals("user", c.elevation)
        assertEquals(listOf("screen", "input", "input_text", "nav", "files", "chat", "voice"), c.features)
        assertEquals(listOf("vp8", "h264"), c.encoders)
        assertEquals(emptyList<String>(), c.interpreters)
        for (absent in listOf("multi_monitor", "clipboard", "elevation", "playbooks", "input_lock", "privacy_screen")) assertTrue(absent !in c.features)
        assertTrue(AgentCapabilities.AGENT_FEATURES.containsAll(c.features))
    }

    @Test
    fun absentFeaturesAnswerNotSupported() {
        for (op in listOf("clipboard.set", "elevation.request", "playbook.run", "playbook.cancel", "os.input_lock", "os.privacy_screen", "tabs.list")) {
            assertEquals(op, "not_supported", code(res(op)))
        }
        assertEquals("phase_d", res("os.input_lock").objOrNull("error")!!.str("message"))
    }

    @Test
    fun monitorsAndSelection() {
        val r = res("os.monitors").objOrNull("result")!!
        val m = r.arr("monitors")!!.single() as JsonObject
        assertEquals(1, m.int("id"))
        assertEquals(1080, m.int("width"))
        assertEquals(4.38, m.num("scale")!!, 0.001)
        assertEquals("ok", if (res("os.monitor.select", obj("monitorIds" to listOf(1)))["ok"].toString() == "true") "ok" else "no")
        assertEquals("no_such_monitor", code(res("os.monitor.select", obj("monitorIds" to listOf(2)))))
        assertEquals("no_such_monitor", code(res("os.pointer", obj("monitorId" to 2, "kind" to "click", "nx" to 0.1, "ny" to 0.1))))
    }

    @Test
    fun pointerOpsMapToGestures() {
        res("os.pointer", obj("monitorId" to 1, "kind" to "click", "nx" to 0.5, "ny" to 0.5, "button" to 0))
        res("os.pointer", obj("monitorId" to 1, "kind" to "click", "nx" to 0.5, "ny" to 0.5, "button" to 2))
        res("os.pointer", obj("monitorId" to 1, "kind" to "dblclick", "nx" to 0.5, "ny" to 0.5))
        res("os.scroll", obj("monitorId" to 1, "nx" to 0.5, "ny" to 0.5, "dx" to 0, "dy" to 2))
        res("os.nav", obj("action" to "home"))
        res("os.pointer", obj("monitorId" to 1, "kind" to "down", "nx" to 0.1, "ny" to 0.1))
        res("os.pointer", obj("monitorId" to 1, "kind" to "up", "nx" to 0.2, "ny" to 0.2))
        assertEquals(listOf("gesture:1:50", "gesture:1:600", "gesture:2:50", "gesture:1:150", "nav:home", "stroke:Begin", "stroke:Continue"), input.log)
        assertEquals("not_supported", code(res("os.pointer", obj("monitorId" to 1, "kind" to "click", "nx" to 0.5, "ny" to 0.5, "button" to 4))))
    }

    @Test
    fun strictArgsAreBadArgs() {
        for ((op, args) in listOf(
            "os.pointer" to obj("monitorId" to 1, "kind" to "click", "nx" to 1.5, "ny" to 0.1),
            "os.pointer" to obj("monitorId" to 1, "kind" to "tap", "nx" to 0.5, "ny" to 0.1),
            "os.pointer" to obj("monitorId" to 1, "kind" to "click", "nx" to 0.5, "ny" to 0.1, "extra" to 1),
            "os.pointer" to obj("monitorId" to 1, "kind" to "click", "nx" to 0.5, "ny" to 0.1, "modifiers" to obj("ctrl" to true)),
            "os.scroll" to obj("monitorId" to 1, "nx" to 0.5, "ny" to 0.5, "dx" to 0, "dy" to 21),
            "os.text" to obj("text" to ""),
            "os.text" to obj("text" to "x".repeat(1025)),
            "os.nav" to obj("action" to "power"),
            "os.quality" to obj("preset" to "ultra"),
            "level.request" to obj("level" to "elevated"),
            "level.request" to obj("level" to "deep_control"),
        )) {
            try {
                d.handle(req(op, args))
                throw AssertionError("$op $args accepted")
            } catch (e: ControlError) {
                assertEquals("bad_args", e.code)
            }
        }
    }

    @Test
    fun inputRefusedBelowControlOrOutsideGuard() {
        guard.state = guard.state.copy(level = "view")
        assertEquals("not_allowed", code(res("os.text", obj("text" to "hi"))))
        assertTrue(res("os.monitors")["ok"].toString() == "true") // view ops still work
        guard.state = guard.state.copy(level = "control", established = false)
        assertEquals("not_allowed", code(res("os.nav", obj("action" to "back"))))
        guard.state = guard.state.copy(established = true, inPromptWindow = true)
        assertEquals("not_allowed", code(res("os.pointer", obj("monitorId" to 1, "kind" to "click", "nx" to 0.5, "ny" to 0.5))))
        assertTrue(input.log.isEmpty())
        val e = audit.flush(force = true).single()
        assertEquals(3, e.data.int("refused"))
    }

    @Test
    fun textIsInsertedAndAudited() {
        res("os.text", obj("text" to "hel"))
        res("os.text", obj("text" to "lo"))
        assertEquals("hello", input.text)
        res("os.key", obj("kind" to "press", "key" to "Backspace", "code" to "Backspace", "modifiers" to obj("alt" to false, "ctrl" to false, "meta" to false, "shift" to false)))
        assertEquals("hell", input.text)
        assertEquals("not_supported", code(res("os.key", obj("kind" to "press", "key" to "a", "code" to "KeyA"))))
        assertTrue(res("os.key", obj("kind" to "down", "key" to "Control", "code" to "ControlLeft"))["ok"].toString() == "true")
        res("os.key", obj("kind" to "press", "key" to "Enter", "code" to "Enter"))
        assertTrue("enter" in input.log)
        val entry = audit.flush(force = true).single()
        assertEquals("control.input", entry.action)
        assertEquals(5, entry.data.int("textChars"))
        assertEquals("os", entry.data.str("mode"))
        assertEquals(1, entry.data.int("monitorId"))
    }

    @Test
    fun secureWindowAndOwnWindowResults() {
        input.next = InputResult.SECURE_WINDOW
        assertEquals("secure_window", code(res("os.pointer", obj("monitorId" to 1, "kind" to "click", "nx" to 0.5, "ny" to 0.5))))
        input.next = InputResult.OWN_WINDOW
        assertEquals("not_allowed", code(res("os.pointer", obj("monitorId" to 1, "kind" to "click", "nx" to 0.5, "ny" to 0.5))))
        assertEquals(1, audit.flush(force = true).single().data.int("refused"))
    }

    @Test
    fun textBudgetAnswersBusy() {
        repeat(2) { res("os.text", obj("text" to "x".repeat(1024))) }
        assertEquals("busy", code(res("os.text", obj("text" to "y"))))
    }

    @Test
    fun qualityAndLevelRequest() {
        val q = res("os.quality", obj("preset" to "floor")).objOrNull("result")!!
        assertEquals("floor", q.str("preset"))
        assertEquals("floor", screen.quality)
        val p = d.handle(req("level.request", obj("level" to "control", "reason" to "fix wifi")))
        assertEquals(ControlOutcome.LevelPrompt("r1", "fix wifi"), p)
        assertEquals("control", AgentControl.minLevelFor("os.text"))
        assertEquals("view", AgentControl.minLevelFor("os.monitors"))
        assertEquals("elevated", AgentControl.minLevelFor("os.privacy_screen"))
    }
}
