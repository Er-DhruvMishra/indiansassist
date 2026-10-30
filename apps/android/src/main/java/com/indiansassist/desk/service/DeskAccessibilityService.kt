package com.indiansassist.desk.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ComponentName
import android.content.Context
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.view.View
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.indiansassist.desk.core.DispatchWindows
import com.indiansassist.desk.core.GesturePlan
import com.indiansassist.desk.core.InputBackend
import com.indiansassist.desk.core.InputResult
import com.indiansassist.desk.core.Pt
import com.indiansassist.desk.core.StrokeCommand
import com.indiansassist.desk.core.TextEdit
import com.indiansassist.desk.session.SessionHub
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Remote input through the Accessibility service (contracts section 12.2): `dispatchGesture` for taps, presses,
 * swipes and drags, global actions for `os.nav`, text by insertion. Every action passes [SessionHub.guard]
 * (`InputGuard.allow()`); outside a session the service does nothing and exposes nothing. Calls block their caller
 * (the controller's input thread, never the main thread) until the system reports the gesture.
 */
class DeskAccessibilityService : AccessibilityService(), InputBackend {
    private var current: GestureDescription.StrokeDescription? = null
    /** Where the open stroke's path ends: a continuation must start exactly there or the system cancels it. */
    private var currentEnd: Pt? = null

    override fun onServiceConnected() {
        instance = this
        Indicator.a11yIdle(this, SessionHub.commands == null)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Outside a session the service returns at once (section 12.2).
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        if (instance === this) instance = null
        Indicator.a11yIdle(this, false)
        super.onDestroy()
    }

    private fun allowed() = SessionHub.guard.allow()

    /** The overlay bar is the only own window that can be on screen while our activities are not in front. */
    private fun ownWindowAt(p: Pt): Boolean = SessionHub.isOwnWindowInFront || OverlayBar.bounds?.contains(p.x.toInt(), p.y.toInt()) == true

    private fun path(points: List<Pt>) = Path().apply {
        moveTo(points[0].x, points[0].y)
        if (points.size == 1) lineTo(points[0].x + 0.5f, points[0].y + 0.5f) else points.drop(1).forEach { lineTo(it.x, it.y) }
    }

    override fun gesture(plan: GesturePlan): InputResult {
        if (!allowed()) return InputResult.OWN_WINDOW
        if (plan.strokes.any { s -> s.points.any { ownWindowAt(it) } }) return InputResult.OWN_WINDOW
        val b = GestureDescription.Builder()
        plan.strokes.forEach { s -> b.addStroke(GestureDescription.StrokeDescription(path(s.points), s.startMs, s.durationMs.coerceAtLeast(1))) }
        val total = plan.strokes.maxOf { it.startMs + it.durationMs }
        return dispatch(b.build(), total, "gesture", plan.strokes.size)
    }

    override fun stroke(cmd: StrokeCommand): InputResult {
        if (!allowed()) { current = null; currentEnd = null; return InputResult.OWN_WINDOW }
        val desc = when (cmd) {
            is StrokeCommand.Begin -> {
                if (ownWindowAt(cmd.at)) return InputResult.OWN_WINDOW
                currentEnd = Pt(cmd.at.x + 0.5f, cmd.at.y + 0.5f) // path() draws a one-point stroke as a 0.5 px segment
                GestureDescription.StrokeDescription(path(listOf(cmd.at)), 0, 1, true)
            }
            is StrokeCommand.Continue -> {
                val prev = current ?: return InputResult.OK
                if (ownWindowAt(cmd.to)) {
                    current = null
                    currentEnd = null
                    return InputResult.OWN_WINDOW
                }
                // MotionEventInjector cancels a continuation that does not start at the previous segment's last point
                // (the begin stroke ends 0.5 px off its tap point), and a zero-length segment is not a valid path.
                val from = currentEnd ?: cmd.from
                val to = if (from == cmd.to) Pt(cmd.to.x - 0.5f, cmd.to.y - 0.5f) else cmd.to
                currentEnd = to
                prev.continueStroke(path(listOf(from, to)), 0, cmd.durationMs.coerceAtLeast(1), cmd.willContinue)
            }
        }
        current = if (cmd is StrokeCommand.Continue && !cmd.willContinue) null else desc
        if (current == null) currentEnd = null
        val dur = if (cmd is StrokeCommand.Continue) cmd.durationMs else 1
        val kind = when (cmd) {
            is StrokeCommand.Begin -> "stroke.begin"
            is StrokeCommand.Continue -> if (cmd.willContinue) "stroke.continue" else "stroke.end"
        }
        return dispatch(GestureDescription.Builder().addStroke(desc).build(), dur, kind, 1)
    }

    private fun dispatch(g: GestureDescription, durationMs: Long, kind: String, strokes: Int): InputResult {
        DispatchWindows.record(SystemClock.uptimeMillis(), durationMs)
        val done = CountDownLatch(1)
        val result = AtomicReference(InputResult.FAILED)
        val accepted = dispatchGesture(g, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) { result.set(InputResult.OK); done.countDown() }
            // A cancelled gesture is most often a FLAG_SECURE window (banking apps, some keyboards), section 12.4.
            override fun onCancelled(gestureDescription: GestureDescription?) { result.set(InputResult.SECURE_WINDOW); done.countDown() }
        }, null)
        if (!accepted) {
            DevLog.gesture(kind, accepted = false, result = "FAILED", strokes = strokes, durationMs = durationMs)
            return InputResult.FAILED
        }
        done.await(durationMs + 2_000, TimeUnit.MILLISECONDS)
        return result.get().also { DevLog.gesture(kind, accepted = true, result = it.name, strokes = strokes, durationMs = durationMs) }
    }

    override fun nav(action: String): InputResult {
        if (!allowed()) return InputResult.OWN_WINDOW
        val a = when (action) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            else -> return InputResult.FAILED
        }
        return if (performGlobalAction(a)) InputResult.OK else InputResult.FAILED
    }

    private fun focused(): AccessibilityNodeInfo? = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)

    private fun isOwn(node: AccessibilityNodeInfo) = node.packageName?.toString() == packageName

    override fun editFocused(edit: (String, Int, Int) -> TextEdit?): InputResult {
        if (!allowed()) return InputResult.OWN_WINDOW
        val node = focused()?.takeIf { it.isEditable } ?: return InputResult.NO_TARGET
        if (isOwn(node)) return InputResult.OWN_WINDOW
        val text = if (Build.VERSION.SDK_INT >= 26 && node.isShowingHintText) "" else node.text?.toString() ?: ""
        val e = edit(text, node.textSelectionStart, node.textSelectionEnd) ?: return InputResult.OK
        val setText = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, e.text) }
        if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, setText)) return InputResult.SECURE_WINDOW
        val sel = Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, e.caret)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, e.caret)
        }
        node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel)
        return InputResult.OK
    }

    override fun imeEnter(): InputResult {
        if (!allowed()) return InputResult.OWN_WINDOW
        val node = focused() ?: return InputResult.NO_TARGET
        if (isOwn(node)) return InputResult.OWN_WINDOW
        if (Build.VERSION.SDK_INT >= 30 && node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)) return InputResult.OK
        return if (node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) InputResult.OK else InputResult.NO_TARGET
    }

    override fun focusMove(forward: Boolean): InputResult {
        if (!allowed()) return InputResult.OWN_WINDOW
        val from = focused() ?: rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY) ?: return InputResult.NO_TARGET
        val next = from.focusSearch(if (forward) View.FOCUS_FORWARD else View.FOCUS_BACKWARD) ?: return InputResult.NO_TARGET
        if (isOwn(next)) return InputResult.OWN_WINDOW
        return if (next.performAction(AccessibilityNodeInfo.ACTION_FOCUS)) InputResult.OK else InputResult.NO_TARGET
    }

    companion object {
        @Volatile
        var instance: DeskAccessibilityService? = null
            private set

        /** Whether the user enabled the service in Settings (checked on the consent screen for **View and control**). */
        fun isEnabled(ctx: Context): Boolean {
            val flat = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            val me = ComponentName(ctx, DeskAccessibilityService::class.java)
            return flat.split(':').any { ComponentName.unflattenFromString(it) == me }
        }
    }
}
