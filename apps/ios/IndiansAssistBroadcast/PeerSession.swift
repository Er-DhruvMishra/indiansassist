import CoreMedia
import Foundation
import IASec
import IASession
import ReplayKit
import WebRTC

/// What the peer reports to the extension's session loop; every call arrives on the session queue.
protocol PeerSessionEvents: AnyObject {
    func sendSignal(_ msg: JSONValue)
    func established(sas: String)
    func secFailed(_ reason: String)
    func chat(_ line: String)
    func recording(_ on: Bool)
}

/// The Desk → Assist peer connection of one key generation (C §§1.3, 3.3, 3.7), the Swift twin of the Android host's
/// `AssistPeer`, view only: the screen track, the seven channels created once before the first offer, the `ia.sec`
/// handshake and the encrypted channels. The Desk is impolite (A §7.7): it offers, and ignores a colliding offer.
final class PeerSession: NSObject {
    /// §17.4: the extension stays within its memory limit by encoding at most 1280 px on the long edge at 15 fps.
    static let maxLongEdge: Int32 = 1280
    static let fps: Int32 = 15

    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(),
                                        decoderFactory: RTCDefaultVideoDecoderFactory())
    }()

    private let queue: DispatchQueue
    private let sessionId: String
    let gen: Int
    private weak var events: PeerSessionEvents?
    private var pc: RTCPeerConnection?
    private let source: RTCVideoSource
    private let capturer: RTCVideoCapturer
    private var channels: [String: RTCDataChannel] = [:]
    private var handshake: SecHandshake?
    private var established = false
    private var closing = false
    private var negotiated = false
    private var boundLocalFpr: String?
    private var boundRemoteFpr: String?
    private var adaptedFor: (Int, Int)?
    private var chatInbox = ChatInbox()

    init(ice: [IceServer], sessionId: String, gen: Int, queue: DispatchQueue, events: PeerSessionEvents) {
        self.queue = queue
        self.sessionId = sessionId
        self.gen = gen
        self.events = events
        source = Self.factory.videoSource(forScreenCast: true)
        capturer = RTCVideoCapturer(delegate: source)
        super.init()
        let track = Self.factory.videoTrack(with: source, trackId: "ia-screen-video")
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let conn = Self.factory.peerConnection(with: Self.config(ice), constraints: constraints, delegate: self) else { return }
        pc = conn
        conn.add(track, streamIds: ["ia-screen"])
        for label in P3Channels.labels {
            let c = RTCDataChannelConfiguration()
            c.isOrdered = true
            if let dc = conn.dataChannel(forLabel: label, configuration: c) {
                dc.delegate = self
                channels[label] = dc
            }
        }
    }

    static func config(_ servers: [IceServer]) -> RTCConfiguration {
        let c = RTCConfiguration()
        c.iceServers = servers.map { RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential) }
        c.sdpSemantics = .unifiedPlan
        c.bundlePolicy = .maxBundle
        c.continualGatheringPolicy = .gatherContinually
        return c
    }

    // MARK: negotiation

    func start(restart: Bool) {
        guard let conn = pc else { return }
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        conn.offer(for: constraints) { [weak self] desc, _ in
            guard let self, let desc else { return }
            let munged = RTCSessionDescription(type: .offer, sdp: SdpMunge.withMaxMessageSize(desc.sdp))
            conn.setLocalDescription(munged) { error in
                let sent = error == nil ? munged : desc
                if error != nil {
                    conn.setLocalDescription(desc) { _ in }
                }
                self.queue.async {
                    guard !self.closing else { return }
                    self.negotiated = true
                    self.events?.sendSignal(DeskSignal.offer(sessionId: self.sessionId, sdp: sent.sdp,
                                                             restart: restart ? true : nil, gen: restart ? self.gen : nil))
                }
            }
        }
    }

    /// `webrtc.answer` / `webrtc.offer` / `webrtc.ice` from the Assist.
    func onSignal(_ m: JSONValue) {
        guard let conn = pc, !closing else { return }
        switch m["t"]?.stringValue {
        case "webrtc.answer":
            guard let sdp = m["sdp"]?.stringValue else { return }
            conn.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { [weak self] _ in
                self?.queue.async { _ = self?.recheckFingerprints() }
            }
        case "webrtc.offer":
            guard conn.signalingState == .stable, let sdp = m["sdp"]?.stringValue else { return } // impolite
            // C8: rebuilds are Desk-initiated; an offer on an established peer would re-terminate the media.
            if established { return fail("channel") }
            conn.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: sdp)) { [weak self] error in
                guard let self, error == nil else { return }
                conn.answer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { desc, _ in
                    guard let desc else { return }
                    conn.setLocalDescription(desc) { _ in
                        self.queue.async {
                            if self.recheckFingerprints() {
                                self.events?.sendSignal(DeskSignal.answer(sessionId: self.sessionId, sdp: desc.sdp, peer: nil))
                            }
                        }
                    }
                }
            }
        case "webrtc.ice":
            guard let c = m["candidate"], let sdp = c["candidate"]?.stringValue else { return }
            let index = Int32(c["sdpMLineIndex"]?.intValue ?? 0)
            conn.add(RTCIceCandidate(sdp: sdp, sdpMLineIndex: index, sdpMid: c["sdpMid"]?.stringValue)) { _ in }
        default:
            break
        }
    }

    func setIce(_ servers: [IceServer], restartIce: Bool) {
        guard let conn = pc else { return }
        conn.setConfiguration(Self.config(servers))
        if restartIce { conn.restartIce() }
    }

    // MARK: video

    /// A ReplayKit video sample: scaled by WebRTC to at most 1280 px on the long edge at 15 fps, rotated as the device is.
    func push(_ sampleBuffer: CMSampleBuffer) {
        guard !closing, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let w = CVPixelBufferGetWidth(pixels), h = CVPixelBufferGetHeight(pixels)
        if adaptedFor.map({ $0 != (w, h) }) ?? true {
            adaptedFor = (w, h)
            let long = max(w, h)
            let k = long > Int(Self.maxLongEdge) ? Double(Self.maxLongEdge) / Double(long) : 1
            source.adaptOutputFormat(toWidth: Int32((Double(w) * k).rounded()) & ~1,
                                     height: Int32((Double(h) * k).rounded()) & ~1, fps: Self.fps)
        }
        var rotation = RTCVideoRotation._0
        if let o = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber {
            switch CGImagePropertyOrientation(rawValue: o.uint32Value) {
            case .left?: rotation = ._90
            case .down?: rotation = ._180
            case .right?: rotation = ._270
            default: rotation = ._0
            }
        }
        let ts = Int64(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer)) * 1_000_000_000)
        let frame = RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: pixels), rotation: rotation, timeStampNs: ts)
        source.capturer(capturer, didCapture: frame)
    }

    // MARK: channels

    /// Sends a JSON message on an encrypted channel; false before `established`.
    @discardableResult
    func sendText(_ label: String, _ msg: JSONValue) -> Bool {
        guard established, let sec = SecLabel(rawValue: label), let h = handshake,
              let dc = channels[label], dc.readyState == .open else { return false }
        do {
            let frame = try h.channel(sec).seal(text: CanonicalJSON.string(msg))
            return dc.sendData(RTCDataBuffer(data: frame, isBinary: true))
        } catch let r as SecFailReason {
            fail(r.rawValue)
        } catch {
            fail("channel")
        }
        return false
    }

    func close() {
        closing = true
        for dc in channels.values {
            dc.delegate = nil
            dc.close()
        }
        channels.removeAll()
        handshake?.dispose()
        handshake = nil
        pc?.close()
        pc = nil
    }

    private func fail(_ reason: String) {
        guard !closing else { return }
        if let r = SecFailReason(rawValue: reason), handshake?.state != .failed {
            handshake?.fail(r) // sends sec.fail on ia.sec while it is open
        }
        closing = true
        events?.secFailed(reason)
    }

    /// C8: after a renegotiation on an established peer, both descriptions must still carry the bound fingerprints.
    private func recheckFingerprints() -> Bool {
        guard established, let conn = pc else { return true }
        let local = conn.localDescription.flatMap { SecCrypto.fingerprintFromSdp($0.sdp) }
        let remote = conn.remoteDescription.flatMap { SecCrypto.fingerprintFromSdp($0.sdp) }
        guard let local, let remote, let bl = boundLocalFpr, let br = boundRemoteFpr,
              Encoding.constantTimeEqual(local, bl), Encoding.constantTimeEqual(remote, br) else {
            fail("fingerprint")
            return false
        }
        return true
    }

    private func onSecOpen() {
        guard let conn = pc,
              let local = conn.localDescription.flatMap({ SecCrypto.fingerprintFromSdp($0.sdp) }),
              let remote = conn.remoteDescription.flatMap({ SecCrypto.fingerprintFromSdp($0.sdp) }) else {
            return fail("fingerprint")
        }
        boundLocalFpr = local
        boundRemoteFpr = remote
        let options = SecHandshake.Options(
            side: .desk, sessionId: sessionId, gen: gen, ownFpr: local, remoteFpr: remote,
            send: { [weak self] msg in
                guard let dc = self?.channels["ia.sec"], dc.readyState == .open else { return }
                dc.sendData(RTCDataBuffer(data: Data(msg.text.utf8), isBinary: false))
            },
            timerQueue: queue
        )
        guard let h = try? SecHandshake(options) else { return fail("key") }
        handshake = h
        h.onEstablished = { [weak self] r in
            self?.established = true
            self?.events?.established(sas: r.sas)
        }
        h.onFailed = { [weak self] reason, _ in self?.fail(reason.rawValue) }
        h.start()
    }

    private func onMessage(_ label: String, _ data: Data, binary: Bool) {
        if label == "ia.sec" {
            guard let h = handshake, !binary else { return fail("commit") }
            h.receive(String(decoding: data, as: UTF8.self))
            return
        }
        guard established, let sec = SecLabel(rawValue: label), let h = handshake else { return fail("decrypt") }
        let text: String?
        do {
            text = try h.channel(sec).open(data).text
        } catch let r as SecFailReason {
            return fail(r.rawValue)
        } catch {
            return fail("decrypt")
        }
        guard let text, let m = JSONValue.parse(text) else { return }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        switch label {
        case "ia.chat":
            if let ack = chatInbox.receive(m, ts: now) {
                events?.chat(chatInbox.lines.last ?? "")
                sendText("ia.chat", ack)
            }
        case "ia.control":
            if let id = m["id"]?.stringValue { sendText("ia.control", P3Channels.controlNotSupported(id: id, ts: now)) }
        case "ia.file":
            if m["t"]?.stringValue == "file.offer", let id = m["fileId"]?.intValue {
                sendText("ia.file", P3Channels.fileReject(fileId: id))
            }
        case "ia.ctrl":
            switch m["t"]?.stringValue {
            case "ping": sendText("ia.ctrl", P3Channels.pong(ts: now))
            case "recording.state": events?.recording(m["recording"]?.boolValue == true)
            default: break
            }
        default:
            break // ia.annot: no overlay on iOS; ia.playbook is Desk → Assist only
        }
    }
}

extension PeerSession: RTCPeerConnectionDelegate {
    func peerConnection(_ pc: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ pc: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ pc: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnection(_ pc: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ pc: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ pc: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    /// C15: after the first offer, a renegotiation (an ICE restart for a TURN refresh) needs a fresh offer.
    func peerConnectionShouldNegotiate(_ pc: RTCPeerConnection) {
        queue.async {
            if self.negotiated, self.pc?.signalingState == .stable { self.start(restart: false) }
        }
    }

    func peerConnection(_ pc: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        let c = obj([("candidate", .string(candidate.sdp)), ("sdpMid", .str(candidate.sdpMid)),
                     ("sdpMLineIndex", .int(Int64(candidate.sdpMLineIndex)))])
        queue.async {
            guard !self.closing else { return }
            self.events?.sendSignal(DeskSignal.ice(sessionId: self.sessionId, candidate: c, peer: nil))
        }
    }

    /// A channel opened by the remote side is `sec.fail channel` (closed unread).
    func peerConnection(_ pc: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        dataChannel.close()
        queue.async { self.fail("channel") }
    }
}

extension PeerSession: RTCDataChannelDelegate {
    func dataChannelDidChangeState(_ dc: RTCDataChannel) {
        let label = dc.label, state = dc.readyState
        queue.async {
            guard !self.closing else { return }
            if state == .open, label == "ia.sec" { self.onSecOpen() }
            // An encrypted channel closing on a live peer connection is sec.fail channel.
            if state == .closed, label != "ia.sec" { self.fail("channel") }
        }
    }

    func dataChannel(_ dc: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        let label = dc.label, data = buffer.data, binary = buffer.isBinary
        queue.async {
            guard !self.closing else { return }
            self.onMessage(label, data, binary: binary)
        }
    }
}
