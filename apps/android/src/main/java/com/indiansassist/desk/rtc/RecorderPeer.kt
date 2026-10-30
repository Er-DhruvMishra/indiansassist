package com.indiansassist.desk.rtc

import com.indiansassist.desk.core.DeskSignal
import com.indiansassist.desk.core.IceServer
import com.indiansassist.desk.core.obj
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.SessionDescription
import java.util.concurrent.Executor

/**
 * The server recorder's peer (A.2 N3, C section 9 R2): answers a `webrtc.offer { peer: 'recorder' }` while sharing
 * with the same screen track (and the microphone track when live), trickles ICE with `peer: 'recorder'`, never offers
 * and never restarts ICE. No data channel (A.2 S4).
 */
class RecorderPeer(
    private val engine: RtcEngine,
    private val sessionId: String,
    ice: List<IceServer>,
    private val exec: Executor,
    private val send: (JsonObject) -> Unit,
) {
    private val pc: PeerConnection? = engine.factory.createPeerConnection(AssistPeer.config(ice), object : PeerConnectionObserverAdapter() {
        override fun onIceCandidate(c: IceCandidate) = exec.execute {
            send(DeskSignal.ice(sessionId, obj("candidate" to c.sdp, "sdpMid" to c.sdpMid, "sdpMLineIndex" to c.sdpMLineIndex), "recorder"))
        }
    })

    fun answer(offerSdp: String) {
        val conn = pc ?: return
        conn.setRemoteDescription(object : SdpAdapter() {
            override fun onSetSuccess() {
                engine.videoTrack?.let { conn.addTrack(it, listOf("ia-screen")) }
                engine.audioTrack?.let { conn.addTrack(it, listOf("ia-screen")) }
                conn.createAnswer(object : SdpAdapter() {
                    override fun onCreateSuccess(desc: SessionDescription) {
                        conn.setLocalDescription(object : SdpAdapter() {
                            override fun onSetSuccess() = exec.execute { send(DeskSignal.answer(sessionId, desc.description, "recorder")) }
                        }, desc)
                    }
                }, MediaConstraints())
            }
        }, SessionDescription(SessionDescription.Type.OFFER, offerSdp))
    }

    fun addIce(c: JsonObject) {
        val cand = (c["candidate"] as? JsonPrimitive)?.content ?: return
        pc?.addIceCandidate(IceCandidate((c["sdpMid"] as? JsonPrimitive)?.content, (c["sdpMLineIndex"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 0, cand))
    }

    fun setIce(servers: List<IceServer>) {
        pc?.setConfiguration(AssistPeer.config(servers))
    }

    fun close() {
        pc?.dispose()
    }
}
