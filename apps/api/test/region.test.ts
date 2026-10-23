import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex, signToken } from '@indiansassist/shared';
import { createAuthSession, createOrgWithAdmin, org as orgTable } from '@indiansassist/db';
import { sql } from 'drizzle-orm';
import { call, listen, makeApp, PASSWORD, signup, SignalClient, uniq, type TestApp } from './helpers.js';

let t: TestApp;
let url: string;

beforeAll(async () => {
  t = await makeApp({
    SERVED_REGIONS: 'in-mum',
    REGION_ORIGINS: 'in-mum=http://localhost:5173,eu-fra=https://eu.example.test',
  });
  url = await listen(t.app);
});
afterAll(async () => {
  await t.close();
});

async function orgCount(): Promise<number> {
  const [r] = await t.db.select({ n: sql<number>`count(*)::int` }).from(orgTable);
  return Number(r?.n ?? 0);
}

async function foreignToken(reg: 'eu-fra' | 'us-east'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const s = await signToken(
    {
      tid: '6f1c2d3e-4b5a-4c6d-8e7f-001122334455',
      org: '7f1c2d3e-4b5a-4c6d-8e7f-001122334455',
      by: '8f1c2d3e-4b5a-4c6d-8e7f-001122334455',
      tier: 'p1_browser',
      typ: 'one_time',
      reg,
      iat: now,
      exp: now + 600,
    },
    t.ctx.keys.seedHex,
  );
  return s.compact;
}

describe('served-region enforcement (sections 1.1, 1.2, 3.5 step 4)', () => {
  it('health reports the served regions', async () => {
    expect((await call(t.app, '/api/v1/health')).json().servedRegions).toEqual(['in-mum']);
  });

  it('signup for an unserved region answers 421 before anything is created', async () => {
    const before = await orgCount();
    const res = await call(t.app, '/api/v1/auth/signup', {
      body: { orgName: 'EU Org', region: 'eu-fra', name: 'Anna', email: `${uniq()}@example.test`, password: PASSWORD },
    });
    expect(res.statusCode).toBe(421);
    expect(res.json().error).toMatchObject({ code: 'region_mismatch', details: { region: 'eu-fra', origin: 'https://eu.example.test' } });
    const us = await call(t.app, '/api/v1/auth/signup', {
      body: { orgName: 'US Org', region: 'us-east', name: 'Bo', email: `${uniq()}@example.test`, password: PASSWORD },
    });
    expect(us.json().error.details).toEqual({ region: 'us-east', origin: null });
    expect(await orgCount()).toBe(before);
    const ok = await signup(t.app, { region: 'in-mum' });
    expect(ok.org).toBeTruthy();
  });

  it('a token signed for another region answers 421 on lookup and on desk.hello, before any DB access', async () => {
    const compact = await foreignToken('eu-fra');
    const res = await call(t.app, '/api/v1/tokens/public-lookup', { body: { code: compact } });
    expect(res.statusCode).toBe(421);
    expect(res.json().error.details).toEqual({ region: 'eu-fra', origin: 'https://eu.example.test' });
    const d = await SignalClient.open(url);
    d.send({ t: 'desk.hello', token: compact });
    const err = await d.next('error');
    expect(err).toMatchObject({ code: 'region_mismatch', details: { region: 'eu-fra' } });
    expect(await d.closed()).toBe(4403);
  });

  it('defence in depth: a session for an org of an unserved region is refused with 421', async () => {
    const seeded = await createOrgWithAdmin(t.db, { region: 'eu-fra' });
    const raw = randomBytes(32).toString('base64url');
    await createAuthSession(t.db, { userId: seeded.user.id, tokenHash: sha256Hex(raw), region: 'eu-fra' });
    const cookie = `ia_session=${encodeURIComponent(t.app.signCookie(raw))}`;
    const me = await call(t.app, '/api/v1/auth/me', { cookie });
    expect(me.statusCode).toBe(421);
    expect(me.json().error.details.region).toBe('eu-fra');
    await expect(SignalClient.open(url, { cookie })).rejects.toThrow(/421/);
  });

  it('org.data_region is immutable', async () => {
    const a = await signup(t.app);
    await expect(t.db.execute(sql`update org set data_region = 'eu-fra' where id = ${a.org.id}`)).rejects.toThrow();
  });
});
