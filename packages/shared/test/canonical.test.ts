import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError,
  base64Decode,
  base64Encode,
  base64urlDecode,
  base64urlEncode,
  canonicalJson,
  constantTimeEqual,
  hexToBytes,
  pepperedHash,
  sha256Hex,
  utf8Encode,
} from '../src/index.js';

describe('canonicalJson', () => {
  it('sorts keys and removes whitespace', () => {
    expect(canonicalJson({ b: 2, a: 1, c: { z: true, y: null } })).toBe('{"a":1,"b":2,"c":{"y":null,"z":true}}');
  });

  it('is deterministic regardless of insertion order', () => {
    const a = { x: [3, 2, 1], m: { q: 'q', p: 'p' }, k: null };
    const b = { k: null, m: { p: 'p', q: 'q' }, x: [3, 2, 1] };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('orders keys by UTF-16 code units (RFC 8785 3.2.3 vector)', () => {
    const v = {
      '\u20AC': 'Euro Sign',
      '\r': 'Carriage Return',
      '\uFB33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\uD83D\uDE00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00F6': 'Latin Small Letter O With Diaeresis',
    };
    expect(canonicalJson(v)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00F6":"Latin Small Letter O With Diaeresis",' +
        '"\u20AC":"Euro Sign","\uD83D\uDE00":"Emoji: Grinning Face","\uFB33":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it('escapes strings minimally', () => {
    expect(canonicalJson('a"b\\c\n\t\b\f\r\u0001\u001f')).toBe('"a\\"b\\\\c\\n\\t\\b\\f\\r\\u0001\\u001f"');
    expect(canonicalJson('/ \u00E9 \u20AC')).toBe('"/ \u00E9 \u20AC"');
  });

  it('keeps null, drops undefined properties, keeps array order', () => {
    expect(canonicalJson({ a: undefined, b: null, c: [2, 1] })).toBe('{"b":null,"c":[2,1]}');
  });

  it('rejects non-integers, non-finite numbers, bigint, undefined array items and non-plain objects', () => {
    expect(() => canonicalJson({ n: 1.5 })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(2 ** 60)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(BigInt(1))).toThrow(CanonicalJsonError);
    expect(() => canonicalJson([undefined])).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Date(0))).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Uint8Array(1))).toThrow(CanonicalJsonError);
  });

  it('serialises -0 as 0 and rejects cycles', () => {
    expect(canonicalJson(-0)).toBe('0');
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => canonicalJson(cyc)).toThrow(CanonicalJsonError);
  });

  it('matches an independently computed vector (Python json.dumps sort_keys) and its sha256', () => {
    const material = {
      action: 'session.started',
      actor: { id: null, label: 'system', type: 'system' },
      data: { path: 'p2p' },
      org_id: '11111111-2222-4333-8444-555555555555',
      prev_hash: '0'.repeat(64),
      reason: null,
      region: 'in-mum',
      seq: 1,
      session_id: null,
      ts: '2026-10-23T10:15:30.123Z',
    };
    const expected =
      '{"action":"session.started","actor":{"id":null,"label":"system","type":"system"},"data":{"path":"p2p"},' +
      '"org_id":"11111111-2222-4333-8444-555555555555","prev_hash":"' +
      '0'.repeat(64) +
      '","reason":null,"region":"in-mum","seq":1,"session_id":null,"ts":"2026-10-23T10:15:30.123Z"}';
    expect(canonicalJson(material)).toBe(expected);
    expect(sha256Hex(canonicalJson(material))).toBe('9d2deadaffdb5013dd99855092e2316e41650bc8c1237c12b2737ff714b662fd');
  });
});

describe('sha256Hex and encodings', () => {
  it('matches known sha256 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(utf8Encode('abc'))).toBe(sha256Hex('abc'));
  });

  it('peppered hash is sha256(pepper:value)', () => {
    expect(pepperedHash('ab', 'x')).toBe(sha256Hex('ab:x'));
  });

  it('base64url round trips and is strict', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(base64urlDecode(base64urlEncode(bytes))).toEqual(bytes);
      expect(base64Decode(base64Encode(bytes))).toEqual(bytes);
    }
    expect(base64urlEncode(hexToBytes('fbff'))).toBe('-_8');
    expect(() => base64urlDecode('ab=')).toThrow();
    expect(() => base64urlDecode('a')).toThrow();
    expect(() => base64urlDecode('AB')).toThrow(); // non-canonical trailing bits
    expect(() => base64urlDecode('a+b/')).toThrow();
  });

  it('constantTimeEqual compares without throwing on length mismatch', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});
