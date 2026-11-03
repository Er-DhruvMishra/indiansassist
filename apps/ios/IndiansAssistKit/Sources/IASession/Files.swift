import CryptoKit
import Foundation
import IASec

/// Phase F §17.4: files from the technician on iOS, the Assist → Desk half of A §8.3 / C §6.1 (`ia.file`): the Swift
/// twin of the Android host's `FileReceiver` and `FileNames`, checked against the shared vectors in
/// `packages/shared/test/fixtures/agent/` (`sec-vectors.json` `fileNames`, `file-lists.json`).

/// The shared `sanitiseFileName` (A §8.3 F5) and the extension lists of C §6.1 F4.
public enum FileNames {
    public static let maxName = 200

    public static let executableExtensions: Set<String> = [
        "exe", "com", "scr", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi", "msp", "msc",
        "dll", "hta", "cpl", "jar", "reg", "lnk", "app", "pkg", "dmg", "sh", "command", "apk",
        "pif", "application", "gadget", "inf", "ins", "isp", "msh", "msh1", "msh2", "mshxml", "msh1xml", "msh2xml",
        "ps1xml", "psd1", "psc1", "appref-ms", "diagcab",
    ]
    public static let passiveRiskExtensions: Set<String> = [
        "url", "scf", "library-ms", "settingcontent-ms", "website", "theme", "deskthemepack", "searchconnector-ms",
    ]
    static let reservedStems: Set<String> = Set(["CON", "PRN", "AUX", "NUL"] + (1...9).map { "COM\($0)" } + (1...9).map { "LPT\($0)" })

    /// ECMAScript `\s` (WhiteSpace and LineTerminator).
    static func isJSSpace(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
        default: return false
        }
    }

    /// Control characters, bidi and zero-width marks: removed.
    static func isStripped(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x00...0x1F, 0x7F...0x9F, 0x200B...0x200F, 0x202A...0x202E, 0x2066...0x2069, 0xFEFF: return true
        default: return false
        }
    }

    static func isUnsafe(_ s: Unicode.Scalar) -> Bool { "/\\:*?\"<>|".unicodeScalars.contains(s) }

    public static func sanitise(_ name: String, fileId: Int64) -> String {
        var s = Array(name.precomposedStringWithCanonicalMapping.unicodeScalars).filter { !isStripped($0) }
        s = s.map { isUnsafe($0) ? "_" : $0 }
        // Runs of whitespace become one space.
        var collapsed: [Unicode.Scalar] = []
        var inRun = false
        for c in s {
            if isJSSpace(c) {
                if !inRun { collapsed.append(" ") }
                inRun = true
            } else {
                collapsed.append(c)
                inRun = false
            }
        }
        s = collapsed
        while let f = s.first, f == "." || isJSSpace(f) { s.removeFirst() }
        while let l = s.last, isJSSpace(l) { s.removeLast() }
        if s.count > maxName {
            if let dot = s.lastIndex(of: "."), dot > 0, s.count - dot < maxName {
                let ext = Array(s[dot...])
                var stem = Array(s[..<dot].prefix(maxName - ext.count))
                while let l = stem.last, isJSSpace(l) { stem.removeLast() }
                s = stem + ext
            } else {
                s = Array(s.prefix(maxName))
            }
        }
        var first = Array(s.split(separator: ".", omittingEmptySubsequences: false).first ?? [])
        while let f = first.first, isJSSpace(f) { first.removeFirst() }
        while let l = first.last, isJSSpace(l) { first.removeLast() }
        if reservedStems.contains(String(String.UnicodeScalarView(first)).uppercased()) {
            s = Array((["_"] + s).prefix(maxName))
        }
        let out = String(String.UnicodeScalarView(s))
        return out.isEmpty ? "file-\(fileId)" : out
    }

    /// The last suffix, lower-case, without the dot; nil when there is none (`fileExtension`).
    public static func fileExtension(_ name: String) -> String? {
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex, name.index(after: dot) != name.endIndex else {
            return nil
        }
        return name[name.index(after: dot)...].lowercased()
    }

    public static func isExecutable(_ name: String) -> Bool { fileExtension(name).map(executableExtensions.contains) ?? false }

    public static func isPassiveRisk(_ name: String) -> Bool { fileExtension(name).map(passiveRiskExtensions.contains) ?? false }

    /// The collision-free final leaf (C §6.1 F3): `<stem> (2).<ext>`, `(3)`… against `taken` (compared lower-case).
    public static func finalName(_ leaf: String, taken: Set<String>) -> String {
        let lower = Set(taken.map { $0.lowercased() })
        if !lower.contains(leaf.lowercased()) { return leaf }
        let stem: String
        let ext: String
        if let dot = leaf.lastIndex(of: "."), dot != leaf.startIndex {
            stem = String(leaf[..<dot])
            ext = String(leaf[dot...])
        } else {
            stem = leaf
            ext = ""
        }
        var n = 2
        while lower.contains("\(stem) (\(n))\(ext)".lowercased()) { n += 1 }
        return "\(stem) (\(n))\(ext)"
    }
}

/// An offer waiting for the person's answer (C §6.1 F4).
public struct IncomingOffer: Codable, Equatable {
    public var fileId: Int64
    public var name: String
    public var size: Int64
    public var mime: String
    public var executable: Bool

    public init(fileId: Int64, name: String, size: Int64, mime: String, executable: Bool) {
        self.fileId = fileId
        self.name = name
        self.size = size
        self.mime = mime
        self.executable = executable
    }
}

/// Where an accepted file is streamed.
public protocol FileSink: AnyObject {
    func write(_ bytes: Data) throws
    /// Publishes the file under its final name; returns where it was saved.
    func commit() throws -> URL
    /// Discards the partial file.
    func abort()
}

/// What one receiver step asks of the caller: frames to send on `ia.file`, an offer to put to the person, the
/// `desk.event file.received` data, and where a verified file was saved.
public struct FileStep {
    public var send: [JSONValue] = []
    public var prompt: IncomingOffer?
    public var attest: JSONValue?
    public var savedTo: URL?

    public init(send: [JSONValue] = [], prompt: IncomingOffer? = nil, attest: JSONValue? = nil, savedTo: URL? = nil) {
        self.send = send
        self.prompt = prompt
        self.attest = attest
        self.savedTo = savedTo
    }
}

/// The receiving half of A §8.3 (C §6.1): `bad_name` for an empty or over-long name, a passive-risk type or a bad
/// header, `too_large` above 2 GiB, `busy` for a second transfer; the F4 chunk rules; streaming SHA-256; `file.ack` and
/// the `file.received` attestation. One transfer at a time, as in every Desk.
public final class FileReceiver {
    public static let chunk: Int64 = 16_384
    public static let maxBytes: Int64 = 2_147_483_648

    private final class Rx {
        let offer: IncomingOffer
        let sha256: String
        let chunks: Int64
        var accepted = false
        var sink: FileSink?
        var seen = Set<Int64>()
        var bytes: Int64 = 0
        var hasher = SHA256()

        init(offer: IncomingOffer, sha256: String, chunks: Int64) {
            self.offer = offer
            self.sha256 = sha256
            self.chunks = chunks
        }
    }

    private let openSink: (IncomingOffer) throws -> FileSink
    private let maxBytes: Int64
    private let clock: () -> Int64
    private var rx: Rx?

    public init(maxBytes: Int64 = FileReceiver.maxBytes, clock: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                openSink: @escaping (IncomingOffer) throws -> FileSink) {
        self.openSink = openSink
        self.maxBytes = maxBytes
        self.clock = clock
    }

    public var busy: Bool { rx != nil }

    /// The offer waiting for an answer, if any.
    public var pending: IncomingOffer? { rx.flatMap { $0.accepted ? nil : $0.offer } }

    private func msg(_ pairs: [(String, JSONValue?)]) -> JSONValue { obj(pairs + [("ts", .int(clock()))]) }

    public func onOffer(_ m: JSONValue) -> FileStep {
        guard let fileId = m["fileId"]?.intValue, (1...0xFFFF_FFFF).contains(fileId) else { return FileStep() }
        func reject(_ reason: String) -> FileStep {
            FileStep(send: [msg([("t", .string("file.reject")), ("fileId", .int(fileId)), ("reason", .string(reason))])])
        }
        if rx != nil { return reject("busy") }
        let raw = m["name"]?.stringValue ?? ""
        if raw.isEmpty || raw.utf16.count > 255 { return reject("bad_name") }
        let name = FileNames.sanitise(raw, fileId: fileId)
        if FileNames.isPassiveRisk(name) || name.contains("/") || name.contains("\\") { return reject("bad_name") }
        guard let size = m["size"]?.intValue, size >= 0 else { return reject("bad_name") }
        if size > maxBytes { return reject("too_large") }
        guard let sha = m["sha256"]?.stringValue?.lowercased(), sha.count == 64,
              sha.allSatisfy({ $0.isHexDigit && ($0.isNumber || $0.isLowercase) }) else { return reject("bad_name") }
        let chunks = (size + Self.chunk - 1) / Self.chunk
        if m["chunkSize"]?.intValue != Self.chunk || m["chunks"]?.intValue != chunks { return reject("bad_name") }
        let offer = IncomingOffer(fileId: fileId, name: name, size: size, mime: m["mime"]?.stringValue ?? "application/octet-stream",
                                  executable: FileNames.isExecutable(name))
        rx = Rx(offer: offer, sha256: sha, chunks: chunks)
        return FileStep(prompt: offer)
    }

    /// The person chose Save.
    public func accept(_ fileId: Int64) -> FileStep {
        guard let r = rx, r.offer.fileId == fileId, !r.accepted else { return FileStep() }
        do {
            r.sink = try openSink(r.offer)
        } catch {
            rx = nil
            return FileStep(send: [msg([("t", .string("file.reject")), ("fileId", .int(fileId)), ("reason", .string("declined"))])])
        }
        r.accepted = true
        return FileStep(send: [msg([("t", .string("file.accept")), ("fileId", .int(fileId))])])
    }

    /// The person chose Decline, or did not answer within 60 s.
    public func decline(_ fileId: Int64) -> FileStep {
        guard let r = rx, r.offer.fileId == fileId, !r.accepted else { return FileStep() }
        rx = nil
        return FileStep(send: [msg([("t", .string("file.reject")), ("fileId", .int(fileId)), ("reason", .string("declined"))])])
    }

    /// A binary chunk: `[0,4)` fileId, `[4,8)` chunk index (big-endian), then the payload.
    public func onChunk(_ frame: Data) -> FileStep {
        guard frame.count >= 8 else { return FileStep() }
        let b = [UInt8](frame)
        let u32 = { (o: Int) -> Int64 in Int64(b[o]) << 24 | Int64(b[o + 1]) << 16 | Int64(b[o + 2]) << 8 | Int64(b[o + 3]) }
        let fileId = u32(0), index = u32(4)
        guard let r = rx, r.offer.fileId == fileId, r.accepted, let sink = r.sink else { return cancel(fileId, "bad_chunk") }
        let n = Int64(b.count - 8)
        let last = index == r.chunks - 1
        if index >= r.chunks || r.seen.contains(index) { return cancel(fileId, "bad_chunk") }
        if n > Self.chunk || (!last && n < Self.chunk) { return cancel(fileId, "bad_chunk") }
        if r.bytes + n > r.offer.size { return cancel(fileId, "overflow") }
        let payload = frame.subdata(in: frame.startIndex + 8 ..< frame.endIndex)
        do {
            try sink.write(payload)
        } catch {
            return cancel(fileId, "aborted")
        }
        r.seen.insert(index)
        r.bytes += n
        r.hasher.update(data: payload)
        return FileStep()
    }

    public func onDone(_ m: JSONValue) -> FileStep {
        guard let r = rx, m["fileId"]?.intValue == r.offer.fileId, r.accepted, let sink = r.sink else { return FileStep() }
        if Int64(r.seen.count) != r.chunks || r.bytes != r.offer.size { return cancel(r.offer.fileId, "bad_chunk") }
        let got = r.hasher.finalize().map { String(format: "%02x", $0) }.joined()
        rx = nil
        var ok = got == r.sha256
        var saved: URL?
        if ok {
            do {
                saved = try sink.commit()
            } catch {
                sink.abort()
                ok = false
            }
        } else {
            sink.abort()
        }
        let ack = msg([("t", .string("file.ack")), ("fileId", .int(r.offer.fileId)), ("ok", .bool(ok)), ("sha256", .string(got))])
        let attest: JSONValue? = ok ? .object([
            "fileId": .int(r.offer.fileId), "direction": .string("assist_to_desk"),
            "name": .string(saved?.lastPathComponent ?? r.offer.name), "bytes": .int(r.bytes), "sha256": .string(got),
        ]) : nil
        return FileStep(send: [ack], attest: attest, savedTo: saved)
    }

    public func onCancel(_ m: JSONValue) -> FileStep {
        if let r = rx, m["fileId"]?.intValue == r.offer.fileId {
            r.sink?.abort()
            rx = nil
        }
        return FileStep()
    }

    /// Teardown or Stop: any partial file is discarded (hard rule 2).
    public func abortAll() {
        rx?.sink?.abort()
        rx = nil
    }

    private func cancel(_ fileId: Int64, _ reason: String) -> FileStep {
        if let r = rx, r.offer.fileId == fileId {
            r.sink?.abort()
            rx = nil
        }
        return FileStep(send: [msg([("t", .string("file.cancel")), ("fileId", .int(fileId)), ("reason", .string(reason))])])
    }
}

/// The App Group folder received files land in, `Received/`, where the app lists them (C §6.1 F3 on iOS): the final
/// name is chosen first, the bytes go to `<final>.<8 hex>.iapart` (created exclusively, 0600, complete protection),
/// and the part is renamed to the final name only after `file.done` and a matching SHA-256. Parts older than a day
/// (a crashed run) are swept when the folder is opened.
public struct ReceivedFolder {
    public static let dirName = "Received"
    public static let partSuffix = ".iapart"
    public static let staleAge: TimeInterval = 24 * 60 * 60
    public let directory: URL

    public init(directory: URL, now: Date = Date()) {
        self.directory = directory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                 attributes: [.protectionKey: FileProtectionType.complete])
        sweep(now: now)
    }

    public static func appGroup() -> ReceivedFolder? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: JoinHandoff.appGroup)
            .map { ReceivedFolder(directory: $0.appendingPathComponent(dirName, isDirectory: true)) }
    }

    private func names() -> [String] { (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [] }

    /// The received files, newest first (never a partial one).
    public func list() -> [URL] {
        let urls = names().filter { !$0.hasSuffix(Self.partSuffix) && !$0.hasPrefix(".") }.map { directory.appendingPathComponent($0) }
        let date = { (u: URL) in (try? u.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast }
        return urls.sorted { date($0) > date($1) }
    }

    public func remove(_ url: URL) {
        guard url.deletingLastPathComponent().standardizedFileURL == directory.standardizedFileURL else { return }
        try? FileManager.default.removeItem(at: url)
    }

    private func sweep(now: Date) {
        for n in names() where n.hasSuffix(Self.partSuffix) {
            let u = directory.appendingPathComponent(n)
            let m = (try? u.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            if now.timeIntervalSince(m) > Self.staleAge { try? FileManager.default.removeItem(at: u) }
        }
    }

    /// A sink for `offer`, streaming into a new part file.
    public func sink(for offer: IncomingOffer) throws -> FileSink {
        try PartFileSink(folder: self, leaf: offer.name)
    }

    /// The final names in use: the files there, and the ones the parts will become (`excluding` one part: the
    /// committing part's own name is free for it).
    func taken(excluding part: String? = nil) -> Set<String> {
        Set(names().filter { $0 != part }.map { n in
            guard n.hasSuffix(Self.partSuffix) else { return n }
            // `<final>.<8 hex>.iapart` → `<final>`.
            let base = String(n.dropLast(Self.partSuffix.count))
            return base.count > 9 ? String(base.dropLast(9)) : base
        })
    }
}

final class PartFileSink: FileSink {
    private let folder: ReceivedFolder
    private let leaf: String
    private let part: URL
    private var handle: FileHandle?

    init(folder: ReceivedFolder, leaf: String) throws {
        self.folder = folder
        self.leaf = leaf
        let final = FileNames.finalName(leaf, taken: folder.taken())
        let tag = (0..<4).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        part = folder.directory.appendingPathComponent("\(final).\(tag)\(ReceivedFolder.partSuffix)")
        let fd = open(part.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw CocoaError(.fileWriteNoPermission) }
        handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: part.path)
    }

    func write(_ bytes: Data) throws {
        guard let handle else { throw CocoaError(.fileWriteUnknown) }
        try handle.write(contentsOf: bytes)
    }

    func commit() throws -> URL {
        try handle?.synchronize()
        try handle?.close()
        handle = nil
        // Chosen again at the end: a file of that name may have appeared since.
        let taken = folder.taken(excluding: part.lastPathComponent)
        let final = folder.directory.appendingPathComponent(FileNames.finalName(leaf, taken: taken))
        try FileManager.default.moveItem(at: part, to: final)
        return final
    }

    func abort() {
        try? handle?.close()
        handle = nil
        try? FileManager.default.removeItem(at: part)
    }
}

/// The person's answer to a file offer, written by the app (its prompt or its notification action) and read by the
/// broadcast extension, which holds the transfer. One small file in the App Group container, complete protection.
public struct FileAnswerStore {
    public static let fileName = "file-answer.json"
    public let file: URL

    struct Answer: Codable {
        var fileId: Int64
        var accept: Bool
    }

    public init(directory: URL) {
        file = directory.appendingPathComponent(Self.fileName)
    }

    public static func appGroup() -> FileAnswerStore? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: JoinHandoff.appGroup).map(FileAnswerStore.init)
    }

    public func answer(fileId: Int64, accept: Bool) throws {
        try JSONEncoder().encode(Answer(fileId: fileId, accept: accept)).write(to: file, options: [.atomic, .completeFileProtection])
    }

    /// The answer for `fileId`, removed once read; nil when there is none yet.
    public func take(fileId: Int64) -> Bool? {
        guard let a = (try? Data(contentsOf: file)).flatMap({ try? JSONDecoder().decode(Answer.self, from: $0) }),
              a.fileId == fileId else { return nil }
        clear()
        return a.accept
    }

    public func clear() {
        try? FileManager.default.removeItem(at: file)
    }
}

/// The names the extension's file-offer notification and the app's handler agree on.
public enum FileOfferNotification {
    public static let category = "IA_FILE_OFFER"
    public static let saveAction = "IA_FILE_SAVE"
    public static let declineAction = "IA_FILE_DECLINE"
    public static let fileIdKey = "fileId"

    public static func id(_ fileId: Int64) -> String { "ia-file-\(fileId)" }
}
