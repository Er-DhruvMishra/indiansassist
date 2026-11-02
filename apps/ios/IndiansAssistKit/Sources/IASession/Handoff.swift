import Foundation

/// Phase F §17.4: what the app hands the broadcast extension through the App Group container. The app is suspended
/// while another app is shown, so the extension holds the signal socket, the peer and the control channel itself and
/// starts from this; chat and received files flow back the same way ([`SessionNote`]).
public struct JoinHandoff: Codable, Equatable {
    /// The App Group shared by the app and the extension.
    public static let appGroup = "group.com.indiansassist.ios"
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

}

/// The join code never stays on disk (the Phase C rule for the C section 2.4 sidecar): the hand-off is one file in the
/// App Group container, written with complete file protection, read once and deleted before the extension opens
/// `/signal`; a stale one is deleted and ignored, and the app removes any leftover on launch and on cancel. Never in
/// UserDefaults.
public struct HandoffStore {
    public static let fileName = "join-handoff.json"
    public let file: URL

    public init(directory: URL) {
        file = directory.appendingPathComponent(Self.fileName)
    }

    /// The store in the shared App Group container; nil when the entitlement is missing.
    public static func appGroup() -> HandoffStore? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: JoinHandoff.appGroup).map(HandoffStore.init)
    }

    /// Writes the hand-off atomically. `.complete`: readable only while the device is unlocked, which it is, since the
    /// person has just tapped Start Broadcast. (File protection has no effect on macOS, where the tests run.)
    public func write(_ handoff: JoinHandoff) throws {
        let data = try JSONEncoder().encode(handoff)
        try data.write(to: file, options: [.atomic, .completeFileProtection])
    }

    /// Reads the hand-off and deletes the file before returning, whatever it holds. A hand-off older than
    /// `JoinHandoff.maxAge`, from the future, or unreadable is deleted and gives nil.
    public func take(now: Date) -> JoinHandoff? {
        let data = try? Data(contentsOf: file)
        clear()
        guard let data, let h = try? JSONDecoder().decode(JoinHandoff.self, from: data), h.isFresh(now: now) else { return nil }
        return h
    }

    /// Removes any hand-off (app launch, cancel).
    public func clear() {
        try? FileManager.default.removeItem(at: file)
    }

    public var exists: Bool { FileManager.default.fileExists(atPath: file.path) }
}

/// What the extension reports back to the app (shown when the person returns to it): the session's state, the
/// technician's display name, chat lines and received file names. Never the code, never keys.
public struct SessionNote: Codable, Equatable {
    public var state: String
    public var technician: String?
    public var chat: [String]
    public var files: [String]
    /// When the extension last wrote it (seconds since 1970).
    public var updatedAt: Double

    public init(state: String, technician: String? = nil, chat: [String] = [], files: [String] = [], updatedAt: Date = Date()) {
        self.state = state
        self.technician = technician
        self.chat = chat
        self.files = files
        self.updatedAt = updatedAt.timeIntervalSince1970
    }
}

/// Chat is end-to-end encrypted in every other client (C section 1.3; the server never stores it), so the note is
/// never in UserDefaults (an unencrypted plist that goes into backups): it is one file in the App Group container,
/// written with complete file protection and excluded from backup, overwritten at the start of each session, deleted
/// when the person dismisses the summary and, at the next launch, when it is older than a day.
public struct SessionNoteStore {
    public static let fileName = "session-note.json"
    public static let maxAge: TimeInterval = 24 * 60 * 60
    public let file: URL

    public init(directory: URL) {
        file = directory.appendingPathComponent(Self.fileName)
    }

    public static func appGroup() -> SessionNoteStore? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: JoinHandoff.appGroup).map(SessionNoteStore.init)
    }

    /// Replaces the note (a new session starts with a fresh one, so nothing of the last session remains).
    public func write(_ note: SessionNote) throws {
        try JSONEncoder().encode(note).write(to: file, options: [.atomic, .completeFileProtection])
        var url = file
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }

    public func load() -> SessionNote? {
        (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(SessionNote.self, from: $0) }
    }

    /// The person dismissed the summary.
    public func clear() {
        try? FileManager.default.removeItem(at: file)
    }

    /// At launch: a note older than `maxAge` (or unreadable, or from the future) is deleted.
    public func clearIfStale(now: Date) {
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        guard let note = load() else { return clear() }
        let age = now.timeIntervalSince1970 - note.updatedAt
        if age < 0 || age > Self.maxAge { clear() }
    }

    public var exists: Bool { FileManager.default.fileExists(atPath: file.path) }
}
