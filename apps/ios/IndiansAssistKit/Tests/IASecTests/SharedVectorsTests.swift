import Foundation
import XCTest
@testable import IASec

/// Cross-language conformance against `packages/shared/test/fixtures/agent/sec-vectors.json`, the file the
/// TypeScript (`agent-sec.test.ts`), Rust (`ia-core/tests/shared_vectors.rs`) and Kotlin tests load.
final class SharedVectorsTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // SharedVectorsTests.swift
            .deletingLastPathComponent() // IASecTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // IndiansAssistKit
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // apps
            .appendingPathComponent("packages/shared/test/fixtures/agent/sec-vectors.json")
        let text = try! String(contentsOf: url, encoding: .utf8)
        return JSONValue.parse(text)!
    }()

    var v: JSONValue { Self.vectors }

    func arr(_ k: String) -> [JSONValue] {
        if case let .array(a)? = v[k] { return a }
        XCTFail("\(k) is not an array")
        return []
    }

    func s(_ x: JSONValue?, _ k: String) -> String { x?[k]?.stringValue ?? { XCTFail("\(k) missing"); return "" }() }
    func hex(_ s: String) -> Data { Encoding.fromHex(s)! }

    func handshake(gen: Int) -> JSONValue {
        arr("handshakes").first { $0["gen"]?.intValue == Int64(gen) }!
    }

    func testSuiteAndLabelIds() {
        XCTAssertEqual(v["suite"]?.stringValue, SEC_SUITE)
        for label in SecLabel.allCases {
            XCTAssertEqual(v["labelIds"]?[label.rawValue]?.intValue, Int64(label.id), label.rawValue)
        }
        XCTAssertEqual(v["limits"]?["secFrameMaxBytes"]?.intValue, Int64(SEC_FRAME_MAX_BYTES))
        XCTAssertEqual(v["limits"]?["secFrameHeaderBytes"]?.intValue, Int64(SEC_FRAME_HEADER_BYTES))
        XCTAssertEqual(v["limits"]?["secTagBytes"]?.intValue, Int64(SEC_TAG_BYTES))
        XCTAssertEqual(v["limits"]?["secHandshakeTimeoutMs"]?.intValue, Int64(SEC_HANDSHAKE_TIMEOUT_MS))
    }

    func testCanonicalJson() {
        for c in arr("canonicalJson") {
            XCTAssertEqual(CanonicalJSON.string(c["value"]!), c["canonical"]?.stringValue)
        }
    }

    func testXChaChaDraftVector() throws {
        let x = v["xchacha20poly1305Draft"]
        let sealed = try XChaCha20Poly1305.seal(key: hex(s(x, "keyHex")), nonce: hex(s(x, "nonceHex")), aad: hex(s(x, "aadHex")),
                                                plaintext: Data(s(x, "plaintextUtf8").utf8))
        XCTAssertEqual(Encoding.hex(sealed), s(x, "ciphertextAndTagHex"))
        let opened = try XChaCha20Poly1305.open(key: hex(s(x, "keyHex")), nonce: hex(s(x, "nonceHex")), aad: hex(s(x, "aadHex")),
                                                sealed: sealed)
        XCTAssertEqual(String(decoding: opened, as: UTF8.self), s(x, "plaintextUtf8"))
    }

    func testHandshakePrimitives() throws {
        for h in arr("handshakes") {
            let sid = s(h, "sessionId"), gen = Int(h["gen"]!.intValue!), e = h["expected"]
            for side in SecSide.allCases {
                let p = h[side.rawValue]
                XCTAssertEqual(try SecCrypto.publicKey(esk: hex(s(p, "eskHex"))), s(p, "epk"))
                XCTAssertEqual(CanonicalJSON.string(.object(["side": .string(side.rawValue), "suite": .string(SEC_SUITE),
                                                             "epk": .string(s(p, "epk")), "fpr": .string(s(p, "fpr"))])),
                               s(p, "commitPreimage"))
                XCTAssertEqual(SecCrypto.commitHash(side: side, suite: SEC_SUITE, epk: s(p, "epk"), fpr: s(p, "fpr")), s(p, "h"))
                XCTAssertEqual(SecMessage.parse(p!["commit"]!)?.json, p!["commit"]!)
                guard case let .hello(hello)? = SecMessage.parse(p!["hello"]!) else { return XCTFail("hello") }
                XCTAssertNoThrow(try SecCrypto.verifyHello(hello, committedH: s(p, "h")))
            }
            let desk = h["desk"], assist = h["assist"]
            let ss = try SecCrypto.sharedSecret(esk: hex(s(desk, "eskHex")), peerEpk: s(assist, "epk"))
            XCTAssertEqual(Encoding.hex(ss), s(e, "ssHex"))
            XCTAssertEqual(Encoding.hex(try SecCrypto.sharedSecret(esk: hex(s(assist, "eskHex")), peerEpk: s(desk, "epk"))), s(e, "ssHex"))
            let di = SecCrypto.SideInfo(h: s(desk, "h"), epk: s(desk, "epk"), fpr: s(desk, "fpr"))
            let ai = SecCrypto.SideInfo(h: s(assist, "h"), epk: s(assist, "epk"), fpr: s(assist, "fpr"))
            XCTAssertEqual(SecCrypto.transcript(sessionId: sid, suite: SEC_SUITE, gen: gen, desk: di, assist: ai), s(e, "transcript"))
            let t = SecCrypto.transcriptHash(sessionId: sid, suite: SEC_SUITE, gen: gen, desk: di, assist: ai)
            XCTAssertEqual(Encoding.hex(t), s(e, "transcriptHashHex"))
            let k = SecCrypto.deriveKeys(ss: ss, transcriptHash: t)
            XCTAssertEqual(Encoding.hex(k.prk), s(e, "prkHex"))
            XCTAssertEqual(Encoding.hex(k.kD2A), s(e, "kD2AHex"))
            XCTAssertEqual(Encoding.hex(k.kA2D), s(e, "kA2DHex"))
            XCTAssertEqual(Encoding.hex(k.kConf), s(e, "kConfHex"))
            XCTAssertEqual(Encoding.hex(k.sasRaw), s(e, "sasRawHex"))
            XCTAssertEqual(k.sas, s(e, "sas"))
            XCTAssertEqual(SecCrypto.sasDisplay(k.sas), s(e, "sasDisplay"))
            XCTAssertEqual(SecCrypto.confirmMac(kConf: k.kConf, side: .desk, transcriptHash: t), s(e?["deskConfirm"], "mac"))
            XCTAssertEqual(SecCrypto.confirmMac(kConf: k.kConf, side: .assist, transcriptHash: t), s(e?["assistConfirm"], "mac"))
        }
    }

    /// Both drivers run against each other with the vector keys and must reach the vector SAS and confirms.
    func testDriversAgainstEachOther() throws {
        for h in arr("handshakes") {
            let sid = s(h, "sessionId"), gen = Int(h["gen"]!.intValue!), e = h["expected"]
            let ts = h["desk"]!["commit"]!["ts"]!.intValue!
            var deskOut: [SecMessage] = [], assistOut: [SecMessage] = []
            let desk = try SecHandshake(.init(side: .desk, sessionId: sid, gen: gen, ownFpr: s(h["desk"], "fpr"),
                                              remoteFpr: s(h["assist"], "fpr"), send: { deskOut.append($0) },
                                              esk: hex(s(h["desk"], "eskHex")), now: { ts }, timerQueue: nil))
            let assist = try SecHandshake(.init(side: .assist, sessionId: sid, gen: gen, ownFpr: s(h["assist"], "fpr"),
                                                remoteFpr: s(h["desk"], "fpr"), send: { assistOut.append($0) },
                                                esk: hex(s(h["assist"], "eskHex")), now: { ts }, timerQueue: nil))
            desk.start()
            assist.start()
            XCTAssertEqual(deskOut.first?.json, h["desk"]!["commit"]!)
            while !deskOut.isEmpty || !assistOut.isEmpty {
                let d = deskOut, a = assistOut
                deskOut = []
                assistOut = []
                d.forEach { assist.receive($0.text) }
                a.forEach { desk.receive($0.text) }
            }
            XCTAssertEqual(desk.state, .established)
            XCTAssertEqual(assist.state, .established)
            XCTAssertEqual(desk.result?.sas, s(e, "sas"))
            XCTAssertEqual(assist.result?.sas, s(e, "sas"))
            XCTAssertEqual(desk.result.map { Encoding.hex($0.kD2A) }, s(e, "kD2AHex"))

            // A chat round trip through the established channels, and a second channel for the same stream refused.
            let frame = try desk.channel(.chat).seal(text: "hello from the iPhone")
            XCTAssertEqual(try assist.channel(.chat).open(frame).text, "hello from the iPhone")
            XCTAssertThrowsError(try SecChannel(side: .desk, sessionId: sid, label: .chat, gen: gen,
                                                kD2A: desk.result!.kD2A, kA2D: desk.result!.kA2D))
        }
    }

    func testFrames() throws {
        for f in arr("frames") {
            let gen = Int(f["gen"]!.intValue!)
            let h = handshake(gen: gen), e = h["expected"]
            let label = SecLabel(rawValue: s(f, "label"))!
            let dir = SecDirection(rawValue: s(f, "direction"))!
            XCTAssertEqual(f["labelId"]?.intValue, Int64(label.id))
            let seq = UInt64(f["seq"]!.intValue!)
            let flags = UInt8(f["flags"]!.intValue!)
            XCTAssertEqual(Encoding.hex(SecFrame.nonce(label: label, direction: dir, gen: gen, seq: seq)), s(f, "nonceHex"))
            XCTAssertEqual(Encoding.hex(SecFrame.aad(sessionId: s(h, "sessionId"), label: label, flags: flags)), s(f, "aadHex"))
            let key = hex(s(e, dir == .deskToAssist ? "kD2AHex" : "kA2DHex"))
            let p = SecFrameParams(key: key, sessionId: s(h, "sessionId"), label: label, gen: gen, direction: dir)
            // Text frames carry `plaintextUtf8`, binary frames (`ia.file` chunks) `plaintextHex`.
            let pt = f["plaintextHex"]?.stringValue.map(hex) ?? Data(s(f, "plaintextUtf8").utf8)
            XCTAssertEqual(Encoding.hex(try SecFrame.encode(p, seq: seq, plaintext: pt, text: flags & 1 == 1)), s(f, "frameHex"))
            let d = try SecFrame.decode(p, expectedSeq: seq, frame: hex(s(f, "frameHex")))
            XCTAssertEqual(d.plaintext, pt)
            XCTAssertEqual(d.text, flags & 1 == 1)
        }
    }

    func testNegative() throws {
        for n in arr("negative") {
            let expect = SecFailReason(rawValue: s(n, "expect"))!
            let name = s(n, "name")
            var got: SecFailReason?
            do {
                switch s(n, "kind") {
                case "hello":
                    // The receive path: an unknown suite is answered before the commit is checked.
                    guard case let .hello(hello)? = SecMessage.parse(n["hello"]!) else { return XCTFail(name) }
                    try SecCrypto.verifyHello(hello, committedH: s(n, "committedH"))
                case "fingerprint":
                    try SecCrypto.verifyPeerFingerprint(s(n["hello"], "fpr"), observed: s(n, "observedRemoteFpr"))
                case "key":
                    _ = try SecCrypto.sharedSecret(esk: hex(s(n, "eskHex")), peerEpk: s(n, "peerEpk"))
                case "mac":
                    let h = handshake(gen: 0), e = h["expected"]
                    try SecCrypto.verifyConfirm(kConf: hex(s(e, "kConfHex")), peerSide: .desk,
                                                transcriptHash: hex(s(e, "transcriptHashHex")), mac: s(n, "mac"))
                case "frame":
                    let gen = Int(n["gen"]!.intValue!)
                    let h = handshake(gen: gen), e = h["expected"]
                    let dir = SecDirection(rawValue: s(n, "direction"))!
                    let p = SecFrameParams(key: hex(s(e, dir == .deskToAssist ? "kD2AHex" : "kA2DHex")), sessionId: s(h, "sessionId"),
                                           label: SecLabel(rawValue: s(n, "label"))!, gen: gen, direction: dir)
                    _ = try SecFrame.decode(p, expectedSeq: UInt64(n["expectedSeq"]!.intValue!), frame: hex(s(n, "frameHex")))
                default:
                    XCTFail("unknown kind in \(name)")
                }
            } catch let r as SecFailReason {
                got = r
            }
            XCTAssertEqual(got, expect, name)
        }
    }

    func testFingerprintFromSdp() {
        guard case let .array(cases)? = v["fingerprintFromSdp"] else { return XCTFail("fingerprintFromSdp") }
        for c in cases {
            XCTAssertEqual(SecCrypto.fingerprintFromSdp(s(c, "sdp")), c["fpr"]?.stringValue, s(c, "name"))
        }
    }

    func testDriverFailures() throws {
        var out: [SecMessage] = []
        let fpr = String(repeating: "a", count: 64)
        let hs = try SecHandshake(.init(side: .desk, sessionId: "s1", gen: 0, ownFpr: fpr, remoteFpr: fpr,
                                        send: { out.append($0) }, now: { 1 }, timerQueue: nil))
        var failed: (SecFailReason, Bool)?
        hs.onFailed = { failed = ($0, $1) }
        hs.start()
        hs.receive(#"{"t":"sec.hello","v":2}"#)
        XCTAssertEqual(hs.state, .failed)
        XCTAssertEqual(failed?.0, .suite)
        XCTAssertEqual(failed?.1, true)
        XCTAssertEqual(out.last, .fail(reason: .suite, ts: 1))

        let hs2 = try SecHandshake(.init(side: .desk, sessionId: "s1", gen: 0, ownFpr: fpr, remoteFpr: fpr,
                                         send: { _ in }, timerQueue: nil))
        hs2.start()
        hs2.receive(#"{"t":"sec.fail","reason":"timeout","ts":5}"#)
        XCTAssertEqual(hs2.failReason, .timeout)
        XCTAssertThrowsError(try hs2.channel(.chat))
    }

    func testSasMatches() {
        XCTAssertTrue(SecCrypto.sasMatches(typed: "483 920", sas: "483920"))
        XCTAssertFalse(SecCrypto.sasMatches(typed: "483921", sas: "483920"))
        XCTAssertFalse(SecCrypto.sasMatches(typed: "48392", sas: "483920"))
    }
}
