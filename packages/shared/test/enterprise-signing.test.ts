/**
 * Phase E section 6.3: the residency report signature. The vector (`fixtures/enterprise/residency-signature.json`,
 * fixed seeds), `verifyResidencyReport` ok / unknown kid / any changed byte / missing signature / an unknown extra
 * top-level field added after signing (proving verification is over the raw JSON, not a stripped parse), and a
 * report signed by a retired key verifying with the well-known list.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RESIDENCY_SIG_DOMAIN,
  bytesToHex,
  canonicalJson,
  residencyReportSchema,
  residencySignatureSchema,
  residencySigningInput,
  sha256Hex,
  signResidencyReport,
  utf8Decode,
  verifyBytesSync,
  verifyResidencyReport,
  type PublicKeyLike,
} from '../src/index.js';

type Key = { seedHex: string; kid: string; pub: string };
type Fixture = {
  key: Key;
  retiredKey: Key;
  report: Record<string, unknown>;
  signingInputPrefixHex: string;
  signingInputSha256: string;
  sig: string;
  signed: Record<string, unknown> & { signature: Record<string, unknown> };
  signedByRetired: Record<string, unknown> & { signature: Record<string, unknown> };
};

const fx = JSON.parse(readFileSync(new URL('./fixtures/enterprise/residency-signature.json', import.meta.url), 'utf8')) as Fixture;
const current: PublicKeyLike = { kid: fx.key.kid, pub: fx.key.pub };
const retired: PublicKeyLike = { kid: fx.retiredKey.kid, pub: fx.retiredKey.pub };
/** The well-known list after a rotation: the current key first, the retired key still published (6.3d). */
const wellKnown = [current, retired];

/** A deep copy through JSON, as a verifier holding the file would see it. */
const raw = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('residency signing input and vector (6.3b, 6.3d)', () => {
  it('is utf8("ia-residency-v1\\n") followed by the canonical JSON of the report without signature', () => {
    const input = residencySigningInput(fx.report);
    const text = utf8Decode(input);
    expect(text.startsWith(`${RESIDENCY_SIG_DOMAIN}\n{`)).toBe(true);
    expect(text.slice(RESIDENCY_SIG_DOMAIN.length + 1)).toBe(canonicalJson(fx.report));
    expect(bytesToHex(input.slice(0, 16))).toBe(fx.signingInputPrefixHex);
    expect(sha256Hex(input)).toBe(fx.signingInputSha256);
    // The signature member never takes part.
    expect(sha256Hex(residencySigningInput(fx.signed))).toBe(fx.signingInputSha256);
  });

  it('signing with the fixed seed reproduces the vector signature (pure Ed25519 over the whole input)', async () => {
    const signed = await signResidencyReport(fx.report, fx.key.seedHex, fx.key.kid);
    expect(residencySignatureSchema.safeParse(signed.signature).success).toBe(true);
    expect(signed.signature).toMatchObject({
      alg: 'Ed25519',
      domain: 'ia-residency-v1',
      kid: fx.key.kid,
      pub: fx.key.pub,
      sig: fx.sig,
      sha256: fx.signingInputSha256,
    });
    expect(fx.signed.signature.sig).toBe(fx.sig);
    // The signature is over the input itself, not over its sha256 (6.3b).
    expect(verifyBytesSync(residencySigningInput(fx.report), fx.sig, fx.key.kid, [current])).toBe(true);
    const digest = new TextEncoder().encode(fx.signingInputSha256);
    expect(verifyBytesSync(digest, fx.sig, fx.key.kid, [current])).toBe(false);
    // A report signature is never a valid checkpoint-style signature over bare canonical JSON.
    expect(verifyBytesSync(new TextEncoder().encode(canonicalJson(fx.report)), fx.sig, fx.key.kid, [current])).toBe(false);
  });

  it('replaces a signature the report already carries and leaves the input untouched', async () => {
    const again = await signResidencyReport(fx.signed, fx.key.seedHex, fx.key.kid);
    expect(again.signature.sig).toBe(fx.sig);
    expect(Object.keys(again).filter((k) => k === 'signature')).toHaveLength(1);
    expect(fx.report.signature).toBeUndefined();
  });

  it('refuses a kid that does not belong to the seed', async () => {
    await expect(signResidencyReport(fx.report, fx.key.seedHex, fx.retiredKey.kid)).rejects.toThrow(/kid/);
  });

  it('the signed vector still parses as a ResidencyReport', () => {
    expect(residencyReportSchema.safeParse(fx.signed).success).toBe(true);
  });
});

describe('verifyResidencyReport (6.3c)', () => {
  it('ok against the current key, and against the well-known list', () => {
    expect(verifyResidencyReport(raw(fx.signed), [current])).toEqual({ ok: true });
    expect(verifyResidencyReport(raw(fx.signed), wellKnown)).toEqual({ ok: true });
  });

  it('a report signed by a retired key verifies while the retired key stays listed, and not once it is removed', () => {
    expect(fx.signedByRetired.signature.kid).toBe(fx.retiredKey.kid);
    expect(verifyResidencyReport(raw(fx.signedByRetired), wellKnown)).toEqual({ ok: true });
    expect(verifyResidencyReport(raw(fx.signedByRetired), [current])).toEqual({ ok: false, cause: 'unknown_kid' });
  });

  it('unknown kid: the key is looked up by kid, never taken from signature.pub', () => {
    expect(verifyResidencyReport(raw(fx.signed), [retired])).toEqual({ ok: false, cause: 'unknown_kid' });
    expect(verifyResidencyReport(raw(fx.signed), [])).toEqual({ ok: false, cause: 'unknown_kid' });
    // A forger signing with their own key and naming it in `pub` gains nothing.
    const forged = raw(fx.signedByRetired);
    forged.signature.kid = fx.key.kid;
    expect(verifyResidencyReport(forged, wellKnown)).toEqual({ ok: false, cause: 'bad_signature' });
  });

  it('any changed byte of the signed content fails', () => {
    const json = JSON.stringify(fx.signed);
    const report = raw(fx.signed) as unknown as Record<string, unknown> & {
      org: { name: string };
      counts: { users: number };
      retention: { recordings: string };
      dataFlows: { leavesRegion: string }[];
    };
    const variants: Record<string, unknown>[] = [];
    variants.push({ ...report, org: { ...report.org, name: `${report.org.name} ` } });
    variants.push({ ...report, counts: { ...report.counts, users: report.counts.users + 1 } });
    variants.push({ ...report, retention: { ...report.retention, recordings: 'until deleted by an org_admin' } });
    variants.push({ ...report, dataFlows: [{ ...report.dataFlows[0]!, leavesRegion: 'yes' }] });
    variants.push({ ...report, generatedAt: '2026-11-02T10:00:00.001Z' });
    // Removing a signed member is a change too.
    const { statement: _s, ...noStatement } = report;
    variants.push(noStatement);
    for (const v of variants) expect(verifyResidencyReport(v, wellKnown)).toEqual({ ok: false, cause: 'bad_signature' });
    // Re-serialising (whitespace, key order) changes no signed byte: the canonical form is what is signed.
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(json) as object).reverse()), null, 2)) as unknown;
    expect(verifyResidencyReport(reordered, wellKnown)).toEqual({ ok: true });
  });

  it('a changed signature, sha256 or pub fails', () => {
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    const bad = (patch: Record<string, unknown>) => {
      const r = raw(fx.signed);
      return verifyResidencyReport({ ...r, signature: { ...r.signature, ...patch } }, wellKnown);
    };
    expect(bad({ sig: flip(fx.sig) })).toEqual({ ok: false, cause: 'bad_signature' });
    expect(bad({ sha256: 'f'.repeat(64) })).toEqual({ ok: false, cause: 'bad_signature' });
    expect(bad({ pub: fx.retiredKey.pub })).toEqual({ ok: false, cause: 'bad_signature' });
    expect(bad({ sig: 'not-a-signature' })).toEqual({ ok: false, cause: 'bad_signature' });
    // signedAt is not signed: changing it alone still verifies (it is the server's clock, for humans).
    expect(bad({ signedAt: '2030-01-01T00:00:00.000Z' })).toEqual({ ok: true });
  });

  it('an unknown extra top-level field added after signing fails (verification is over the raw JSON)', () => {
    const extra = { ...raw(fx.signed), injected: 'a field the schema would strip' };
    // A schema parse strips the field, so verifying a parsed copy would wrongly pass ...
    const parsed = residencyReportSchema.parse(extra) as unknown as Record<string, unknown>;
    expect('injected' in parsed).toBe(false);
    expect(verifyResidencyReport(parsed, wellKnown)).toEqual({ ok: true });
    // ... while the raw JSON, which is what verifyResidencyReport is given, fails.
    expect(verifyResidencyReport(extra, wellKnown)).toEqual({ ok: false, cause: 'bad_signature' });
    // The same holds for a nested extra field and for a `__proto__` member of parsed JSON.
    const nested = raw(fx.signed) as unknown as Record<string, unknown> & { org: Record<string, unknown> };
    nested.org.extra = 1;
    expect(verifyResidencyReport(nested, wellKnown)).toEqual({ ok: false, cause: 'bad_signature' });
    const proto = JSON.parse(JSON.stringify(fx.signed).replace(/^\{/, '{"__proto__":{"x":1},')) as unknown;
    expect(verifyResidencyReport(proto, wellKnown)).toEqual({ ok: false, cause: 'bad_signature' });
  });

  it('missing or malformed signature, or a value outside canonical JSON, is malformed; never throws', () => {
    const { signature: _sig, ...unsigned } = raw(fx.signed);
    expect(verifyResidencyReport(unsigned, wellKnown)).toEqual({ ok: false, cause: 'malformed' });
    expect(verifyResidencyReport({ ...unsigned, signature: null }, wellKnown)).toEqual({ ok: false, cause: 'malformed' });
    expect(verifyResidencyReport({ ...unsigned, signature: { ...fx.signed.signature, alg: 'RS256' } }, wellKnown)).toEqual({ ok: false, cause: 'malformed' });
    expect(verifyResidencyReport({ ...unsigned, signature: { ...fx.signed.signature, domain: 'ia-checkpoint' } }, wellKnown)).toEqual({ ok: false, cause: 'malformed' });
    expect(verifyResidencyReport({ ...raw(fx.signed), ratio: 0.5 }, wellKnown)).toEqual({ ok: false, cause: 'malformed' });
    for (const v of [null, undefined, 'x', 42, [], [fx.signed]]) expect(verifyResidencyReport(v, wellKnown)).toEqual({ ok: false, cause: 'malformed' });
    expect(verifyResidencyReport(raw(fx.signed), [{ kid: fx.key.kid, pub: 'not base64url' }])).toEqual({ ok: false, cause: 'bad_signature' });
  });

  it('accepts raw public key bytes in the key list as well as base64url', async () => {
    const { publicKeyFromSeed } = await import('../src/index.js');
    const bytes = await publicKeyFromSeed(fx.key.seedHex);
    expect(verifyResidencyReport(raw(fx.signed), [{ kid: fx.key.kid, pub: bytes }])).toEqual({ ok: true });
  });
});
