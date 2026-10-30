package com.indiansassist.desk.ui

import android.Manifest
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CountDownTimer
import android.provider.Settings
import android.widget.Button
import android.widget.CheckBox
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.indiansassist.desk.core.DeskPhase
import kotlinx.coroutines.launch
import com.indiansassist.desk.service.DeskAccessibilityService
import com.indiansassist.desk.service.Indicator
import com.indiansassist.desk.session.SessionHub

/**
 * The consent screen (contracts section 12.3): who asks, what is shared (the whole screen), the recording sentence,
 * the required checkbox, the level radio (control needs the Accessibility service), and **Share my screen**, which is
 * disabled until the indicator notification can be shown and then triggers the system MediaProjection dialog (a
 * second OS consent). Back and **Decline** decline. Every control filters obscured and injected touches.
 */
class ConsentActivity : ComponentActivity() {
    private lateinit var share: Button
    private lateinit var checklist: CheckBox
    private lateinit var control: RadioButton
    private lateinit var viewOnly: RadioButton
    private lateinit var notice: TextView
    private lateinit var countdown: TextView
    private var timer: CountDownTimer? = null
    private var decided = false

    private val projection = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val data = r.data
        if (r.resultCode == RESULT_OK && data != null) {
            decided = true
            SessionHub.commands?.consentAccepted(if (control.isChecked && control.isEnabled) "control" else "view", data)
            finish()
        }
        // Cancelled system dialog: nothing is sent and the consent screen stays (A section 7.7).
    }

    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { refresh() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val info = SessionHub.state.value.consent
        if (info == null || SessionHub.commands == null) { finish(); return }
        // Back declines, like closing the consent window on Windows.
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = decline()
        })
        val col = Ui.column(this)
        col.filterTouchesWhenObscured = true
        val who = if (info.org.isBlank()) info.technician else "${info.technician} (${info.org})"
        col.addView(Ui.title(this, "$who wants to see this phone"))
        col.addView(Ui.body(this, "What will be shared: your whole screen, including notifications that appear while sharing. Android cannot share a single app."))
        if (info.recordingMode == "server" || info.recordingMode == "both") {
            col.addView(Ui.body(this, "This session will be recorded and kept by ${info.org.ifBlank { "the support team" }}${info.region?.let { " in region $it" } ?: ""}. You will see a recording mark while it runs."))
        }
        col.addView(Ui.body(this, "Before you start, check the security code on the next screen against what your technician reads out.", 14f))
        val levels = RadioGroup(this)
        viewOnly = Ui.guard(RadioButton(this).apply { text = "View only"; id = android.view.View.generateViewId() })
        control = Ui.guard(RadioButton(this).apply { text = "View and control (tap, swipe and type)"; id = android.view.View.generateViewId() })
        levels.addView(viewOnly)
        levels.addView(control)
        levels.check(control.id)
        col.addView(levels)
        col.addView(Ui.guard(Ui.button(this, "Turn on remote control in Settings", "#374151") {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }))
        col.addView(Ui.guard(Ui.button(this, "Allow the always-on-top bar (optional)", "#374151") {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        }))
        checklist = Ui.guard(CheckBox(this).apply { text = "I have closed or hidden anything private"; setOnCheckedChangeListener { _, _ -> refresh() } })
        col.addView(checklist)
        notice = Ui.body(this, "", 14f)
        col.addView(notice)
        share = Ui.guard(Ui.button(this, "Share my screen") { onShare() })
        col.addView(share)
        col.addView(Ui.guard(Ui.button(this, "Decline", Ui.RED) { decline() }))
        countdown = Ui.body(this, "", 13f)
        col.addView(countdown)
        setContentView(Ui.scroll(this, col))
        timer = object : CountDownTimer(180_000, 1000) {
            override fun onTick(ms: Long) { countdown.text = "This request expires in ${ms / 1000} s" }
            override fun onFinish() { if (!decided) finish() }
        }.start()
        // A consent screen outlives its request only by mistake: close it once the session left consent_pending
        // (consented, declined, ended by the Assist, or the 180 s deadline on the server).
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                SessionHub.state.collect { s -> if (!decided && (s.phase != DeskPhase.CONSENT_PENDING || s.ended != null)) finish() }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (!decided && SessionHub.state.value.phase != DeskPhase.CONSENT_PENDING) return finish()
        refresh()
    }

    private fun refresh() {
        val a11y = DeskAccessibilityService.isEnabled(this)
        control.isEnabled = a11y
        if (!a11y && control.isChecked) (control.parent as RadioGroup).check(viewOnly.id)
        val indicator = Indicator.usable(this)
        share.isEnabled = indicator && checklist.isChecked
        share.alpha = if (share.isEnabled) 1f else 0.5f
        notice.text = buildString {
            if (!indicator) append("IndiansAssist must be allowed to show its sharing notification: it is how you always know your screen is shared, and where Stop lives. Tap Share my screen after allowing it.\n")
            if (!a11y) append("To let the technician tap and type, turn on IndiansAssist remote control in Settings. Without it the technician can only watch.")
        }
        if (!indicator && Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            share.text = "Allow notifications"
            share.isEnabled = true
            share.alpha = 1f
        } else {
            share.text = "Share my screen"
        }
    }

    private fun onShare() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }
        if (!Indicator.usable(this) || !checklist.isChecked) return refresh()
        projection.launch(getSystemService(MediaProjectionManager::class.java).createScreenCaptureIntent())
    }

    private fun decline() {
        decided = true
        SessionHub.commands?.consentDeclined()
        finish()
    }

    override fun onDestroy() {
        timer?.cancel()
        super.onDestroy()
    }
}
