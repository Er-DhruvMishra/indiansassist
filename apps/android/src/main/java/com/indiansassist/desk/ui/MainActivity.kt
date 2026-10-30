package com.indiansassist.desk.ui

import android.Manifest
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.indiansassist.desk.core.DeskPhase
import com.indiansassist.desk.core.JoinCode
import com.indiansassist.desk.core.JoinInput
import com.indiansassist.desk.core.TokenSource
import com.indiansassist.desk.net.ResolveError
import com.indiansassist.desk.net.TokenResolver
import com.indiansassist.desk.service.DeskAccessibilityService
import com.indiansassist.desk.service.Indicator
import com.indiansassist.desk.service.SessionService
import com.indiansassist.desk.session.SessionHub
import com.indiansassist.desk.session.UiState
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.launch

/**
 * Token entry (App Link / deep link, QR scan, manual paste; the clipboard is read only on a **Paste** tap), waiting,
 * the in-session screen (security code, Stop, View only, voice, chat, Send a file) and the ended receipt
 * (contracts section 12.3).
 */
class MainActivity : ComponentActivity() {
    private var screen = ""
    private var codeField: EditText? = null
    private var nameField: EditText? = null
    private var error: TextView? = null
    private var chatView: TextView? = null
    private var statusView: TextView? = null
    private var sasView: TextView? = null
    private var consentOpened = false
    private val resolver = TokenResolver()

    private val scan = registerForActivityResult(ScanContract()) { r -> r.contents?.let { join(it, TokenSource.DEEPLINK) } }
    private val pickFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { SessionHub.commands?.sendFile(it) } }
    private val mic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok -> if (ok) SessionHub.commands?.setMuted(false) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) { SessionHub.state.collect { render(it) } }
        }
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        Indicator.a11yIdle(this, SessionHub.commands == null && DeskAccessibilityService.isEnabled(this))
    }

    private fun handleIntent(i: Intent?) {
        if (i?.getBooleanExtra(EXTRA_OVERLAY_LOST, false) == true) {
            SessionHub.update { it.copy(error = "The always-on-top bar was turned off. Your screen is still shared: use Stop below or in the notification.") }
        }
        val data = i?.data ?: return
        join(data.toString(), TokenSource.DEEPLINK)
    }

    private fun join(raw: String, source: TokenSource) {
        if (SessionHub.commands != null) {
            SessionHub.update { it.copy(error = "Another support code was received; finish this session first.") }
            return
        }
        val code: JoinCode = JoinInput.parseAny(raw, TokenResolver.linkHosts()) ?: run {
            showError("That is not an IndiansAssist code or link.")
            return
        }
        showError("Checking the code...")
        val label = nameField?.text?.toString()?.trim()?.take(80)?.ifBlank { null }
        Thread {
            try {
                val t = resolver.resolve(code)
                runOnUiThread {
                    showError("")
                    consentOpened = false
                    SessionService.join(this, t, source.wire, label)
                }
            } catch (e: ResolveError) {
                runOnUiThread { showError(e.userMessage) }
            }
        }.start()
    }

    private fun showError(text: String) {
        error?.text = text
    }

    private fun kindOf(s: UiState): String = when {
        s.ended != null && SessionHub.commands == null -> "ended"
        s.phase in setOf(DeskPhase.ACTIVE, DeskPhase.STARTING, DeskPhase.ENDING) -> "live"
        s.phase in setOf(DeskPhase.CONNECTING, DeskPhase.WAITING, DeskPhase.HELD, DeskPhase.KNOCKED, DeskPhase.CONSENT_PENDING) -> "waiting"
        else -> "entry"
    }

    private fun render(s: UiState) {
        val kind = kindOf(s)
        if (kind != screen) {
            screen = kind
            setContentView(Ui.scroll(this, when (kind) {
                "live" -> liveScreen()
                "waiting" -> waitingScreen()
                "ended" -> endedScreen(s)
                else -> entryScreen()
            }))
        }
        statusView?.text = s.status
        error?.text = s.error ?: error?.text
        sasView?.text = when {
            s.sas != null -> "Security code ${s.sas}\nIf the code your technician reads out is different, tap Stop."
            kind == "live" -> "Securing the connection..."
            else -> ""
        }
        chatView?.text = s.chat.takeLast(30).joinToString("\n") { "${it.from}: ${it.text}" }
        if (s.phase == DeskPhase.CONSENT_PENDING && !consentOpened) {
            consentOpened = true
            startActivity(Intent(this, ConsentActivity::class.java))
        }
        if (s.prompts.isNotEmpty() && kind == "live") startActivity(Intent(this, PromptActivity::class.java))
    }

    private fun entryScreen(): LinearLayout = Ui.column(this).apply {
        addView(Ui.title(this@MainActivity, "Get help from your technician"))
        addView(Ui.body(this@MainActivity, "Open the link your technician sent, scan their QR code, or paste the support code."))
        val f = EditText(this@MainActivity).apply { hint = "Paste your support code or link"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS }
        codeField = f
        addView(f)
        nameField = EditText(this@MainActivity).apply { hint = "Your name (optional)" }.also { addView(it) }
        addView(Ui.button(this@MainActivity, "Paste") {
            // Read only on this tap (Android 12+ shows its own toast); never automatically.
            val clip = getSystemService(ClipboardManager::class.java).primaryClip
            f.setText(clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this@MainActivity)?.toString() ?: "")
        })
        addView(Ui.button(this@MainActivity, "Scan QR code") { scan.launch(ScanOptions().setPrompt("Scan the QR code on your technician's screen").setBeepEnabled(false).setOrientationLocked(false)) })
        addView(Ui.button(this@MainActivity, "Join") { join(f.text.toString(), TokenSource.MANUAL) })
        error = Ui.body(this@MainActivity, "", 14f).apply { setTextColor(Color.parseColor(Ui.RED)) }.also { addView(it) }
    }

    private fun waitingScreen(): LinearLayout = Ui.column(this).apply {
        addView(Ui.title(this@MainActivity, "IndiansAssist"))
        statusView = Ui.body(this@MainActivity, "").also { addView(it) }
        addView(Ui.button(this@MainActivity, "Review the request") { startActivity(Intent(this@MainActivity, ConsentActivity::class.java)) })
        addView(Ui.button(this@MainActivity, "Cancel", Ui.RED) { SessionHub.commands?.stop() ?: SessionHub.reset() })
        error = Ui.body(this@MainActivity, "", 14f).also { addView(it) }
    }

    private fun liveScreen(): LinearLayout = Ui.column(this).apply {
        val s = SessionHub.state.value
        addView(Ui.title(this@MainActivity, "Sharing with ${s.technician ?: "your technician"}"))
        sasView = Ui.body(this@MainActivity, "", 20f).also { addView(it) }
        statusView = Ui.body(this@MainActivity, "").also { addView(it) }
        addView(Ui.guard(Ui.button(this@MainActivity, "Stop sharing", Ui.RED) { SessionHub.commands?.stop() }))
        addView(Ui.guard(Ui.button(this@MainActivity, "View only") { SessionHub.commands?.viewOnly() }))
        addView(Ui.guard(Ui.button(this@MainActivity, "Microphone on / off") {
            val muted = SessionHub.state.value.voiceMuted
            if (muted && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) mic.launch(Manifest.permission.RECORD_AUDIO)
            else SessionHub.commands?.setMuted(!muted)
        }))
        addView(Ui.guard(Ui.button(this@MainActivity, "Send a file") { pickFile.launch(arrayOf("*/*")) }))
        if (!DeskAccessibilityService.isEnabled(this@MainActivity)) {
            addView(Ui.button(this@MainActivity, "Turn on remote control in Settings", "#374151") { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) })
        }
        addView(Ui.body(this@MainActivity, "Chat", 14f))
        chatView = Ui.body(this@MainActivity, "", 15f).also { addView(it) }
        val msg = EditText(this@MainActivity).apply { hint = "Message" }
        addView(msg)
        addView(Ui.guard(Ui.button(this@MainActivity, "Send") {
            msg.text.toString().trim().takeIf { it.isNotEmpty() }?.let { SessionHub.commands?.sendChat(it) }
            msg.setText("")
        }))
        error = Ui.body(this@MainActivity, "", 14f).also { addView(it) }
    }

    private fun endedScreen(s: UiState): LinearLayout = Ui.column(this).apply {
        val e = s.ended!!
        addView(Ui.title(this@MainActivity, "Session ended"))
        addView(Ui.body(this@MainActivity, buildString {
            append("Reason: ").append(e.endReason.replace('_', ' '))
            if (s.sasHistory.isNotEmpty()) append("\nSecurity codes: ").append(s.sasHistory.joinToString { "${it.second} (key ${it.first})" })
            e.hashChainTail?.let { append("\nAudit chain at session end: ").append(it.take(16)) }
            if (s.saved.isNotEmpty()) append("\nFiles saved in Downloads/IndiansAssist: ").append(s.saved.size)
            s.error?.let { append("\n").append(it) }
        }))
        if (DeskAccessibilityService.isEnabled(this@MainActivity)) {
            addView(Ui.button(this@MainActivity, "Turn off remote control in Settings", Ui.RED) { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) })
        }
        addView(Ui.button(this@MainActivity, "Done") { SessionHub.reset() })
    }

    companion object {
        const val EXTRA_OVERLAY_LOST = "overlay_lost"
    }
}
