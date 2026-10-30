package com.indiansassist.desk.core

import kotlinx.serialization.json.JsonObject

enum class DeskPhase { IDLE, CONNECTING, WAITING, HELD, KNOCKED, CONSENT_PENDING, STARTING, ACTIVE, ENDING, ENDED }

/** What the consent screen shows (section 12.3), from `session.created`. */
data class ConsentInfo(val technician: String, val org: String, val recordingMode: String?, val region: String?)

data class EndInfo(val endReason: String, val local: Boolean, val error: String? = null, val hashChainTail: String? = null, val reachedActive: Boolean = false)

sealed interface DeskEvent {
    data class Start(val token: String, val signalUrl: String) : DeskEvent
    data class SocketOpen(val reconnect: Boolean) : DeskEvent
    data class SocketClosed(val code: Int) : DeskEvent
    data class Server(val msg: JsonObject) : DeskEvent
    data class ConsentAccepted(val level: String) : DeskEvent
    data object ConsentDeclined : DeskEvent
    data object Stop : DeskEvent
    data object RevokeConsent : DeskEvent
    data object IndicatorLost : DeskEvent
    data class SecFailed(val reason: String) : DeskEvent
    data object LowerToView : DeskEvent
    data object LocalEndTimeout : DeskEvent
}

sealed interface DeskEffect {
    data class Connect(val url: String) : DeskEffect
    data class Send(val msg: JsonObject) : DeskEffect
    data class SendCtrl(val msg: JsonObject) : DeskEffect
    data object StartPolling : DeskEffect
    data object StopPolling : DeskEffect
    data class ShowConsent(val info: ConsentInfo) : DeskEffect
    data class StartMedia(val ice: List<IceServer>) : DeskEffect
    data class RebuildPeer(val ice: List<IceServer>) : DeskEffect
    data class RefreshIce(val ice: List<IceServer>) : DeskEffect
    /** A hard rule 2 teardown: stop tracks, close channels and peer connections, zeroise keys. */
    data object Teardown : DeskEffect
    data object FlushOutbox : DeskEffect
    data class Recording(val on: Boolean) : DeskEffect
    data class LevelChanged(val level: String) : DeskEffect
    data class PeerSignal(val msg: JsonObject) : DeskEffect
    data class ChatRelay(val msg: JsonObject) : DeskEffect
    data class LevelReply(val re: String?, val ok: Boolean) : DeskEffect
    data object StartLocalEndTimer : DeskEffect
    data object CloseSocket : DeskEffect
    data class Ended(val info: EndInfo) : DeskEffect
}

/**
 * The Desk session state machine of the Android host: A section 7.4 as seen from the Desk, with the native resume
 * rule (C sections 3.2 and 3.7: a resume from `active` stays `active` and rebuilds the peer on the next
 * `ice.refresh`), the local-end rule of A section 7.5 and the C step 9 / `indicator_lost` endings. Pure: the
 * service executes the returned effects.
 */
class DeskMachine(private val client: DeskClient, private val deskLabel: String?) {
    var phase = DeskPhase.IDLE
        private set
    var sessionId: String? = null
        private set
    var level = "view"
        private set
    var technician: String? = null
        private set
    var recordingMode: String? = null
        private set
    var ice: List<IceServer> = emptyList()
        private set
    private var token: String? = null
    private var resumeKey: String? = null
    private var org: String? = null
    private var region: String? = null
    private var consentShown = false
    private var expectRebuild = false
    private var pendingStart = false
    private var reachedActive = false
    private var socketOpen = false
    private var localEndFrame: JsonObject? = null

    val isLive: Boolean get() = phase == DeskPhase.ACTIVE || phase == DeskPhase.STARTING

    fun handle(e: DeskEvent): List<DeskEffect> = when (e) {
        is DeskEvent.Start -> {
            token = e.token
            phase = DeskPhase.CONNECTING
            listOf(DeskEffect.Connect(e.signalUrl))
        }
        is DeskEvent.SocketOpen -> {
            socketOpen = true
            listOf(DeskEffect.Send(DeskSignal.hello(token!!, client, deskLabel, resumeKey)))
        }
        is DeskEvent.SocketClosed -> onClosed(e.code)
        is DeskEvent.Server -> onServer(e.msg)
        is DeskEvent.ConsentAccepted -> {
            if (phase != DeskPhase.CONSENT_PENDING) emptyList() else {
                level = if (e.level == "control") "control" else "view"
                phase = DeskPhase.STARTING
                listOf(DeskEffect.Send(DeskSignal.consentGranted(sessionId!!, level)))
            }
        }
        DeskEvent.ConsentDeclined -> {
            if (phase != DeskPhase.CONSENT_PENDING) emptyList() else {
                phase = DeskPhase.ENDING
                endFrame(DeskSignal.consentRevoked(sessionId!!))
            }
        }
        DeskEvent.Stop -> stop(null, sendStopSharing = true)
        DeskEvent.RevokeConsent -> {
            val sid = sessionId
            if (!isLive || sid == null) emptyList() else {
                phase = DeskPhase.ENDING
                listOf(DeskEffect.SendCtrl(obj("t" to "consent.revoked", "ts" to System.currentTimeMillis())), DeskEffect.Teardown, DeskEffect.FlushOutbox) +
                    endFrame(DeskSignal.consentRevoked(sid))
            }
        }
        DeskEvent.IndicatorLost -> stop("indicator_lost", sendStopSharing = false)
        is DeskEvent.SecFailed -> {
            val sid = sessionId
            if (sid == null || phase == DeskPhase.ENDED) emptyList() else {
                listOf(DeskEffect.Send(DeskSignal.event(sid, "sec.failed", obj("reason" to e.reason)))) + stop("sec:${e.reason}", sendStopSharing = false)
            }
        }
        DeskEvent.LowerToView -> {
            val sid = sessionId
            if (phase != DeskPhase.ACTIVE || level == "view" || sid == null) emptyList() else {
                // The host stops honouring input before the frame is sent (section 3.4).
                level = "view"
                listOf(DeskEffect.LevelChanged("view"), DeskEffect.Send(DeskSignal.consentLevel(sid, "view")))
            }
        }
        DeskEvent.LocalEndTimeout -> {
            if (phase != DeskPhase.ENDING) emptyList() else finish(EndInfo("desk_stopped", local = true, reachedActive = reachedActive))
        }
    }

    private fun stop(note: String?, sendStopSharing: Boolean): List<DeskEffect> {
        val sid = sessionId
        return when {
            phase == DeskPhase.ENDED || phase == DeskPhase.IDLE -> emptyList()
            sid == null -> finish(EndInfo("desk_stopped", local = true)) + DeskEffect.CloseSocket
            else -> {
                val out = mutableListOf<DeskEffect>()
                if (sendStopSharing && isLive) out += DeskEffect.SendCtrl(obj("t" to "stop.sharing", "ts" to System.currentTimeMillis()))
                out += DeskEffect.Teardown
                out += DeskEffect.FlushOutbox
                phase = DeskPhase.ENDING
                out + endFrame(DeskSignal.end(sid, note))
            }
        }
    }

    /** Sends an end frame now, or keeps it for the next `desk.hello.ok` while the socket is down (A section 7.5). */
    private fun endFrame(frame: JsonObject): List<DeskEffect> {
        if (!socketOpen) localEndFrame = frame
        return listOfNotNull(if (socketOpen) DeskEffect.Send(frame) else null, DeskEffect.StopPolling, DeskEffect.StartLocalEndTimer)
    }

    private fun finish(info: EndInfo): List<DeskEffect> {
        val wasLive = isLive
        phase = DeskPhase.ENDED
        localEndFrame = null
        return listOfNotNull(if (wasLive) DeskEffect.Teardown else null, DeskEffect.StopPolling, DeskEffect.Ended(info))
    }

    private fun onClosed(code: Int): List<DeskEffect> {
        socketOpen = false
        return when (code) {
            WS_SESSION_ENDED, WS_HANDED_OVER -> if (phase == DeskPhase.ENDED) emptyList() else finish(EndInfo("desk_stopped", local = true, reachedActive = reachedActive))
            WS_FORBIDDEN, WS_TOKEN_BUSY, WS_UNAUTHENTICATED -> if (phase == DeskPhase.ENDED) emptyList() else finish(EndInfo("error", local = true, error = "closed_$code"))
            else -> emptyList() // the socket reconnects with backoff and re-sends desk.hello with the resumeKey
        }
    }

    private fun onServer(m: JsonObject): List<DeskEffect> {
        return when (m.str("t")) {
            "ping" -> listOf(DeskEffect.Send(DeskSignal.pong(m.str("id"))))
            "desk.hello.ok" -> onHelloOk(m)
            "knock.ok" -> {
                sessionId = m.str("sessionId")
                resumeKey = m.str("resumeKey") ?: resumeKey
                phase = DeskPhase.KNOCKED
                listOf(DeskEffect.StopPolling)
            }
            "knock.held" -> { phase = DeskPhase.HELD; emptyList() }
            "poll.status" -> {
                if (phase == DeskPhase.WAITING || phase == DeskPhase.HELD) phase = if (m.str("state") == "held") DeskPhase.HELD else DeskPhase.WAITING
                emptyList()
            }
            "session.created" -> onCreated(m)
            "consent.ok" -> {
                if (m.str("state") == "active" && phase == DeskPhase.STARTING) {
                    ice = IceServer.parseList(m.arr("iceServers"))
                    phase = DeskPhase.ACTIVE
                    reachedActive = true
                    listOf(DeskEffect.StartMedia(ice))
                } else emptyList()
            }
            "ice.refresh" -> {
                ice = IceServer.parseList(m.arr("iceServers"))
                when {
                    expectRebuild && phase == DeskPhase.ACTIVE -> { expectRebuild = false; listOf(DeskEffect.RebuildPeer(ice)) }
                    pendingStart -> { pendingStart = false; phase = DeskPhase.ACTIVE; reachedActive = true; listOf(DeskEffect.StartMedia(ice)) }
                    isLive -> listOf(DeskEffect.RefreshIce(ice))
                    else -> emptyList()
                }
            }
            "assist.reconnected" -> {
                IceServer.parseList(m.arr("iceServers")).takeIf { it.isNotEmpty() }?.let { ice = it }
                if (m.str("state") == "active" && phase == DeskPhase.ACTIVE) listOf(DeskEffect.RebuildPeer(ice)) else emptyList()
            }
            "session.recording" -> listOf(DeskEffect.Recording(m.bool("recording") == true))
            "consent.level_ok" -> {
                m.str("level")?.let { level = it }
                listOf(DeskEffect.LevelChanged(level), DeskEffect.LevelReply(m.str("re"), true))
            }
            "session.ended" -> if (phase == DeskPhase.ENDED) emptyList() else finish(
                EndInfo(m.str("endReason") ?: "error", local = false, hashChainTail = m.str("hashChainTail"), reachedActive = m.bool("reachedActive") ?: reachedActive),
            )
            "session.handed_over" -> if (phase == DeskPhase.ENDED) emptyList() else finish(EndInfo("handed_over", local = false))
            "webrtc.offer", "webrtc.answer", "webrtc.ice" -> if (isLive) listOf(DeskEffect.PeerSignal(m)) else emptyList()
            "chat.message" -> listOf(DeskEffect.ChatRelay(m))
            "error" -> onError(m)
            else -> emptyList()
        }
    }

    private fun onHelloOk(m: JsonObject): List<DeskEffect> {
        technician = m.objOrNull("technician")?.str("name") ?: technician
        org = m.objOrNull("org")?.str("displayName") ?: org
        region = m.str("region") ?: region
        val resume = m.objOrNull("resume")
        val kept = localEndFrame
        if (kept != null) {
            localEndFrame = null
            return listOf(DeskEffect.Send(kept))
        }
        if (resume != null) {
            sessionId = resume.str("sessionId") ?: sessionId
            if (resume.str("state") == "knocked") phase = DeskPhase.KNOCKED
            return emptyList()
        }
        if (phase == DeskPhase.ENDED || phase == DeskPhase.ENDING) return emptyList()
        phase = DeskPhase.WAITING
        return listOf(DeskEffect.Send(DeskSignal.knock(deskLabel)), DeskEffect.StartPolling)
    }

    private fun onCreated(m: JsonObject): List<DeskEffect> {
        if (phase == DeskPhase.ENDING || phase == DeskPhase.ENDED) return emptyList()
        sessionId = m.str("sessionId") ?: sessionId
        technician = m.objOrNull("assist")?.str("name") ?: technician
        org = m.objOrNull("org")?.str("displayName") ?: org
        recordingMode = m.str("recordingMode") ?: recordingMode
        return when (m.str("state")) {
            "consent_pending" -> {
                if (consentShown && (phase == DeskPhase.CONSENT_PENDING || phase == DeskPhase.STARTING)) emptyList() else {
                    consentShown = true
                    phase = DeskPhase.CONSENT_PENDING
                    listOf(DeskEffect.StopPolling, DeskEffect.ShowConsent(ConsentInfo(technician ?: "your technician", org ?: "", recordingMode, region)))
                }
            }
            "active" -> {
                when (phase) {
                    DeskPhase.ACTIVE -> expectRebuild = true
                    DeskPhase.STARTING, DeskPhase.CONSENT_PENDING -> pendingStart = true
                    else -> {}
                }
                emptyList()
            }
            else -> emptyList()
        }
    }

    private fun onError(m: JsonObject): List<DeskEffect> {
        val code = m.str("code") ?: "error"
        if (m.str("re")?.startsWith("lv") == true) return listOf(DeskEffect.LevelReply(m.str("re"), false))
        return if (code in FATAL_ERRORS && phase != DeskPhase.ENDED) finish(EndInfo("error", local = true, error = code)) else emptyList()
    }

    companion object {
        const val WS_UNAUTHENTICATED = 4401
        const val WS_FORBIDDEN = 4403
        const val WS_TOKEN_BUSY = 4409
        const val WS_SESSION_ENDED = 4410
        const val WS_HANDED_OVER = 4411
        val TERMINAL_CLOSES = setOf(WS_UNAUTHENTICATED, WS_FORBIDDEN, WS_TOKEN_BUSY, WS_SESSION_ENDED, WS_HANDED_OVER)
        val FATAL_ERRORS = setOf(
            "token_malformed", "token_bad_signature", "token_not_found", "token_gone", "token_busy", "region_mismatch",
            "join_unsupported", "forbidden", "session_not_found", "not_authenticated",
        )
    }
}
