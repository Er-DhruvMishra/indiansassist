import Foundation
import IASec

/// The P3 data channels of the iOS Desk (C §1.3), and the pure handling of what arrives on them. The broadcast
/// extension's peer creates every channel once before the first offer, as the other Desks do; an iPhone is view only,
/// so `ia.control` requests are answered `not_supported` and nothing else is driven from them.
public enum P3Channels {
    /// `P3_DATA_CHANNEL_LABELS`, in creation order.
    public static let labels = ["ia.sec", "ia.chat", "ia.annot", "ia.file", "ia.ctrl", "ia.control", "ia.playbook"]

    /// `ctl.res { ok: false, error: { code: 'not_supported' } }` for any `ia.control` request (view only, §17.4).
    public static func controlNotSupported(id: String, ts: Int64) -> JSONValue {
        .object([
            "t": .string("ctl.res"),
            "id": .string(String(id.prefix(40))),
            "ok": .bool(false),
            "error": .object(["code": .string("not_supported"),
                              "message": .string("An iPhone or iPad can only be viewed; Apple does not allow control.")]),
            "ts": .int(ts),
        ])
    }

    /// `pong` for an `ia.ctrl` `ping`.
    public static func pong(ts: Int64) -> JSONValue {
        .object(["t": .string("pong"), "ts": .int(ts)])
    }
}

/// Assist → Desk chat on `ia.chat`: each `msgId` is shown once and acknowledged once.
public struct ChatInbox {
    private var seen: Set<String> = []
    public private(set) var lines: [String] = []

    public init() {}

    /// The `chat.ack` to send for a new `chat` message, or nil for a duplicate or anything else.
    public mutating func receive(_ m: JSONValue, ts: Int64) -> JSONValue? {
        guard m["t"]?.stringValue == "chat", let id = m["msgId"]?.stringValue, id.count <= 64, seen.insert(id).inserted else {
            return nil
        }
        lines.append(String((m["text"]?.stringValue ?? "").prefix(4000)))
        return .object(["t": .string("chat.ack"), "msgId": .string(id), "ts": .int(ts)])
    }
}

/// Local SDP adjustments before `setLocalDescription` (C §1.3 message-size interop): the `m=application` section
/// advertises `a=max-message-size:131072` so a 64 KiB frame fits, as the Rust agent sets it and the Android host munges it.
public enum SdpMunge {
    public static let maxMessageSize = 131_072

    public static func withMaxMessageSize(_ sdp: String, size: Int = maxMessageSize) -> String {
        let eol = sdp.contains("\r\n") ? "\r\n" : "\n"
        var lines = sdp.components(separatedBy: eol)
        guard let app = lines.firstIndex(where: { $0.hasPrefix("m=application") }) else { return sdp }
        var end = lines[(app + 1)...].firstIndex(where: { $0.hasPrefix("m=") }) ?? lines.count
        if end == lines.count, lines.last == "" { end = lines.count - 1 }
        let line = "a=max-message-size:\(size)"
        if let existing = lines[(app + 1)..<end].firstIndex(where: { $0.hasPrefix("a=max-message-size:") }) {
            lines[existing] = line
        } else {
            let anchor = lines[(app + 1)..<end].firstIndex(where: { $0.hasPrefix("a=sctp-port:") }) ?? (end - 1)
            lines.insert(line, at: anchor + 1)
        }
        return lines.joined(separator: eol)
    }
}
