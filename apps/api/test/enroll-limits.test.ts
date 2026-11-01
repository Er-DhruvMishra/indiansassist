/**
 * Phase D enrollment rate limits (docs/specs/phase-d-contracts.md section 3.2, section 15.3 "rate limits"): the two
 * `POST /devices/enroll` budgets, per IP (60 / minute) and per enrollment token (120 / minute), against a real app
 * with rate limiting ON — every other api test runs with `RATE_LIMIT_DISABLED=true`, so these limits are only
 * exercised here. The per-IP budget is spent before the body is even parsed (a malformed body still costs a hit, so
 * a flood cannot be made free), the per-token budget only after the configuration and the token verify, and both
 * answer `429 rate_limited { retryAfterSec }` without touching the device table.
 */
import { base64urlEncode } from '@indiansassist/shared';
import { listDevicesByOrg } from '@indiansassist/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, type Account, type TestApp } from './helpers.js';
import { enrollBody, enrollConfigFor, makeP4App, newDev, p4Admin } from './p4-kit.js';

/** `TRUST_PROXY` makes `req.ip` the `x-forwarded-for` value, so one test can act as many clients. */
const ENV = { RATE_LIMIT_DISABLED: 'false', TRUST_PROXY: 'true' };

describe('enrollment rate limits (section 3.2)', () => {
  let t: TestApp;
  let admin: Account;

  const enroll = (body: unknown, ip: string) =>
    call(t.app, '/api/v1/devices/enroll', { body, headers: { 'x-forwarded-for': ip } });
  const codeOf = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code ?? null;

  beforeAll(async () => {
    t = await makeP4App(ENV);
    admin = await p4Admin(t);
  });
  afterAll(async () => {
    await t.close();
  });

  it('spends the per-IP budget before the body is parsed: 60 a minute, then 429 rate_limited', async () => {
    const ip = '203.0.113.7';
    await t.ctx.limiter.reset(`enroll-ip:${ip}`);
    // A malformed body is still a hit (otherwise the cheapest flood would be the free one).
    const bad = await Promise.all(Array.from({ length: 60 }, () => enroll({ nope: true }, ip)));
    expect(bad.every((r) => r.statusCode === 400)).toBe(true);
    const over = await enroll({ nope: true }, ip);
    expect(over.statusCode, over.body).toBe(429);
    expect(codeOf(over)).toBe('rate_limited');
    expect((over.json() as { error: { details: { retryAfterSec: number } } }).error.details.retryAfterSec).toBeGreaterThan(0);
    // A well-formed enrollment from the same IP is refused too: the limit is on the route, not on the body.
    const { cfg, tokenId } = await enrollConfigFor(t, admin, 1);
    const real = await enroll(enrollBody(newDev(), cfg, tokenId), ip);
    expect(real.statusCode, real.body).toBe(429);
    expect(codeOf(real)).toBe('rate_limited');
    // Another client is unaffected, and nothing was enrolled while the budget was spent.
    const ok = await enroll(enrollBody(newDev(), cfg, tokenId), '203.0.113.8');
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await listDevicesByOrg(t.ctx.db, admin.org.id, { limit: 50, cursor: null })).items).toHaveLength(1);
  });

  it('spends the per-token budget across IPs: 120 a minute on one token, then 429 rate_limited', async () => {
    const { cfg, tokenId } = await enrollConfigFor(t, admin, 2);
    // One request per IP, so the token budget is the one that runs out (60 from one IP would come first). The proof
    // is forged, so each call is refused one step *after* the token limit: the token stays active and nothing is
    // enrolled, which is what lets 120 attempts on one token be counted at all.
    const body = { ...enrollBody(newDev(), cfg, tokenId), deviceKeyProof: base64urlEncode(new Uint8Array(64)) };
    const ip = (n: number) => `198.51.100.${n}`;
    const codes = new Set<string>();
    for (let i = 0; i < 120; i++) codes.add(String(codeOf(await enroll(body, ip(i)))));
    expect(codes).toEqual(new Set(['token_bad_signature']));
    const over = await enroll(body, ip(120));
    expect(over.statusCode, over.body).toBe(429);
    expect(codeOf(over)).toBe('rate_limited');
    // Not the device's fault and not its IP: a sound enrollment on the same token from an unused IP is refused too.
    const sound = await enroll(enrollBody(newDev(), cfg, tokenId), ip(121));
    expect(sound.statusCode, sound.body).toBe(429);
    // A second enrollment token of the same org has its own budget.
    const other = await enrollConfigFor(t, admin, 1);
    const fresh = await enroll(enrollBody(newDev(), other.cfg, other.tokenId), ip(122));
    expect(fresh.statusCode, fresh.body).toBe(201);
  });
});
