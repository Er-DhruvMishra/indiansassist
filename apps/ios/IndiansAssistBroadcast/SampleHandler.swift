import Foundation
import IASec
import IASession
import ReplayKit

/// Phase F section 17.4: the ReplayKit Broadcast Upload Extension. It joins as a native, view-only Desk from the
/// hand-off the app wrote after its consent screen, and holds the signal socket itself (the app is suspended while
/// another app is shown). Everything runs on one serial queue; DeskMachine decides, this class executes its effects.
///
/// Media: the WebRTC peer, the `ia.sec` handshake on its data channel and the video track (at most 1280 px on the long
/// edge at 15 fps, within the extension's memory limit) are added with the pinned WebRTC package; until then the
/// session reaches `active` without video.
final class SampleHandler: RPBroadcastSampleHandler {
    private let queue = DispatchQueue(label: "com.indiansassist.broadcast")
    private let group = UserDefaults(suiteName: JoinHandoff.appGroup)
    private var machine: DeskMachine?
    private var socket: SignalSocket?
    private var signalURL: URL?
    private var pollTimer: DispatchSourceTimer?
    private var reconnectDelay: TimeInterval = 1
    private var note = SessionNote(state: "connecting")

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        queue.async { self.start() }
    }

    override func broadcastFinished() {
        queue.sync { self.run(.stop) }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        // Video frames go to the WebRTC track once it exists; audio is never sent (the microphone button is hidden).
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
        case .sendCtrl:
            break // the control channel exists with the peer (pending WebRTC)
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
        case .startMedia, .rebuildPeer, .refreshIce, .peerSignal:
            note.state = "active"
            save()
        case .teardown, .flushOutbox, .recording:
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
        if let group { note.save(to: group) }
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
