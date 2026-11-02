import Foundation

/// A JSON value in the canonical subset of `packages/shared/src/canonical.ts`: integers only, no floats.
public indirect enum JSONValue: Equatable {
    case null
    case bool(Bool)
    case int(Int64)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public subscript(key: String) -> JSONValue? {
        if case let .object(o) = self { return o[key] }
        return nil
    }

    public var stringValue: String? {
        if case let .string(s) = self { return s }
        return nil
    }

    public var intValue: Int64? {
        if case let .int(n) = self { return n }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case let .object(o) = self { return o }
        return nil
    }

    /// Parses JSON text; nil when it is not JSON or holds a non-integer or unsafe number.
    public static func parse(_ text: String) -> JSONValue? {
        guard let data = text.data(using: .utf8),
              let any = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return nil }
        return from(any)
    }

    static func from(_ any: Any) -> JSONValue? {
        switch any {
        case is NSNull:
            return .null
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
            let d = n.doubleValue
            guard d.isFinite, d == d.rounded(), abs(d) <= 9_007_199_254_740_991 else { return nil }
            return .int(n.int64Value)
        case let s as String:
            return .string(s)
        case let a as [Any]:
            var out: [JSONValue] = []
            for item in a {
                guard let v = from(item) else { return nil }
                out.append(v)
            }
            return .array(out)
        case let o as [String: Any]:
            var out: [String: JSONValue] = [:]
            for (k, v) in o {
                guard let jv = from(v) else { return nil }
                out[k] = jv
            }
            return .object(out)
        default:
            return nil
        }
    }
}

/// RFC 8785 subset: keys sorted by UTF-16 code units, no whitespace, strings escaped as `JSON.stringify` does.
public enum CanonicalJSON {
    public static func string(_ value: JSONValue) -> String {
        var out = ""
        write(value, into: &out)
        return out
    }

    public static func bytes(_ value: JSONValue) -> Data {
        Data(string(value).utf8)
    }

    private static func write(_ value: JSONValue, into out: inout String) {
        switch value {
        case .null: out += "null"
        case let .bool(b): out += b ? "true" : "false"
        case let .int(n): out += String(n)
        case let .string(s): quote(s, into: &out)
        case let .array(a):
            out += "["
            for (i, v) in a.enumerated() {
                if i > 0 { out += "," }
                write(v, into: &out)
            }
            out += "]"
        case let .object(o):
            out += "{"
            let keys = o.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
            for (i, k) in keys.enumerated() {
                if i > 0 { out += "," }
                quote(k, into: &out)
                out += ":"
                write(o[k]!, into: &out)
            }
            out += "}"
        }
    }

    private static func quote(_ s: String, into out: inout String) {
        out += "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if u.value < 0x20 {
                    out += String(format: "\\u%04x", u.value)
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        out += "\""
    }
}
