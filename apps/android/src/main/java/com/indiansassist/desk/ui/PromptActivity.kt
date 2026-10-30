package com.indiansassist.desk.ui

import android.graphics.Color
import android.os.Bundle
import android.text.format.Formatter
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.indiansassist.desk.core.FileNames
import com.indiansassist.desk.session.Prompt
import com.indiansassist.desk.session.SessionHub
import kotlinx.coroutines.launch

/**
 * Desk prompts (contracts sections 3.4, 6.1 F4, 12.3): an incoming file (sanitised name, extension, declared type,
 * size, sender; executables need a second tap) and a level request (**Allow** / **Refuse**). While this activity is
 * in front the InputGuard refuses every injected gesture, and every button also ignores obscured and injected touches.
 */
class PromptActivity : ComponentActivity() {
    private var shownId: String? = null
    private var armed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { shownId?.let { answer(it, false) } ?: finish() }
        })
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                SessionHub.state.collect { s ->
                    val p = s.prompts.firstOrNull()
                    if (p == null || s.ended != null) finish() else if (p.id != shownId) render(p)
                }
            }
        }
    }

    private fun render(p: Prompt) {
        shownId = p.id
        armed = false
        val col = Ui.column(this)
        col.filterTouchesWhenObscured = true
        when (p) {
            is Prompt.File -> {
                val o = p.offer
                col.addView(Ui.title(this, "${p.sender} wants to send you a file"))
                col.addView(Ui.body(this, "Name: ${o.name}\nType: ${FileNames.extension(o.name) ?: "none"}\nDeclared as: ${o.mime}\nSize: ${Formatter.formatShortFileSize(this, o.size)}"))
                if (o.executable) col.addView(Ui.body(this, "This file type can run programs on your phone.").apply { setTextColor(Color.parseColor(Ui.RED)) })
                col.addView(Ui.body(this, "It will be saved in Downloads/IndiansAssist. IndiansAssist never opens it.", 13f))
                lateinit var accept: android.widget.Button
                accept = Ui.guard(Ui.button(this, "Save file") {
                    if (o.executable && !armed) {
                        armed = true
                        accept.text = "Tap again to save this program file"
                    } else answer(p.id, true)
                })
                col.addView(accept)
                col.addView(Ui.guard(Ui.button(this, "Decline", Ui.RED) { answer(p.id, false) }))
            }
            is Prompt.Level -> {
                col.addView(Ui.title(this, "${p.technician} asks to control your phone"))
                col.addView(Ui.body(this, "Reason: ${p.reason?.takeIf { it.isNotBlank() } ?: "none given"}\nThey will be able to tap, swipe and type. You can switch back to view only from the notification at any time."))
                col.addView(Ui.guard(Ui.button(this, "Allow") { answer(p.id, true) }))
                col.addView(Ui.guard(Ui.button(this, "Refuse", Ui.RED) { answer(p.id, false) }))
            }
        }
        setContentView(Ui.scroll(this, col))
    }

    private fun answer(id: String, accept: Boolean) {
        SessionHub.commands?.answerPrompt(id, accept)
        SessionHub.removePrompt(id)
        shownId = null
    }
}
