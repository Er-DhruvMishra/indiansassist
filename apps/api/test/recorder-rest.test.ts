/**
 * Phase A.2 REST (docs/specs/phase-a2-recorder.md sections 3, 9, 10): the org recording policy (RBAC, audit), the
 * policy gate on Assist recording, the service-token internal upload and the recorder ICE route.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getOrg,
  getUser,
  listAuditBySession,
  seedSession,
  seedToken,
  transitionSession,
  updateSession,
} from '@indiansassist/db';
import type { RecordingMode } from '@indiansassist/shared';
import { addMember, call, makeApp, signup, type Account, type TestApp } from './helpers.js';

const TOKEN = 'recorder-test-token-0123456789abcdef';
let t: TestApp;
let admin: Account;
let tech: Account;
let auditor: Account;

beforeAll(async () => {
  t = await makeApp({ RECORDER_TOKEN: TOKEN });
  admin = await signup(t.app);
  tech = await addMember(t.app, admin, 'technician');
  auditor = await addMember(t.app, admin, 'auditor');
});
afterAll(async () => {
  await t.close();
});

async function activeSession(owner: Account, mode: RecordingMode | null): Promise<string> {
  const org = (await getOrg(t.db, owner.org.id))!;
  const user = (await getUser(t.db, owner.user.id))!;
  const tok = await seedToken(t.db, org, user);
  const s = await seedSession(t.db, tok, { assistUserId: user.id });
  await transitionSession(t.db, s.id, 'accepted', { set: { assistUserId: user.id } });
  await transitionSession(t.db, s.id, 'consent_pending');
  await transitionSession(t.db, s.id, 'active', { set: { consentSurface: 'monitor' } });
  if (mode) await updateSession(t.db, s.id, { recordingMode: mode });
  return s.id;
}

function multipart(meta: unknown, file: Buffer): { body: Buffer; type: string } {
  const b = `----ia${randomBytes(8).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n${JSON.stringify(meta)}\r\n`),
    Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="file"; filename="x.webm"\r\nContent-Type: video/webm\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return { body, type: `multipart/form-data; boundary=${b}` };
}

function internalUpload(
  sessionId: string,
  file: Buffer,
  over: Record<string, unknown> = {},
  token: string | null = TOKEN,
) {
  const sha256 = createHash('sha256').update(file).digest('hex');
  const meta = {
    sessionId,
    recorderId: 'rec-1',
    mime: 'video/webm;codecs="vp8,opus"',
    durationMs: 1000,
    bytes: file.length,
    sha256,
    ...over,
  };
  const mp = multipart(meta, file);
  const headers: Record<string, string> = { 'content-type': mp.type };
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  return call(t.app, '/api/v1/internal/recordings', { body: mp.body, headers });
}

describe('org recording policy', () => {
  it('reads for any role and defaults to assist_only', async () => {
    for (const acc of [admin, tech, auditor]) {
      const res = await call(t.app, '/api/v1/orgs/current/policy/recording', { cookie: acc.cookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ recordingMode: 'assist_only' });
    }
  });

  it('lets only org_admin patch it and audits org.policy_updated once per change', async () => {
    for (const acc of [tech, auditor]) {
      const res = await call(t.app, '/api/v1/orgs/current/policy/recording', {
        method: 'PATCH',
        cookie: acc.cookie,
        body: { recordingMode: 'server' },
      });
      expect(res.statusCode).toBe(403);
    }
    const bad = await call(t.app, '/api/v1/orgs/current/policy/recording', {
      method: 'PATCH',
      cookie: admin.cookie,
      body: { recordingMode: 'always' },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await call(t.app, '/api/v1/orgs/current/policy/recording', {
      method: 'PATCH',
      cookie: admin.cookie,
      body: { recordingMode: 'both' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ recordingMode: 'both' });
    const same = await call(t.app, '/api/v1/orgs/current/policy/recording', {
      method: 'PATCH',
      cookie: admin.cookie,
      body: { recordingMode: 'both' },
    });
    expect(same.statusCode).toBe(200);
    const audit = await call(t.app, '/api/v1/audit?action=org.policy_updated', { cookie: admin.cookie });
    const items = (audit.json() as { items: { data: { fields: string[] } }[] }).items.filter((e) =>
      e.data.fields.includes('recordingMode'),
    );
    expect(items).toHaveLength(1);
    await call(t.app, '/api/v1/orgs/current/policy/recording', {
      method: 'PATCH',
      cookie: admin.cookie,
      body: { recordingMode: 'assist_only' },
    });
  });

  it('refuses console recording when the session mode is server or off, allows assist_only / both / null', async () => {
    for (const [mode, status] of [
      ['server', 403],
      ['off', 403],
      ['both', 201],
      ['assist_only', 201],
      [null, 201],
    ] as const) {
      const sid = await activeSession(tech, mode);
      const res = await call(t.app, `/api/v1/sessions/${sid}/events`, {
        cookie: tech.cookie,
        body: { action: 'recording.started', data: {} },
      });
      expect(res.statusCode, String(mode)).toBe(status);
    }
  });
});

describe('internal recording upload', () => {
  it('needs the service token (401) and stores a server recording with source server in the chain', async () => {
    const sid = await activeSession(tech, 'server');
    const file = randomBytes(4096);
    expect((await internalUpload(sid, file, {}, null)).statusCode).toBe(401);
    expect((await internalUpload(sid, file, {}, 'wrong-token')).statusCode).toBe(401);
    const res = await internalUpload(sid, file);
    expect(res.statusCode).toBe(201);
    const rec = res.json() as { id: string; recordedBy: string; status: string; sha256: string };
    expect(rec).toMatchObject({ recordedBy: 'server', status: 'stored' });
    expect(rec.sha256).toBe(createHash('sha256').update(file).digest('hex'));
    const entries = await listAuditBySession(t.db, sid);
    const stored = entries.find((e) => e.action === 'recording.stored')!;
    expect(stored.data).toMatchObject({ recordingId: rec.id, source: 'server', sha256: rec.sha256 });
    expect(stored.actorType).toBe('system');
    expect(stored.actorId).toBe('recorder:rec-1');
    expect(stored.actorLabel).toBe('recorder');
    const again = await internalUpload(sid, file);
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: { details: { sha256: string } } }).error.details.sha256).toBe(rec.sha256);
    const session = await call(t.app, `/api/v1/sessions/${sid}`, { cookie: tech.cookie });
    expect(session.json()).toMatchObject({ serverRecordingId: rec.id, recordingId: null, recordingMode: 'server' });
    const verify = await call(t.app, `/api/v1/recordings/${rec.id}/verify`, { cookie: tech.cookie, body: {} });
    expect(verify.json()).toMatchObject({ ok: true });
  });

  it('fails the row on a sha256 mismatch and refuses sessions whose mode does not ask for the server', async () => {
    const sid = await activeSession(tech, 'both');
    const res = await internalUpload(sid, randomBytes(1000), { sha256: 'a'.repeat(64) });
    expect(res.statusCode).toBe(400);
    const failed = (await listAuditBySession(t.db, sid)).find((e) => e.action === 'recording.failed')!;
    expect(failed.data).toMatchObject({ error: 'sha256_mismatch', source: 'server' });
    const retry = await internalUpload(sid, randomBytes(500));
    expect(retry.statusCode).toBe(201);
    const assistOnly = await activeSession(tech, 'assist_only');
    expect((await internalUpload(assistOnly, randomBytes(100))).statusCode).toBe(403);
    expect((await internalUpload('00000000-0000-4000-8000-000000000001', randomBytes(100))).statusCode).toBe(404);
  });

  it('keeps the Assist and the server recordings of a session apart (mode both)', async () => {
    const sid = await activeSession(tech, 'both');
    expect((await internalUpload(sid, randomBytes(300))).statusCode).toBe(201);
    const mp = multipart({ mime: 'video/webm', durationMs: 1000 }, randomBytes(300));
    const assist = await call(t.app, `/api/v1/sessions/${sid}/recordings`, {
      cookie: tech.cookie,
      body: mp.body,
      headers: { 'content-type': mp.type },
    });
    expect(assist.statusCode).toBe(201);
    expect(assist.json()).toMatchObject({ recordedBy: 'assist' });
  });

  it('serves recorder ICE with the bearer token only', async () => {
    const ok = await call(t.app, '/api/v1/ice?recorderId=rec-1', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.statusCode).toBe(200);
    const ice = ok.json() as { iceServers: { username?: string }[] };
    expect(ice.iceServers.find((s) => s.username)?.username).toMatch(/^\d+:recorder:rec-1$/);
    expect(
      (await call(t.app, '/api/v1/ice?recorderId=rec-1', { headers: { authorization: 'Bearer nope' } })).statusCode,
    ).toBe(401);
    expect(
      (await call(t.app, '/api/v1/ice?recorderId=BAD ID', { headers: { authorization: `Bearer ${TOKEN}` } }))
        .statusCode,
    ).toBe(400);
  });
});

describe('recorder disabled', () => {
  it('answers 404 on the internal route when RECORDER_TOKEN is empty', async () => {
    const t2 = await makeApp();
    try {
      const res = await call(t2.app, '/api/v1/internal/recordings', {
        body: {},
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await t2.close();
    }
  });
});
