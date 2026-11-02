/**
 * Canonical JSON (RFC 8785 / JCS subset, contracts section 5.1) and sha256 helpers (@noble/hashes).
 *
 * Rules: object keys sorted by UTF-16 code unit order, no whitespace, strings escaped exactly as
 * ECMAScript JSON.stringify does (which is the JCS escaping), integers only (non-finite, non-integer,
 * unsafe-integer and bigint values throw), `null` kept, `undefined` object properties dropped,
 * arrays keep order. Only plain objects, arrays, strings, booleans, null and safe integers are accepted.
 */
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8Encode } from './encoding.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function serialise(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`non-finite number at ${path}`);
      if (!Number.isInteger(value)) throw new CanonicalJsonError(`non-integer number at ${path}`);
      if (!Number.isSafeInteger(value)) throw new CanonicalJsonError(`unsafe integer at ${path}`);
      return String(value === 0 ? 0 : value);
    case 'bigint':
      throw new CanonicalJsonError(`bigint at ${path}`);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`unsupported ${typeof value} at ${path}`);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalJsonError(`cycle at ${path}`);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        const item: unknown = obj[i];
        if (item === undefined) throw new CanonicalJsonError(`undefined array element at ${path}[${i}]`);
        parts.push(serialise(item, `${path}[${i}]`, seen));
      }
      return `[${parts.join(',')}]`;
    }
    if (!isPlainObject(obj)) throw new CanonicalJsonError(`non-plain object at ${path}`);
    const record = obj as Record<string, unknown>;
    // Default Array.prototype.sort compares strings by UTF-16 code units, as JCS requires.
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = record[key];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${serialise(v, `${path}.${key}`, seen)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

/** Canonical JSON string of `value`. Throws CanonicalJsonError on values outside the subset. */
export function canonicalJson(value: unknown): string {
  return serialise(value, '$', new Set());
}

/** UTF-8 bytes of the canonical JSON of `value`. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return utf8Encode(canonicalJson(value));
}

/** Lower-case hex sha256 of a byte array or of the UTF-8 bytes of a string. */
export function sha256Hex(input: Uint8Array | string): string {
  return bytesToHex(sha256(typeof input === 'string' ? utf8Encode(input) : input));
}

/** Raw sha256 digest. */
export function sha256Bytes(input: Uint8Array | string): Uint8Array {
  return sha256(typeof input === 'string' ? utf8Encode(input) : input);
}

/**
 * `sha256Hex(pepper + ':' + value)`, the PII hashing rule of section 5.3. Phase F section 5.3 step 6: throws when
 * the pepper is not 64 lower-case hex (an erased org's pepper is null, and `"null:" + value` would be an
 * unpeppered, therefore linkable, hash).
 */
export function pepperedHash(pepperHex: string, value: string): string {
  if (typeof pepperHex !== 'string' || !/^[0-9a-f]{64}$/.test(pepperHex)) {
    throw new Error('pepperedHash: the pepper must be 64 lower-case hex characters');
  }
  return sha256Hex(`${pepperHex}:${value}`);
}

/**
 * Incremental sha256 (Phase C section 6.1 F2): the P3 console hashes a file of up to 2 GiB chunk by chunk from
 * `file.stream()` / `Blob.slice` without holding it in one `ArrayBuffer`.
 */
export function createSha256Hasher(): { update(chunk: Uint8Array): void; digestHex(): string } {
  const h = sha256.create();
  return {
    update: (chunk) => {
      h.update(chunk);
    },
    digestHex: () => bytesToHex(h.digest()),
  };
}
