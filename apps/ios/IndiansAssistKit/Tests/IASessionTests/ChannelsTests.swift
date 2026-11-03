import Foundation
import XCTest
import IASec
@testable import IASession

final class ChannelsTests: XCTestCase {
    func testTheLabelsAreTheP3SetInOrder() {
        XCTAssertEqual(P3Channels.labels, ["ia.sec", "ia.chat", "ia.annot", "ia.file", "ia.ctrl", "ia.control", "ia.playbook"])
        // Every label but ia.sec is an encrypted one with a frame label id.
        for l in P3Channels.labels.dropFirst() { XCTAssertNotNil(SecLabel(rawValue: l), l) }
    }

    func testEveryControlRequestIsNotSupported() {
        let r = P3Channels.controlNotSupported(id: "r1", ts: 5)
        XCTAssertEqual(r["t"]?.stringValue, "ctl.res")
        XCTAssertEqual(r["ok"], .bool(false))
        XCTAssertEqual(r["error"]?["code"]?.stringValue, "not_supported")
        XCTAssertEqual(P3Channels.controlNotSupported(id: String(repeating: "x", count: 99), ts: 5)["id"]?.stringValue?.count, 40)
    }

    func testChatIsShownAndAcknowledgedOnce() {
        var inbox = ChatInbox()
        let m: JSONValue = .object(["t": .string("chat"), "msgId": .string("m1"), "text": .string("Hello"), "ts": .int(1)])
        let ack = inbox.receive(m, ts: 9)
        XCTAssertEqual(ack, .object(["t": .string("chat.ack"), "msgId": .string("m1"), "ts": .int(9)]))
        XCTAssertNil(inbox.receive(m, ts: 10), "a duplicate is not shown twice")
        XCTAssertNil(inbox.receive(.object(["t": .string("chat.ack"), "msgId": .string("m2")]), ts: 10))
        XCTAssertEqual(inbox.lines, ["Hello"])
    }

    func testTheMaxMessageSizeLineIsAddedAfterSctpPort() {
        let sdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:1\r\na=sctp-port:5000\r\na=setup:actpass\r\n"
        let out = SdpMunge.withMaxMessageSize(sdp)
        XCTAssertTrue(out.contains("a=sctp-port:5000\r\na=max-message-size:131072\r\na=setup:actpass"), out)
        XCTAssertEqual(out.components(separatedBy: "max-message-size").count, 2)
    }

    func testAnExistingMaxMessageSizeIsReplacedAndNoApplicationMeansNoChange() {
        let sdp = "v=0\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\na=max-message-size:262144\n"
        XCTAssertEqual(SdpMunge.withMaxMessageSize(sdp), "v=0\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\na=max-message-size:131072\n")
        let video = "v=0\nm=video 9 RTP 96\n"
        XCTAssertEqual(SdpMunge.withMaxMessageSize(video), video)
    }
}
