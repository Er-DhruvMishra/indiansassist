package com.indiansassist.desk

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.indiansassist.desk.core.AgentCapabilities
import com.indiansassist.desk.core.ClientPlatform
import com.indiansassist.desk.core.ConsentInfo
import com.indiansassist.desk.core.DeskClient
import com.indiansassist.desk.core.DeskEffect
import com.indiansassist.desk.core.DeskEvent
import com.indiansassist.desk.core.DeskMachine
import com.indiansassist.desk.core.obj
import com.indiansassist.desk.core.str
import com.indiansassist.desk.service.Indicator
import com.indiansassist.desk.session.SessionCommands
import com.indiansassist.desk.session.SessionHub
import com.indiansassist.desk.ui.ConsentActivity
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Section 12.3: the notification precondition disables **Share my screen**; a lost indicator ends the session. */
@RunWith(AndroidJUnit4::class)
class IndicatorTest {
    private val inst = InstrumentationRegistry.getInstrumentation()
    private val ctx = inst.targetContext

    private val fake = object : SessionCommands {
        override fun consentAccepted(level: String, projectionData: Intent) {}
        override fun consentDeclined() {}
        override fun stop() {}
        override fun viewOnly() {}
        override fun sendChat(text: String) {}
        override fun setMuted(muted: Boolean) {}
        override fun sendFile(uri: Uri) {}
        override fun answerPrompt(id: String, accept: Boolean) {}
    }

    private fun shell(cmd: String) = inst.uiAutomation.executeShellCommand(cmd).close()

    @Before
    fun setUp() {
        assumeTrue("POST_NOTIFICATIONS is a runtime permission from Android 13", Build.VERSION.SDK_INT >= 33)
        SessionHub.reset()
        SessionHub.commands = fake
        SessionHub.update { it.copy(consent = ConsentInfo("Asha", "Acme", "off", "in-mum")) }
    }

    @After
    fun tearDown() {
        Indicator.testOverride = null
        SessionHub.commands = null
        SessionHub.reset()
    }

    private fun <T : View> find(v: View, cls: Class<T>, pred: (T) -> Boolean): T? {
        if (cls.isInstance(v) && pred(cls.cast(v)!!)) return cls.cast(v)
        if (v is ViewGroup) for (i in 0 until v.childCount) find(v.getChildAt(i), cls, pred)?.let { return it }
        return null
    }

    @Test
    fun notificationPreconditionDisablesShare() {
        // Revoking POST_NOTIFICATIONS would kill the process under test, so the unusable state is forced.
        Indicator.testOverride = false
        assertFalse(Indicator.usable(ctx))
        ActivityScenario.launch(ConsentActivity::class.java).use { sc ->
            inst.waitForIdleSync()
            sc.onActivity { a ->
                val root = a.window.decorView
                find(root, CheckBox::class.java) { true }!!.isChecked = true
                val b = find(root, Button::class.java) { it.text == "Share my screen" || it.text == "Allow notifications" }!!
                assertTrue("Share my screen must not be usable without the indicator", b.text == "Allow notifications" || !b.isEnabled)
            }
        }
        Indicator.testOverride = null
        shell("pm grant ${ctx.packageName} android.permission.POST_NOTIFICATIONS")
        Thread.sleep(500)
        assertTrue(Indicator.usable(ctx))
        ActivityScenario.launch(ConsentActivity::class.java).use { sc ->
            inst.waitForIdleSync()
            sc.onActivity { a ->
                val root = a.window.decorView
                val share = find(root, Button::class.java) { it.text == "Share my screen" }!!
                assertFalse("disabled until the checklist is ticked", share.isEnabled)
                find(root, CheckBox::class.java) { true }!!.isChecked = true
                assertTrue(share.isEnabled)
            }
        }
    }

    @Test
    fun indicatorLostEndsTheSession() {
        Indicator.testOverride = false
        val m = DeskMachine(DeskClient(version = "0", platform = ClientPlatform("15", "x64"), tokenSource = "manual", capabilities = AgentCapabilities()), null)
        m.handle(DeskEvent.Start("t", "ws://x"))
        m.handle(DeskEvent.SocketOpen(false))
        m.handle(DeskEvent.Server(obj("t" to "desk.hello.ok")))
        m.handle(DeskEvent.Server(obj("t" to "knock.ok", "sessionId" to "s", "resumeKey" to "k")))
        m.handle(DeskEvent.Server(obj("t" to "session.created", "sessionId" to "s", "state" to "consent_pending")))
        m.handle(DeskEvent.ConsentAccepted("view"))
        m.handle(DeskEvent.Server(obj("t" to "consent.ok", "state" to "active", "iceServers" to emptyList<Any>())))
        // The service's 5 s poll does exactly this.
        val effects = if (m.isLive && !Indicator.usable(ctx)) m.handle(DeskEvent.IndicatorLost) else emptyList()
        val end = effects.filterIsInstance<DeskEffect.Send>().single { it.msg.str("t") == "session.end" }
        assertEquals("indicator_lost", end.msg.str("note"))
        assertTrue(DeskEffect.Teardown in effects)
    }
}
