package com.indiansassist.desk.session

import android.content.Intent
import android.net.Uri
import com.indiansassist.desk.core.ConsentInfo
import com.indiansassist.desk.core.DeskPhase
import com.indiansassist.desk.core.EndInfo
import com.indiansassist.desk.core.IncomingOffer
import com.indiansassist.desk.core.InputGuard
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

data class ChatLine(val from: String, val text: String, val ts: Long)

/** A Desk prompt (section 12.3): an incoming file or a level request, answered in [com.indiansassist.desk.ui.PromptActivity]. */
sealed interface Prompt {
    val id: String
    data class File(override val id: String, val offer: IncomingOffer, val sender: String) : Prompt
    data class Level(override val id: String, val technician: String, val reason: String?) : Prompt
}

data class UiState(
    val phase: DeskPhase = DeskPhase.IDLE,
    val status: String = "",
    val technician: String? = null,
    val org: String? = null,
    val consent: ConsentInfo? = null,
    val sas: String? = null,
    val sasHistory: List<Pair<Int, String>> = emptyList(),
    val secured: Boolean = false,
    val recording: Boolean = false,
    val level: String = "view",
    val voiceMuted: Boolean = true,
    val chat: List<ChatLine> = emptyList(),
    val saved: List<String> = emptyList(),
    val prompts: List<Prompt> = emptyList(),
    val error: String? = null,
    val ended: EndInfo? = null,
)

/** What the UI can ask of the running session (implemented by the service's controller). */
interface SessionCommands {
    fun consentAccepted(level: String, projectionData: Intent)
    fun consentDeclined()
    fun stop()
    fun viewOnly()
    fun sendChat(text: String)
    fun setMuted(muted: Boolean)
    fun sendFile(uri: Uri)
    fun answerPrompt(id: String, accept: Boolean)
}

/**
 * Process-wide session state for the activities, the notification, the overlay and the Accessibility service. The
 * [guard] is the single InputGuard of section 12.2.
 */
object SessionHub {
    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state
    val guard = InputGuard()

    @Volatile
    var commands: SessionCommands? = null

    /** Captured-frame counter of the live capture (instrumented smoke, section 15.3). */
    @Volatile
    var framesProbe: (() -> Long)? = null

    @Volatile
    private var ownInFront = false

    fun update(f: (UiState) -> UiState) = _state.update(f)

    fun reset() {
        _state.value = UiState()
        guard.state = guard.state.copy(active = false, level = "view", established = false)
    }

    /** One of the app's own activities is resumed: injected input must never land on it (section 12.3). */
    fun ownWindowInFront(front: Boolean) {
        ownInFront = front
        guard.state = guard.state.copy(inPromptWindow = front)
    }

    val isOwnWindowInFront: Boolean get() = ownInFront

    fun addPrompt(p: Prompt) = update { it.copy(prompts = it.prompts + p) }

    fun removePrompt(id: String) = update { s -> s.copy(prompts = s.prompts.filterNot { it.id == id }) }
}
