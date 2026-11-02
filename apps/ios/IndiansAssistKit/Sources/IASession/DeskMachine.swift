import Foundation
import IASec

/// Phase F §17.4: the Desk session state machine of the iOS broadcast extension, the Swift twin of the Android host's
/// `DeskMachine` (A §7.4 from the Desk, the native resume rule of C §§3.2 and 3.7, the local-end rule of A §7.5, the
/// C §1.3 step 9 and `indicator_lost` endings), **view only**: no control level exists, so there is no level raise,
/// lower or `consent.level_ok`. Pure: the extension executes the returned effects.
public enum DeskPhase: Equatable {
    case idle, connecting, waiting, held, knocked, consentPending, starting, active, ending, ended
}

/// What the app's consent screen shows (§17.4), from `session.created`.
public struct ConsentInfo: Equatable {
    public var technician: String
    public var org: String
    public var recordingMode: String?
    public var region: String?
}

public struct EndInfo: Equatable {
    public var endReason: String
    public var local: Bool
    public var error: String?
    public var hashChainTail: String?
    public var reachedActive: Bool

    public init(endReason: String, local: Bool, error: String? = nil, hashChainTail: String? = nil, reachedActive: Bool = false) {
        self.endReason = endReason
        self.local = local
        self.error = error
        self.hashChainTail = hashChainTail
        self.reachedActive = reachedActive
    }
}

public enum DeskEvent: Equatable {
    case start(token: String, signalUrl: String)
    case socketOpen(reconnect: Bool)
    case socketClosed(code: Int)
    case server(JSONValue)
    case consentAccepted
    case consentDeclined
    /// The person stopped the broadcast (the red status bar, Control Centre, or the app's Stop).
    case stop
    case revokeConsent
    /// The system ended the broadcast without the person (memory limit, the device locked).
    case indicatorLost
    case secFailed(reason: String)
    case localEndTimeout
}

public enum DeskEffect: Equatable {
    case connect(url: String)
    case send(JSONValue)
    case sendCtrl(JSONValue)
    case startPolling
    case stopPolling
    case showConsent(ConsentInfo)
    case startMedia(ice: [IceServer])
    case rebuildPeer(ice: [IceServer])
    case refreshIce(ice: [IceServer])
    /// Hard rule 2: stop the capture, close the channels and the peer, zeroise the keys.
    case teardown
    case flushOutbox
    case recording(Bool)
    case peerSignal(JSONValue)
    case chatRelay(JSONValue)
    case startLocalEndTimer
    case closeSocket
    case ended(EndInfo)
}

public final class DeskMachine {
    public static let wsUnauthenticated = 4401
    public static let wsForbidden = 4403
    public static let wsTokenBusy = 4409
    public static let wsSessionEnded = 4410
    public static let wsHandedOver = 4411
    public static let fatalErrors: Set<String> = [
        "token_malformed", "token_bad_signature", "token_not_found", "token_gone", "token_busy", "region_mismatch",
        "join_unsupported", "forbidden", "session_not_found", "not_authenticated",
    ]

    public private(set) var phase: DeskPhase = .idle
    public private(set) var sessionId: String?
    public private(set) var technician: String?
    public private(set) var recordingMode: String?
    public private(set) var ice: [IceServer] = []

    private let client: DeskClient
    private let deskLabel: String?
    private let now: () -> Int64
    private var token: String?
    private var resumeKey: String?
    private var org: String?
    private var region: String?
    private var consentShown = false
    private var expectRebuild = false
    private var pendingStart = false
    private var reachedActive = false
    private var socketOpen = false
    private var localEndFrame: JSONValue?

    public init(client: DeskClient, deskLabel: String?, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.client = client
        self.deskLabel = deskLabel
        self.now = now
    }

    public var isLive: Bool { phase == .active || phase == .starting }

    public func handle(_ e: DeskEvent) -> [DeskEffect] {
        switch e {
        case let .start(token, url):
            self.token = token
            phase = .connecting
            return [.connect(url: url)]
        case .socketOpen:
            socketOpen = true
            return [.send(DeskSignal.hello(token: token ?? "", client: client, deskLabel: deskLabel, resumeKey: resumeKey))]
        case let .socketClosed(code):
            return onClosed(code)
        case let .server(m):
            return onServer(m)
        case .consentAccepted:
            guard phase == .consentPending, let sid = sessionId else { return [] }
            phase = .starting
            return [.send(DeskSignal.consentGranted(sessionId: sid))]
        case .consentDeclined:
            guard phase == .consentPending, let sid = sessionId else { return [] }
            phase = .ending
            return endFrame(DeskSignal.consentRevoked(sessionId: sid))
        case .stop:
            return stop(note: nil, sendStopSharing: true)
        case .revokeConsent:
            guard isLive, let sid = sessionId else { return [] }
            phase = .ending
            return [.sendCtrl(obj([("t", .string("consent.revoked")), ("ts", .int(now()))])), .flushOutbox, .teardown, .flushOutbox]
                + endFrame(DeskSignal.consentRevoked(sessionId: sid))
        case .indicatorLost:
            return stop(note: "indicator_lost", sendStopSharing: false)
        case let .secFailed(reason):
            guard let sid = sessionId, phase != .ended else { return [] }
            return [.send(DeskSignal.event(sessionId: sid, action: "sec.failed", data: .object(["reason": .string(reason)])))]
                + stop(note: "sec:\(reason)", sendStopSharing: false)
        case .localEndTimeout:
            guard phase == .ending else { return [] }
            return finish(EndInfo(endReason: "desk_stopped", local: true, reachedActive: reachedActive))
        }
    }

    private func stop(note: String?, sendStopSharing: Bool) -> [DeskEffect] {
        if phase == .ended || phase == .idle { return [] }
        guard let sid = sessionId else { return finish(EndInfo(endReason: "desk_stopped", local: true)) + [.closeSocket] }
        var out: [DeskEffect] = []
        if sendStopSharing && isLive { out.append(.sendCtrl(obj([("t", .string("stop.sharing")), ("ts", .int(now()))]))) }
        // Attestations ride the WebSocket, not the channels: flushed before the teardown closes the channels.
        if isLive { out.append(.flushOutbox) }
        out += [.teardown, .flushOutbox]
        phase = .ending
        return out + endFrame(DeskSignal.end(sessionId: sid, note: note))
    }

    /// Sends an end frame now, or keeps it for the next `desk.hello.ok` while the socket is down (A §7.5).
    private func endFrame(_ frame: JSONValue) -> [DeskEffect] {
        if !socketOpen { localEndFrame = frame }
        return (socketOpen ? [.send(frame)] : []) + [.stopPolling, .startLocalEndTimer]
    }

    private func finish(_ info: EndInfo) -> [DeskEffect] {
        let wasLive = isLive
        phase = .ended
        localEndFrame = nil
        return (wasLive ? [.teardown] : []) + [.stopPolling, .ended(info)]
    }

    private func onClosed(_ code: Int) -> [DeskEffect] {
        socketOpen = false
        switch code {
        case Self.wsSessionEnded, Self.wsHandedOver:
            return phase == .ended ? [] : finish(EndInfo(endReason: "desk_stopped", local: true, reachedActive: reachedActive))
        case Self.wsForbidden, Self.wsTokenBusy, Self.wsUnauthenticated:
            return phase == .ended ? [] : finish(EndInfo(endReason: "error", local: true, error: "closed_\(code)"))
        default:
            return [] // the socket reconnects with backoff and re-sends desk.hello with the resumeKey
        }
    }

    private func onServer(_ m: JSONValue) -> [DeskEffect] {
        switch m["t"]?.stringValue {
        case "ping":
            return [.send(DeskSignal.pong(re: m["id"]?.stringValue))]
        case "desk.hello.ok":
            return onHelloOk(m)
        case "knock.ok":
            sessionId = m["sessionId"]?.stringValue
            resumeKey = m["resumeKey"]?.stringValue ?? resumeKey
            phase = .knocked
            return [.stopPolling]
        case "knock.held":
            phase = .held
            return []
        case "poll.status":
            if phase == .waiting || phase == .held { phase = m["state"]?.stringValue == "held" ? .held : .waiting }
            return []
        case "session.created":
            return onCreated(m)
        case "consent.ok":
            guard m["state"]?.stringValue == "active", phase == .starting else { return [] }
            ice = IceServer.parseList(m["iceServers"])
            phase = .active
            reachedActive = true
            return [.startMedia(ice: ice)]
        case "ice.refresh":
            ice = IceServer.parseList(m["iceServers"])
            if expectRebuild && phase == .active {
                expectRebuild = false
                return [.rebuildPeer(ice: ice)]
            }
            if pendingStart {
                pendingStart = false
                phase = .active
                reachedActive = true
                return [.startMedia(ice: ice)]
            }
            return isLive ? [.refreshIce(ice: ice)] : []
        case "assist.reconnected":
            let fresh = IceServer.parseList(m["iceServers"])
            if !fresh.isEmpty { ice = fresh }
            return m["state"]?.stringValue == "active" && phase == .active ? [.rebuildPeer(ice: ice)] : []
        case "session.recording":
            return [.recording(m["recording"]?.boolValue == true)]
        case "session.ended":
            return phase == .ended ? [] : finish(EndInfo(
                endReason: m["endReason"]?.stringValue ?? "error", local: false,
                hashChainTail: m["hashChainTail"]?.stringValue,
                reachedActive: m["reachedActive"]?.boolValue ?? reachedActive))
        case "session.handed_over":
            return phase == .ended ? [] : finish(EndInfo(endReason: "handed_over", local: false))
        case "webrtc.offer", "webrtc.answer", "webrtc.ice":
            return isLive ? [.peerSignal(m)] : []
        case "chat.message":
            return [.chatRelay(m)]
        case "error":
            let code = m["code"]?.stringValue ?? "error"
            return Self.fatalErrors.contains(code) && phase != .ended ? finish(EndInfo(endReason: "error", local: true, error: code)) : []
        default:
            return []
        }
    }

    private func onHelloOk(_ m: JSONValue) -> [DeskEffect] {
        technician = m["technician"]?["name"]?.stringValue ?? technician
        org = m["org"]?["displayName"]?.stringValue ?? org
        region = m["region"]?.stringValue ?? region
        if let kept = localEndFrame {
            localEndFrame = nil
            return [.send(kept)]
        }
        if let resume = m["resume"]?.objectValue {
            sessionId = resume["sessionId"]?.stringValue ?? sessionId
            if resume["state"]?.stringValue == "knocked" { phase = .knocked }
            return []
        }
        if phase == .ended || phase == .ending { return [] }
        phase = .waiting
        return [.send(DeskSignal.knock(deskLabel: deskLabel)), .startPolling]
    }

    private func onCreated(_ m: JSONValue) -> [DeskEffect] {
        if phase == .ending || phase == .ended { return [] }
        sessionId = m["sessionId"]?.stringValue ?? sessionId
        technician = m["assist"]?["name"]?.stringValue ?? technician
        org = m["org"]?["displayName"]?.stringValue ?? org
        recordingMode = m["recordingMode"]?.stringValue ?? recordingMode
        switch m["state"]?.stringValue {
        case "consent_pending":
            if consentShown && (phase == .consentPending || phase == .starting) { return [] }
            consentShown = true
            phase = .consentPending
            return [.stopPolling, .showConsent(ConsentInfo(technician: technician ?? "your technician", org: org ?? "",
                                                             recordingMode: recordingMode, region: region))]
        case "active":
            switch phase {
            case .active: expectRebuild = true
            case .starting, .consentPending: pendingStart = true
            default: break
            }
            return []
        default:
            return []
        }
    }
}
