import Foundation
import IASec

/// Phase F §17.4: the iOS broadcast extension joins as a native Desk, view only. These are the `/signal` frames it
/// sends (A §7.3, C §§3.1, 3.4), the Swift twin of the Android host's `DeskSignal`. `nil` values are left out of the
/// JSON, never sent as `null` (except `webrtc.ice`'s end-of-candidates `candidate: null`).

/// Builds a JSON object, dropping `nil` values.
public func obj(_ pairs: [(String, JSONValue?)]) -> JSONValue {
    var o: [String: JSONValue] = [:]
    for (k, v) in pairs {
        if let v { o[k] = v }
    }
    return .object(o)
}

extension JSONValue {
    public static func str(_ s: String?) -> JSONValue? { s.map(JSONValue.string) }
    public static func num(_ n: Int64) -> JSONValue { .int(n) }
    public static func flag(_ b: Bool?) -> JSONValue? { b.map(JSONValue.bool) }

    public var boolValue: Bool? {
        if case let .bool(b) = self { return b }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case let .array(a) = self { return a }
        return nil
    }
}

/// `AgentCapabilities` of the iOS Desk (§17.4): one screen, view only, chat and files; no input, no playbooks.
public struct IOSCapabilities: Equatable {
    public static let features = ["screen", "chat", "files"]

    public static var json: JSONValue {
        .object([
            "monitors": .int(1),
            "elevation": .string("user"),
            "features": .array(features.map(JSONValue.string)),
            "encoders": .array([.string("vp8"), .string("h264")]),
            "hwEncoder": .bool(true),
            "interpreters": .array([]),
        ])
    }
}

/// How the join code reached the app (`TOKEN_SOURCES`): the `indiansassist://join` link is `deeplink`, a paste is
/// `clipboard`, a typed or QR-scanned code is `manual`.
public enum TokenSource: String {
    case deeplink, clipboard, manual
}

/// `desk.hello.client` for `kind: 'native'`, `os: 'ios'`.
public struct DeskClient: Equatable {
    public var version: String
    /// `UIDevice.current.systemVersion`, for example `18.1`.
    public var osVersion: String
    /// `arm64` on every supported iPhone and iPad.
    public var arch: String
    public var tokenSource: TokenSource

    public init(version: String, osVersion: String, arch: String = "arm64", tokenSource: TokenSource) {
        self.version = version
        self.osVersion = osVersion
        self.arch = arch
        self.tokenSource = tokenSource
    }

    public var json: JSONValue {
        .object([
            "kind": .string("native"),
            "version": .string(version),
            "os": .string("ios"),
            "platform": .object(["osVersion": .string(String(osVersion.prefix(32))), "arch": .string(arch)]),
            "tokenSource": .string(tokenSource.rawValue),
            "capabilities": IOSCapabilities.json,
        ])
    }
}

/// An `RTCIceServer` as the server sends it (`urls` may be a string or a list).
public struct IceServer: Equatable {
    public var urls: [String]
    public var username: String?
    public var credential: String?

    public static func parseList(_ v: JSONValue?) -> [IceServer] {
        (v?.arrayValue ?? []).compactMap { e in
            guard let o = e.objectValue else { return nil }
            let urls: [String]
            switch o["urls"] {
            case let .string(s)?: urls = [s]
            case let .array(a)?: urls = a.compactMap(\.stringValue)
            default: urls = []
            }
            return urls.isEmpty ? nil : IceServer(urls: urls, username: o["username"]?.stringValue, credential: o["credential"]?.stringValue)
        }
    }
}

/// Builders for every Desk → server `/signal` frame the extension sends.
public enum DeskSignal {
    public static func hello(token: String, client: DeskClient, deskLabel: String?, resumeKey: String?) -> JSONValue {
        obj([("t", .string("desk.hello")), ("token", .string(token)), ("deskLabel", .str(deskLabel)),
             ("resumeKey", .str(resumeKey)), ("client", client.json)])
    }

    public static func knock(deskLabel: String?) -> JSONValue {
        obj([("t", .string("desk.knock")), ("deskLabel", .str(deskLabel))])
    }

    public static func poll() -> JSONValue { obj([("t", .string("desk.poll"))]) }

    public static func pong(re: String?) -> JSONValue { obj([("t", .string("pong")), ("re", .str(re))]) }

    /// View only: an iPhone or iPad can never be controlled (Apple does not allow it), so `level` is always `view`.
    public static func consentGranted(sessionId: String) -> JSONValue {
        obj([("t", .string("desk.consent")), ("sessionId", .string(sessionId)), ("state", .string("granted")),
             ("surface", .string("monitor")),
             ("native", .object(["level": .string("view"), "monitors": .array([.int(1)]), "clipboard": .bool(false)]))])
    }

    public static func consentRevoked(sessionId: String) -> JSONValue {
        obj([("t", .string("desk.consent")), ("sessionId", .string(sessionId)), ("state", .string("revoked"))])
    }

    public static func offer(sessionId: String, sdp: String, restart: Bool?, gen: Int?) -> JSONValue {
        obj([("t", .string("webrtc.offer")), ("sessionId", .string(sessionId)), ("sdp", .string(sdp)),
             ("restart", .flag(restart)), ("gen", gen.map { .int(Int64($0)) })])
    }

    public static func answer(sessionId: String, sdp: String, peer: String?) -> JSONValue {
        obj([("t", .string("webrtc.answer")), ("sessionId", .string(sessionId)), ("sdp", .string(sdp)), ("peer", .str(peer))])
    }

    /// `candidate: null` is end-of-candidates, the one place a `null` is sent.
    public static func ice(sessionId: String, candidate: JSONValue?, peer: String?) -> JSONValue {
        var o = obj([("t", .string("webrtc.ice")), ("sessionId", .string(sessionId)), ("peer", .str(peer))]).objectValue!
        o["candidate"] = candidate ?? .null
        return .object(o)
    }

    public static func end(sessionId: String, note: String?) -> JSONValue {
        obj([("t", .string("session.end")), ("sessionId", .string(sessionId)), ("note", .str(note))])
    }

    public static func event(sessionId: String, action: String, data: JSONValue, id: String? = nil, reason: String? = nil) -> JSONValue {
        obj([("t", .string("desk.event")), ("id", .str(id)), ("sessionId", .string(sessionId)), ("action", .string(action)),
             ("data", data), ("reason", .str(reason))])
    }

    public static func chatRelay(sessionId: String, msgId: String, text: String, ts: Int64) -> JSONValue {
        obj([("t", .string("chat.message")), ("sessionId", .string(sessionId)), ("msgId", .string(msgId)),
             ("from", .string("desk")), ("text", .string(text)), ("ts", .int(ts))])
    }
}
