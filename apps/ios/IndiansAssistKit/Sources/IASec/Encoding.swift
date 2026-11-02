import Foundation

/// base64url without padding, lower-case hex and constant-time comparison: the `encoding.ts` helpers.
public enum Encoding {
    public static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Strict decode: the url-safe alphabet only, no padding.
    public static func base64urlDecode(_ s: String) -> Data? {
        guard s.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let rem = b.count % 4
        if rem == 1 { return nil }
        if rem > 0 { b += String(repeating: "=", count: 4 - rem) }
        return Data(base64Encoded: b)
    }

    public static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    public static func fromHex(_ s: String) -> Data? {
        guard s.count % 2 == 0 else { return nil }
        var out = Data(capacity: s.count / 2)
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            guard let byte = UInt8(s[i..<j], radix: 16) else { return nil }
            out.append(byte)
            i = j
        }
        return out
    }

    /// Constant time over the longer input; different lengths are unequal.
    public static func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
        let n = max(a.count, b.count)
        var diff: UInt8 = a.count == b.count ? 0 : 1
        let aa = [UInt8](a), bb = [UInt8](b)
        for i in 0..<n {
            diff |= (i < aa.count ? aa[i] : 0) ^ (i < bb.count ? bb[i] : 0)
        }
        return diff == 0
    }

    public static func constantTimeEqual(_ a: String, _ b: String) -> Bool {
        constantTimeEqual(Data(a.utf8), Data(b.utf8))
    }
}
