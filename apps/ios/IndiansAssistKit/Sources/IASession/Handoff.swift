import Foundation

/// Phase F §17.4: what the app hands the broadcast extension through the App Group container. The app is suspended
/// while another app is shown, so the extension holds the signal socket, the peer and the control channel itself and
/// starts from this; chat and received files flow back the same way ([`SessionNote`]).
public struct JoinHandoff: Codable, Equatable {
    /// The App Group shared by the app and the extension.
    public static let appGroup = "group.com.indiansassist.ios"
    static let key = "join.handoff"
    /// A hand-off older than this is ignored: the person tapped Get help and walked away.
    public static let maxAge: TimeInterval = 10 * 60

    public var code: String
    public var tokenSource: String
    /// The api origin of the code's region, e.g. `https://in.example`; the signal URL is derived from it.
    public var apiOrigin: String
    /// When the person accepted the app's consent screen (seconds since 1970).
    public var consentedAt: Double

    public init(code: String, tokenSource: TokenSource, apiOrigin: String, consentedAt: Date) {
        self.code = code
        self.tokenSource = tokenSource.rawValue
        self.apiOrigin = apiOrigin
        self.consentedAt = consentedAt.timeIntervalSince1970
    }

    /// `ws`/`wss` + `/signal` from the api origin; nil for anything but an http(s) origin with no path.
    public var signalUrl: String? {
        guard let u = URLComponents(string: apiOrigin), let scheme = u.scheme?.lowercased(), u.host != nil,
              u.path.isEmpty || u.path == "/", u.query == nil, u.fragment == nil else { return nil }
        var s = u
        switch scheme {
        case "https": s.scheme = "wss"
        case "http": s.scheme = "ws"
        default: return nil
        }
        s.path = "/signal"
        return s.string
    }

    public func isFresh(now: Date) -> Bool {
        let age = now.timeIntervalSince1970 - consentedAt
        return age >= 0 && age <= Self.maxAge
    }

    public func save(to defaults: UserDefaults) throws {
        defaults.set(try JSONEncoder().encode(self), forKey: Self.key)
    }

    /// Reads and removes the hand-off (it is used once).
    public static func take(from defaults: UserDefaults) -> JoinHandoff? {
        guard let data = defaults.data(forKey: key) else { return nil }
        defaults.removeObject(forKey: key)
        return try? JSONDecoder().decode(JoinHandoff.self, from: data)
    }
}

/// What the extension reports back to the app (shown when the person returns to it): the session's state, the
/// technician, chat lines and received file names. Never the code, never keys.
public struct SessionNote: Codable, Equatable {
    static let key = "session.note"
    public var state: String
    public var technician: String?
    public var chat: [String]
    public var files: [String]

    public init(state: String, technician: String? = nil, chat: [String] = [], files: [String] = []) {
        self.state = state
        self.technician = technician
        self.chat = chat
        self.files = files
    }

    public func save(to defaults: UserDefaults) {
        if let data = try? JSONEncoder().encode(self) { defaults.set(data, forKey: Self.key) }
    }

    public static func load(from defaults: UserDefaults) -> SessionNote? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(SessionNote.self, from: $0) }
    }
}
