import { beforeEach, describe, expect, it, vi } from 'vitest';
import { kidOf, publicKeyFromSeed, publicKeyToBase64url, signToken } from '@indiansassist/shared';
import { resolveJoinCode } from '../src/background/token-check';
import { parseJoinInput } from '../src/shared/join-input';
import { installChromeMock } from './chrome-mock';

const SEED = '11'.repeat(32);
const ORIGIN = 'https://in.indiansassist.example';
const OTHER = 'https://eu.indiansassist.example';
const UUID = '00000000-0000-4000-8000-000000000001';

function publicToken(tier = 'p2_extension') {
  return {
    tokenId: UUID,
    tier,
    typ: 'one_time',
    expiresAt: '2030-01-01T00:00:00.000Z',
    region: 'in-mum',
    org: { displayName: 'Acme', logoData: null, accentColor: null, supportEmail: null },
    technician: { name: 'Asha' },
    signalUrl: 'wss://in.indiansassist.example/signal',
    joinSupported: true,
    extension: { ids: [], webStoreUrl: null, edgeAddonsUrl: null, minVersion: '0.1.0' },
  };
}

async function wellKnown() {
  const pub = await publicKeyFromSeed(SEED);
  return { v: 1, region: 'in-mum', keys: [{ kid: kidOf(pub), alg: 'Ed25519', pub: publicKeyToBase64url(pub), createdAt: '2026-01-01T00:00:00.000Z' }], api: '', signal: '', join: '' };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function compact(offsetSec = 600, tier: 'p2_extension' | 'p1_browser' = 'p2_extension') {
  const now = Math.floor(Date.now() / 1000);
  const t = await signToken({ tid: UUID, org: UUID, by: UUID, tier, typ: 'one_time', reg: 'in-mum', iat: now - 10, exp: now + offsetSec }, SEED);
  return t.compact;
}

describe('token acquisition (sections 2.2, 2.3)', () => {
  beforeEach(() => {
    installChromeMock();
  });

  it('refuses an api origin outside the compiled REGION_ORIGINS without any network call', async () => {
    const fetchImpl = vi.fn();
    for (const o of ['https://evil.example', 'https://x.in.indiansassist.example', 'https://in.indiansassist.example:8443', 'http://in.indiansassist.example']) {
      const r = await resolveJoinCode('482193657710', o, { fetch: fetchImpl });
      expect(r).toMatchObject({ ok: false, error: 'origin' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers bad_code for input that is not a code', async () => {
    const r = await resolveJoinCode('hello', ORIGIN, { fetch: vi.fn() });
    expect(r).toMatchObject({ ok: false, error: 'bad_code' });
  });

  it('verifies a compact token locally, then looks it up with the CSRF header and no credentials', async () => {
    const code = await compact();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/.well-known/indiansassist.json')) return json(200, await wellKnown());
      expect(url).toBe(`${ORIGIN}/api/v1/tokens/public-lookup`);
      expect((init?.headers as Record<string, string>)['X-Requested-With']).toBe('IndiansAssist');
      expect(init?.credentials).toBe('omit');
      expect(JSON.parse(String(init?.body))).toEqual({ code });
      return json(200, publicToken());
    });
    const r = await resolveJoinCode(code, ORIGIN, { fetch: fetchImpl });
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses a token with a bad signature before any lookup (bad_code)', async () => {
    const code = await compact();
    const tampered = code.slice(0, -4) + (code.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const fetchImpl = vi.fn(async (url: string) => (url.includes('well-known') ? json(200, await wellKnown()) : json(200, publicToken())));
    const r = await resolveJoinCode(tampered, ORIGIN, { fetch: fetchImpl });
    expect(r).toMatchObject({ ok: false, error: 'bad_code' });
    expect(fetchImpl.mock.calls.map((c) => c[0]).some((u) => String(u).includes('public-lookup'))).toBe(false);
  });

  it('refuses an expired token locally', async () => {
    const code = await compact(-5);
    const fetchImpl = vi.fn(async () => json(200, await wellKnown()));
    expect(await resolveJoinCode(code, ORIGIN, { fetch: fetchImpl })).toMatchObject({ ok: false, error: 'bad_code' });
  });

  it('caches the region keys for 24 h', async () => {
    const fetchImpl = vi.fn(async (url: string) => (url.includes('well-known') ? json(200, await wellKnown()) : json(200, publicToken())));
    await resolveJoinCode(await compact(), ORIGIN, { fetch: fetchImpl });
    await resolveJoinCode(await compact(), ORIGIN, { fetch: fetchImpl });
    expect(fetchImpl.mock.calls.filter((c) => String(c[0]).includes('well-known'))).toHaveLength(1);
  });

  it('a 12-digit short code skips local verification', async () => {
    const fetchImpl = vi.fn(async () => json(200, publicToken()));
    const r = await resolveJoinCode('4821 9365 7710', ORIGIN, { fetch: fetchImpl });
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows one 421 region_mismatch to another compiled origin only', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.startsWith(ORIGIN) ? json(421, { error: { code: 'region_mismatch', message: 'x', details: { origin: OTHER } } }) : json(200, publicToken()),
    );
    const r = await resolveJoinCode('482193657710', ORIGIN, { fetch: fetchImpl });
    expect(r).toMatchObject({ ok: true, apiOrigin: OTHER });
    const bad = vi.fn(async () => json(421, { error: { code: 'region_mismatch', message: 'x', details: { origin: 'https://evil.example' } } }));
    expect(await resolveJoinCode('482193657710', ORIGIN, { fetch: bad })).toMatchObject({ ok: false, error: 'origin' });
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it('a lookup for another package answers unsupported_tier', async () => {
    const fetchImpl = vi.fn(async () => json(200, publicToken('p1_browser')));
    expect(await resolveJoinCode('482193657710', ORIGIN, { fetch: fetchImpl })).toMatchObject({ ok: false, error: 'unsupported_tier' });
  });
});

describe('manual and clipboard entry parsing', () => {
  it('accepts the 12-digit code with spaces, a compact token and a /join#t= or ?t= link', async () => {
    expect(parseJoinInput(' 4821 9365 7710 ')).toEqual({ kind: 'short_code', value: '482193657710' });
    const c = await compact();
    expect(parseJoinInput(c)).toEqual({ kind: 'compact', value: c });
    expect(parseJoinInput(`https://in.indiansassist.example/join#t=${c}`)).toEqual({ kind: 'compact', value: c });
    expect(parseJoinInput(`https://in.indiansassist.example/join?t=482193657710`)).toEqual({ kind: 'short_code', value: '482193657710' });
    expect(parseJoinInput('not a code')).toBeNull();
    expect(parseJoinInput(42)).toBeNull();
  });
});
