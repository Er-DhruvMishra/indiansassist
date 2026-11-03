import Foundation
import XCTest
import IASec
@testable import IASession

/// The iOS Desk session state machine (A §7.4 from the Desk, C §§3.2, 3.7, 1.3 step 9; view only, §17.4).
final class DeskMachineTests: XCTestCase {
    let client = DeskClient(version: "0.3.0", osVersion: "18.1", tokenSource: .manual)
    var m: DeskMachine!
    let ice: JSONValue = .array([.object(["urls": .string("stun:stun.example:3478")])])

    override func setUp() {
        m = DeskMachine(client: client, deskLabel: "Rahul's iPhone", now: { 1_793_059_200_000 })
    }

    func srv(_ o: [String: JSONValue]) -> [DeskEffect] { m.handle(.server(.object(o))) }

    func sent(_ effects: [DeskEffect]) -> [JSONValue] {
        effects.compactMap { if case let .send(v) = $0 { return v } else { return nil } }
    }

    func toActive() {
        _ = m.handle(.start(token: "ia1.x.y.z", signalUrl: "wss://h/signal"))
        _ = m.handle(.socketOpen(reconnect: false))
        _ = srv(["t": .string("desk.hello.ok"), "technician": .object(["name": .string("Asha")]),
                 "org": .object(["displayName": .string("Acme")]), "region": .string("in-mum")])
        _ = srv(["t": .string("knock.ok"), "sessionId": .string("s1"), "resumeKey": .string("rk")])
        _ = srv(["t": .string("session.created"), "sessionId": .string("s1"), "state": .string("consent_pending"),
                 "assist": .object(["name": .string("Asha K")]), "org": .object(["displayName": .string("Acme")])])
        _ = m.handle(.consentAccepted)
        _ = srv(["t": .string("consent.ok"), "sessionId": .string("s1"), "state": .string("active"), "iceServers": ice])
    }

    func testTheHappyPathReachesActiveAsANativeIOSDesk() {
        XCTAssertEqual(m.handle(.start(token: "ia1.x.y.z", signalUrl: "wss://h/signal")), [.connect(url: "wss://h/signal")])
        let hello = sent(m.handle(.socketOpen(reconnect: false))).first!
        XCTAssertEqual(hello["t"]?.stringValue, "desk.hello")
        XCTAssertEqual(hello["client"]?["kind"]?.stringValue, "native")
        XCTAssertEqual(hello["client"]?["os"]?.stringValue, "ios")
        XCTAssertEqual(hello["client"]?["tokenSource"]?.stringValue, "manual")
        XCTAssertEqual(hello["client"]?["capabilities"]?["features"], .array([.string("screen"), .string("chat"), .string("files")]))
        XCTAssertEqual(hello["client"]?["capabilities"]?["interpreters"], .array([]))
        XCTAssertNil(hello["resumeKey"], "no null is sent")
        let ok = srv(["t": .string("desk.hello.ok"), "org": .object(["displayName": .string("Acme")])])
        XCTAssertEqual(sent(ok).first?["t"]?.stringValue, "desk.knock")
        XCTAssertTrue(ok.contains(.startPolling))
        XCTAssertEqual(m.phase, .waiting)
        _ = srv(["t": .string("knock.held")])
        XCTAssertEqual(m.phase, .held)
        XCTAssertTrue(srv(["t": .string("knock.ok"), "sessionId": .string("s1"), "resumeKey": .string("rk")]).contains(.stopPolling))
        let created = srv(["t": .string("session.created"), "sessionId": .string("s1"), "state": .string("consent_pending"),
                           "assist": .object(["name": .string("Asha K")]), "org": .object(["displayName": .string("Acme")]),
                           "recordingMode": .string("both")])
        XCTAssertTrue(created.contains(.showConsent(ConsentInfo(technician: "Asha K", org: "Acme", recordingMode: "both", region: nil))))
        // A re-sent session.created never opens a second consent screen.
        XCTAssertTrue(srv(["t": .string("session.created"), "sessionId": .string("s1"), "state": .string("consent_pending")]).isEmpty)
        let consent = sent(m.handle(.consentAccepted)).first!
        XCTAssertEqual(consent["state"]?.stringValue, "granted")
        XCTAssertEqual(consent["native"]?["level"]?.stringValue, "view", "an iPhone is never controlled")
        XCTAssertEqual(m.phase, .starting)
        let active = srv(["t": .string("consent.ok"), "state": .string("active"), "iceServers": ice])
        XCTAssertEqual(active, [.startMedia(ice: [IceServer(urls: ["stun:stun.example:3478"], username: nil, credential: nil)])])
        XCTAssertEqual(m.phase, .active)
    }

    func testDecliningConsentRevokesAndEndsLocally() {
        _ = m.handle(.start(token: "t", signalUrl: "u"))
        _ = m.handle(.socketOpen(reconnect: false))
        _ = srv(["t": .string("desk.hello.ok")])
        _ = srv(["t": .string("knock.ok"), "sessionId": .string("s1")])
        _ = srv(["t": .string("session.created"), "sessionId": .string("s1"), "state": .string("consent_pending")])
        let out = m.handle(.consentDeclined)
        XCTAssertEqual(sent(out).first?["state"]?.stringValue, "revoked")
        XCTAssertTrue(out.contains(.startLocalEndTimer))
        XCTAssertEqual(m.handle(.localEndTimeout).last, .ended(EndInfo(endReason: "desk_stopped", local: true)))
    }

    func testStoppingTheBroadcastSendsStopSharingFlushesAndTearsDownBeforeTheEnd() {
        toActive()
        let out = m.handle(.stop)
        guard case let .sendCtrl(stop) = out.first else { return XCTFail("stop.sharing first") }
        XCTAssertEqual(stop["t"]?.stringValue, "stop.sharing")
        let teardown = out.firstIndex(of: .teardown)!
        let end = out.firstIndex { if case let .send(v) = $0 { return v["t"]?.stringValue == "session.end" } else { return false } }!
        XCTAssertLessThan(out.firstIndex(of: .flushOutbox)!, teardown)
        XCTAssertLessThan(teardown, end)
        XCTAssertEqual(m.phase, .ending)
    }

    func testTheSystemEndingTheBroadcastIsIndicatorLost() {
        toActive()
        let end = sent(m.handle(.indicatorLost)).first { $0["t"]?.stringValue == "session.end" }
        XCTAssertEqual(end?["note"]?.stringValue, "indicator_lost")
    }

    func testASecFailureIsReportedAndEndsTheSession() {
        toActive()
        let out = sent(m.handle(.secFailed(reason: "mac")))
        XCTAssertEqual(out.first?["action"]?.stringValue, "sec.failed")
        XCTAssertEqual(out.last?["note"]?.stringValue, "sec:mac")
    }

    func testAnEndWhileTheSocketIsDownIsKeptForTheNextHello() {
        toActive()
        _ = m.handle(.socketClosed(code: 1006))
        let out = m.handle(.stop)
        XCTAssertFalse(sent(out).contains { $0["t"]?.stringValue == "session.end" })
        _ = m.handle(.socketOpen(reconnect: true))
        let replay = sent(srv(["t": .string("desk.hello.ok")]))
        XCTAssertEqual(replay.first?["t"]?.stringValue, "session.end")
    }

    func testTerminalClosesAndFatalErrorsEndTheSession() {
        toActive()
        XCTAssertEqual(m.handle(.socketClosed(code: 4410)).last, .ended(EndInfo(endReason: "desk_stopped", local: true, reachedActive: true)))
        let m2 = DeskMachine(client: client, deskLabel: nil)
        _ = m2.handle(.start(token: "t", signalUrl: "u"))
        XCTAssertEqual(m2.handle(.server(.object(["t": .string("error"), "code": .string("token_gone")]))).last,
                       .ended(EndInfo(endReason: "error", local: true, error: "token_gone")))
    }

    func testResumeFromActiveRebuildsThePeerOnTheNextIceRefresh() {
        toActive()
        XCTAssertTrue(srv(["t": .string("session.created"), "sessionId": .string("s1"), "state": .string("active")]).isEmpty)
        XCTAssertEqual(srv(["t": .string("ice.refresh"), "iceServers": ice]),
                       [.rebuildPeer(ice: [IceServer(urls: ["stun:stun.example:3478"], username: nil, credential: nil)])])
    }

    func testPeerSignalsAndChatAreRelayedOnlyWhileLive() {
        XCTAssertTrue(srv(["t": .string("webrtc.answer"), "sdp": .string("x")]).isEmpty)
        toActive()
        XCTAssertEqual(srv(["t": .string("webrtc.answer"), "sdp": .string("x")]).count, 1)
        XCTAssertEqual(srv(["t": .string("ping"), "id": .string("p1")]), [.send(DeskSignal.pong(re: "p1"))])
    }

    func testEndOfCandidatesIsTheOneNullSent() {
        let ice = DeskSignal.ice(sessionId: "s1", candidate: nil, peer: nil)
        XCTAssertEqual(ice["candidate"], .null)
        XCTAssertNil(ice["peer"])
    }
}
