package com.indiansassist.desk.rtc

import com.indiansassist.desk.core.Fingerprint
import com.indiansassist.desk.core.IceServer
import com.indiansassist.desk.core.Sec
import com.indiansassist.desk.core.SecChannel
import com.indiansassist.desk.core.SecFailure
import com.indiansassist.desk.core.SecHandshake
import com.indiansassist.desk.core.SecKeys
import com.indiansassist.desk.core.SecPlain
import com.indiansassist.desk.core.SdpMunge
import com.indiansassist.desk.core.Side
import com.indiansassist.desk.core.Wire
import kotlinx.serialization.json.JsonObject
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.RtpSender
import org.webrtc.SessionDescription
import java.nio.ByteBuffer
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/** What the Assist peer reports to the controller (always on the controller's executor). */
interface AssistPeerEvents {
    fun sendSignal(msg: JsonObject)
    fun onEstablished(keys: SecKeys)
    fun onPlain(label: String, plain: SecPlain)
    fun onSecFailure(reason: String)
}

/**
 * The Desk -> Assist peer connection of one key generation (contracts sections 1.3, 3.3, 3.7): the screen and
 * microphone tracks, the seven channels created once before the first offer, the `ia.sec` handshake and the
 * encrypted channels. Desk is impolite (A section 7.7): it offers, and ignores a colliding remote offer.
 */
class AssistPeer(
    private val engine: RtcEngine,
    private var ice: List<IceServer>,
    private val sessionId: String,
    val gen: Int,
    private val exec: ScheduledExecutorService,
    private val events: AssistPeerEvents,
) {
    private var pc: PeerConnection? = null
    private val channels = LinkedHashMap<String, DataChannel>()
    private val sec = HashMap<String, SecChannel>()
    private var hs: SecHandshake? = null
    private var keys: SecKeys? = null
    @Volatile private var closing = false
    // C8: the DTLS fingerprints the SAS was confirmed against, bound at `ia.sec` open. A renegotiation on this PC must
    // never change them (a signaling MITM re-terminating media after the code was compared).
    private var boundLocalFpr: String? = null
    private var boundRemoteFpr: String? = null
    // C15: has the first (initial / rebuild) offer been sent? Only then does a renegotiation re-offer (ICE restart).
    @Volatile private var negotiated = false
    var videoSender: RtpSender? = null
        private set
    var audioSender: RtpSender? = null
        private set

    val established: Boolean get() = keys != null
    val videoMid: String? get() = pc?.transceivers?.firstOrNull { it.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO }?.mid

    fun start(restart: Boolean) {
        val conn = engine.factory.createPeerConnection(config(ice), Observer()) ?: throw IllegalStateException("createPeerConnection failed")
        pc = conn
        engine.videoTrack?.let { videoSender = conn.addTrack(it, listOf("ia-screen")) }
        engine.audioTrack?.let { audioSender = conn.addTrack(it, listOf("ia-screen")) }
        try {
            conn.transceivers.firstOrNull { it.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO }?.setCodecPreferences(engine.preferredVideoCodecs())
        } catch (_: Exception) {
            // older libwebrtc builds: the default order applies
        }
        for (label in Sec.P3_LABELS) {
            val dc = conn.createDataChannel(label, DataChannel.Init().apply { ordered = true }) ?: continue
            channels[label] = dc
            dc.registerObserver(ChannelObserver(label, dc))
        }
        offer(restart)
    }

    private fun offer(restart: Boolean) {
        val conn = pc ?: return
        conn.createOffer(object : SdpAdapter() {
            override fun onCreateSuccess(desc: SessionDescription) {
                val munged = SessionDescription(desc.type, SdpMunge.withMaxMessageSize(desc.description))
                conn.setLocalDescription(object : SdpAdapter() {
                    override fun onSetSuccess() = post { negotiated = true; events.sendSignal(com.indiansassist.desk.core.DeskSignal.offer(sessionId, munged.description, if (restart) true else null, if (restart) gen else null)) }
                    override fun onSetFailure(error: String?) {
                        // A build that refuses the munged line: fall back to the unmodified offer.
                        conn.setLocalDescription(object : SdpAdapter() {
                            override fun onSetSuccess() = post { negotiated = true; events.sendSignal(com.indiansassist.desk.core.DeskSignal.offer(sessionId, desc.description, if (restart) true else null, if (restart) gen else null)) }
                        }, desc)
                    }
                }, munged)
            }
        }, MediaConstraints())
    }

    /** `webrtc.answer` / `webrtc.offer` / `webrtc.ice` from the Assist (perfect negotiation, Desk impolite). */
    fun onSignal(m: JsonObject) {
        val conn = pc ?: return
        when (m.s("t")) {
            "webrtc.answer" -> conn.setRemoteDescription(object : SdpAdapter() {
                override fun onSetSuccess() = post { recheckFingerprints() }
            }, SessionDescription(SessionDescription.Type.ANSWER, m.s("sdp") ?: return))
            "webrtc.offer" -> {
                if (conn.signalingState() != PeerConnection.SignalingState.STABLE) return // impolite: ignore the collision
                // C8: per section 3.7 rebuilds are Desk-initiated; a remote offer on an established PC is never
                // expected. Treat it as a stray channel event (step 9 rebuild), so a relayed offer cannot silently
                // re-terminate the media tracks after the SAS was confirmed.
                if (keys != null) return post { fail("channel") }
                conn.setRemoteDescription(object : SdpAdapter() {
                    override fun onSetSuccess() {
                        conn.createAnswer(object : SdpAdapter() {
                            override fun onCreateSuccess(desc: SessionDescription) {
                                conn.setLocalDescription(object : SdpAdapter() {
                                    override fun onSetSuccess() = post {
                                        if (recheckFingerprints()) events.sendSignal(com.indiansassist.desk.core.DeskSignal.answer(sessionId, desc.description, null))
                                    }
                                }, desc)
                            }
                        }, MediaConstraints())
                    }
                }, SessionDescription(SessionDescription.Type.OFFER, m.s("sdp") ?: return))
            }
            "webrtc.ice" -> {
                val c = m["candidate"] as? JsonObject ?: return
                conn.addIceCandidate(IceCandidate(c.s("sdpMid"), (c["sdpMLineIndex"]?.toString()?.toIntOrNull() ?: 0), c.s("candidate") ?: return))
            }
        }
    }

    fun setIce(servers: List<IceServer>, restartIce: Boolean) {
        ice = servers
        pc?.setConfiguration(config(servers))
        if (restartIce) pc?.restartIce()
    }

    /** Sends a JSON message on an encrypted channel; false before `established` (the caller uses the WS fallback). */
    fun sendText(label: String, msg: JsonObject): Boolean = sendFrame(label) { it.sealText(Wire.encode(msg)) }

    fun sendBinary(label: String, data: ByteArray): Boolean = sendFrame(label) { it.sealBinary(data) }

    private fun sendFrame(label: String, seal: (SecChannel) -> ByteArray): Boolean {
        val ch = sec[label] ?: return false
        val dc = channels[label]?.takeIf { it.state() == DataChannel.State.OPEN } ?: return false
        return try {
            dc.send(DataChannel.Buffer(ByteBuffer.wrap(seal(ch)), true))
        } catch (e: SecFailure) {
            fail(e.reason)
            false
        }
    }

    fun bufferedAmount(label: String): Long = channels[label]?.bufferedAmount() ?: 0

    fun stats(cb: (org.webrtc.RTCStatsReport) -> Unit) {
        pc?.getStats { r -> post { cb(r) } }
    }

    fun close() {
        closing = true
        for (dc in channels.values) {
            try { dc.unregisterObserver(); dc.close(); dc.dispose() } catch (_: Exception) {}
        }
        channels.clear()
        sec.clear()
        keys?.zeroise()
        keys = null
        pc?.dispose()
        pc = null
    }

    private fun fail(reason: String) {
        if (closing) return
        val h = hs
        channels["ia.sec"]?.takeIf { it.state() == DataChannel.State.OPEN }?.let { dc ->
            h?.failMessage(reason)?.let { dc.send(DataChannel.Buffer(ByteBuffer.wrap(Wire.encode(it).toByteArray()), false)) }
        }
        closing = true
        events.onSecFailure(reason)
    }

    private fun post(r: () -> Unit) = exec.execute { if (!closing) r() }

    /**
     * C8: after any renegotiation on an established PC, the live descriptions must still carry the bound fingerprints.
     * Before establishment the handshake itself binds them, so this is a no-op. Returns false (and fails) on mismatch.
     */
    private fun recheckFingerprints(): Boolean {
        if (keys == null) return true
        val conn = pc ?: return true
        val ok = Fingerprint.matches(boundLocalFpr, conn.localDescription?.description) &&
            Fingerprint.matches(boundRemoteFpr, conn.remoteDescription?.description)
        if (!ok) { fail("fingerprint"); return false }
        return true
    }

    private fun onSecOpen() {
        val conn = pc ?: return
        val local = conn.localDescription?.description?.let { Fingerprint.fromSdp(it) }
        val remote = conn.remoteDescription?.description?.let { Fingerprint.fromSdp(it) }
        if (local == null || remote == null) return fail("fingerprint")
        boundLocalFpr = local
        boundRemoteFpr = remote
        val h = SecHandshake(sessionId, gen, Side.DESK, local, remote)
        hs = h
        h.start().forEach { sendSec(it) }
        exec.schedule({
            if (closing) return@schedule
            try { h.checkTimeout() } catch (e: SecFailure) { fail(e.reason) }
        }, Sec.HANDSHAKE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    }

    private fun sendSec(msg: JsonObject) {
        channels["ia.sec"]?.send(DataChannel.Buffer(ByteBuffer.wrap(Wire.encode(msg).toByteArray(Charsets.UTF_8)), false))
    }

    private fun onMessage(label: String, bytes: ByteArray, binary: Boolean) {
        try {
            if (label == "ia.sec") {
                val h = hs ?: throw SecFailure("commit", "ia.sec before open")
                if (binary) throw SecFailure("commit", "binary on ia.sec")
                val step = h.receive(Wire.parseObject(String(bytes, Charsets.UTF_8)) ?: throw SecFailure("commit", "bad JSON"))
                step.send.forEach { sendSec(it) }
                step.established?.let { k ->
                    keys = k
                    for (l in Sec.ENCRYPTED_LABELS) sec[l] = k.channel(l)
                    events.onEstablished(k)
                }
                return
            }
            val ch = sec[label] ?: throw SecFailure("decrypt", "frame before established")
            events.onPlain(label, ch.open(bytes))
        } catch (e: SecFailure) {
            fail(e.reason)
        }
    }

    private inner class ChannelObserver(val label: String, val dc: DataChannel) : DataChannel.Observer {
        override fun onBufferedAmountChange(previousAmount: Long) {}
        override fun onStateChange() {
            val st = dc.state()
            post {
                when {
                    st == DataChannel.State.OPEN && label == "ia.sec" -> onSecOpen()
                    // Channel lifetime rule: an encrypted channel closing on a live peer connection is sec.fail channel.
                    st == DataChannel.State.CLOSED && label in Sec.ENCRYPTED_LABELS -> fail("channel")
                }
            }
        }
        override fun onMessage(buffer: DataChannel.Buffer) {
            val b = ByteArray(buffer.data.remaining())
            buffer.data.get(b)
            post { onMessage(label, b, buffer.binary) }
        }
    }

    private inner class Observer : PeerConnectionObserverAdapter() {
        override fun onIceCandidate(c: IceCandidate) = post {
            events.sendSignal(com.indiansassist.desk.core.DeskSignal.ice(sessionId, com.indiansassist.desk.core.obj("candidate" to c.sdp, "sdpMid" to c.sdpMid, "sdpMLineIndex" to c.sdpMLineIndex), null))
        }

        /** A channel opened by the remote side with a P3 label is `sec.fail channel` (closed unread). */
        override fun onDataChannel(dc: DataChannel) {
            dc.close()
            post { fail("channel") }
        }

        /**
         * C15: after the first offer, a renegotiation (e.g. the ICE restart that [setIce] triggers for a TURN
         * credential refresh) must produce a fresh offer, or the restart is a no-op. The DTLS transport and the data
         * channels are unchanged, so the fingerprints and `gen` stay the same; this is not a section 3.7 rebuild.
         */
        override fun onRenegotiationNeeded() = post {
            if (negotiated && pc?.signalingState() == PeerConnection.SignalingState.STABLE) offer(restart = false)
        }
    }

    companion object {
        fun config(servers: List<IceServer>) = PeerConnection.RTCConfiguration(
            servers.map { s ->
                PeerConnection.IceServer.builder(s.urls).apply {
                    s.username?.let { setUsername(it) }
                    s.credential?.let { setPassword(it) }
                }.createIceServer()
            },
        ).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            iceCandidatePoolSize = 2
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }

        private fun JsonObject.s(k: String): String? = (this[k] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
    }
}
