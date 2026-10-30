package com.indiansassist.desk.core

import kotlin.math.abs
import kotlin.math.min
import kotlin.math.sign

data class Pt(val x: Float, val y: Float)

/** One stroke of a gesture: a polyline drawn over [durationMs], starting [startMs] into the gesture. */
data class StrokePlan(val points: List<Pt>, val startMs: Long, val durationMs: Long)

/** A complete `dispatchGesture` (tap, long press, double tap, swipe). */
data class GesturePlan(val strokes: List<StrokePlan>)

/** One step of an incremental drag (`StrokeDescription.continueStroke`, section 12.4). */
sealed interface StrokeCommand {
    /** A new 1-point stroke with `willContinue = true`. */
    data class Begin(val at: Pt) : StrokeCommand

    /** Continue the current stroke from its last point to [to] over [durationMs]. */
    data class Continue(val from: Pt, val to: Pt, val durationMs: Long, val willContinue: Boolean) : StrokeCommand
}

/**
 * The console op -> gesture mapping of contracts section 12.4: taps at (`nx`, `ny`) x display size, `button: 2` click
 * = 600 ms long press, `dblclick` = two taps, `os.scroll` = a 150 ms swipe of 10 % of the shorter side per notch (at
 * most 5), inverted like a finger.
 */
class GestureMapper(val width: Int, val height: Int) {
    fun point(nx: Double, ny: Double): Pt = Pt(
        (nx * width).toFloat().coerceIn(0f, (width - 1).toFloat()),
        (ny * height).toFloat().coerceIn(0f, (height - 1).toFloat()),
    )

    fun tap(nx: Double, ny: Double): GesturePlan = GesturePlan(listOf(StrokePlan(listOf(point(nx, ny)), 0, TAP_MS)))

    fun longPress(nx: Double, ny: Double): GesturePlan = GesturePlan(listOf(StrokePlan(listOf(point(nx, ny)), 0, LONG_PRESS_MS)))

    fun doubleTap(nx: Double, ny: Double): GesturePlan {
        val p = point(nx, ny)
        return GesturePlan(listOf(StrokePlan(listOf(p), 0, TAP_MS), StrokePlan(listOf(p), TAP_MS + DOUBLE_TAP_GAP_MS, TAP_MS)))
    }

    /** Null when both deltas are zero. Positive `dy` (scroll down) moves the finger up. */
    fun scroll(nx: Double, ny: Double, dx: Int, dy: Int): GesturePlan? {
        if (dx == 0 && dy == 0) return null
        val notch = min(width, height) * NOTCH_FRACTION
        val start = point(nx, ny)
        val ex = start.x - sign(dx.toFloat()) * min(abs(dx), MAX_NOTCHES) * notch
        val ey = start.y - sign(dy.toFloat()) * min(abs(dy), MAX_NOTCHES) * notch
        val end = Pt(ex.coerceIn(0f, (width - 1).toFloat()), ey.coerceIn(0f, (height - 1).toFloat()))
        return GesturePlan(listOf(StrokePlan(listOf(start, end), 0, SCROLL_MS)))
    }

    companion object {
        const val TAP_MS = 50L
        const val LONG_PRESS_MS = 600L
        const val DOUBLE_TAP_GAP_MS = 100L
        const val SCROLL_MS = 150L
        const val NOTCH_FRACTION = 0.10f
        const val MAX_NOTCHES = 5
    }
}

/**
 * Incremental drag for `os.pointer` down / move / up (section 12.4): `down` begins a 1-point stroke that will
 * continue, moves are coalesced to 20 Hz and each continues the stroke with a 50 ms segment, `up` ends it. A stroke
 * that reaches 55 s is ended and a new one begun at the same point (lift-and-replace); a stroke with no event for
 * 2 s is ended (a long press / drop). [tick] must be called periodically (the service uses 50 ms).
 */
class StrokeTracker(private val clock: () -> Long) {
    private var active = false
    private var strokeStart = 0L
    private var lastEvent = 0L
    private var lastDispatch = 0L
    private var last: Pt = Pt(0f, 0f)
    private var pending: Pt? = null

    val isActive get() = active

    fun down(p: Pt): List<StrokeCommand> {
        val out = mutableListOf<StrokeCommand>()
        if (active) out += end(last)
        active = true
        val now = clock()
        strokeStart = now
        lastEvent = now
        lastDispatch = now
        last = p
        pending = null
        out += StrokeCommand.Begin(p)
        return out
    }

    /** Queues a move; dispatches at once when 50 ms have passed since the last segment, else on the next [tick]. */
    fun move(p: Pt): List<StrokeCommand> {
        if (!active) return emptyList()
        lastEvent = clock()
        pending = p
        return flushIfDue()
    }

    fun up(p: Pt): List<StrokeCommand> {
        if (!active) return emptyList()
        pending = null
        return end(p)
    }

    fun tick(): List<StrokeCommand> {
        if (!active) return emptyList()
        val now = clock()
        if (now - lastEvent >= DANGLING_MS) {
            val at = pending ?: last
            pending = null
            return end(at)
        }
        return flushIfDue()
    }

    /** Ends any stroke (level drop, teardown). */
    fun cancel(): List<StrokeCommand> = if (active) end(pending ?: last) else emptyList()

    private fun flushIfDue(): List<StrokeCommand> {
        val now = clock()
        val p = pending ?: return splitIfDue(now)
        if (now - lastDispatch < SEGMENT_MS) return splitIfDue(now)
        pending = null
        val out = mutableListOf<StrokeCommand>()
        out += splitIfDue(now)
        out += StrokeCommand.Continue(last, p, SEGMENT_MS, willContinue = true)
        last = p
        lastDispatch = now
        return out
    }

    private fun splitIfDue(now: Long): List<StrokeCommand> {
        if (now - strokeStart < MAX_STROKE_MS) return emptyList()
        val at = last
        val out = mutableListOf<StrokeCommand>(StrokeCommand.Continue(at, at, 1, willContinue = false), StrokeCommand.Begin(at))
        strokeStart = now
        lastDispatch = now
        return out
    }

    private fun end(p: Pt): List<StrokeCommand> {
        active = false
        val c = StrokeCommand.Continue(last, p, SEGMENT_MS, willContinue = false)
        last = p
        return listOf(c)
    }

    companion object {
        const val SEGMENT_MS = 50L
        const val MAX_STROKE_MS = 55_000L
        const val DANGLING_MS = 2_000L
    }
}
