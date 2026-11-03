/**
 * Phase F section 5.5: the erasure certificate signature. The vector (`fixtures/erasure/certificate-signature.json`,
 * fixed seeds), `verifyErasureCertificate` over the raw JSON (ok, unknown kid, any changed byte, a field added after
 * signing, a missing or malformed signature), a certificate signed by a retired key verifying while the key is listed,
 * and the final entry recomputing to the chain tail.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ERASURE_SIG_DOMAIN,
  RESIDENCY_SIG_DOMAIN,
  bytesToHex,
  canonicalJson,
  erasureCertificateSchema,
  erasureSignatureSchema,
  erasureSigningInput,
  hashAuditEntry,
  residencySigningInput,
  sha256Hex,
  signErasureCertificate,
  utf8Decode,
  verifyBytesSync,
  verifyErasureCertificate,
  verifyResidencyReport,
  type ChainEntry,
  type PublicKeyLike,
  type UnsignedErasureCertificate,
} from '../src/index.js';

type Key = { seedHex: string; kid: string; pub: string };
type Signed = Record<string, unknown> & { signature: Record<string, unknown> };
type Fixture = {
  key: Key;
  retiredKey: Key;
  certificate: UnsignedErasureCertificate & Record<string, unknown>;
  signingInputPrefixHex: string;
  signingInputSha256: string;
  sig: string;
  signed: Signed;
  signedByRetired: Signed;
};

const fx = JSON.parse(readFileSync(new URL('./fixtures/erasure/certificate-signature.json', import.meta.url), 'utf8')) as Fixture;
const current: PublicKeyLike = { kid: fx.key.kid, pub: fx.key.pub };
const retired: PublicKeyLike = { kid: fx.retiredKey.kid, pub: fx.retiredKey.pub };
const wellKnown = [current, retired];
const raw = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('erasure signing input and vector (5.5)', () => {
  it('is utf8("ia-erasure-v1\\n") followed by the canonical JSON of the certificate without signature', () => {
    const input = erasureSigningInput(fx.certificate);
    const text = utf8Decode(input);
    expect(text.startsWith(`${ERASURE_SIG_DOMAIN}\n{`)).toBe(true);
    expect(text.slice(ERASURE_SIG_DOMAIN.length + 1)).toBe(canonicalJson(fx.certificate));
    expect(bytesToHex(input.slice(0, 16))).toBe(fx.signingInputPrefixHex);
    expect(sha256Hex(input)).toBe(fx.signingInputSha256);
    expect(sha256Hex(erasureSigningInput(fx.signed))).toBe(fx.signingInputSha256);
  });

  it('signing with the fixed seed reproduces the vector signature', async () => {
    const signed = await signErasureCertificate(fx.certificate, fx.key.seedHex, fx.key.kid);
    expect(erasureSignatureSchema.safeParse(signed.signature).success).toBe(true);
    expect(signed.signature).toMatchObject({ alg: 'Ed25519', domain: 'ia-erasure-v1', kid: fx.key.kid, pub: fx.key.pub, sig: fx.sig, sha256: fx.signingInputSha256 });
    expect(fx.signed.signature.sig).toBe(fx.sig);
    expect(verifyBytesSync(erasureSigningInput(fx.certificate), fx.sig, fx.key.kid, [current])).toBe(true);
    // Never valid over bare canonical JSON (tokens, checkpoints) or under the residency domain.
    expect(verifyBytesSync(new TextEncoder().encode(canonicalJson(fx.certificate)), fx.sig, fx.key.kid, [current])).toBe(false);
    expect(verifyBytesSync(residencySigningInput(fx.certificate), fx.sig, fx.key.kid, [current])).toBe(false);
    const asResidency = { ...raw(fx.signed), signature: { ...raw(fx.signed).signature, domain: RESIDENCY_SIG_DOMAIN } };
    expect(verifyResidencyReport(asResidency, [current]).ok).toBe(false);
  });

  it('replaces a signature it already carries, and refuses a kid that is not the seed', async () => {
    const again = await signErasureCertificate(fx.signed as never, fx.key.seedHex, fx.key.kid);
    expect(again.signature.sig).toBe(fx.sig);
    await expect(signErasureCertificate(fx.certificate, fx.key.seedHex, fx.retiredKey.kid)).rejects.toThrow(/kid/);
  });

  it('the signed vector parses as a certificate, and holds no name, slug, email or reason', () => {
    expect(erasureCertificateSchema.safeParse(fx.signed).success).toBe(true);
    const text = JSON.stringify(fx.signed);
    expect(text).not.toMatch(/@|"name"|"slug"|"reason":\s*"/);
  });

  it('chain.finalEntry recomputes to chain.tail', () => {
    const chain = fx.certificate.chain as { tail: string; finalEntry: ChainEntry };
    expect(hashAuditEntry(chain.finalEntry)).toBe(chain.tail);
    expect(chain.finalEntry.action).toBe('org.erased');
  });
});

describe('verifyErasureCertificate (5.5)', () => {
  it('ok against the current key and the well-known list', () => {
    expect(verifyErasureCertificate(raw(fx.signed), [current])).toEqual({ ok: true });
    expect(verifyErasureCertificate(raw(fx.signed), wellKnown)).toEqual({ ok: true });
  });

  it('a retired key verifies while listed, and is unknown once removed', () => {
    expect(verifyErasureCertificate(raw(fx.signedByRetired), wellKnown)).toEqual({ ok: true });
    expect(verifyErasureCertificate(raw(fx.signedByRetired), [current])).toEqual({ ok: false, cause: 'unknown_kid' });
  });

  it('the key is looked up by kid, never taken from signature.pub', () => {
    expect(verifyErasureCertificate(raw(fx.signed), [retired])).toEqual({ ok: false, cause: 'unknown_kid' });
    const forged = raw(fx.signedByRetired);
    forged.signature.kid = fx.key.kid;
    expect(verifyErasureCertificate(forged, wellKnown)).toEqual({ ok: false, cause: 'bad_signature' });
  });

  it('any changed or removed signed member fails; an added top-level field fails (raw JSON, not a stripped parse)', () => {
    const c = raw(fx.signed) as Signed & { deleted: Record<string, number>; chain: { verified: boolean } };
    const variants: Record<string, unknown>[] = [
      { ...c, deleted: { ...c.deleted, auth_session: 5 } },
      { ...c, chain: { ...c.chain, verified: false } },
      { ...c, backups: 'backup retention not stated' },
      { ...c, externalFlows: [] },
      { ...c, footnote: 'added later' },
    ];
    const { objectBytes: _o, ...noBytes } = c;
    variants.push(noBytes);
    for (const v of variants) expect(verifyErasureCertificate(v, wellKnown)).toEqual({ ok: false, cause: 'bad_signature' });
    // The schema alone would accept the added field (it strips unknown keys); verification does not.
    expect(erasureCertificateSchema.safeParse({ ...c, footnote: 'added later' }).success).toBe(true);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(c).reverse()), null, 2)) as unknown;
    expect(verifyErasureCertificate(reordered, wellKnown)).toEqual({ ok: true });
  });

  it('a changed sig, sha256 or pub fails; signedAt is not signed', () => {
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    const bad = (patch: Record<string, unknown>) => {
      const r = raw(fx.signed);
      return verifyErasureCertificate({ ...r, signature: { ...r.signature, ...patch } }, wellKnown);
    };
    expect(bad({ sig: flip(fx.sig) })).toEqual({ ok: false, cause: 'bad_signature' });
    expect(bad({ sha256: 'f'.repeat(64) })).toEqual({ ok: false, cause: 'bad_signature' });
    expect(bad({ pub: fx.retiredKey.pub })).toEqual({ ok: false, cause: 'bad_signature' });
    expect(bad({ signedAt: '2031-01-01T00:00:00.000Z' })).toEqual({ ok: true });
  });

  it('malformed input never throws', () => {
    const r = raw(fx.signed);
    const { signature: _s, ...unsigned } = r;
    for (const v of [null, 'x', 42, [], unsigned, { ...r, signature: 'x' }, { ...r, signature: { ...r.signature, domain: 'ia-residency-v1' } }, { ...r, signature: { ...r.signature, alg: 'RSA' } }, { ...r, n: 0.5 }])
      expect(verifyErasureCertificate(v, wellKnown).ok).toBe(false);
    expect(verifyErasureCertificate({ ...r, n: 0.5 }, wellKnown)).toEqual({ ok: false, cause: 'malformed' });
  });
});
