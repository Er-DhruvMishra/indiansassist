import Foundation
import XCTest
import IASec
@testable import IASession

/// Token entry (§17.4) against the shared `joinInput` and `shortCodes` vectors, and the strict link grammar.
final class JoinInputTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/shared/test/fixtures/agent/sec-vectors.json")
        return JSONValue.parse(try! String(contentsOf: url, encoding: .utf8))!
    }()

    func testNormaliseMatchesTheSharedVectors() {
        guard case let .array(cases)? = Self.vectors["joinInput"] else { return XCTFail("joinInput") }
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let input = c["input"]!.stringValue!
            let got = JoinInput.normalise(input)
            if case .null? = c["normalised"] {
                XCTAssertNil(got, input)
            } else {
                XCTAssertEqual(got?.kind.rawValue, c["normalised"]?["kind"]?.stringValue, input)
                XCTAssertEqual(got?.value, c["normalised"]?["value"]?.stringValue, input)
            }
        }
    }

    func testShortCodeValidityMatchesTheSharedVectors() {
        guard case let .array(cases)? = Self.vectors["shortCodes"] else { return XCTFail("shortCodes") }
        for c in cases {
            XCTAssertEqual(JoinInput.isValidShortCode(c["code"]!.stringValue!), c["valid"]!.boolValue!, c["code"]!.stringValue!)
        }
    }

    func testTheSchemeLinkCarriesOnlyTOrC() {
        let hosts: Set<String> = []
        XCTAssertEqual(JoinInput.parseAny("indiansassist://join?t=ia1.a.b.c", allowedHosts: hosts), JoinCode(kind: .compact, value: "ia1.a.b.c"))
        XCTAssertEqual(JoinInput.parseAny("indiansassist://join?c=482193657715", allowedHosts: hosts), JoinCode(kind: .shortCode, value: "482193657715"))
        XCTAssertNil(JoinInput.parseAny("indiansassist://join?t=ia1.a&x=1", allowedHosts: hosts), "unknown parameter")
        XCTAssertNil(JoinInput.parseAny("indiansassist://evil?t=ia1.a.b.c", allowedHosts: hosts))
        XCTAssertNil(JoinInput.parseAny("indiansassist://join?t=482193657715", allowedHosts: hosts), "t is compact only")
        XCTAssertNil(JoinInput.parseAny("indiansassist://join?c=ia1.a.b.c", allowedHosts: hosts), "c is a short code only")
    }

    func testWebLinksAreAcceptedOnlyFromTheRegionHosts() {
        let hosts: Set<String> = ["in.indiansassist.example", "localhost:5340"]
        XCTAssertEqual(JoinInput.parseAny("https://in.indiansassist.example/join#t=4821-9365-7715", allowedHosts: hosts)?.value, "482193657715")
        XCTAssertEqual(JoinInput.parseAny("http://localhost:5340/join?t=ia1.a.b.c", allowedHosts: hosts)?.kind, .compact)
        XCTAssertNil(JoinInput.parseAny("https://evil.example/join#t=482193657715", allowedHosts: hosts))
        XCTAssertNil(JoinInput.parseAny("https://in.indiansassist.example/other#t=482193657715", allowedHosts: hosts))
    }

    func testBareCodesAndDisplay() {
        XCTAssertEqual(JoinInput.parseAny("  4821 9365 7715 ", allowedHosts: [])?.value, "482193657715")
        XCTAssertNil(JoinInput.parseAny("hello", allowedHosts: []))
        XCTAssertEqual(JoinInput.formatShortCode("482193657715"), "4821 9365 7715")
    }
}
