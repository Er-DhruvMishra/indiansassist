package com.indiansassist.desk.core

/** The result of an `os.text` / `Backspace` / `Delete` edit on the focused node: new text and caret. */
data class TextEdit(val text: String, val caret: Int)

/**
 * `os.text` by **insertion**, never replacement (section 12.4): splice at the selection (replacing a selected range);
 * without a selection (start < 0) append. Two flushes `hel` + `lo` therefore read `hello`.
 */
object TextEditing {
    fun insert(current: String, selStart: Int, selEnd: Int, incoming: String): TextEdit {
        if (selStart < 0 || selEnd < 0) return TextEdit(current + incoming, current.length + incoming.length)
        val (a, b) = range(current, selStart, selEnd)
        val out = current.substring(0, a) + incoming + current.substring(b)
        return TextEdit(out, a + incoming.length)
    }

    /** `Backspace`: delete the selection, else one code point before the caret; null when nothing changes. */
    fun backspace(current: String, selStart: Int, selEnd: Int): TextEdit? {
        val (a, b) = if (selStart < 0) current.length to current.length else range(current, selStart, selEnd)
        if (a != b) return TextEdit(current.substring(0, a) + current.substring(b), a)
        if (a == 0) return null
        val from = current.offsetByCodePoints(a, -1)
        return TextEdit(current.substring(0, from) + current.substring(a), from)
    }

    /** `Delete`: delete the selection, else one code point after the caret; null when nothing changes. */
    fun delete(current: String, selStart: Int, selEnd: Int): TextEdit? {
        val (a, b) = if (selStart < 0) current.length to current.length else range(current, selStart, selEnd)
        if (a != b) return TextEdit(current.substring(0, a) + current.substring(b), a)
        if (a >= current.length) return null
        val to = current.offsetByCodePoints(a, 1)
        return TextEdit(current.substring(0, a) + current.substring(to), a)
    }

    private fun range(s: String, x: Int, y: Int): Pair<Int, Int> {
        val a = minOf(x, y).coerceIn(0, s.length)
        val b = maxOf(x, y).coerceIn(0, s.length)
        return a to b
    }
}

/** The inputs of [InputGuard.allow] (section 12.2). */
data class GuardState(val active: Boolean, val level: String, val established: Boolean, val inPromptWindow: Boolean)

/**
 * The single gate every `dispatchGesture` / `performAction` passes through (section 12.2, binding):
 * `SessionState.active && level >= control && secChannel.established && !inPromptWindow`.
 */
class InputGuard {
    @Volatile
    var state = GuardState(active = false, level = "view", established = false, inPromptWindow = false)

    fun allow(): Boolean = allow(state)

    companion object {
        fun allow(s: GuardState): Boolean =
            s.active && s.established && !s.inPromptWindow && (AgentControl.LEVEL_ORDER[s.level] ?: 0) >= 1
    }
}

/**
 * Prompt self-defence (section 12.3): the service records every dispatch; prompt activities ignore touch events
 * whose timestamp falls inside a dispatch window plus 150 ms. Timestamps are `SystemClock.uptimeMillis()`.
 */
object DispatchWindows {
    const val SLACK_MS = 150L
    private val windows = ArrayDeque<LongRange>()

    @Synchronized
    fun record(startUptime: Long, durationMs: Long) {
        windows.addLast(startUptime..(startUptime + durationMs + SLACK_MS))
        while (windows.size > 64) windows.removeFirst()
    }

    @Synchronized
    fun isInjected(eventUptime: Long): Boolean = windows.any { eventUptime in it }

    @Synchronized
    fun clear() = windows.clear()
}

/** A token bucket (`rate` per second, `burst` capacity). */
class TokenBucket(private val ratePerSec: Double, private val burst: Double, private val clock: () -> Long) {
    private var tokens = burst
    private var last = clock()

    @Synchronized
    fun tryTake(n: Double = 1.0): Boolean {
        refill()
        if (tokens < n) return false
        tokens -= n
        return true
    }

    private fun refill() {
        val now = clock()
        tokens = minOf(burst, tokens + (now - last) / 1000.0 * ratePerSec)
        last = now
    }
}
