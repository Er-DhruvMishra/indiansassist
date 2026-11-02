import Foundation
import XCTest
@testable import IASession

final class HandoffTests: XCTestCase {
    func defaults() -> UserDefaults {
        let name = "ia.test.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    func store() throws -> HandoffStore {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ia-handoff-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return HandoffStore(directory: dir)
    }

    func handoff(at date: Date) -> JoinHandoff {
        JoinHandoff(code: "482193657715", tokenSource: .manual, apiOrigin: "https://in.example", consentedAt: date)
    }

    func testTheHandoffIsReadOnceAndTheFileIsGoneAfterReading() throws {
        let s = try store()
        let now = Date()
        let h = handoff(at: now)
        try s.write(h)
        XCTAssertTrue(s.exists)
        XCTAssertEqual(s.take(now: now), h)
        XCTAssertFalse(s.exists, "deleted on read, before the extension opens /signal")
        XCTAssertNil(s.take(now: now), "read once")
    }

    func testAnExpiredHandoffIsDeletedAndIgnored() throws {
        let s = try store()
        let then = Date(timeIntervalSince1970: 1_800_000_000)
        try s.write(handoff(at: then))
        XCTAssertNil(s.take(now: then.addingTimeInterval(JoinHandoff.maxAge + 1)))
        XCTAssertFalse(s.exists, "a stale hand-off is deleted too")
        try s.write(handoff(at: then))
        XCTAssertNil(s.take(now: then.addingTimeInterval(-5)), "from the future")
        XCTAssertFalse(s.exists)
    }

    func testAnUnreadableHandoffIsDeleted() throws {
        let s = try store()
        try Data("not json".utf8).write(to: s.file)
        XCTAssertNil(s.take(now: Date()))
        XCTAssertFalse(s.exists)
    }

    func testTheAppClearsALeftoverHandoffOnLaunch() throws {
        let s = try store()
        try s.write(handoff(at: Date()))
        s.clear() // what the app does on launch and on cancel
        XCTAssertFalse(s.exists)
        s.clear() // and clearing nothing is harmless
        XCTAssertFalse(s.exists)
    }

    func testTheCodeIsNeverInUserDefaults() throws {
        let s = try store()
        try s.write(handoff(at: Date()))
        let dump = UserDefaults.standard.dictionaryRepresentation().description
        XCTAssertFalse(dump.contains("482193657715"))
    }

    func testTheSignalUrlFollowsTheOrigin() {
        func url(_ o: String) -> String? {
            JoinHandoff(code: "c", tokenSource: .manual, apiOrigin: o, consentedAt: Date()).signalUrl
        }
        XCTAssertEqual(url("https://in.example"), "wss://in.example/signal")
        XCTAssertEqual(url("http://192.168.1.20:4170"), "ws://192.168.1.20:4170/signal")
        XCTAssertNil(url("https://in.example/sub"))
        XCTAssertNil(url("ftp://in.example"))
        XCTAssertNil(url("not a url"))
    }

    func testAStaleHandoffIsNotFresh() {
        let then = Date(timeIntervalSince1970: 1_000_000)
        let h = JoinHandoff(code: "c", tokenSource: .deeplink, apiOrigin: "https://x", consentedAt: then)
        XCTAssertTrue(h.isFresh(now: then.addingTimeInterval(60)))
        XCTAssertFalse(h.isFresh(now: then.addingTimeInterval(JoinHandoff.maxAge + 1)))
        XCTAssertFalse(h.isFresh(now: then.addingTimeInterval(-5)), "from the future")
    }

    func testTheSessionNoteRoundTrips() {
        let d = defaults()
        let n = SessionNote(state: "active", technician: "Asha", chat: ["hi"], files: ["a.txt"])
        n.save(to: d)
        XCTAssertEqual(SessionNote.load(from: d), n)
    }
}
