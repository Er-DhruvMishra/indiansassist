import CryptoKit
import Foundation
import XCTest
import IASec
@testable import IASession

final class FilesTests: XCTestCase {
    private static func fixture(_ name: String) throws -> Any {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/shared/test/fixtures/agent/\(name)")
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url))
    }

    // MARK: names (the shared vectors)

    func testSanitiseMatchesEverySharedVector() throws {
        let root = try XCTUnwrap(try Self.fixture("sec-vectors.json") as? [String: Any])
        let vectors = try XCTUnwrap(root["fileNames"] as? [[String: Any]])
        XCTAssertFalse(vectors.isEmpty)
        for v in vectors {
            let name = try XCTUnwrap(v["name"] as? String)
            let id = try XCTUnwrap((v["fileId"] as? NSNumber)?.int64Value)
            XCTAssertEqual(FileNames.sanitise(name, fileId: id), v["sanitised"] as? String, "\(name.debugDescription)")
        }
    }

    func testTheExtensionListsAreTheSharedOnes() throws {
        let lists = try XCTUnwrap(try Self.fixture("file-lists.json") as? [String: Any])
        XCTAssertEqual(FileNames.executableExtensions, Set(try XCTUnwrap(lists["executableExtensions"] as? [String])))
        XCTAssertEqual(FileNames.passiveRiskExtensions, Set(try XCTUnwrap(lists["passiveRiskExtensions"] as? [String])))
        XCTAssertEqual(FileNames.reservedStems, Set(try XCTUnwrap(lists["reservedDeviceStems"] as? [String]).map { $0.uppercased() }))
        XCTAssertTrue(FileNames.isExecutable("setup.EXE"))
        XCTAssertTrue(FileNames.isPassiveRisk("share.url"))
        XCTAssertFalse(FileNames.isExecutable("notes.txt"))
        XCTAssertNil(FileNames.fileExtension(".profile"))
    }

    func testTheFinalNameAvoidsTakenNamesCaseInsensitively() {
        XCTAssertEqual(FileNames.finalName("a.txt", taken: []), "a.txt")
        XCTAssertEqual(FileNames.finalName("a.txt", taken: ["A.TXT"]), "a (2).txt")
        XCTAssertEqual(FileNames.finalName("a.txt", taken: ["a.txt", "a (2).txt"]), "a (3).txt")
        XCTAssertEqual(FileNames.finalName("README", taken: ["readme"]), "README (2)")
    }

    // MARK: the receiver

    private final class MemorySink: FileSink {
        var data = Data()
        var committed = false
        var aborted = false
        func write(_ bytes: Data) throws { data.append(bytes) }
        func commit() throws -> URL {
            committed = true
            return URL(fileURLWithPath: "/received/report.pdf")
        }
        func abort() { aborted = true }
    }

    private var sink = MemorySink()

    private func receiver() -> FileReceiver {
        FileReceiver(clock: { 42 }) { [unowned self] _ in self.sink }
    }

    private static func hex(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }

    private static func offer(_ id: Int64 = 7, name: String = "report.pdf", body: Data, sha: String? = nil,
                              chunkSize: Int64 = 16_384) -> JSONValue {
        .object([
            "t": .string("file.offer"), "fileId": .int(id), "name": .string(name), "size": .int(Int64(body.count)),
            "mime": .string("application/pdf"), "sha256": .string(sha ?? hex(body)), "chunkSize": .int(chunkSize),
            "chunks": .int((Int64(body.count) + 16_383) / 16_384), "ts": .int(1),
        ])
    }

    private static func chunk(_ id: UInt32, _ index: UInt32, _ payload: Data) -> Data {
        var d = Data()
        for v in [id, index] { d.append(contentsOf: [UInt8(v >> 24), UInt8(v >> 16 & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v & 0xFF)]) }
        return d + payload
    }

    private static let body = Data((0..<(16_384 + 100)).map { UInt8($0 % 251) })

    func testAnAcceptedFileIsStreamedVerifiedSavedAndAttested() {
        let r = receiver()
        let step = r.onOffer(Self.offer(body: Self.body))
        XCTAssertEqual(step.prompt?.name, "report.pdf")
        XCTAssertEqual(step.prompt?.executable, false)
        XCTAssertTrue(step.send.isEmpty, "nothing is sent until the person answers")
        XCTAssertEqual(r.pending?.fileId, 7)
        XCTAssertEqual(r.accept(7).send.first?["t"]?.stringValue, "file.accept")
        XCTAssertNil(r.pending)
        XCTAssertTrue(r.onChunk(Self.chunk(7, 0, Self.body.prefix(16_384))).send.isEmpty)
        XCTAssertTrue(r.onChunk(Self.chunk(7, 1, Self.body.suffix(100))).send.isEmpty)
        let done = r.onDone(.object(["t": .string("file.done"), "fileId": .int(7)]))
        let ack = done.send.first
        XCTAssertEqual(ack?["t"]?.stringValue, "file.ack")
        XCTAssertEqual(ack?["ok"], .bool(true))
        XCTAssertEqual(ack?["sha256"]?.stringValue, Self.hex(Self.body))
        XCTAssertEqual(ack?["ts"], .int(42))
        XCTAssertEqual(sink.data, Self.body)
        XCTAssertTrue(sink.committed)
        XCTAssertEqual(done.attest?["direction"]?.stringValue, "assist_to_desk")
        XCTAssertEqual(done.attest?["bytes"], .int(Int64(Self.body.count)))
        XCTAssertEqual(done.savedTo?.lastPathComponent, "report.pdf")
        XCTAssertFalse(r.busy)
    }

    func testAHashMismatchIsAckedNotOkAndTheFileDiscarded() {
        let r = receiver()
        _ = r.onOffer(Self.offer(body: Self.body, sha: String(repeating: "0", count: 64)))
        _ = r.accept(7)
        _ = r.onChunk(Self.chunk(7, 0, Self.body.prefix(16_384)))
        _ = r.onChunk(Self.chunk(7, 1, Self.body.suffix(100)))
        let done = r.onDone(.object(["t": .string("file.done"), "fileId": .int(7)]))
        XCTAssertEqual(done.send.first?["ok"], .bool(false))
        XCTAssertNil(done.attest)
        XCTAssertTrue(sink.aborted)
        XCTAssertFalse(sink.committed)
    }

    func testOffersThatAreRefused() {
        let r = receiver()
        func reason(_ s: FileStep) -> String? { s.send.first?["reason"]?.stringValue }
        XCTAssertEqual(reason(r.onOffer(Self.offer(name: "share.url", body: Self.body))), "bad_name")
        XCTAssertEqual(reason(r.onOffer(Self.offer(name: "", body: Self.body))), "bad_name")
        XCTAssertEqual(reason(r.onOffer(Self.offer(name: String(repeating: "a", count: 256), body: Self.body))), "bad_name")
        XCTAssertEqual(reason(r.onOffer(Self.offer(body: Self.body, sha: "xyz"))), "bad_name")
        XCTAssertEqual(reason(r.onOffer(Self.offer(body: Self.body, chunkSize: 1024))), "bad_name")
        let small = FileReceiver(maxBytes: 10) { _ in MemorySink() }
        XCTAssertEqual(reason(small.onOffer(Self.offer(body: Self.body))), "too_large")
        XCTAssertNotNil(r.onOffer(Self.offer(body: Self.body)).prompt)
        XCTAssertEqual(reason(r.onOffer(Self.offer(8, body: Self.body))), "busy")
        // A name with a path is sanitised, never refused for it; an executable is flagged for the prompt.
        let r2 = receiver()
        XCTAssertEqual(r2.onOffer(Self.offer(name: "../../setup.exe", body: Self.body)).prompt?.name, "_.._setup.exe")
        XCTAssertEqual(r2.pending?.executable, true)
    }

    func testBadChunksCancelTheTransfer() {
        func started() -> FileReceiver {
            let r = receiver()
            _ = r.onOffer(Self.offer(body: Self.body))
            _ = r.accept(7)
            return r
        }
        func reason(_ s: FileStep) -> String? { s.send.first?["reason"]?.stringValue }
        XCTAssertEqual(reason(started().onChunk(Self.chunk(7, 2, Data([1])))), "bad_chunk", "index out of range")
        XCTAssertEqual(reason(started().onChunk(Self.chunk(7, 0, Data([1])))), "bad_chunk", "a short chunk that is not the last")
        XCTAssertEqual(reason(started().onChunk(Self.chunk(9, 0, Self.body.prefix(16_384)))), "bad_chunk", "another fileId")
        let dup = started()
        _ = dup.onChunk(Self.chunk(7, 0, Self.body.prefix(16_384)))
        XCTAssertEqual(reason(dup.onChunk(Self.chunk(7, 0, Self.body.prefix(16_384)))), "bad_chunk", "a repeated index")
        let over = started()
        _ = over.onChunk(Self.chunk(7, 0, Self.body.prefix(16_384)))
        XCTAssertEqual(reason(over.onChunk(Self.chunk(7, 1, Data(count: 200)))), "overflow", "more bytes than offered")
        let early = started()
        _ = early.onChunk(Self.chunk(7, 0, Self.body.prefix(16_384)))
        XCTAssertEqual(reason(early.onDone(.object(["t": .string("file.done"), "fileId": .int(7)]))), "bad_chunk", "done before every chunk")
        XCTAssertTrue(sink.aborted)
        // A chunk before the person said Save.
        let unanswered = receiver()
        _ = unanswered.onOffer(Self.offer(body: Self.body))
        XCTAssertEqual(reason(unanswered.onChunk(Self.chunk(7, 0, Self.body.prefix(16_384)))), "bad_chunk")
    }

    func testDeclineCancelAndAbortAll() {
        let r = receiver()
        _ = r.onOffer(Self.offer(body: Self.body))
        XCTAssertEqual(r.decline(7).send.first?["reason"]?.stringValue, "declined")
        XCTAssertFalse(r.busy)
        _ = r.onOffer(Self.offer(body: Self.body))
        _ = r.accept(7)
        XCTAssertTrue(r.onCancel(.object(["t": .string("file.cancel"), "fileId": .int(7)])).send.isEmpty)
        XCTAssertTrue(sink.aborted)
        XCTAssertFalse(r.busy)
        sink = MemorySink()
        _ = r.onOffer(Self.offer(body: Self.body))
        _ = r.accept(7)
        r.abortAll()
        XCTAssertTrue(sink.aborted)
        XCTAssertFalse(r.busy)
    }

    // MARK: the App Group folder and the answer

    private func tempDir() throws -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("ia-files-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: d) }
        return d
    }

    func testTheFolderCommitsUnderAFreeNameAndNeverListsAPart() throws {
        let folder = ReceivedFolder(directory: try tempDir().appendingPathComponent("Received"))
        let offer = IncomingOffer(fileId: 1, name: "a.txt", size: 3, mime: "text/plain", executable: false)
        let s1 = try folder.sink(for: offer)
        try s1.write(Data("abc".utf8))
        XCTAssertTrue(folder.list().isEmpty, "a part is never listed")
        let parts = try FileManager.default.contentsOfDirectory(atPath: folder.directory.path)
        XCTAssertEqual(parts.count, 1)
        XCTAssertTrue(parts[0].hasPrefix("a.txt.") && parts[0].hasSuffix(".iapart"), parts[0])
        let perms = try FileManager.default.attributesOfItem(atPath: folder.directory.appendingPathComponent(parts[0]).path)[.posixPermissions]
        XCTAssertEqual((perms as? NSNumber)?.intValue, 0o600)
        let saved = try s1.commit()
        XCTAssertEqual(saved.lastPathComponent, "a.txt")
        XCTAssertEqual(try Data(contentsOf: saved), Data("abc".utf8))
        let s2 = try folder.sink(for: offer)
        try s2.write(Data("de".utf8))
        XCTAssertEqual(try s2.commit().lastPathComponent, "a (2).txt")
        let s3 = try folder.sink(for: offer)
        try s3.write(Data("x".utf8))
        s3.abort()
        XCTAssertEqual(Set(folder.list().map(\.lastPathComponent)), ["a.txt", "a (2).txt"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.directory.path).count, 2, "the aborted part is gone")
    }

    func testAStalePartIsSweptWhenTheFolderOpens() throws {
        let dir = try tempDir()
        let part = dir.appendingPathComponent("old.bin.0123abcd.iapart")
        try Data([1]).write(to: part)
        let fresh = dir.appendingPathComponent("new.bin.89abcdef.iapart")
        try Data([1]).write(to: fresh)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -2 * 86_400)], ofItemAtPath: part.path)
        _ = ReceivedFolder(directory: dir)
        XCTAssertFalse(FileManager.default.fileExists(atPath: part.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: fresh.path), "a part from today may belong to a live transfer")
    }

    func testANoteFromBeforeFileReceiveStillLoadsAndAPendingOfferRoundTrips() throws {
        let old = #"{"state":"live","chat":["hi"],"files":[],"updatedAt":1}"#
        let note = try JSONDecoder().decode(SessionNote.self, from: Data(old.utf8))
        XCTAssertNil(note.pendingFile)
        var next = note
        next.pendingFile = IncomingOffer(fileId: 5, name: "a.pdf", size: 9, mime: "application/pdf", executable: false)
        XCTAssertEqual(try JSONDecoder().decode(SessionNote.self, from: JSONEncoder().encode(next)), next)
    }

    func testTheAnswerIsReadOnceAndOnlyForItsOffer() throws {
        let store = FileAnswerStore(directory: try tempDir())
        XCTAssertNil(store.take(fileId: 3))
        try store.answer(fileId: 3, accept: true)
        XCTAssertNil(store.take(fileId: 4))
        XCTAssertEqual(store.take(fileId: 3), true)
        XCTAssertNil(store.take(fileId: 3), "read once")
    }
}
