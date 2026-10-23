import { describe, expect, it } from 'vitest';
import {
  base64urlDecode,
  base64urlEncode,
  bytesToHex,
  checkToken,
  formatShortCode,
  generateShortCode,
  isTokenTimeValid,
  isValidShortCode,
  kidOf,
  luhnCheckDigit,
  normaliseTokenInput,
  parseToken,
  publicKeyEntry,
  publicKeyFromSeed,
  signToken,
  utf8Decode,
  utf8Encode,
  verifyTokenSignature,
} from '../src/index.js';

// RFC 8032 section 7.1 TEST 1.
const RFC_SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const RFC_PUB = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const OTHER_SEED = '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb';

const NOW = 1_761_220_000;
const base = {
  tid: '0b0c7e1e-8f0e-4c3e-9a4e-1f2d3c4b5a69',
  org: '11111111-2222-4333-8444-555555555555',
  by: '66666666-7777-4888-9999-aaaaaaaaaaaa',
  tier: 'p1_browser' as const,
  typ: 'one_time' as const,
  reg: 'in-mum' as const,
  iat: NOW,
  exp: NOW + 900,
};

async function keys(seed = RFC_SEED) {
  return [publicKeyEntry(await publicKeyFromSeed(seed))];
}

describe('keys', () => {
  it('derives the RFC 8032 public key and its kid', async () => {
    const pub = await publicKeyFromSeed(RFC_SEED);
    expect(bytesToHex(pub)).toBe(RFC_PUB);
    expect(kidOf(pub)).toBe('21fe31dfa154a261');
    expect(publicKeyEntry('11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo').kid).toBe('21fe31dfa154a261');
  });

  it('rejects a bad seed', async () => {
    await expect(publicKeyFromSeed('abc')).rejects.toThrow();
  });
});

describe('token round trip', () => {
  it('signs, parses and verifies', async () => {
    const signed = await signToken(base, RFC_SEED);
    expect(signed.compact.startsWith(`ia1.${signed.kid}.`)).toBe(true);
    expect(signed.compact.split('.')).toHaveLength(4);
    expect(signed.kid).toBe('21fe31dfa154a261');
    expect(signed.payload).toMatchObject({ v: 1, ...base });
    expect(base64urlDecode(signed.payload.nonce)).toHaveLength(16);

    const parsed = parseToken(signed.compact);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.payload).toEqual(signed.payload);
    expect(parsed.signature).toBe(signed.signature);
    expect(await verifyTokenSignature(parsed, await keys())).toBe(true);
    expect(await checkToken(signed.compact, await keys(), NOW + 10)).toEqual({
      ok: true,
      kid: signed.kid,
      payload: signed.payload,
    });
  });

  it('gives two tokens with identical fields distinct nonces', async () => {
    const a = await signToken(base, RFC_SEED);
    const b = await signToken(base, RFC_SEED);
    expect(a.payload.nonce).not.toBe(b.payload.nonce);
    expect(a.compact).not.toBe(b.compact);
  });

  it('refuses to sign an invalid payload', async () => {
    await expect(signToken({ ...base, tier: 'p9' as never }, RFC_SEED)).rejects.toThrow();
  });
});

describe('tamper detection', () => {
  it('detects a modified payload with a valid structure', async () => {
    const signed = await signToken(base, RFC_SEED);
    const [p, k, , s] = signed.compact.split('.');
    const forged = { ...signed.payload, tier: 'p4_installed' };
    const keysSorted = Object.keys(forged).sort();
    const json = `{${keysSorted.map((key) => `${JSON.stringify(key)}:${JSON.stringify((forged as Record<string, unknown>)[key])}`).join(',')}}`;
    const tampered = `${p}.${k}.${base64urlEncode(utf8Encode(json))}.${s}`;
    const parsed = parseToken(tampered);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(await verifyTokenSignature(parsed, await keys())).toBe(false);
    expect(await checkToken(tampered, await keys(), NOW)).toEqual({ ok: false, error: 'token_bad_signature' });
  });

  it('detects a modified signature', async () => {
    const signed = await signToken(base, RFC_SEED);
    const sig = base64urlDecode(signed.signature);
    sig[0] = sig[0]! ^ 1;
    const tampered = signed.compact.replace(signed.signature, base64urlEncode(sig));
    expect(await checkToken(tampered, await keys(), NOW)).toEqual({ ok: false, error: 'token_bad_signature' });
  });

  it('rejects malformed tokens (steps 1-2)', async () => {
    const signed = await signToken(base, RFC_SEED);
    const [, k, payload, s] = signed.compact.split('.');
    const bad = [
      '',
      'ia1.abc',
      `ia2.${k}.${payload}.${s}`,
      `ia1.${k!.toUpperCase()}.${payload}.${s}`,
      `ia1.${k}x.${payload}.${s}`,
      `ia1.${k}.${payload}.${s}.extra`,
      `ia1.${k}.${payload}=.${s}`,
      `ia1.${k}.!!!.${s}`,
      `ia1.${k}.${base64urlEncode(utf8Encode('not json'))}.${s}`,
      `ia1.${k}.${payload}.`,
    ];
    for (const t of bad) expect(parseToken(t)).toEqual({ ok: false, error: 'token_malformed' });
  });

  it('rejects non-canonical payload bytes and extra or missing fields', async () => {
    const signed = await signToken(base, RFC_SEED);
    const [p, k, payloadPart, s] = signed.compact.split('.');
    const json = utf8Decode(base64urlDecode(payloadPart!));
    const spaced = json.replace(':', ': ');
    const obj = JSON.parse(json) as Record<string, unknown>;
    const extra = { ...obj, zz: 1 };
    const missing = { ...obj };
    delete missing.nonce;
    const enc = (v: unknown) => base64urlEncode(utf8Encode(typeof v === 'string' ? v : JSON.stringify(v)));
    for (const variant of [spaced, extra, missing, { ...obj, v: 2 }, { ...obj, iat: 1.5 }]) {
      expect(parseToken(`${p}.${k}.${enc(variant)}.${s}`)).toEqual({ ok: false, error: 'token_malformed' });
    }
  });
});

describe('expiry', () => {
  it('enforces iat <= now + 60 and now < exp', async () => {
    expect(isTokenTimeValid(base, NOW)).toBe(true);
    expect(isTokenTimeValid(base, NOW + 899)).toBe(true);
    expect(isTokenTimeValid(base, NOW + 900)).toBe(false);
    expect(isTokenTimeValid(base, NOW - 60)).toBe(true);
    expect(isTokenTimeValid(base, NOW - 61)).toBe(false);
    const signed = await signToken(base, RFC_SEED);
    expect(await checkToken(signed.compact, await keys(), NOW + 901)).toEqual({
      ok: false,
      error: 'token_gone',
      status: 'expired',
    });
  });
});

describe('wrong key rejection', () => {
  it('fails with a different key under the same kid, and with an unknown kid', async () => {
    const signed = await signToken(base, RFC_SEED);
    const parsed = parseToken(signed.compact);
    if (!parsed.ok) throw new Error('parse failed');
    const other = await publicKeyFromSeed(OTHER_SEED);
    expect(await verifyTokenSignature(parsed, [{ kid: signed.kid, pub: other }])).toBe(false);
    expect(await verifyTokenSignature(parsed, await keys(OTHER_SEED))).toBe(false);
    expect(await verifyTokenSignature(parsed, [])).toBe(false);
    expect(await verifyTokenSignature(parsed, [{ kid: signed.kid, pub: 'garbage' }])).toBe(false);
  });

  it('verifies against a rotated key set including base64url keys', async () => {
    const signed = await signToken(base, OTHER_SEED);
    const parsed = parseToken(signed.compact);
    if (!parsed.ok) throw new Error('parse failed');
    const otherPub = await publicKeyFromSeed(OTHER_SEED);
    const set = [...(await keys()), { kid: kidOf(otherPub), pub: base64urlEncode(otherPub) }];
    expect(await verifyTokenSignature(parsed, set)).toBe(true);
  });
});

describe('normaliseTokenInput', () => {
  it('recognises compact tokens and short codes per section 3.3', () => {
    expect(normaliseTokenInput('  ia1.abc.\n def.ghi ')).toEqual({ kind: 'compact', value: 'ia1.abc.def.ghi' });
    expect(normaliseTokenInput('4821 9365 7710')).toEqual({ kind: 'short_code', value: '482193657710' });
    expect(normaliseTokenInput('4821-9365-7710')).toEqual({ kind: 'short_code', value: '482193657710' });
    expect(normaliseTokenInput('12345')).toBeNull();
    expect(normaliseTokenInput('hello')).toBeNull();
    expect(normaliseTokenInput('4821 9365 77101')).toBeNull();
  });
});

describe('short code check digit', () => {
  it('generates valid 12-digit codes with a leading non-zero digit', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateShortCode();
      expect(code).toMatch(/^[1-9]\d{11}$/);
      expect(isValidShortCode(code)).toBe(true);
    }
  });

  it('computes the Luhn digit (known vector 7992739871 -> 3)', () => {
    expect(luhnCheckDigit('7992739871')).toBe(3);
  });

  it('detects every single-digit typo and adjacent transposition', () => {
    const code = generateShortCode(() => Uint8Array.from({ length: 32 }, (_, i) => (i * 53 + 7) % 250));
    expect(isValidShortCode(code)).toBe(true);
    for (let i = 0; i < 12; i++) {
      for (let d = 0; d <= 9; d++) {
        const ch = String(d);
        if (ch === code[i]) continue;
        const typo = code.slice(0, i) + ch + code.slice(i + 1);
        expect(isValidShortCode(typo)).toBe(false);
      }
    }
    for (let i = 0; i < 11; i++) {
      const a = code[i]!;
      const b = code[i + 1]!;
      if (a === b || (a === '0' && b === '9') || (a === '9' && b === '0')) continue;
      const swapped = code.slice(0, i) + b + a + code.slice(i + 2);
      expect(isValidShortCode(swapped)).toBe(false);
    }
  });

  it('rejects wrong shapes and formats for display', () => {
    expect(isValidShortCode('012345678903')).toBe(false);
    expect(isValidShortCode('1234')).toBe(false);
    expect(isValidShortCode('4821 9365 7710')).toBe(false);
    expect(formatShortCode('482193657710')).toBe('4821 9365 7710');
    expect(() => formatShortCode('48219365771')).toThrow();
  });
});
