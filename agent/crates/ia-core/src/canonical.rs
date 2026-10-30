//! Canonical JSON (contract "A §5.1 canonical JSON"), used by the §1.3 transcript
//! hash and the commit hash, and by the signed-sidecar signing input (§2.4).
//!
//! Definition (this crate is the current authority until the shared TS `canonicalJson`
//! lands — see agent/README.md): compact JSON (no insignificant whitespace), object
//! members emitted in ascending key order. Keys are compared by Unicode scalar value;
//! every key in the Phase C payloads is ASCII, so this matches a JavaScript
//! `Array.prototype.sort()` over the same keys byte-for-byte. Arrays keep their order.
//! Numbers are integers in these payloads and are emitted by `serde_json`'s formatter.

use serde_json::{Map, Value};

/// Serialise a [`serde_json::Value`] to its canonical JSON string.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

/// Parse `text` as JSON and re-emit it canonically. Returns `None` on invalid JSON.
pub fn canonicalize_str(text: &str) -> Option<String> {
    let v: Value = serde_json::from_str(text).ok()?;
    Some(canonical_json(&v))
}

fn write_value(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => write_object(map, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        // serde_json renders strings, numbers, bools and null canonically for our
        // integer-only payloads; reuse it rather than re-implementing escaping.
        other => out.push_str(&serde_json::to_string(other).expect("scalar serialises")),
    }
}

fn write_object(map: &Map<String, Value>, out: &mut String) {
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort_unstable();
    out.push('{');
    for (i, key) in keys.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&serde_json::to_string(key).expect("key serialises"));
        out.push(':');
        write_value(&map[*key], out);
    }
    out.push('}');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sorts_object_keys_and_strips_whitespace() {
        let v = json!({ "b": 1, "a": 2, "c": { "z": 1, "a": 2 } });
        assert_eq!(canonical_json(&v), r#"{"a":2,"b":1,"c":{"a":2,"z":1}}"#);
    }

    #[test]
    fn preserves_array_order() {
        let v = json!({ "xs": [3, 1, 2], "s": "hi" });
        assert_eq!(canonical_json(&v), r#"{"s":"hi","xs":[3,1,2]}"#);
    }

    #[test]
    fn escapes_strings_like_json() {
        let v = json!({ "k": "a\"b\n" });
        assert_eq!(canonical_json(&v), r#"{"k":"a\"b\n"}"#);
    }

    #[test]
    fn round_trips_through_string_helper() {
        let s = r#"{ "epk": "AAAA", "side": "desk", "suite": "x", "fpr": "ff" }"#;
        assert_eq!(
            canonicalize_str(s).unwrap(),
            r#"{"epk":"AAAA","fpr":"ff","side":"desk","suite":"x"}"#
        );
    }
}
