package com.indiansassist.desk

import android.app.NotificationManager
import android.app.UiAutomation
import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Configurator
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import com.indiansassist.desk.core.DeskPhase
import com.indiansassist.desk.service.DeskAccessibilityService
import com.indiansassist.desk.service.Indicator
import com.indiansassist.desk.session.SessionHub
import com.indiansassist.desk.ui.MainActivity
import org.junit.After
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.regex.Pattern

/**
 * The live emulator end-to-end test (contracts section 15.3), the device half of `pnpm android:e2e`
 * (apps/android/tools/android-e2e.mjs drives the Assist half: the real web console in Playwright, REST and ws).
 * Skipped unless the runner gets `IA_EMULATOR=1` and `IA_TOKEN` (a `p3_portable` compact token or 12-digit code).
 *
 * The two halves synchronise through the device: this test reports progress as `IA_E2E` logcat lines
 * (`step=<name> k=v ...`, `fail=<reason>`) and waits for the driver's go signals, which are empty files the driver
 * creates in [signalDir] (read with the instrumentation's shell, because the app cannot read /data/local/tmp).
 *
 * Device steps: deep link `indiansassist://join?t=`; the consent screen names the technician and the org; **View and
 * control** (the Accessibility service is pre-enabled by the driver), the checklist, **Share my screen**; the system
 * MediaProjection dialog is driven with UiAutomator ("Entire screen", then Start: it cannot be pre-granted on API 34+);
 * `active` with captured frames; the foreground sharing notification is posted; the security code read from the app
 * screen equals the state's SAS; Home (the InputGuard refuses injected input while an IndiansAssist window is in
 * front, section 12.3); the technician's chat line arrives and a reply is typed in the app; the incoming file is
 * accepted with a physical tap and lands in Download/IndiansAssist; on the driver's `stop` signal **Stop sharing**
 * ends the session and the notification is gone.
 */
@RunWith(AndroidJUnit4::class)
class AssistE2ETest {
    private val args = InstrumentationRegistry.getArguments()
    private val inst = InstrumentationRegistry.getInstrumentation()
    private val ctx = inst.targetContext
    // UiAutomation suppresses every other accessibility service by default; this test needs ours bound.
    private val device: UiDevice = run {
        Configurator.getInstance().uiAutomationFlags = UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES
        UiDevice.getInstance(inst)
    }
    private val signalDir = args.getString("IA_SIGNAL_DIR") ?: "/data/local/tmp/ia-e2e"

    @After
    fun stopIfRunning() {
        SessionHub.commands?.stop()
    }

    @Test
    fun liveSessionWithPlaywrightAssist() {
        assumeTrue("set IA_EMULATOR=1 to run the live emulator e2e (pnpm android:e2e)", args.getString("IA_EMULATOR") == "1")
        val token = args.getString("IA_TOKEN").orEmpty()
        assumeTrue("set IA_TOKEN to a p3_portable compact token or 12-digit code", token.isNotEmpty())
        val tech = args.getString("IA_TECH").orEmpty()
        val org = args.getString("IA_ORG").orEmpty()
        val chatIn = args.getString("IA_CHAT_IN") ?: "Hello from the Assist"
        val chatOut = args.getString("IA_CHAT_OUT") ?: "Hello from the Android Desk"
        val fileName = args.getString("IA_FILE_NAME").orEmpty()

        // `am instrument` force-stops the app, and a force stop drops its Accessibility service from the enabled list,
        // so the driver's `settings put` is repeated here from the instrumentation's shell (section 12.2: a user turns
        // the service on in Settings; the harness does it for them).
        // The removal is asynchronous, so the setting is (re)written until the service is actually bound.
        val component = "${ctx.packageName}/${DeskAccessibilityService::class.java.name}"
        var bound = false
        for (attempt in 0 until 4) {
            if (attempt > 0) shell("settings put secure enabled_accessibility_services null")
            shell("settings put secure enabled_accessibility_services $component")
            shell("settings put secure accessibility_enabled 1")
            if (waitFor(8_000) { DeskAccessibilityService.instance != null }) { bound = true; break }
        }
        check(bound, "a11y_not_bound", "the Accessibility service did not bind")
        step("a11y_bound")

        step("launch")
        val param = if (token.startsWith("ia1.")) "t" else "c"
        ctx.startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse("indiansassist://join?$param=${Uri.encode(token)}"), ctx, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        check(waitFor(120_000) { SessionHub.state.value.phase == DeskPhase.CONSENT_PENDING }, "consent_pending_timeout", "never reached consent_pending (did the Assist accept the knock?)")
        step("consent_pending", "session" to (SessionHub.state.value.consent?.technician ?: ""))

        // Consent screen: who asks (technician and org), then View and control, checklist, Share my screen.
        val who = if (org.isBlank()) tech else "$tech ($org)"
        val title = device.wait(Until.findObject(By.textContains("wants to see this phone")), 20_000)
        check(title != null, "consent_screen_missing", "the consent screen did not open")
        val titleText = title!!.text
        check(tech.isEmpty() || titleText == "$who wants to see this phone", "consent_title", "consent title was '$titleText', expected '$who wants to see this phone'")
        step("consent_screen", "title" to titleText)
        val control = find(By.text("View and control (tap, swipe and type)"), 5_000, "control_radio")
        check(control.isEnabled, "control_disabled", "View and control is disabled: the Accessibility service is not enabled")
        control.click()
        check(waitFor(3_000) { device.findObject(By.text("View and control (tap, swipe and type)"))?.isChecked == true }, "control_not_checked", "View and control did not get checked")
        scrollTo("I have closed or hidden anything private").click()
        val share = scrollTo("Share my screen")
        check(waitFor(5_000) { device.findObject(By.text("Share my screen"))?.isEnabled == true }, "share_disabled", "Share my screen stays disabled (notifications not allowed?)")
        share.click()
        step("share_clicked")

        acceptProjectionDialog()

        check(waitFor(60_000) { SessionHub.state.value.phase == DeskPhase.ACTIVE }, "active_timeout", "never reached active (phase ${SessionHub.state.value.phase})")
        check(SessionHub.state.value.level == "control", "level", "level is ${SessionHub.state.value.level}, expected control")
        check(waitFor(30_000) { (SessionHub.framesProbe?.invoke() ?: 0) > 0 }, "no_frames", "MediaProjection captured no frames")
        step("active", "frames" to (SessionHub.framesProbe?.invoke() ?: 0).toString(), "level" to SessionHub.state.value.level)

        // The foreground-service sharing notification is the indicator (section 12.3).
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val note = nm.activeNotifications.firstOrNull { it.id == Indicator.ID_SHARING }
        check(note != null, "no_notification", "the sharing notification is not posted")
        val noteTitle = note!!.notification.extras.getCharSequence("android.title")?.toString().orEmpty()
        check(noteTitle.startsWith("Sharing your screen with"), "notification_title", "notification title '$noteTitle'")
        check(note.isOngoing, "notification_not_ongoing", "the sharing notification is dismissable")
        step("notification", "title" to noteTitle)

        // Security code: read from the app screen through UiAutomator, compared with the session state.
        check(waitFor(60_000) { SessionHub.state.value.secured }, "sec_timeout", "the ia.sec handshake never established")
        val sasObj = device.wait(Until.findObject(By.textStartsWith("Security code ")), 15_000)
        check(sasObj != null, "sas_not_shown", "the app screen shows no security code")
        val m = Regex("Security code (\\d{3}) (\\d{3})").find(sasObj!!.text)
        check(m != null, "sas_format", "security code text '${sasObj.text}'")
        val screenSas = m!!.groupValues[1] + m.groupValues[2]
        val stateSas = SessionHub.state.value.sas?.replace(" ", "")
        check(screenSas == stateSas, "sas_mismatch_local", "screen SAS $screenSas != state SAS $stateSas")
        step("sas", "sas" to screenSas)

        // Leave the app: injected input is refused while one of our own windows is in front (section 12.3).
        device.pressHome()
        check(waitFor(5_000) { !SessionHub.isOwnWindowInFront }, "still_in_front", "an IndiansAssist window is still in front after Home")
        step("home")

        // Chat both ways: the technician's line arrives, the reply is typed in the app.
        check(waitFor(150_000) { SessionHub.state.value.chat.any { it.text == chatIn && it.from != "You" } }, "chat_in_timeout", "the technician's chat line never arrived")
        step("chat_in")
        bringToFront()
        val field = device.wait(Until.findObject(By.clazz("android.widget.EditText")), 10_000)
        check(field != null, "chat_field", "no chat field on the in-session screen")
        field!!.text = chatOut
        scrollTo("Send").click()
        check(waitFor(10_000) { SessionHub.state.value.chat.any { it.from == "You" && it.text == chatOut } }, "chat_out", "the reply did not reach the chat list")
        step("chat_out")

        // Incoming file: accepted with a physical tap, saved in Download/IndiansAssist through MediaStore.
        val save = device.wait(Until.findObject(By.text("Save file")), 120_000)
        check(save != null, "file_prompt_timeout", "no file prompt appeared")
        if (fileName.isNotEmpty()) check(device.findObject(By.textContains(fileName)) != null, "file_prompt_name", "the file prompt does not show $fileName")
        save!!.click()
        check(waitFor(60_000) { SessionHub.state.value.saved.isNotEmpty() }, "file_save_timeout", "the file was never saved")
        val uri = Uri.parse(SessionHub.state.value.saved.first())
        var shownName = ""
        var relPath = ""
        ctx.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.RELATIVE_PATH), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                shownName = c.getString(0) ?: ""
                relPath = c.getString(1) ?: ""
            }
        }
        step("file_saved", "name" to shownName, "path" to relPath, "uri" to uri.toString())

        // Stop from the app when the driver has checked everything it needs from the live session.
        check(waitSignal("stop", 180_000), "stop_signal_timeout", "the driver never sent the stop signal")
        bringToFront()
        scrollTo("Stop sharing").click()
        check(waitFor(30_000) { SessionHub.state.value.ended != null }, "end_timeout", "Stop did not end the session")
        val ended = SessionHub.state.value.ended!!
        // The end reason is the server's (session.ended); the driver asserts and classifies it with the audit.
        check(ended.endReason in setOf("desk_stopped", "error"), "end_reason", "endReason ${ended.endReason}")
        check(waitFor(10_000) { nm.activeNotifications.none { it.id == Indicator.ID_SHARING } }, "notification_left", "the sharing notification outlived the session")
        step("ended", "reason" to ended.endReason, "tail" to (ended.hashChainTail ?: ""))
    }

    // ---------- MediaProjection system dialog ----------

    /**
     * API 34+: "Start recording or casting with IndiansAssist?" with a spinner (A single app / Entire screen) and
     * Start; API 35 builds also say "Share one app" / "Share entire screen" and "Share screen". Neither can be
     * pre-granted with adb (appops PROJECT_MEDIA only skips the dialog for privileged callers).
     */
    private fun acceptProjectionDialog() {
        val single = device.wait(Until.findObject(By.text(Pattern.compile("A single app|Share one app", Pattern.CASE_INSENSITIVE))), 15_000)
        if (single != null) {
            single.click()
            val entire = device.wait(Until.findObject(By.text(Pattern.compile("Entire screen|Share entire screen", Pattern.CASE_INSENSITIVE))), 5_000)
            check(entire != null, "projection_entire", "no 'Entire screen' option in the MediaProjection dialog: ${screenTexts()}")
            entire!!.click()
        }
        val start = device.wait(Until.findObject(By.text(Pattern.compile("Start|Start now|Share screen", Pattern.CASE_INSENSITIVE)).clickable(true)), 10_000)
            ?: device.wait(Until.findObject(By.text(Pattern.compile("Start|Start now|Share screen", Pattern.CASE_INSENSITIVE))), 2_000)
        check(start != null, "projection_start", "no Start button in the MediaProjection dialog: ${screenTexts()}")
        val label = start!!.text
        start.click()
        step("projection_accepted", "spinner" to (single != null).toString(), "button" to label)
    }

    // ---------- helpers ----------

    private fun bringToFront() {
        ctx.startActivity(Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        device.wait(Until.hasObject(By.pkg(ctx.packageName).depth(0)), 5_000)
        device.waitForIdle(2_000)
    }

    private fun find(sel: androidx.test.uiautomator.BySelector, ms: Long, what: String): UiObject2 {
        val o = device.wait(Until.findObject(sel), ms)
        check(o != null, "missing_$what", "$what not on screen: ${screenTexts()}")
        return o!!
    }

    /** Finds a text in the app's (scrolling) screen, scrolling down when it is below the fold. */
    private fun scrollTo(text: String): UiObject2 {
        repeat(6) {
            device.findObject(By.text(text))?.let { return it }
            device.findObject(By.scrollable(true))?.scroll(androidx.test.uiautomator.Direction.DOWN, 0.6f)
            device.waitForIdle(500)
        }
        return find(By.text(text), 2_000, text)
    }

    private fun screenTexts(): String = device.findObjects(By.textStartsWith("")).mapNotNull { it.text?.takeIf { t -> t.isNotBlank() } }.take(40).joinToString(" | ")

    /**
     * Values are percent-encoded (`Uri.encode`), which is lossless: a space becomes `%20` and an underscore stays an
     * underscore. The runner decodes with `decodeURIComponent`. The earlier space-to-underscore scheme could not be
     * reversed, so a wire value such as `desk_stopped` reached the runner as "desk stopped".
     */
    private fun step(name: String, vararg kv: Pair<String, String>) {
        Log.i(TAG, "step=$name" + kv.joinToString("") { " ${it.first}=${Uri.encode(it.second)}" })
    }

    private fun check(cond: Boolean, code: String, message: String) {
        if (!cond) {
            Log.e(TAG, "fail=$code $message")
            throw AssertionError("$code: $message")
        }
    }

    private fun shell(cmd: String): String {
        val pfd = inst.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES).executeShellCommand(cmd)
        return ParcelFileDescriptor.AutoCloseInputStream(pfd).use { it.readBytes().toString(Charsets.UTF_8) }
    }

    private fun waitSignal(name: String, ms: Long): Boolean = waitFor(ms, 500) { shell("ls $signalDir").lines().any { it.trim() == name } }

    private fun waitFor(ms: Long, every: Long = 250, cond: () -> Boolean): Boolean {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) {
            if (cond()) return true
            Thread.sleep(every)
        }
        return cond()
    }

    companion object {
        const val TAG = "IA_E2E"
    }
}
