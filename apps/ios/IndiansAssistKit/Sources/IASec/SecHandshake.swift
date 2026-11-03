import CryptoKit
import Foundation

/// Phase C section 1.3 handshake driver, the Swift twin of `packages/shared/src/agent/sec-handshake.ts`, the Rust
/// `ia_core::sec` driver and the Kotlin `SecHandshake`. Commit first, hello only once the peer's commit is held,
/// confirm after both hellos, `established` once the own confirm was sent and the peer's verified. Every order or
/// shape violation is `commit`, an unknown suite or version `suite`; any `sec.fail` received ends the handshake.
/// Not thread-safe: drive it from one queue (the extension's signalling queue).
public final class SecHandshake {
    public enum State: Equatable { case idle, committed, confirming, established, failed }

    public struct Established {
        public let sas: String
        public let gen: Int
        public let kD2A: Data
        public let kA2D: Data
    }

    public struct Options {
        public var side: SecSide
        public var sessionId: String
        /// Key generation of this peer connection (0, then +1 per rebuild).
        public var gen: Int
        /// Own and remote `a=fingerprint:sha-256` of the current descriptions, 64 lower-case hex.
        public var ownFpr: String
        public var remoteFpr: String
        /// Sends one `ia.sec` message (its `text` is the JSON on the handshake channel).
        public var send: (SecMessage) -> Void
        /// Injectable for test vectors: a fixed 32-byte X25519 private key.
        public var esk: Data?
        public var now: () -> Int64
        /// Where the 10 s timeout (step 8) is armed; nil disables it.
        public var timerQueue: DispatchQueue?

        public init(side: SecSide, sessionId: String, gen: Int, ownFpr: String, remoteFpr: String,
                    send: @escaping (SecMessage) -> Void, esk: Data? = nil,
                    now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                    timerQueue: DispatchQueue? = .main) {
            self.side = side
            self.sessionId = sessionId
            self.gen = gen
            self.ownFpr = ownFpr
            self.remoteFpr = remoteFpr
            self.send = send
            self.esk = esk
            self.now = now
            self.timerQueue = timerQueue
        }
    }

    public private(set) var state: State = .idle
    public private(set) var failReason: SecFailReason?
    public private(set) var result: Established?
    public var onEstablished: ((Established) -> Void)?
    /// `sent` is true when this side sent the `sec.fail`.
    public var onFailed: ((SecFailReason, _ sent: Bool) -> Void)?

    private let o: Options
    private var esk: Data
    public let epk: String
    private let ownH: String
    private var peerH: String?
    private var peerHello: SecHello?
    private var helloSent = false
    private var confirmSent = false
    private var peerConfirmed = false
    private var transcript: Data?
    private var kConf: Data?
    private var timer: DispatchWorkItem?
    private var channels: [SecLabel: SecChannel] = [:]

    public init(_ o: Options) throws {
        self.o = o
        let key = try o.esk.map { try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: $0) }
            ?? Curve25519.KeyAgreement.PrivateKey()
        esk = key.rawRepresentation
        epk = Encoding.base64url(key.publicKey.rawRepresentation)
        ownH = SecCrypto.commitHash(side: o.side, suite: SEC_SUITE, epk: epk, fpr: o.ownFpr)
    }

    /// Step 2a: sends the commit and arms the timeout.
    public func start() {
        guard state == .idle else { return }
        state = .committed
        o.send(.commit(sessionId: o.sessionId, side: o.side, h: ownH, gen: o.gen, ts: o.now()))
        if let q = o.timerQueue {
            let item = DispatchWorkItem { [weak self] in self?.fail(.timeout) }
            timer = item
            q.asyncAfter(deadline: .now() + .milliseconds(SEC_HANDSHAKE_TIMEOUT_MS), execute: item)
        }
        maybeHello()
    }

    /// Feeds one message received on `ia.sec` (the JSON text).
    public func receive(_ text: String) {
        guard let v = JSONValue.parse(text) else {
            if state != .failed { fail(.commit) }
            return
        }
        receive(v)
    }

    public func receive(_ v: JSONValue) {
        if state == .failed { return }
        if state == .established { return fail(.commit) }
        if v["t"]?.stringValue == "sec.fail" {
            let reason = v["reason"]?.stringValue.flatMap(SecFailReason.init(rawValue:)) ?? .commit
            return failed(reason, sent: false)
        }
        if v["t"]?.stringValue == "sec.hello", v["v"] != .int(1) { return fail(.suite) }
        guard let m = SecMessage.parse(v) else { return fail(.commit) }
        do {
            try handle(m)
        } catch let r as SecFailReason {
            fail(r)
        } catch {
            fail(.commit)
        }
    }

    private func handle(_ m: SecMessage) throws {
        switch m {
        case let .commit(sessionId, side, h, gen, _):
            guard peerH == nil, sessionId == o.sessionId, side == o.side.peer, gen == o.gen else { throw SecFailReason.commit }
            peerH = h
            maybeHello()
        case let .hello(hello):
            guard hello.suite == SEC_SUITE else { throw SecFailReason.suite }
            guard let committed = peerH, peerHello == nil, hello.sessionId == o.sessionId, hello.side == o.side.peer else {
                throw SecFailReason.commit
            }
            try SecCrypto.verifyHello(hello, committedH: committed)
            try SecCrypto.verifyPeerFingerprint(hello.fpr, observed: o.remoteFpr)
            peerHello = hello
            try derive()
        case let .confirm(mac, _):
            guard let k = kConf, let t = transcript, !peerConfirmed else { throw SecFailReason.commit }
            try SecCrypto.verifyConfirm(kConf: k, peerSide: o.side.peer, transcriptHash: t, mac: mac)
            peerConfirmed = true
            maybeEstablished()
        case .fail:
            return
        }
    }

    private func maybeHello() {
        guard !helloSent, state == .committed, peerH != nil else { return }
        helloSent = true
        o.send(.hello(SecHello(sessionId: o.sessionId, side: o.side, suite: SEC_SUITE, epk: epk, fpr: o.ownFpr, ts: o.now())))
    }

    private func derive() throws {
        guard let peer = peerHello, let theirH = peerH else { throw SecFailReason.commit }
        var ss = try SecCrypto.sharedSecret(esk: esk, peerEpk: peer.epk)
        let own = SecCrypto.SideInfo(h: ownH, epk: epk, fpr: o.ownFpr)
        let theirs = SecCrypto.SideInfo(h: theirH, epk: peer.epk, fpr: peer.fpr)
        let t = SecCrypto.transcriptHash(sessionId: o.sessionId, suite: SEC_SUITE, gen: o.gen,
                                         desk: o.side == .desk ? own : theirs, assist: o.side == .assist ? own : theirs)
        var keys = SecCrypto.deriveKeys(ss: ss, transcriptHash: t)
        transcript = t
        kConf = keys.kConf
        result = Established(sas: keys.sas, gen: o.gen, kD2A: keys.kD2A, kA2D: keys.kA2D)
        ss.resetBytes(in: 0..<ss.count)
        keys.prk.resetBytes(in: 0..<keys.prk.count)
        esk.resetBytes(in: 0..<esk.count)
        state = .confirming
        confirmSent = true
        o.send(.confirm(mac: SecCrypto.confirmMac(kConf: keys.kConf, side: o.side, transcriptHash: t), ts: o.now()))
        maybeEstablished()
    }

    private func maybeEstablished() {
        guard confirmSent, peerConfirmed, state != .established, let r = result else { return }
        state = .established
        timer?.cancel()
        kConf = kConf.map { var k = $0; k.resetBytes(in: 0..<k.count); return k }
        onEstablished?(r)
    }

    /// Sends `sec.fail { reason }` and ends the handshake (step 9: the caller tears down and ends the session).
    public func fail(_ reason: SecFailReason) {
        guard state != .failed else { return }
        o.send(.fail(reason: reason, ts: o.now()))
        failed(reason, sent: true)
    }

    private func failed(_ reason: SecFailReason, sent: Bool) {
        guard state != .failed else { return }
        state = .failed
        failReason = reason
        timer?.cancel()
        esk.resetBytes(in: 0..<esk.count)
        onFailed?(reason, sent)
    }

    /// The `SecChannel` of an encrypted label for this key generation (one per label, created on first use).
    public func channel(_ label: SecLabel) throws -> SecChannel {
        guard state == .established, let r = result else { throw SecFailReason.channel }
        if let c = channels[label] { return c }
        let c = try SecChannel(side: o.side, sessionId: o.sessionId, label: label, gen: o.gen, kD2A: r.kD2A, kA2D: r.kA2D)
        channels[label] = c
        return c
    }

    public func dispose() {
        timer?.cancel()
        esk.resetBytes(in: 0..<esk.count)
        kConf = kConf.map { var k = $0; k.resetBytes(in: 0..<k.count); return k }
        channels.removeAll()
    }
}
