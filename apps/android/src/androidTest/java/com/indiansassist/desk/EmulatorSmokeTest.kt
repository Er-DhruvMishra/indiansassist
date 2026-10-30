package com.indiansassist.desk

import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.indiansassist.desk.core.DeskPhase
import com.indiansassist.desk.session.SessionHub
import com.indiansassist.desk.ui.MainActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The section 15.3 emulator smoke, gated `IA_EMULATOR=1` (and a `p3_portable` token in `IA_TOKEN`): joins through the
 * deep link against a local api at 10.0.2.2:4000, waits for a (fake) Assist to accept, ticks the checklist, grants
 * the system MediaProjection dialog through UiAutomator, and asserts `active` plus captured frames. See README.
 */
@RunWith(AndroidJUnit4::class)
class EmulatorSmokeTest {
    private val args = InstrumentationRegistry.getArguments()

    @Test
    fun joinsAndStreams() {
        assumeTrue("set IA_EMULATOR=1 to run the emulator smoke", args.getString("IA_EMULATOR") == "1")
        val token = args.getString("IA_TOKEN").orEmpty()
        assumeTrue("set IA_TOKEN to a p3_portable compact token or 12-digit code", token.isNotEmpty())
        val inst = InstrumentationRegistry.getInstrumentation()
        val device = UiDevice.getInstance(inst)
        val param = if (token.startsWith("ia1.")) "t" else "c"
        inst.targetContext.startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse("indiansassist://join?$param=${Uri.encode(token)}"), inst.targetContext, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        assertTrue("never reached consent_pending (is a fake Assist accepting?)", waitFor(90_000) { SessionHub.state.value.phase == DeskPhase.CONSENT_PENDING })
        device.wait(Until.findObject(By.text("I have closed or hidden anything private")), 15_000)?.click()
        device.wait(Until.findObject(By.text("Allow notifications")), 2_000)?.let {
            it.click()
            device.wait(Until.findObject(By.textContains("Allow")), 5_000)?.click()
        }
        device.wait(Until.findObject(By.text("Share my screen")), 10_000)!!.click()
        // System MediaProjection dialog (Android 14+: pick "A single app" / "Entire screen" then Start).
        device.wait(Until.findObject(By.textContains("Entire screen")), 5_000)?.click()
        (device.wait(Until.findObject(By.text("Start")), 10_000) ?: device.wait(Until.findObject(By.textContains("Start now")), 5_000))?.click()
        assertTrue("never reached active", waitFor(60_000) { SessionHub.state.value.phase == DeskPhase.ACTIVE })
        assertTrue("no frames captured", waitFor(30_000) { (SessionHub.framesProbe?.invoke() ?: 0) > 0 })
        assertTrue("secure channel never established", waitFor(30_000) { SessionHub.state.value.secured })
        assertEquals(6, SessionHub.state.value.sas?.replace(" ", "")?.length)
        SessionHub.commands?.stop()
        assertTrue(waitFor(15_000) { SessionHub.state.value.ended != null })
    }

    private fun waitFor(ms: Long, cond: () -> Boolean): Boolean {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) {
            if (cond()) return true
            Thread.sleep(250)
        }
        return cond()
    }
}
