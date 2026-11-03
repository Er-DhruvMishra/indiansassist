import Foundation
import IASec
import IASession
import ReplayKit
import UserNotifications

/// Phase F section 17.4: the ReplayKit Broadcast Upload Extension. It joins as a native, view-only Desk from the
/// hand-off the app wrote after its consent screen, and holds the signal socket itself (the app is suspended while
/// another app is shown). Everything runs on one serial queue; DeskMachine decides, this class executes its effects.
///
/// Media is `PeerSession` (WebRTC 155, pinned): the screen track at most 1280 px on the long edge at 15 fps, the seven
/// channels, and the `ia.sec` handshake on its channel.
final class SampleHandler: RPBroadcastSampleHandler, PeerSessionEvents {
    private let queue = DispatchQueue(label: "com.indiansassist.broadcast")
    private let notes = SessionNoteStore.appGroup()
    private var machine: DeskMachine?
    private var socket: SignalSocket?
    private var signalURL: URL?
    private var pollTimer: DispatchSourceTimer?
    private var reconnectDelay: TimeInterval = 1
    private var note = SessionNote(state: "connecting")
    private var peer: PeerSession?
    private var gen = 0
    private let answers = FileAnswerStore.appGroup()
    /// Polls the App Group for the person's Save or Decline while an offer waits (at most 60 s, C §6.1 F4).
    private var answerTimer: DispatchSourceTimer?

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        queue.async { self.start() }
    }

    override func broadcastFinished() {
        queue.sync { self.run(.stop) }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        // Video only; audio is never sent (the microphone button is hidden). The peer is read on the session queue.
        guard sampleBufferType == .video else { return }
        queue.sync { self.peer?.push(sampleBuffer) }
    }

    private func start() {
        // Read once and deleted before /signal is opened; a stale or unreadable one is deleted and ignored.
        guard let handoff = HandoffStore.appGroup()?.take(now: Date()),
              let url = handoff.signalUrl.flatMap(URL.init(string:)),
              let source = TokenSource(rawValue: handoff.tokenSource) else {
            finish("Open IndiansAssist and enter your support code first, then start sharing from there.")
            return
        }
        let os = ProcessInfo.processInfo.operatingSystemVersion
        let client = DeskClient(
            version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0",
            osVersion: "\(os.majorVersion).\(os.minorVersion)",
            tokenSource: source
        )
        machine = DeskMachine(client: client, deskLabel: nil)
        // A new session starts with a fresh note: nothing of the last one remains.
        note = SessionNote(state: "connecting")
        save()
        signalURL = url
        let s = SignalSocket(queue: queue)
        s.onOpen = { [weak self] in
            self?.reconnectDelay = 1
            self?.run(.socketOpen(reconnect: false))
        }
        s.onMessage = { [weak self] in self?.run(.server($0)) }
        s.onClose = { [weak self] code in self?.closed(code) }
        socket = s
        run(.start(token: handoff.code, signalUrl: url.absoluteString))
    }

    private func run(_ event: DeskEvent) {
        guard let machine else { return }
        for effect in machine.handle(event) { execute(effect) }
    }

    private func execute(_ effect: DeskEffect) {
        switch effect {
        case .connect:
            if let signalURL { socket?.connect(signalURL) }
        case let .send(msg):
            socket?.send(msg)
        case let .sendCtrl(msg):
            peer?.sendText("ia.ctrl", msg)
        case .startPolling:
            startPolling()
        case .stopPolling:
            pollTimer?.cancel()
            pollTimer = nil
        case let .showConsent(info):
            // The person already accepted the app's consent screen before starting this broadcast.
            note = SessionNote(state: "starting", technician: info.technician)
            save()
            run(.consentAccepted)
        case let .startMedia(ice):
            startPeer(ice: ice, restart: false)
            note.state = "active"
            save()
        case let .rebuildPeer(ice):
            gen += 1
            startPeer(ice: ice, restart: true)
        case let .refreshIce(ice):
            peer?.setIce(ice, restartIce: true)
        case let .peerSignal(msg):
            peer?.onSignal(msg)
        case .teardown:
            peer?.close()
            peer = nil
        case .flushOutbox, .recording:
            break
        case let .chatRelay(msg):
            if let text = msg["text"]?.stringValue {
                note.chat.append(String(text.prefix(500)))
                note.chat = Array(note.chat.suffix(50))
                save()
            }
        case .startLocalEndTimer:
            queue.asyncAfter(deadline: .now() + 5) { [weak self] in self?.run(.localEndTimeout) }
        case .closeSocket:
            socket?.close()
        case let .ended(info):
            pollTimer?.cancel()
            socket?.close()
            note.state = "ended"
            save()
            finish(endMessage(info))
        }
    }

    private func startPeer(ice: [IceServer], restart: Bool) {
        peer?.close()
        guard let sid = machine?.sessionId else { return }
        let p = PeerSession(ice: ice, sessionId: sid, gen: gen, queue: queue, events: self)
        peer = p
        p.start(restart: restart)
    }

    // MARK: PeerSessionEvents (on the session queue)

    func sendSignal(_ msg: JSONValue) {
        socket?.send(msg)
    }

    func established(sas: String) {
        note.state = "secured"
        save()
    }

    func secFailed(_ reason: String) {
        run(.secFailed(reason: reason))
    }

    func chat(_ line: String) {
        note.chat.append(String(line.prefix(500)))
        note.chat = Array(note.chat.suffix(50))
        save()
    }

    func recording(_ on: Bool) {}

    /// C §6.1 F4 on iOS: the extension has no window, so the offer goes into the session note (the app's Get help
    /// screen shows Save and Decline) and into a notification with the same two actions; the answer comes back
    /// through the App Group. No answer in 60 s is Decline.
    func fileOffer(_ offer: IncomingOffer) {
        answers?.clear()
        note.pendingFile = offer
        save()
        let content = UNMutableNotificationContent()
        content.title = "\(note.technician ?? "The technician") wants to send you a file"
        let size = ByteCountFormatter.string(fromByteCount: offer.size, countStyle: .file)
        content.body = "\(offer.name) (\(size))." + (offer.executable
            ? " This type of file can run programs on a computer; save it only if you expected it."
            : "")
        content.categoryIdentifier = FileOfferNotification.category
        content.userInfo = [FileOfferNotification.fileIdKey: NSNumber(value: offer.fileId)]
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: FileOfferNotification.id(offer.fileId), content: content, trigger: nil))
        answerTimer?.cancel()
        let deadline = Date().addingTimeInterval(60)
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 0.5, repeating: 0.5)
        t.setEventHandler { [weak self] in
            guard let self, let peer = self.peer else { return }
            if let accept = self.answers?.take(fileId: offer.fileId) {
                peer.answerFile(offer.fileId, accept: accept)
            } else if Date() >= deadline {
                peer.answerFile(offer.fileId, accept: false)
            }
        }
        t.resume()
        answerTimer = t
    }

    func fileOfferEnded(_ fileId: Int64) {
        answerTimer?.cancel()
        answerTimer = nil
        answers?.clear()
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [FileOfferNotification.id(fileId)])
        guard note.pendingFile?.fileId == fileId else { return }
        note.pendingFile = nil
        save()
    }

    func fileSaved(_ name: String) {
        note.files.append(String(name.prefix(200)))
        note.files = Array(note.files.suffix(50))
        save()
    }

    private func closed(_ code: Int) {
        run(.socketClosed(code: code))
        guard let machine, machine.phase != .ended, !DeskMachine.terminalCloses.contains(code) else { return }
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, 30)
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, let url = self.signalURL, self.machine?.phase != .ended else { return }
            self.socket?.connect(url)
        }
    }

    private func startPolling() {
        pollTimer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 2, repeating: 2)
        t.setEventHandler { [weak self] in self?.socket?.send(DeskSignal.poll()) }
        t.resume()
        pollTimer = t
    }

    private func save() {
        note.updatedAt = Date().timeIntervalSince1970
        try? notes?.write(note)
    }

    private func endMessage(_ info: EndInfo) -> String {
        switch info.endReason {
        case "desk_stopped": return "You stopped sharing your screen."
        case "assist_ended": return "The technician ended the session."
        case "error": return "The session could not continue (\(info.error ?? "error"))."
        default: return "The support session has ended."
        }
    }

    private func finish(_ message: String) {
        finishBroadcastWithError(NSError(domain: "com.indiansassist.broadcast", code: 1,
                                         userInfo: [NSLocalizedDescriptionKey: message]))
    }
}
