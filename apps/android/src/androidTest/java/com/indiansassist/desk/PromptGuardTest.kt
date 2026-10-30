package com.indiansassist.desk

import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.indiansassist.desk.core.DispatchWindows
import com.indiansassist.desk.core.GuardState
import com.indiansassist.desk.core.IncomingOffer
import com.indiansassist.desk.session.Prompt
import com.indiansassist.desk.session.SessionCommands
import com.indiansassist.desk.session.SessionHub
import com.indiansassist.desk.ui.PromptActivity
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Section 12.3 self-defence on a device: a tap whose timestamp lies inside a dispatched-gesture window (what the
 * Accessibility service records for every injected gesture) cannot accept a file; a physical tap outside the window
 * can. Also: while a prompt activity is in front the InputGuard refuses injected input altogether.
 */
@RunWith(AndroidJUnit4::class)
class PromptGuardTest {
    private val answers = CopyOnWriteArrayList<Pair<String, Boolean>>()

    private val fake = object : SessionCommands {
        override fun consentAccepted(level: String, projectionData: Intent) {}
        override fun consentDeclined() {}
        override fun stop() {}
        override fun viewOnly() {}
        override fun sendChat(text: String) {}
        override fun setMuted(muted: Boolean) {}
        override fun sendFile(uri: Uri) {}
        override fun answerPrompt(id: String, accept: Boolean) { answers += id to accept }
    }

    @Before
    fun setUp() {
        SessionHub.reset()
        DispatchWindows.clear()
        SessionHub.commands = fake
        SessionHub.guard.state = GuardState(active = true, level = "control", established = true, inPromptWindow = false)
        SessionHub.addPrompt(Prompt.File("file-1", IncomingOffer(1, "notes.txt", 12, "text/plain", executable = false), "Asha"))
    }

    @After
    fun tearDown() {
        SessionHub.commands = null
        SessionHub.reset()
        DispatchWindows.clear()
    }

    private fun findButton(v: View, label: String): Button? {
        if (v is Button && v.text.toString() == label) return v
        if (v is ViewGroup) for (i in 0 until v.childCount) findButton(v.getChildAt(i), label)?.let { return it }
        return null
    }

    private fun tap(scenario: ActivityScenario<PromptActivity>, label: String, eventTime: Long) {
        scenario.onActivity { a ->
            val b = findButton(a.window.decorView, label)!!
            val down = MotionEvent.obtain(eventTime, eventTime, MotionEvent.ACTION_DOWN, b.width / 2f, b.height / 2f, 0)
            val up = MotionEvent.obtain(eventTime, eventTime + 10, MotionEvent.ACTION_UP, b.width / 2f, b.height / 2f, 0)
            b.dispatchTouchEvent(down)
            b.dispatchTouchEvent(up)
            down.recycle(); up.recycle()
        }
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
    }

    @Test
    fun dispatchedTapCannotAcceptAFile() {
        ActivityScenario.launch(PromptActivity::class.java).use { scenario ->
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            assertTrue("InputGuard closed while a prompt is in front", SessionHub.guard.state.inPromptWindow && !SessionHub.guard.allow())
            val now = SystemClock.uptimeMillis()
            DispatchWindows.record(now, 50)
            tap(scenario, "Save file", now + 20)
            assertTrue("an injected tap answered the prompt: $answers", answers.isEmpty())
            DispatchWindows.clear()
            tap(scenario, "Save file", SystemClock.uptimeMillis())
            assertEquals(listOf("file-1" to true), answers.toList())
        }
    }
}
