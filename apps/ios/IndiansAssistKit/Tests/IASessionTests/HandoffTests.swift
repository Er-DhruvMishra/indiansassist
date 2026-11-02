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

    func testTheHandoffIsReadOnce() throws {
        let d = defaults()
        let h = JoinHandoff(code: "482193657715", tokenSource: .manual, apiOrigin: "https://in.example", consentedAt: Date())
        try h.save(to: d)
        XCTAssertEqual(JoinHandoff.take(from: d), h)
        XCTAssertNil(JoinHandoff.take(from: d), "used once")
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
