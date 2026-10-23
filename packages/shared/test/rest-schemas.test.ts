import { describe, expect, it } from 'vitest';
import {
  API_ERROR_STATUS,
  apiError,
  apiErrorEnvelopeSchema,
  auditEntrySchema,
  auditVerifyResponseSchema,
  brandingPatchRequestSchema,
  createTokenRequestSchema,
  healthResponseSchema,
  iceResponseSchema,
  isValidLogoData,
  pageQuerySchema,
  publicLookupRequestSchema,
  publicTokenSchema,
  recordingSchema,
  residencyReportSchema,
  sessionEventRequestSchema,
  sessionSchema,
  sessionStatsResponseSchema,
  signupRequestSchema,
  tokenLifetimeSeconds,
  tokenSchema,
  tokenTypeAllowedForTier,
  tokensPageSchema,
  wellKnownSchema,
  buildIceConfig,
  turnCredential,
  turnRestCredentials,
  base64Encode,
  decodeSeqCursor,
  decodeTimeIdCursor,
  encodeSeqCursor,
  encodeTimeIdCursor,
} from '../src/index.js';

const U1 = '11111111-2222-4333-8444-555555555555';
const U2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const T = '2026-10-23T10:15:30.123Z';
const H = 'ab'.repeat(32);

describe('contract example payloads (REST)', () => {
  it('well-known document (3.4)', () => {
    const doc = {
      v: 1,
      region: 'in-mum',
      keys: [
        {
          kid: '3f9a1c2b4d5e6f70',
          alg: 'Ed25519',
          pub: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
          createdAt: '2026-10-23T00:00:00.000Z',
        },
      ],
      api: 'http://localhost:4000/api/v1',
      signal: 'ws://localhost:4000/signal',
      join: 'http://localhost:5173/join',
    };
    expect(wellKnownSchema.parse(doc)).toEqual(doc);
  });

  it('error envelope (6.2) and status map', () => {
    const body = { error: { code: 'validation_failed', message: 'ttlMinutes must be <= 60', details: { issues: [] } } };
    expect(apiErrorEnvelopeSchema.parse(body)).toEqual(body);
    expect(apiErrorEnvelopeSchema.safeParse({ error: { code: 'nope', message: 'x' } }).success).toBe(false);
    expect(API_ERROR_STATUS.token_bad_signature).toBe(400);
    expect(API_ERROR_STATUS.region_mismatch).toBe(421);
    expect(apiError('token_gone', 'gone', { status: 'expired' })).toEqual({
      error: { code: 'token_gone', message: 'gone', details: { status: 'expired' } },
    });
  });

  it('PublicToken (6.7)', () => {
    const pt = {
      tokenId: U1,
      tier: 'p1_browser',
      typ: 'one_time',
      expiresAt: T,
      region: 'in-mum',
      org: { displayName: 'Acme IT', logoData: null, accentColor: '#0f766e', supportEmail: null },
      technician: { name: 'Priya S' },
      signalUrl: 'ws://localhost:4000/signal',
      joinSupported: true,
    };
    expect(publicTokenSchema.parse(pt)).toEqual(pt);
    expect(publicTokenSchema.parse({ ...pt, technician: null }).technician).toBeNull();
  });

  it('ICE response (6.11)', () => {
    const ice = {
      iceServers: [
        { urls: ['stun:turn.in-mum.indianscloud.com:3478'] },
        {
          urls: ['turn:turn.in-mum.indianscloud.com:3478?transport=udp', 'turns:turn.in-mum.indianscloud.com:5349'],
          username: `1761220000:user:${U1}`,
          credential: 'abc=',
        },
      ],
      iceTtl: 3600,
      iceExpiresAt: '2026-10-23T11:15:30.000Z',
    };
    expect(iceResponseSchema.parse(ice)).toEqual(ice);
  });

  it('health, token, session, audit entry, recording, page, verify, stats, residency', () => {
    expect(
      healthResponseSchema.parse({
        ok: true,
        region: 'in-mum',
        servedRegions: [],
        nodeId: 'h:1',
        version: '0.1.0',
        time: T,
      }).ok,
    ).toBe(true);
    const token = {
      id: U1,
      tier: 'p1_browser',
      typ: 'timed',
      status: 'active',
      shortCode: '482193657710',
      shortCodeDisplay: '4821 9365 7710',
      label: null,
      region: 'in-mum',
      createdBy: { id: U2, name: 'Priya S' },
      issuedAt: T,
      expiresAt: T,
      usedAt: null,
      revokedAt: null,
      deniedCount: 0,
      joinUrl: 'http://localhost:5173/join#t=ia1.x',
      joinHost: 'localhost:5173',
    };
    expect(tokenSchema.parse(token)).toEqual(token);
    expect(tokensPageSchema.parse({ items: [token], nextCursor: null }).items).toHaveLength(1);
    const session = {
      id: U1,
      tokenId: U2,
      tokenCreatedBy: { id: U2, name: 'A' },
      assist: { id: U2, name: 'A' },
      deskLabel: 'Rahul',
      tier: 'p1_browser',
      state: 'active',
      consentState: 'granted',
      consentSurface: 'monitor',
      path: 'p2p',
      region: 'in-mum',
      nodeId: 'h:1',
      knockedAt: T,
      acceptedAt: T,
      consentAt: T,
      startedAt: T,
      endedAt: null,
      endReason: null,
      lastStats: { rttMs: 12 },
      recordingStarted: false,
      recordingId: null,
      hashChainTail: H,
    };
    expect(sessionSchema.parse(session)).toEqual(session);
    const entry = {
      id: U1,
      seq: 1,
      sessionId: null,
      actor: { type: 'user', id: U2, label: 'Priya S' },
      action: 'auth.signup',
      reason: null,
      region: 'in-mum',
      ts: T,
      data: { emailHash: H },
      prevHash: '0'.repeat(64),
      hash: H,
    };
    expect(auditEntrySchema.parse(entry)).toEqual(entry);
    const rec = {
      id: U1,
      sessionId: U2,
      status: 'stored',
      mime: 'video/webm',
      bytes: 10,
      sha256: H,
      durationMs: 20000,
      storageKey: `in-mum/${U1}/${U2}/${U1}.webm`,
      chainedInto: U2,
      region: 'in-mum',
      createdAt: T,
      storedAt: T,
    };
    expect(recordingSchema.parse(rec)).toEqual(rec);
    expect(
      auditVerifyResponseSchema.parse({
        ok: false,
        checked: 3,
        tail: H,
        failure: { kind: 'seq_gap', seq: 4 },
        verifiedAt: T,
      }).ok,
    ).toBe(false);
    const byEndReason = {
      denied: 0,
      timeout: 1,
      desk_left: 0,
      desk_stopped: 0,
      consent_revoked: 0,
      assist_ended: 2,
      token_revoked: 0,
      error: 0,
    };
    expect(
      sessionStatsResponseSchema.parse({
        total: 3,
        active: 0,
        byPath: { p2p: 2, relay: 1, unknown: 0 },
        byEndReason,
        avgDurationMs: 1200,
        medianRttMs: 30,
        byDay: [{ day: '2026-10-23', count: 3 }],
      }).total,
    ).toBe(3);
    const report = {
      org: { id: U1, name: 'Acme', slug: 'acme', dataRegion: 'in-mum' },
      generatedAt: T,
      servedBy: { region: 'in-mum', apiOrigin: 'http://localhost:4000', nodeId: 'h:1' },
      storage: { driver: 'fs', bucket: './data/storage', prefix: `in-mum/${U1}/` },
      ice: { stunUrls: [], turnUrls: [], thirdPartyHosts: [] },
      counts: { users: 1, tokens: 2, sessions: 3, recordings: 1, recordingBytes: 10, auditEntries: 20 },
      chain: {
        length: 20,
        tail: H,
        lastVerifiedAt: T,
        lastVerifiedOk: true,
        lastAnchor: { seq: 19, tail: H, ts: T, kid: '3f9a1c2b4d5e6f70' },
      },
      retention: {
        auditEntries: 'append-only, never deleted',
        piiInChain: 'hashed with a per-org pepper; pepper destruction is the erasure mechanism (Phase E)',
        recordings: 'until deleted by an org_admin (Phase B endpoint)',
      },
      statement: 'All session metadata, recordings and audit entries for Acme are stored and served in India (Mumbai).',
    };
    expect(residencyReportSchema.parse(report)).toEqual(report);
  });
});

describe('request schemas', () => {
  it('signup and lookup', () => {
    expect(
      signupRequestSchema.parse({ orgName: 'Smoke Org', name: 'A', email: 'a@b.co', password: 'longenough1' }).orgName,
    ).toBe('Smoke Org');
    expect(signupRequestSchema.safeParse({ orgName: 'X', name: 'A', email: 'a@b.co', password: 'short' }).success).toBe(
      false,
    );
    expect(
      signupRequestSchema.safeParse({
        orgName: 'X',
        slug: 'Bad Slug',
        name: 'A',
        email: 'a@b.co',
        password: 'longenough1',
      }).success,
    ).toBe(false);
    expect(publicLookupRequestSchema.parse({ code: '482193657710' }).code).toBe('482193657710');
  });

  it('create token refinement (3.2)', () => {
    const ok = (v: unknown) => createTokenRequestSchema.safeParse(v).success;
    expect(ok({ tier: 'p1_browser', typ: 'one_time', ttlMinutes: 60 })).toBe(true);
    expect(ok({ tier: 'p1_browser', typ: 'one_time', ttlMinutes: 61 })).toBe(false);
    expect(ok({ tier: 'p1_browser', typ: 'timed', ttlMinutes: 480 })).toBe(true);
    expect(ok({ tier: 'p1_browser', typ: 'timed', ttlMinutes: 481 })).toBe(false);
    expect(ok({ tier: 'p4_installed', typ: 'enrollment', ttlDays: 30 })).toBe(true);
    expect(ok({ tier: 'p4_installed', typ: 'enrollment', ttlDays: 31 })).toBe(false);
    expect(ok({ tier: 'p4_installed', typ: 'enrollment', ttlMinutes: 10 })).toBe(false);
    expect(ok({ tier: 'p1_browser', typ: 'one_time', ttlDays: 1 })).toBe(false);
    expect(ok({ tier: 'p1_browser', typ: 'one_time', ttlMinutes: 5, ttlDays: 1 })).toBe(false);
    const parsed = createTokenRequestSchema.parse({
      tier: 'p1_browser',
      typ: 'one_time',
      label: `a\u0000b${'x'.repeat(200)}`,
    });
    expect(parsed.label).toHaveLength(80);
    expect(parsed.label!.startsWith('ab')).toBe(true);
    expect(tokenLifetimeSeconds({ typ: 'one_time' })).toBe(900);
    expect(tokenLifetimeSeconds({ typ: 'timed', ttlMinutes: 30 })).toBe(1800);
    expect(tokenLifetimeSeconds({ typ: 'enrollment' })).toBe(7 * 86400);
    expect(tokenTypeAllowedForTier('enrollment', 'p1_browser')).toBe(false);
    expect(tokenTypeAllowedForTier('enrollment', 'p4_installed')).toBe(true);
  });

  it('branding patch accepts only PNG / JPEG data URLs by magic bytes', () => {
    const png = `data:image/png;base64,${base64Encode(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]))}`;
    const jpeg = `data:image/jpeg;base64,${base64Encode(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0]))}`;
    const fake = `data:image/png;base64,${base64Encode(Uint8Array.from([1, 2, 3, 4]))}`;
    const big = `data:image/png;base64,${base64Encode(new Uint8Array(200 * 1024 + 1).fill(0x89))}`;
    expect(isValidLogoData(png)).toBe(true);
    expect(isValidLogoData(jpeg)).toBe(true);
    expect(isValidLogoData(fake)).toBe(false);
    expect(isValidLogoData(big)).toBe(false);
    expect(isValidLogoData('https://evil.example/logo.png')).toBe(false);
    expect(brandingPatchRequestSchema.safeParse({ logoData: png, accentColor: '#0F766E' }).success).toBe(true);
    expect(brandingPatchRequestSchema.safeParse({ logoData: null, displayName: null }).success).toBe(true);
    expect(brandingPatchRequestSchema.safeParse({ logoData: 'https://x/y.png' }).success).toBe(false);
    expect(brandingPatchRequestSchema.safeParse({ unknown: 1 }).success).toBe(false);
  });

  it('session events and page query', () => {
    expect(sessionEventRequestSchema.parse({ action: 'recording.started', data: {} }).action).toBe('recording.started');
    const file = {
      action: 'file.sent',
      data: { fileId: 1, direction: 'assist_to_desk', name: 'a.txt', bytes: 5, sha256: H },
    };
    expect(sessionEventRequestSchema.parse(file)).toEqual(file);
    expect(sessionEventRequestSchema.safeParse({ action: 'session.ended', data: {} }).success).toBe(false);
    expect(pageQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(pageQuerySchema.parse({ limit: '200' }).limit).toBe(200);
    expect(pageQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
  });

  it('cursors round trip', () => {
    expect(decodeTimeIdCursor(encodeTimeIdCursor(T, U1))).toEqual({ createdAt: T, id: U1 });
    expect(decodeSeqCursor(encodeSeqCursor(42))).toBe(42);
    expect(decodeSeqCursor('!!')).toBeNull();
  });
});

describe('TURN REST credentials', () => {
  it('matches an independently computed HMAC-SHA1 (Python hmac)', () => {
    expect(turnCredential('dev-turn-secret', `1761220000:user:${U1}`)).toBe('/KJl/WJTToS5UdOKKlpU7NGJrKs=');
  });

  it('builds username and ICE config', () => {
    const nowMs = 1761216400_000;
    const c = turnRestCredentials({ secret: 'dev-turn-secret', principal: `user:${U1}`, ttlSeconds: 3600, nowMs });
    expect(c.username).toBe(`1761220000:user:${U1}`);
    expect(c.credential).toBe('/KJl/WJTToS5UdOKKlpU7NGJrKs=');
    const cfg = buildIceConfig({
      stunUrls: ['stun:a:3478'],
      turnUrls: ['turn:a:3478?transport=udp'],
      secret: 'dev-turn-secret',
      principal: `desk:${U1}`,
      ttlSeconds: 3600,
      nowMs,
    });
    expect(iceResponseSchema.parse(cfg)).toEqual(cfg);
    expect(cfg.iceServers[1]!.username).toBe(`1761220000:desk:${U1}`);
    expect(
      buildIceConfig({ stunUrls: [], turnUrls: [], secret: 's', principal: `user:${U1}`, ttlSeconds: 60, nowMs })
        .iceServers,
    ).toEqual([]);
  });
});

describe('recording mime allowlist (SEC-01)', () => {
  it('accepts the four allow-listed media types with or without a codecs parameter', async () => {
    const { recordingMetaSchema, recordingUploadInitRequestSchema } = await import('../src/index.js');
    for (const mime of [
      'video/webm',
      'video/webm;codecs=vp9,opus',
      'video/webm; codecs=vp8, opus',
      'video/webm;codecs=avc1.42E01F',
      'video/mp4',
      'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
      'audio/webm;codecs=opus',
      'audio/ogg; codecs=opus',
    ])
      expect(recordingMetaSchema.safeParse({ mime }).success).toBe(true);
    expect(recordingUploadInitRequestSchema.safeParse({ mime: 'video/webm', bytes: 10 }).success).toBe(true);
  });
  it('refuses active document types and other media types', async () => {
    const { recordingMetaSchema, recordingUploadInitRequestSchema } = await import('../src/index.js');
    for (const mime of ['text/html', 'application/javascript', 'image/svg+xml', 'video/quicktime', 'audio/mpeg', 'video/webm;charset=utf-8', 'video/webm;codecs=vp9"><script>', 'video/mp4;codecs="avc1', 'VIDEO/WEBM2'])
      expect(recordingMetaSchema.safeParse({ mime }).success).toBe(false);
    expect(recordingUploadInitRequestSchema.safeParse({ mime: 'text/html', bytes: 10 }).success).toBe(false);
  });
});
