package com.indiansassist.desk.service

import android.content.Intent
import android.net.Uri
import android.os.Build
import com.indiansassist.desk.BuildConfig
import com.indiansassist.desk.core.AgentCapabilities
import com.indiansassist.desk.core.AgentControl
import com.indiansassist.desk.core.AttestOutbox
import com.indiansassist.desk.core.ClientPlatform
import com.indiansassist.desk.core.DeskClient
import com.indiansassist.desk.core.DeskEffect
import com.indiansassist.desk.core.DeskEvent
import com.indiansassist.desk.core.DeskMachine
import com.indiansassist.desk.core.DeskPhase
import com.indiansassist.desk.core.DeskSignal
import com.indiansassist.desk.core.InputAudit
import com.indiansassist.desk.core.OutboxEntry
import com.indiansassist.desk.core.obj
import com.indiansassist.desk.core.str
import com.indiansassist.desk.net.ResolvedToken
import com.indiansassist.desk.net.SignalSocket
import com.indiansassist.desk.session.ChatLine
import com.indiansassist.desk.session.Prompt
import com.indiansassist.desk.session.SessionCommands
import com.indiansassist.desk.session.SessionHub
import kotlinx.serialization.json.JsonObject
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Glue between [DeskMachine] (pure), the `/signal` socket, [LiveMedia] and the UI. Every machine event and effect runs
 * on one executor (`ia-desk`); input runs on `ia-input` so a 600 ms long press never blocks signaling.
 */
class DeskController(private val service: SessionService, private val token: ResolvedToken, tokenSource: String, deskLabel: String?) :
    SessionCommands, SignalSocket.Listener, LiveHost {
    private val exec = Executors.newSingleThreadScheduledExecutor { Thread(it, "ia-desk") }
    private val inputExec = Executors.newSingleThreadExecutor { Thread(it, "ia-input") }
    private val fileExec = Executors.newSingleThreadExecutor { Thread(it, "ia-file") }
    private val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown"
    private val client = DeskClient(
        version = BuildConfig.VERSION_NAME,
        platform = ClientPlatform(Build.VERSION.RELEASE.take(32), DeskClient.archOf(abi)),
        tokenSource = tokenSource,
        capabilities = AgentCapabilities(),
    )
    private val machine = DeskMachine(client, deskLabel)
    private val outbox = AttestOutbox()
    private val audit = InputAudit()
    private var socket: SignalSocket? = null
    private var live: LiveMedia? = null
    private var poll: ScheduledFuture<*>? = null
    private val timers = mutableListOf<ScheduledFuture<*>>()
    private var levelSeq = 0
    private val levelWaiters = HashMap<String, String>() // desk.consent_level frame id -> ctl.req id

    override val sessionId: String get() = machine.sessionId ?: ""
    override val technician: String get() = machine.technician ?: "your technician"
    override val recordingMode: String? get() = machine.recordingMode

    fun start() = post {
        SessionHub.commands = this
        SessionHub.update { it.copy(phase = DeskPhase.CONNECTING, technician = token.technician, org = token.org, status = "Connecting...") }
        run(machine.handle(DeskEvent.Start(token.code, token.signalUrl)))
        timers += exec.scheduleWithFixedDelay({ tick() }, 250, 250, TimeUnit.MILLISECONDS)
        timers += exec.scheduleWithFixedDelay({ live?.publishStats() }, 2, 2, TimeUnit.SECONDS)
        timers += exec.scheduleWithFixedDelay({ checkIndicator() }, 5, 5, TimeUnit.SECONDS)
        timers += exec.scheduleWithFixedDelay({ inputExec.execute { live?.dispatcher?.tick() } }, 50, 50, TimeUnit.MILLISECONDS)
    }

    private fun post(r: () -> Unit) {
        if (!exec.isShutdown) exec.execute { try { r() } catch (e: Exception) { android.util.Log.e("IA", "controller", e) } }
    }

    private fun event(e: DeskEvent) = run(machine.handle(e))

    private fun tick() {
        val sid = machine.sessionId ?: return
        audit.flush().forEach { outbox.add(it) }
        outbox.drain(sid) { socket?.send(it) ?: false }
    }

    // ---------- socket ----------

    override fun onOpen(reconnect: Boolean) = post { event(DeskEvent.SocketOpen(reconnect)) }

    override fun onMessage(msg: JsonObject) = post {
        when (msg.str("t")) {
            "error" -> msg.str("re")?.takeIf { it.startsWith("ev") }?.let { if (msg.str("code") == "rate_limited") outbox.rateLimited(it) }
            "event.ok" -> msg.str("re")?.let { outbox.acked(it) }
        }
        event(DeskEvent.Server(msg))
    }

    override fun onClosed(code: Int) = post { event(DeskEvent.SocketClosed(code)) }

    // ---------- effects ----------

    private fun run(effects: List<DeskEffect>) {
        for (e in effects) effect(e)
        SessionHub.update {
            it.copy(
                phase = machine.phase, technician = machine.technician ?: it.technician, level = machine.level,
                status = statusFor(machine.phase),
            )
        }
    }

    private fun effect(e: DeskEffect) {
        when (e) {
            is DeskEffect.Connect -> socket = SignalSocket(e.url, DeskClient.userAgent(BuildConfig.VERSION_NAME, Build.VERSION.SDK_INT, abi), this).also { it.connect() }
            is DeskEffect.Send -> socket?.send(e.msg)
            is DeskEffect.SendCtrl -> live?.sendCtrl(e.msg)
            DeskEffect.StartPolling -> if (poll == null) poll = exec.scheduleWithFixedDelay({ socket?.send(DeskSignal.poll()) }, 3, 3, TimeUnit.SECONDS)
            DeskEffect.StopPolling -> { poll?.cancel(false); poll = null }
            is DeskEffect.ShowConsent -> { SessionHub.update { it.copy(consent = e.info) }; service.showConsent() }
            is DeskEffect.StartMedia -> {
                SessionHub.guard.state = SessionHub.guard.state.copy(active = true, level = machine.level, established = false)
                outbox.add(OutboxEntry("a11y.state", obj("enabled" to DeskAccessibilityService.isEnabled(service))))
                live?.startAssist(e.ice)
                service.showOverlay()
            }
            is DeskEffect.RebuildPeer -> live?.rebuild(e.ice)
            is DeskEffect.RefreshIce -> live?.refreshIce(e.ice)
            DeskEffect.Teardown -> { live?.teardown(); live = null; service.mediaStopped() }
            DeskEffect.FlushOutbox -> {
                audit.flush(force = true).forEach { outbox.add(it) }
                if (machine.sessionId != null && machine.phase != DeskPhase.IDLE) outbox.add(OutboxEntry("a11y.state", obj("enabled" to DeskAccessibilityService.isEnabled(service))))
                machine.sessionId?.let { sid -> repeat(10) { outbox.drain(sid) { f -> socket?.send(f) ?: false } } }
            }
            is DeskEffect.Recording -> SessionHub.update { it.copy(recording = e.on) }
            is DeskEffect.LevelChanged -> {
                SessionHub.guard.state = SessionHub.guard.state.copy(level = e.level)
                if (e.level == "view") inputExec.execute { live?.dispatcher?.strokes?.cancel() }
                live?.sendAgentLevel()
            }
            is DeskEffect.PeerSignal -> live?.onPeerSignal(e.msg)
            is DeskEffect.ChatRelay -> live?.onChat(JsonObject(e.msg + ("t" to kotlinx.serialization.json.JsonPrimitive("chat"))))
                ?: SessionHub.update { it.copy(chat = it.chat + ChatLine(technician, e.msg.str("text") ?: "", System.currentTimeMillis())) }
            is DeskEffect.LevelReply -> e.re?.let { re -> levelWaiters.remove(re)?.let { id -> answerLevelOp(id, e.ok) } }
            DeskEffect.StartLocalEndTimer -> exec.schedule({ event(DeskEvent.LocalEndTimeout) }, 5, TimeUnit.SECONDS)
            DeskEffect.CloseSocket -> socket?.close()
            is DeskEffect.Ended -> ended(e)
        }
        service.refreshIndicator()
    }

    private fun ended(e: DeskEffect.Ended) {
        SessionHub.update { it.copy(ended = e.info, prompts = emptyList(), error = e.info.error?.let { c -> errorText(c) }) }
        SessionHub.commands = null
        SessionHub.framesProbe = null
        if (DeskAccessibilityService.isEnabled(service)) Indicator.a11yTurnOff(service)
        for (t in timers) t.cancel(false)
        poll?.cancel(false)
        socket?.close()
        socket = null
        service.finish()
        exec.schedule({ exec.shutdown(); inputExec.shutdownNow(); fileExec.shutdownNow() }, 1, TimeUnit.SECONDS)
    }

    private fun checkIndicator() {
        if (!machine.isLive) return
        if (!Indicator.usable(service)) event(DeskEvent.IndicatorLost)
        service.checkOverlay()
    }

    // ---------- LiveHost ----------

    override fun signal(msg: JsonObject) { socket?.send(msg) }

    override fun attest(e: OutboxEntry) { outbox.add(e) }

    override fun secFailed(reason: String) = post { event(DeskEvent.SecFailed(reason)) }

    override fun levelPrompt(id: String, reason: String?) {
        SessionHub.addPrompt(Prompt.Level("lvl-$id", technician, reason))
        service.showPrompt()
        exec.schedule({ if (SessionHub.state.value.prompts.any { it.id == "lvl-$id" }) levelAnswered(id, accept = false, timeout = true) }, 60, TimeUnit.SECONDS)
    }

    private fun levelAnswered(id: String, accept: Boolean, timeout: Boolean) {
        SessionHub.removePrompt("lvl-$id")
        val sid = machine.sessionId ?: return
        val opId = AgentControl.opIdFor(sid, id)
        if (accept && machine.phase == DeskPhase.ACTIVE) {
            val frameId = "lv${levelSeq++}"
            levelWaiters[frameId] = id
            socket?.send(DeskSignal.consentLevel(sid, "control", id = frameId, requested = true, opId = opId))
        } else {
            live?.sendControl(AgentControl.err(id, if (timeout) "timeout" else "refused", if (timeout) "no answer on the phone" else "the user refused"))
            outbox.add(OutboxEntry("consent.level_refused", obj("from" to machine.level, "requested" to "control", "opId" to opId, "timeout" to timeout)))
        }
    }

    private fun answerLevelOp(id: String, ok: Boolean) {
        val msg = if (ok) AgentControl.ok(id, obj("level" to machine.level)) else AgentControl.err(id, "refused", "the server refused the level change")
        live?.sendControl(msg)
    }

    // ---------- SessionCommands (UI) ----------

    override fun consentAccepted(level: String, projectionData: Intent) = post {
        if (machine.phase != DeskPhase.CONSENT_PENDING) return@post
        service.goForeground()
        val l = LiveMedia(service, this, exec, inputExec, fileExec, audit)
        try {
            l.prepareCapture(projectionData) { post { event(DeskEvent.Stop) } }
        } catch (e: Exception) {
            l.teardown()
            SessionHub.update { it.copy(error = "Screen capture is not available on this phone.") }
            return@post
        }
        live = l
        SessionHub.framesProbe = { live?.capturedFrames ?: 0 }
        event(DeskEvent.ConsentAccepted(level))
    }

    override fun consentDeclined() = post { event(DeskEvent.ConsentDeclined) }

    override fun stop() = post { event(DeskEvent.Stop) }

    override fun viewOnly() = post { event(DeskEvent.LowerToView) }

    override fun sendChat(text: String) = post {
        val sid = machine.sessionId ?: return@post
        val t = text.take(4000)
        val id = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        if (live?.sendChat(id, t, now) != true) socket?.send(DeskSignal.chatRelay(sid, id, t, now))
        SessionHub.update { it.copy(chat = it.chat + ChatLine("You", t, now)) }
    }

    override fun setMuted(muted: Boolean) = post {
        live?.setMuted(muted)
        SessionHub.update { it.copy(voiceMuted = muted) }
    }

    override fun sendFile(uri: Uri) = post { live?.sendFile(uri) }

    override fun answerPrompt(id: String, accept: Boolean) = post {
        when {
            id.startsWith("file-") -> live?.answerFile(id.removePrefix("file-").toLong(), accept)
            id.startsWith("lvl-") -> levelAnswered(id.removePrefix("lvl-"), accept, timeout = false)
        }
    }

    val capturedFrames: Long get() = live?.capturedFrames ?: 0

    companion object {
        fun statusFor(p: DeskPhase) = when (p) {
            DeskPhase.IDLE -> ""
            DeskPhase.CONNECTING -> "Connecting..."
            DeskPhase.WAITING, DeskPhase.KNOCKED -> "Waiting for your technician"
            DeskPhase.HELD -> "Your technician is not online yet. We will connect as soon as they are."
            DeskPhase.CONSENT_PENDING -> "Your technician is ready"
            DeskPhase.STARTING -> "Starting..."
            DeskPhase.ACTIVE -> "Sharing your screen"
            DeskPhase.ENDING -> "Finishing..."
            DeskPhase.ENDED -> "Session ended"
        }

        fun errorText(code: String) = when (code) {
            "token_gone", "token_not_found" -> "This code is not valid or has expired."
            "token_busy" -> "Another device is already using this code."
            "join_unsupported" -> "This code is for a different IndiansAssist package, or this app is too old."
            "region_mismatch" -> "This code belongs to another region."
            else -> "The session could not continue ($code)."
        }
    }
}
