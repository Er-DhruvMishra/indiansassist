package com.indiansassist.desk.service

import android.content.Context
import android.content.Intent
import com.indiansassist.desk.core.AgentControl
import com.indiansassist.desk.core.ControlDispatcher
import com.indiansassist.desk.core.ControlError
import com.indiansassist.desk.core.ControlOutcome
import com.indiansassist.desk.core.FileReceiver
import com.indiansassist.desk.core.FileStep
import com.indiansassist.desk.core.IceServer
import com.indiansassist.desk.core.InputAudit
import com.indiansassist.desk.core.OutboxEntry
import com.indiansassist.desk.core.ScreenInfo
import com.indiansassist.desk.core.SdpMunge
import com.indiansassist.desk.core.SecKeys
import com.indiansassist.desk.core.SecPlain
import com.indiansassist.desk.core.Wire
import com.indiansassist.desk.core.bool
import com.indiansassist.desk.core.long
import com.indiansassist.desk.core.obj
import com.indiansassist.desk.core.objOrNull
import com.indiansassist.desk.core.str
import com.indiansassist.desk.rtc.AssistPeer
import com.indiansassist.desk.rtc.AssistPeerEvents
import com.indiansassist.desk.rtc.RecorderPeer
import com.indiansassist.desk.rtc.RtcEngine
import com.indiansassist.desk.session.ChatLine
import com.indiansassist.desk.session.Prompt
import com.indiansassist.desk.session.SessionHub
import kotlinx.serialization.json.JsonObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.ScheduledExecutorService

/** What [LiveMedia] needs from the controller. */
interface LiveHost {
    val sessionId: String
    val technician: String
    val recordingMode: String?
    fun signal(msg: JsonObject)
    fun attest(e: OutboxEntry)
    fun secFailed(reason: String)
    fun levelPrompt(id: String, reason: String?)
}

/**
 * Everything that exists only while sharing (hard rule 2 tears it all down): the capture, the Assist peer of the
 * current key generation, the recorder peer, and the routing of the decrypted channels (control, chat, files, ctrl).
 */
class LiveMedia(
    private val ctx: Context,
    private val host: LiveHost,
    private val exec: ScheduledExecutorService,
    private val inputExec: ExecutorService,
    private val fileExec: ExecutorService,
    audit: InputAudit,
) : AssistPeerEvents {
    private var engine: RtcEngine? = null
    private var assist: AssistPeer? = null
    private var recorder: RecorderPeer? = null
    private var gen = -1
    private var ice: List<IceServer> = emptyList()
    private var quality = "auto"
    private val seenChat = LinkedHashSet<String>()
    private var nextFileId = 1L
    private var sending: FileSender? = null
    @Volatile private var sendCancelled = false
    private var lastBytes = 0L
    private var lastStatsAt = 0L

    private val screen = object : ScreenInfo {
        override val width get() = engine?.width ?: 0
        override val height get() = engine?.height ?: 0
        override val densityDpi get() = ctx.resources.displayMetrics.densityDpi
        override val mid get() = assist?.videoMid
        override fun applyQuality(preset: String) = exec.execute { quality = preset; engine?.applyQuality(assist?.videoSender, preset) }
    }

    val dispatcher = ControlDispatcher(DelegatingInput, screen, SessionHub.guard, audit)
    val receiver = FileReceiver({ offer -> DownloadsSink(ctx, offer) })

    /** Section 3.3 order: capture starts before consent is recorded, so a failure is reported first. */
    fun prepareCapture(projectionData: Intent, onStopped: () -> Unit) {
        val m = ctx.resources.displayMetrics
        val scale = minOf(1.0, 1600.0 / maxOf(m.widthPixels, m.heightPixels))
        val w = (m.widthPixels * scale).toInt() and 1.inv()
        val h = (m.heightPixels * scale).toInt() and 1.inv()
        engine = RtcEngine(ctx).also { it.startCapture(projectionData, w, h, onStopped) }
    }

    val hwEncoder: Boolean get() = engine?.hwEncoder ?: false

    fun startAssist(servers: List<IceServer>) {
        ice = servers
        newAssist(restart = false)
    }

    /** Section 3.7 rebuild: a new peer connection, re-added tracks, seven new channels, `gen + 1`, fresh keys. */
    fun rebuild(servers: List<IceServer>) {
        ice = servers
        assist?.close()
        SessionHub.guard.state = SessionHub.guard.state.copy(established = false)
        SessionHub.update { it.copy(secured = false, sas = null) }
        newAssist(restart = true)
    }

    private fun newAssist(restart: Boolean) {
        val e = engine ?: return
        gen++
        assist = AssistPeer(e, ice, host.sessionId, gen, exec, this).also { it.start(restart) }
    }

    fun refreshIce(servers: List<IceServer>) {
        ice = servers
        assist?.setIce(servers, restartIce = true)
        recorder?.setIce(servers)
    }

    fun onPeerSignal(m: JsonObject) {
        if (m.str("peer") != "recorder") return assist?.onSignal(m) ?: Unit
        when (m.str("t")) {
            "webrtc.offer" -> {
                val sdp = m.str("sdp") ?: return
                if (host.recordingMode !in setOf("server", "both") || SdpMunge.hasApplication(sdp)) return
                recorder?.close()
                recorder = RecorderPeer(engine ?: return, host.sessionId, ice, exec) { host.signal(it) }.also { it.answer(sdp) }
            }
            "webrtc.ice" -> (m["candidate"] as? JsonObject)?.let { recorder?.addIce(it) }
        }
    }

    fun sendCtrl(msg: JsonObject): Boolean = assist?.sendText("ia.ctrl", msg) ?: false

    fun sendChat(msgId: String, text: String, ts: Long): Boolean =
        assist?.sendText("ia.chat", obj("t" to "chat", "msgId" to msgId, "from" to "desk", "text" to text, "ts" to ts)) ?: false

    fun setMuted(muted: Boolean) {
        engine?.audioTrack?.setEnabled(!muted)
        sendCtrl(obj("t" to "voice.state", "from" to "desk", "muted" to muted, "ts" to System.currentTimeMillis()))
    }

    fun sendControl(msg: JsonObject) = exec.execute { assist?.sendText("ia.control", msg) }

    // ---------- AssistPeerEvents ----------

    override fun sendSignal(msg: JsonObject) = host.signal(msg)

    override fun onEstablished(keys: SecKeys) {
        SessionHub.guard.state = SessionHub.guard.state.copy(established = true)
        SessionHub.update { it.copy(secured = true, sas = keys.sasDisplay, sasHistory = it.sasHistory + (keys.gen to keys.sasDisplay)) }
        engine?.applyQuality(assist?.videoSender, quality)
        assist?.sendText("ia.control", AgentControl.event("monitors", "monitors" to dispatcher.monitors().getValue("monitors"), "selected" to listOf(1)))
        sendAgentLevel()
    }

    fun sendAgentLevel() {
        assist?.sendText("ia.control", AgentControl.event("agent_level", "level" to SessionHub.guard.state.level, "clipboard" to false, "elevation" to "user"))
    }

    override fun onSecFailure(reason: String) {
        if (reason == "channel") rebuild(ice) else host.secFailed(reason)
    }

    override fun onPlain(label: String, plain: SecPlain) {
        when (label) {
            "ia.control" -> plain.text?.let { onControl(it) }
            "ia.chat" -> plain.text?.let { Wire.parseObject(it) }?.let { onChat(it) }
            "ia.file" -> if (plain.binary != null) applyFile(receiver.onChunk(plain.binary)) else plain.text?.let { Wire.parseObject(it) }?.let { onFileMsg(it) }
            "ia.ctrl" -> plain.text?.let { Wire.parseObject(it) }?.let { onCtrl(it) }
            else -> {} // ia.annot: no Desk-side overlay renderer in Phase C (W15); ia.playbook is Desk -> Assist only
        }
    }

    private fun onControl(text: String) {
        val m = Wire.parseObject(text) ?: return
        val req = try {
            AgentControl.parse(m)
        } catch (e: ControlError) {
            m.str("id")?.takeIf { it.length <= 40 }?.let { sendControl(AgentControl.err(it, e.code, e.message ?: e.code)) }
            return
        }
        inputExec.execute {
            when (val out = dispatcher.handle(req)) {
                is ControlOutcome.Reply -> {
                    DevLog.control(req.op, req.id, out.res, (req.parsed as? com.indiansassist.desk.core.AgentOp.Pointer)?.kind)
                    sendControl(out.res)
                }
                is ControlOutcome.LevelPrompt -> exec.execute { host.levelPrompt(out.id, out.reason) }
            }
        }
    }

    fun onChat(m: JsonObject) {
        if (m.str("t") != "chat") return
        val id = m.str("msgId") ?: return
        if (!seenChat.add(id)) return
        SessionHub.update { it.copy(chat = it.chat + ChatLine(host.technician, m.str("text") ?: "", m.long("ts") ?: System.currentTimeMillis())) }
        assist?.sendText("ia.chat", obj("t" to "chat.ack", "msgId" to id, "ts" to System.currentTimeMillis()))
    }

    private fun onCtrl(m: JsonObject) {
        when (m.str("t")) {
            "recording.state" -> SessionHub.update { it.copy(recording = m.bool("recording") == true) }
            "ping" -> sendCtrl(obj("t" to "pong", "ts" to System.currentTimeMillis()))
            else -> {}
        }
    }

    private fun onFileMsg(m: JsonObject) {
        when (m.str("t")) {
            "file.offer" -> applyFile(receiver.onOffer(m))
            "file.done" -> applyFile(receiver.onDone(m))
            "file.cancel" -> {
                applyFile(receiver.onCancel(m))
                if (m.long("fileId") == sending?.fileId) sendCancelled = true
            }
            "file.accept" -> sending?.takeIf { it.fileId == m.long("fileId") }?.let { streamOut(it) }
            "file.reject" -> if (m.long("fileId") == sending?.fileId) sending = null
            "file.ack" -> sending?.takeIf { it.fileId == m.long("fileId") }?.let { s ->
                if (m.bool("ok") == true) host.attest(s.attestation())
                sending = null
            }
        }
    }

    private fun applyFile(step: FileStep) {
        step.send.forEach { assist?.sendText("ia.file", it) }
        step.prompt?.let { offer ->
            SessionHub.addPrompt(Prompt.File("file-${offer.fileId}", offer, host.technician))
            exec.schedule({ answerFile(offer.fileId, accept = false) }, 60, java.util.concurrent.TimeUnit.SECONDS)
        }
        step.attest?.let { host.attest(it) }
        step.savedTo?.let { saved -> SessionHub.update { it.copy(saved = it.saved + saved) } }
    }

    fun answerFile(fileId: Long, accept: Boolean) {
        SessionHub.removePrompt("file-$fileId")
        applyFile(if (accept) receiver.accept(fileId) else receiver.decline(fileId))
    }

    /** Section 6.1 F5: sha256 first, then the offer; one transfer per direction. */
    fun sendFile(uri: android.net.Uri) {
        if (sending != null) return
        val s = FileSender(ctx, uri, nextFileId++)
        sending = s
        sendCancelled = false
        fileExec.execute {
            val offer = try { s.prepare() } catch (_: Exception) { exec.execute { sending = null }; return@execute }
            exec.execute { assist?.sendText("ia.file", offer) }
        }
    }

    private fun streamOut(s: FileSender) {
        fileExec.execute {
            val ok = s.stream(
                send = { chunk -> val r = java.util.concurrent.FutureTask { assist?.sendBinary("ia.file", chunk) ?: false }; exec.execute(r); r.get() },
                buffered = { assist?.bufferedAmount("ia.file") ?: 0 },
                cancelled = { sendCancelled },
            )
            exec.execute { if (ok) assist?.sendText("ia.file", obj("t" to "file.done", "fileId" to s.fileId, "ts" to System.currentTimeMillis())) else sending = null }
        }
    }

    /** `agent.stats` every 2 s on `ia.ctrl` (section 4.4, Android form: `capturePath: 'projection'`, `rung: null`). */
    fun publishStats() {
        val a = assist ?: return
        if (!a.established) return
        a.stats { report ->
            var bytes = 0L
            var fps = 0.0
            var codec = "vp8"
            for (s in report.statsMap.values) {
                if (s.type == "outbound-rtp" && s.members["kind"] == "video") {
                    bytes += (s.members["bytesSent"] as? java.math.BigInteger)?.toLong() ?: (s.members["bytesSent"] as? Long) ?: 0L
                    fps = (s.members["framesPerSecond"] as? Double) ?: fps
                    (s.members["codecId"] as? String)?.let { id -> (report.statsMap[id]?.members?.get("mimeType") as? String)?.let { codec = it.substringAfter('/').lowercase() } }
                }
            }
            val now = System.currentTimeMillis()
            val kbps = if (lastStatsAt > 0) ((bytes - lastBytes) * 8 / maxOf(1, now - lastStatsAt)).toInt() else 0
            lastBytes = bytes
            lastStatsAt = now
            val w = engine?.width ?: 0
            val h = engine?.height ?: 0
            sendCtrl(obj(
                "t" to "agent.stats", "encoder" to codec, "hwEncoder" to hwEncoder, "capturePath" to "projection", "rung" to kotlinx.serialization.json.JsonNull,
                "floorMode" to (quality == "floor"), "targetKbps" to if (quality == "floor") 250 else 2500, "sentKbps" to kbps,
                "recorderKbps" to kotlinx.serialization.json.JsonNull, "captureFps" to fps, "sentFps" to fps, "encodeMs" to kotlinx.serialization.json.JsonNull,
                "monitors" to listOf(obj("id" to 1, "width" to w, "height" to h, "fps" to fps)), "cpuPercent" to kotlinx.serialization.json.JsonNull, "ts" to now,
            ))
        }
    }

    val capturedFrames: Long get() = engine?.capturedFrames ?: 0

    /** Hard rule 2: every track stopped, every channel and peer closed, keys zeroised, partial files discarded. */
    fun teardown() {
        sendCancelled = true
        dispatcher.strokes.cancel()
        receiver.abortAll()
        assist?.close()
        assist = null
        recorder?.close()
        recorder = null
        engine?.dispose()
        engine = null
        SessionHub.guard.state = SessionHub.guard.state.copy(active = false, established = false)
    }

    /** Routes the dispatcher to whichever Accessibility service instance is connected. */
    private object DelegatingInput : com.indiansassist.desk.core.InputBackend {
        private fun svc() = DeskAccessibilityService.instance
        override fun gesture(plan: com.indiansassist.desk.core.GesturePlan) = svc()?.gesture(plan) ?: com.indiansassist.desk.core.InputResult.FAILED
        override fun stroke(cmd: com.indiansassist.desk.core.StrokeCommand) = svc()?.stroke(cmd) ?: com.indiansassist.desk.core.InputResult.FAILED
        override fun nav(action: String) = svc()?.nav(action) ?: com.indiansassist.desk.core.InputResult.FAILED
        override fun editFocused(edit: (String, Int, Int) -> com.indiansassist.desk.core.TextEdit?) = svc()?.editFocused(edit) ?: com.indiansassist.desk.core.InputResult.FAILED
        override fun imeEnter() = svc()?.imeEnter() ?: com.indiansassist.desk.core.InputResult.FAILED
        override fun focusMove(forward: Boolean) = svc()?.focusMove(forward) ?: com.indiansassist.desk.core.InputResult.FAILED
    }
}
