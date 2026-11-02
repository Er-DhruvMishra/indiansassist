import CryptoKit
import Foundation

/// Phase C section 1.3: the `ia.sec` handshake primitives and the XChaCha20-Poly1305 frame format, byte for byte
/// the TypeScript `packages/shared/src/agent/sec.ts`, the Rust `ia_core::sec` / `ia_core::secchan` and the Kotlin
/// `SecCrypto` / `SecChannel`. `sec-vectors.json` is the cross-language authority.
public let SEC_SUITE = "x25519-xchacha20poly1305-hkdfsha256"
public let SEC_FRAME_VERSION: UInt8 = 1
public let SEC_FRAME_HEADER_BYTES = 10
public let SEC_TAG_BYTES = 16
public let SEC_FRAME_MAX_BYTES = 131_072
public let SEC_HANDSHAKE_TIMEOUT_MS = 10_000
/// Largest plaintext of one frame: `secFrameMaxBytes - 26`.
public let SEC_MAX_PLAINTEXT = SEC_FRAME_MAX_BYTES - SEC_FRAME_HEADER_BYTES - SEC_TAG_BYTES
private let FLAG_TEXT: UInt8 = 0b0000_0001

public enum SecSide: String, CaseIterable {
    case desk, assist

    public var peer: SecSide { self == .desk ? .assist : .desk }
}

public enum SecFailReason: String, CaseIterable, Error {
    case suite, commit, fingerprint, key, mac, timeout, replay, decrypt, oversize, channel
}

public enum SecLabel: String, CaseIterable {
    case control = "ia.control"
    case file = "ia.file"
    case playbook = "ia.playbook"
    case chat = "ia.chat"
    case annot = "ia.annot"
    case ctrl = "ia.ctrl"

    public var id: UInt8 {
        switch self {
        case .control: return 1
        case .file: return 2
        case .playbook: return 3
        case .chat: return 4
        case .annot: return 5
        case .ctrl: return 6
        }
    }
}

public enum SecDirection: String {
    case deskToAssist = "desk_to_assist"
    case assistToDesk = "assist_to_desk"
}

// MARK: - wire messages (`ia.sec` carries these and nothing else)

public enum SecMessage: Equatable {
    case commit(sessionId: String, side: SecSide, h: String, gen: Int, ts: Int64)
    case hello(SecHello)
    case confirm(mac: String, ts: Int64)
    case fail(reason: SecFailReason, ts: Int64)

    public var json: JSONValue {
        switch self {
        case let .commit(sessionId, side, h, gen, ts):
            return .object(["t": .string("sec.commit"), "v": .int(1), "sessionId": .string(sessionId),
                            "side": .string(side.rawValue), "h": .string(h), "gen": .int(Int64(gen)), "ts": .int(ts)])
        case let .hello(m):
            return .object(["t": .string("sec.hello"), "v": .int(1), "sessionId": .string(m.sessionId),
                            "side": .string(m.side.rawValue), "suite": .string(m.suite), "epk": .string(m.epk),
                            "fpr": .string(m.fpr), "ts": .int(m.ts)])
        case let .confirm(mac, ts):
            return .object(["t": .string("sec.confirm"), "mac": .string(mac), "ts": .int(ts)])
        case let .fail(reason, ts):
            return .object(["t": .string("sec.fail"), "reason": .string(reason.rawValue), "ts": .int(ts)])
        }
    }

    /// The JSON text sent on `ia.sec`.
    public var text: String { CanonicalJSON.string(json) }

    /// Strict parse, as `secMessageSchema` (exact key sets, the same patterns); nil when the shape is wrong.
    public static func parse(_ v: JSONValue) -> SecMessage? {
        guard let o = v.objectValue, let t = o["t"]?.stringValue else { return nil }
        func keys(_ k: Set<String>) -> Bool { Set(o.keys) == k }
        func ts() -> Int64? { o["ts"]?.intValue.flatMap { $0 >= 0 ? $0 : nil } }
        func sessionId() -> String? { o["sessionId"]?.stringValue.flatMap { (1...64).contains($0.count) ? $0 : nil } }
        func side() -> SecSide? { o["side"]?.stringValue.flatMap(SecSide.init(rawValue:)) }
        switch t {
        case "sec.commit":
            guard keys(["t", "v", "sessionId", "side", "h", "gen", "ts"]), o["v"] == .int(1),
                  let sid = sessionId(), let sd = side(), let h = o["h"]?.stringValue, isB64u32(h),
                  let gen = o["gen"]?.intValue, (0...65535).contains(gen), let ts = ts() else { return nil }
            return .commit(sessionId: sid, side: sd, h: h, gen: Int(gen), ts: ts)
        case "sec.hello":
            guard keys(["t", "v", "sessionId", "side", "suite", "epk", "fpr", "ts"]), o["v"] == .int(1),
                  let sid = sessionId(), let sd = side(), let suite = o["suite"]?.stringValue, (1...64).contains(suite.count),
                  let epk = o["epk"]?.stringValue, isB64u32(epk), let fpr = o["fpr"]?.stringValue, isFpr64(fpr),
                  let ts = ts() else { return nil }
            return .hello(SecHello(sessionId: sid, side: sd, suite: suite, epk: epk, fpr: fpr, ts: ts))
        case "sec.confirm":
            guard keys(["t", "mac", "ts"]), let mac = o["mac"]?.stringValue, isB64u32(mac), let ts = ts() else { return nil }
            return .confirm(mac: mac, ts: ts)
        case "sec.fail":
            guard keys(["t", "reason", "ts"]), let r = o["reason"]?.stringValue.flatMap(SecFailReason.init(rawValue:)),
                  let ts = ts() else { return nil }
            return .fail(reason: r, ts: ts)
        default:
            return nil
        }
    }

    static func isB64u32(_ s: String) -> Bool {
        s.utf8.count == 43 && s.utf8.allSatisfy { c in
            (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x2D || c == 0x5F
        }
    }

    static func isFpr64(_ s: String) -> Bool {
        s.utf8.count == 64 && s.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }
}

public struct SecHello: Equatable {
    public var sessionId: String
    public var side: SecSide
    public var suite: String
    public var epk: String
    public var fpr: String
    public var ts: Int64

    public init(sessionId: String, side: SecSide, suite: String, epk: String, fpr: String, ts: Int64) {
        self.sessionId = sessionId
        self.side = side
        self.suite = suite
        self.epk = epk
        self.fpr = fpr
        self.ts = ts
    }
}

// MARK: - handshake

public enum SecCrypto {
    /// `base64url(sha256(utf8(canonicalJson({ side, suite, epk, fpr }))))` (step 2a).
    public static func commitHash(side: SecSide, suite: String, epk: String, fpr: String) -> String {
        let pre = CanonicalJSON.bytes(.object(["side": .string(side.rawValue), "suite": .string(suite),
                                               "epk": .string(epk), "fpr": .string(fpr)]))
        return Encoding.base64url(Data(SHA256.hash(data: pre)))
    }

    /// Steps 2b then 3a: an unknown suite is `suite`, then the hello must hash to the commit (constant time).
    public static func verifyHello(_ hello: SecHello, committedH: String) throws {
        guard hello.suite == SEC_SUITE else { throw SecFailReason.suite }
        let h = commitHash(side: hello.side, suite: hello.suite, epk: hello.epk, fpr: hello.fpr)
        guard Encoding.constantTimeEqual(h, committedH) else { throw SecFailReason.commit }
    }

    /// Step 3b: `peer.fpr === observedRemoteFingerprint`, constant time.
    public static func verifyPeerFingerprint(_ peerFpr: String, observed: String) throws {
        guard Encoding.constantTimeEqual(peerFpr, observed) else { throw SecFailReason.fingerprint }
    }

    public static func publicKey(esk: Data) throws -> String {
        let k = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: esk)
        return Encoding.base64url(k.publicKey.rawRepresentation)
    }

    /// Step 4: `ss = X25519(esk, peer.epk)`; an all-zero result (low-order point) is `key`.
    public static func sharedSecret(esk: Data, peerEpk: String) throws -> Data {
        guard let pub = Encoding.base64urlDecode(peerEpk), pub.count == 32 else { throw SecFailReason.key }
        let ss: Data
        do {
            let priv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: esk)
            let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: pub)
            ss = try priv.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) }
        } catch {
            throw SecFailReason.key
        }
        guard ss.contains(where: { $0 != 0 }) else { throw SecFailReason.key }
        return ss
    }

    public struct SideInfo: Equatable {
        public var h: String
        public var epk: String
        public var fpr: String

        public init(h: String, epk: String, fpr: String) {
            self.h = h
            self.epk = epk
            self.fpr = fpr
        }

        var json: JSONValue { .object(["h": .string(h), "epk": .string(epk), "fpr": .string(fpr)]) }
    }

    /// The canonical transcript string whose sha256 is `T` (step 4).
    public static func transcript(sessionId: String, suite: String, gen: Int, desk: SideInfo, assist: SideInfo) -> String {
        CanonicalJSON.string(.object(["v": .int(1), "sessionId": .string(sessionId), "suite": .string(suite),
                                      "gen": .int(Int64(gen)), "desk": desk.json, "assist": assist.json]))
    }

    public static func transcriptHash(sessionId: String, suite: String, gen: Int, desk: SideInfo, assist: SideInfo) -> Data {
        Data(SHA256.hash(data: Data(transcript(sessionId: sessionId, suite: suite, gen: gen, desk: desk, assist: assist).utf8)))
    }

    public struct Keys {
        public var prk: Data
        public var kD2A: Data
        public var kA2D: Data
        public var kConf: Data
        public var sasRaw: Data
        /// Six digits, zero-padded.
        public var sas: String
    }

    /// Step 5: HKDF-SHA256 with salt `T` over `ss`.
    public static func deriveKeys(ss: Data, transcriptHash t: Data) -> Keys {
        let prkMac = HKDF<SHA256>.extract(inputKeyMaterial: SymmetricKey(data: ss), salt: t)
        let prk = Data(prkMac)
        func expand(_ label: String, _ n: Int) -> Data {
            HKDF<SHA256>.expand(pseudoRandomKey: prkMac, info: Data("ia-sec-v1 \(label)".utf8), outputByteCount: n)
                .withUnsafeBytes { Data($0) }
        }
        let raw = expand("sas", 4)
        let n = raw.reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        let sas = String(n % 1_000_000)
        return Keys(prk: prk, kD2A: expand("desk->assist", 32), kA2D: expand("assist->desk", 32),
                    kConf: expand("confirm", 32), sasRaw: raw,
                    sas: String(repeating: "0", count: 6 - sas.count) + sas)
    }

    /// `483920` -> `483 920` (step 7).
    public static func sasDisplay(_ sas: String) -> String {
        "\(sas.prefix(3)) \(sas.dropFirst(3))"
    }

    /// Step 6: `base64url(HMAC-SHA256(kConf, utf8(side) || T))`, `side` the sender's own.
    public static func confirmMac(kConf: Data, side: SecSide, transcriptHash t: Data) -> String {
        let mac = HMAC<SHA256>.authenticationCode(for: Data(side.rawValue.utf8) + t, using: SymmetricKey(data: kConf))
        return Encoding.base64url(Data(mac))
    }

    public static func verifyConfirm(kConf: Data, peerSide: SecSide, transcriptHash t: Data, mac: String) throws {
        guard Encoding.constantTimeEqual(confirmMac(kConf: kConf, side: peerSide, transcriptHash: t), mac) else {
            throw SecFailReason.mac
        }
    }

    /// Step 1: the first `a=fingerprint:sha-256` line, as 64 lower-case hex without colons; nil when absent.
    public static func fingerprintFromSdp(_ sdp: String) -> String? {
        for raw in sdp.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" }) {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let prefix = "a=fingerprint:sha-256"
            guard line.lowercased().hasPrefix(prefix) else { continue }
            let rest = line.dropFirst(prefix.count)
            guard let first = rest.first, first == " " || first == "\t" else { continue }
            let value = rest.trimmingCharacters(in: .whitespaces)
            guard !value.isEmpty, value.allSatisfy({ $0 == ":" || $0.isHexDigit }) else { continue }
            let hex = value.replacingOccurrences(of: ":", with: "").lowercased()
            if hex.count == 64 { return hex }
        }
        return nil
    }

    /// `sasMatches` (step 7): compares the six digits the user read out, constant time, spaces ignored.
    public static func sasMatches(typed: String, sas: String) -> Bool {
        let digits = typed.filter { !$0.isWhitespace }
        func six(_ s: String) -> Bool { s.utf8.count == 6 && s.utf8.allSatisfy { $0 >= 0x30 && $0 <= 0x39 } }
        guard six(digits), six(sas) else { return false }
        return Encoding.constantTimeEqual(digits, sas)
    }
}

// MARK: - frames

public struct SecFrameParams {
    public var key: Data
    public var sessionId: String
    public var label: SecLabel
    public var gen: Int
    public var direction: SecDirection

    public init(key: Data, sessionId: String, label: SecLabel, gen: Int, direction: SecDirection) {
        self.key = key
        self.sessionId = sessionId
        self.label = label
        self.gen = gen
        self.direction = direction
    }
}

public struct DecodedSecFrame: Equatable {
    public var seq: UInt64
    public var text: Bool
    public var plaintext: Data
}

public enum SecFrame {
    /// Nonce = labelId || direction || u16be(gen) || 12 zero bytes || u64be(seq).
    public static func nonce(label: SecLabel, direction: SecDirection, gen: Int, seq: UInt64) -> Data {
        var n = Data(count: 24)
        n[0] = label.id
        n[1] = direction == .deskToAssist ? 0 : 1
        n[2] = UInt8((gen >> 8) & 0xFF)
        n[3] = UInt8(gen & 0xFF)
        n.replaceSubrange(16..<24, with: u64be(seq))
        return n
    }

    /// AAD = "ia-sec-v1" || sessionId || 0x00 || label || 0x00 || version || flags.
    public static func aad(sessionId: String, label: SecLabel, flags: UInt8) -> Data {
        Data("ia-sec-v1\(sessionId)\u{0}\(label.rawValue)\u{0}".utf8) + Data([SEC_FRAME_VERSION, flags])
    }

    public static func encode(_ p: SecFrameParams, seq: UInt64, plaintext: Data, text: Bool) throws -> Data {
        guard plaintext.count <= SEC_MAX_PLAINTEXT else { throw SecFailReason.oversize }
        let flags = text ? FLAG_TEXT : 0
        let ct = try XChaCha20Poly1305.seal(key: p.key, nonce: nonce(label: p.label, direction: p.direction, gen: p.gen, seq: seq),
                                            aad: aad(sessionId: p.sessionId, label: p.label, flags: flags), plaintext: plaintext)
        return Data([SEC_FRAME_VERSION, flags]) + u64be(seq) + ct
    }

    /// Opens one frame enforcing `seq == expectedSeq` (`replay`), the size limit (`oversize`) and the tag (`decrypt`).
    public static func decode(_ p: SecFrameParams, expectedSeq: UInt64, frame f: Data) throws -> DecodedSecFrame {
        let b = [UInt8](f)
        guard b.count >= SEC_FRAME_HEADER_BYTES + SEC_TAG_BYTES, b[0] == SEC_FRAME_VERSION else { throw SecFailReason.decrypt }
        let flags = b[1]
        guard flags & ~FLAG_TEXT == 0 else { throw SecFailReason.decrypt }
        let seq = b[2..<10].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
        guard seq == expectedSeq else { throw SecFailReason.replay }
        guard b.count - SEC_FRAME_HEADER_BYTES - SEC_TAG_BYTES <= SEC_MAX_PLAINTEXT else { throw SecFailReason.oversize }
        do {
            let pt = try XChaCha20Poly1305.open(key: p.key, nonce: nonce(label: p.label, direction: p.direction, gen: p.gen, seq: seq),
                                                aad: aad(sessionId: p.sessionId, label: p.label, flags: flags),
                                                sealed: Data(b[SEC_FRAME_HEADER_BYTES...]))
            return DecodedSecFrame(seq: seq, text: flags & FLAG_TEXT != 0, plaintext: pt)
        } catch {
            throw SecFailReason.decrypt
        }
    }

    static func u64be(_ n: UInt64) -> Data {
        Data((0..<8).map { UInt8((n >> (56 - 8 * UInt64($0))) & 0xFF) })
    }
}

// MARK: - SecChannel

/// One encrypted channel of one key generation: `seal` numbers frames from 0, `open` enforces `lastSeq + 1`.
/// A second channel for the same send key, label and gen is refused (it would reuse a nonce at seq 0).
public final class SecChannel {
    private static let lock = NSLock()
    private static var startedStreams = Set<String>()

    private var sendSeq: UInt64 = 0
    private var recvSeq: UInt64 = 0
    private let send: SecFrameParams
    private let recv: SecFrameParams

    public enum ChannelError: Error { case alreadyStarted }

    public init(side: SecSide, sessionId: String, label: SecLabel, gen: Int, kD2A: Data, kA2D: Data) throws {
        let out: SecDirection = side == .desk ? .deskToAssist : .assistToDesk
        let inn: SecDirection = side == .desk ? .assistToDesk : .deskToAssist
        let sendKey = side == .desk ? kD2A : kA2D
        let id = "\(Encoding.hex(Data(SHA256.hash(data: sendKey))))|\(label.id)|\(out.rawValue)|\(gen)"
        SecChannel.lock.lock()
        defer { SecChannel.lock.unlock() }
        guard !SecChannel.startedStreams.contains(id) else { throw ChannelError.alreadyStarted }
        SecChannel.startedStreams.insert(id)
        send = SecFrameParams(key: sendKey, sessionId: sessionId, label: label, gen: gen, direction: out)
        recv = SecFrameParams(key: side == .desk ? kA2D : kD2A, sessionId: sessionId, label: label, gen: gen, direction: inn)
    }

    public func seal(text: String) throws -> Data {
        try seal(Data(text.utf8), text: true)
    }

    public func seal(_ bytes: Data, text: Bool = false) throws -> Data {
        let f = try SecFrame.encode(send, seq: sendSeq, plaintext: bytes, text: text)
        sendSeq += 1
        return f
    }

    /// `text` is the UTF-8 decoding of a text frame, nil for a binary frame.
    public func open(_ frame: Data) throws -> (text: String?, bytes: Data) {
        let d = try SecFrame.decode(recv, expectedSeq: recvSeq, frame: frame)
        recvSeq += 1
        return (d.text ? String(decoding: d.plaintext, as: UTF8.self) : nil, d.plaintext)
    }
}
