import Foundation

/// A normalised join code (A §3.3 `normaliseTokenInput`).
public struct JoinCode: Equatable {
    public enum Kind: String { case compact, shortCode = "short_code" }
    public var kind: Kind
    public var value: String
}

/// Token entry for the iOS app (§17.4): the `indiansassist://join?t=` scheme, a QR payload, or a pasted code. No
/// universal links (they need a file on every self-hosted origin). The Swift twin of the Android `JoinInput`; nothing
/// is ever executed from the input.
public enum JoinInput {
    /// Trim; `ia1.` → compact with whitespace removed; else exactly 12 digits → short code; else nil.
    public static func normalise(_ s: String) -> JoinCode? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.hasPrefix("ia1.") {
            return JoinCode(kind: .compact, value: t.filter { !$0.isWhitespace })
        }
        let digits = t.filter { $0.isASCII && $0.isNumber }
        return digits.count == 12 ? JoinCode(kind: .shortCode, value: digits) : nil
    }

    /// `isValidShortCode`: 12 digits, the first 1-9, Luhn-valid.
    public static func isValidShortCode(_ code: String) -> Bool {
        let bytes = Array(code.utf8)
        guard bytes.count == 12, bytes.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }), bytes[0] != 0x30 else { return false }
        var sum = 0
        for (i, b) in bytes.reversed().enumerated() {
            var d = Int(b - 0x30)
            if i % 2 == 1 {
                d *= 2
                if d > 9 { d -= 9 }
            }
            sum += d
        }
        return sum % 10 == 0
    }

    /// A bare code, `https://<host>/join#t=<code>` (or `?t=`), or `indiansassist://join?t=<compact>` / `?c=<12 digits>`.
    /// Web links are accepted only from `allowedHosts` (the app's region hosts).
    public static func parseAny(_ raw: String, allowedHosts: Set<String>) -> JoinCode? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = s.lowercased()
        if lower.hasPrefix("indiansassist:") || lower.hasPrefix("http://") || lower.hasPrefix("https://") {
            return parseLink(s, allowedHosts: allowedHosts)
        }
        return normalise(s)
    }

    /// The strict link grammar (A §3.6, C §2.5 L2): the scheme link carries only `t` (compact) or `c` (short code).
    public static func parseLink(_ link: String, allowedHosts: Set<String>) -> JoinCode? {
        guard let u = URLComponents(string: link), let scheme = u.scheme?.lowercased() else { return nil }
        switch scheme {
        case "indiansassist":
            guard u.host?.lowercased() == "join", u.path.isEmpty || u.path == "/" else { return nil }
            let q = params(u.percentEncodedQuery)
            guard q.keys.allSatisfy({ $0 == "t" || $0 == "c" }) else { return nil }
            if let t = q["t"] { return normalise(t).flatMap { $0.kind == .compact ? $0 : nil } }
            if let c = q["c"] { return normalise(c).flatMap { $0.kind == .shortCode ? $0 : nil } }
            return nil
        case "https", "http":
            guard let host = u.host?.lowercased() else { return nil }
            let hostPort = u.port.map { "\(host):\($0)" } ?? host
            guard allowedHosts.contains(host) || allowedHosts.contains(hostPort) else { return nil }
            var path = u.path
            while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
            guard path == "/join" || path == "/download" else { return nil }
            guard let t = params(u.percentEncodedFragment)["t"] ?? params(u.percentEncodedQuery)["t"] else { return nil }
            return normalise(t)
        default:
            return nil
        }
    }

    /// `4821 9365 7715` for display.
    public static func formatShortCode(_ code: String) -> String {
        guard code.count == 12 else { return code }
        let a = Array(code)
        return "\(String(a[0..<4])) \(String(a[4..<8])) \(String(a[8..<12]))"
    }

    private static func params(_ raw: String?) -> [String: String] {
        guard let raw, !raw.isEmpty else { return [:] }
        var out: [String: String] = [:]
        for part in raw.split(separator: "&") where !part.isEmpty {
            let kv = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let decode = { (s: Substring) in (String(s).replacingOccurrences(of: "+", with: " ").removingPercentEncoding) ?? String(s) }
            out[decode(kv[0])] = kv.count > 1 ? decode(kv[1]) : ""
        }
        return out
    }
}
