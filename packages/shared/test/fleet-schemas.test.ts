/**
 * Phase D shared schemas (docs/specs/phase-d-contracts.md sections 3, 9, 13): enums and the additive changes of
 * section 16.2, device / action / wake / tamper / receipt objects, the enroll config, the `/signal/device` unions,
 * `desk.hello` with exactly one of `token` / `workerCredential`, P4 `session.created`, and the P4 audit actions.
 */
import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPES,
  AUDIT_ACTIONS,
  DEFAULT_UNATTENDED_POLICY,
  DEVICE_STATUSES,
  P4_ACTION_ACTORS,
  P4_AUDIT_ACTIONS,
  SERVICE_FEATURES,
  SESSION_END_REASONS,
  TOKEN_LIFETIMES,
  TOKEN_SOURCES,
  WS_CLOSE,
  AGENT_CONTROL_EVENT_KINDS,
  agentControlEventSchema,
  agentMinLevelFor,
  auditDataSchema,
  consentLevelFamily,
  deviceActionRequestSchema,
  deviceEnrollRequestSchema,
  deviceSchema,
  deviceSessionRequestSchema,
  installerDistManifestSchema,
  installerDownloadQuerySchema,
  installerFileName,
  installerManifestSchema,
  isNativeTier,
  isPrivilegedAction,
  parseClientSignal,
  parseDeviceClientMessage,
  parseDeviceServerMessage,
  parseServerSignal,
  parseSignalMessage,
  playbookCreateSchema,
  serviceCapabilitiesSchema,
  sessionSummarySchema,
  signEnrollConfig,
  tamperEventSchema,
  verifyEnrollConfig,
  publicKeyFromSeed,
  kidOf,
} from '../src/index.js';

const U = '0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a';
const U2 = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const H = 'a'.repeat(64);
const B32 = 'A'.repeat(43);
const B16 = 'A'.repeat(22);
const B64 = 'A'.repeat(86);
const CAPS = {
  monitors: 2,
  elevation: 'admin',
  features: ['screen', 'input', 'recorder', 'waker', 'secure_desktop', 'input_lock'],
  encoders: ['vp8'],
  hwEncoder: false,
  interpreters: ['powershell'],
  serviceVersion: '0.4.0',
};
const INTERACTIVE = { state: 'locked', idleSec: null, at: 1 };

describe('Phase D enums and additive changes (section 16.2)', () => {
  it('additive enum values', () => {
    expect(ACTOR_TYPES).toContain('device');
    for (const r of ['consent_required', 'policy_timeout', 'device_disabled']) expect(SESSION_END_REASONS).toContain(r);
    for (const s of ['superseded', 'retired', 'deregistered']) expect(DEVICE_STATUSES).toContain(s);
    expect(WS_CLOSE.deviceUnauthenticated).toBe(4412);
    expect(TOKEN_LIFETIMES.enrollment.maxDays).toBe(180);
    expect(TOKEN_SOURCES).toContain('service');
    expect(new Set(SERVICE_FEATURES).size).toBe(SERVICE_FEATURES.length);
  });
  it('isNativeTier and the consent family of every native tier', () => {
    expect(isNativeTier('p3_portable')).toBe(true);
    expect(isNativeTier('p4_installed')).toBe(true);
    expect(isNativeTier('p2_extension')).toBe(false);
    expect(consentLevelFamily('p4_installed')).toBe('p3');
  });
  it('os.sas needs elevated; device_attest is a ctl.event kind', () => {
    expect(agentMinLevelFor('os.sas')).toBe('elevated');
    expect(AGENT_CONTROL_EVENT_KINDS).toContain('device_attest');
    expect(agentControlEventSchema.safeParse({ t: 'ctl.event', kind: 'device_attest', ts: 1, gen: 2, sig: B64 }).success).toBe(true);
  });
  it('playbook vaultRefs: env names, relative paths, <= 8, unique', () => {
    const base = { name: 'x', interpreter: 'powershell', body: 'echo 1' };
    expect(playbookCreateSchema.safeParse({ ...base, vaultRefs: [{ env: 'DB_PASS', path: 'db/prod' }] }).success).toBe(true);
    expect(playbookCreateSchema.safeParse({ ...base, vaultRefs: [{ env: 'db', path: 'x' }] }).success).toBe(false);
    expect(playbookCreateSchema.safeParse({ ...base, vaultRefs: [{ env: 'A', path: '../x' }] }).success).toBe(false);
    expect(playbookCreateSchema.safeParse({ ...base, vaultRefs: [{ env: 'A', path: 'x' }, { env: 'A', path: 'y' }] }).success).toBe(false);
  });
});

describe('device objects (section 13.1a)', () => {
  it('serviceCapabilities: elevation admin, unique features from SERVICE_FEATURES', () => {
    expect(serviceCapabilitiesSchema.safeParse(CAPS).success).toBe(true);
    // Phase F section 8.7: a Linux or macOS service advertises `elevation: 'user'`.
    expect(serviceCapabilitiesSchema.safeParse({ ...CAPS, elevation: 'user' }).success).toBe(true);
    expect(serviceCapabilitiesSchema.safeParse({ ...CAPS, elevation: 'system' }).success).toBe(false);
    expect(serviceCapabilitiesSchema.safeParse({ ...CAPS, features: ['screen', 'screen'] }).success).toBe(false);
    expect(serviceCapabilitiesSchema.safeParse({ ...CAPS, features: ['teleport'] }).success).toBe(false);
  });
  it('enroll request', () => {
    const req = {
      enrollConfig: '{}',
      devicePublicKey: B32,
      deviceKexPublicKey: B32,
      deviceKeyProof: B64,
      machine: { name: 'PC-01', platform: 'windows', osVersion: '10.0.26100', arch: 'x64', serviceVersion: '0.4.0', hwFingerprint: H, wakeMac: '0a1b2c3d4e5f', amt: null, capabilities: CAPS, interactive: INTERACTIVE },
    };
    expect(deviceEnrollRequestSchema.safeParse(req).success).toBe(true);
    expect(deviceEnrollRequestSchema.safeParse({ ...req, machine: { ...req.machine, wakeMac: '0A:1B' } }).success).toBe(false);
    expect(deviceEnrollRequestSchema.safeParse({ ...req, enrollConfig: 'x'.repeat(16385) }).success).toBe(false);
  });
  it('enroll.iaconfig: signed by a region key, strict, verified', async () => {
    const seed = '11'.repeat(32);
    const pub = await publicKeyFromSeed(seed);
    const text = await signEnrollConfig(
      { v: 1, apiOrigin: 'http://localhost:4100', signalUrl: 'ws://localhost:4100/signal/device', region: 'in-mum', token: 'ia1.x', groupId: null, kid: kidOf(pub) },
      seed,
    );
    const ok = await verifyEnrollConfig(text, [{ kid: kidOf(pub), pub }]);
    expect(ok?.region).toBe('in-mum');
    expect(await verifyEnrollConfig(text.replace('in-mum', 'eu-fra'), [{ kid: kidOf(pub), pub }])).toBeNull();
    expect(await verifyEnrollConfig(text, [])).toBeNull();
  });
  it('enroll.iaconfig origins: plain http / ws only for localhost or 127.0.0.1 (C section 2.4, as the MSI checks)', async () => {
    const seed = '11'.repeat(32);
    const kid = kidOf(await publicKeyFromSeed(seed));
    const base = { v: 1 as const, region: 'in-mum' as const, token: 'ia1.x', groupId: null, kid };
    await expect(signEnrollConfig({ ...base, apiOrigin: 'https://in.example.com', signalUrl: 'wss://in.example.com/signal/device' }, seed)).resolves.toContain('wss://');
    await expect(signEnrollConfig({ ...base, apiOrigin: 'http://127.0.0.1:4100', signalUrl: 'ws://127.0.0.1:4100/signal/device' }, seed)).resolves.toContain('ws://');
    await expect(signEnrollConfig({ ...base, apiOrigin: 'http://in.example.com', signalUrl: 'wss://in.example.com/signal/device' }, seed)).rejects.toThrow();
    await expect(signEnrollConfig({ ...base, apiOrigin: 'https://in.example.com', signalUrl: 'ws://in.example.com/signal/device' }, seed)).rejects.toThrow();
    await expect(signEnrollConfig({ ...base, apiOrigin: 'http://localhost.evil.com', signalUrl: 'ws://localhost.evil.com/signal/device' }, seed)).rejects.toThrow();
  });
  it('device session request: reason required when unattended', () => {
    expect(deviceSessionRequestSchema.safeParse({ unattended: false }).success).toBe(true);
    expect(deviceSessionRequestSchema.safeParse({ unattended: true }).success).toBe(false);
    expect(deviceSessionRequestSchema.safeParse({ unattended: true, reason: '   ' }).success).toBe(false);
    expect(deviceSessionRequestSchema.safeParse({ unattended: true, reason: 'patch KB123' }).success).toBe(true);
  });
  it('action request: per-kind payloads and the reason rules (rule 9.1)', () => {
    const pb = { kind: 'playbook_run', payload: { playbookId: U, args: {}, requiresElevation: true } };
    expect(deviceActionRequestSchema.safeParse(pb).success).toBe(false);
    expect(deviceActionRequestSchema.safeParse({ ...pb, reason: 'fix' }).success).toBe(true);
    const pr = { kind: 'print', payload: { fileRef: 'https://s3/x', name: 'a.pdf', printer: 'HP' } };
    expect(deviceActionRequestSchema.safeParse(pr).success).toBe(false);
    expect(deviceActionRequestSchema.safeParse({ kind: 'print', payload: { fileRef: 'https://s3/x', name: 'a.pdf' } }).success).toBe(true);
    expect(deviceActionRequestSchema.safeParse({ kind: 'message', payload: { title: 'Hi', body: 'soon' } }).success).toBe(true);
    expect(deviceActionRequestSchema.safeParse({ kind: 'file_push', payload: { fileRef: 'https://s3/x', name: '../evil', bytes: 1, sha256: H } }).success).toBe(false);
    expect(isPrivilegedAction(pb)).toBe(true);
    expect(isPrivilegedAction({ kind: 'playbook_run', payload: { requiresElevation: false } }, { vaultRefs: 1 })).toBe(true);
    expect(isPrivilegedAction(pr)).toBe(true);
    expect(isPrivilegedAction({ kind: 'message', payload: {} })).toBe(false);
  });
  it('tamper event', () => {
    expect(tamperEventSchema.safeParse({ id: U, cause: 'stopped', at: '2026-11-01T10:00:00.000Z', sig: B64 }).success).toBe(true);
    expect(tamperEventSchema.safeParse({ id: U, cause: 'suspected', at: '2026-11-01T10:00:00.000Z', sig: B64 }).success).toBe(false);
  });
});

describe('/signal/device unions (section 3.4)', () => {
  const lan = { subnetHash: H, gatewayMacHash: H };
  it('device.hello and the D->S messages parse; S->D types are unknown to the server side', () => {
    const hello = {
      t: 'device.hello',
      deviceId: U,
      keyId: '0123456789abcdef',
      nonce: B16,
      sig: B64,
      client: { serviceVersion: '0.4.0', agentVersion: '0.4.0', osVersion: '10', arch: 'x64', capabilities: CAPS, lanSegment: lan, wakeMac: null, amt: null, interactive: INTERACTIVE },
    };
    expect(parseDeviceClientMessage(JSON.stringify(hello)).ok).toBe(true);
    expect(parseDeviceClientMessage({ t: 'device.heartbeat', interactive: INTERACTIVE }).ok).toBe(true);
    expect(parseDeviceClientMessage({ t: 'device.action_result', actionId: U, state: 'done', result: { exit: 0 }, sig: B64 }).ok).toBe(true);
    expect(parseDeviceClientMessage({ t: 'wake.sent', wakeId: U, ok: true }).ok).toBe(true);
    const r = parseDeviceClientMessage({ t: 'device.challenge', serverChallenge: B32, ts: 1 });
    expect(r.ok === false && r.code).toBe('unknown_type');
    expect(parseDeviceClientMessage({ t: 'assist.hello' }).ok).toBe(false);
  });
  it('S->D messages parse on the device side', () => {
    expect(parseDeviceServerMessage({ t: 'device.challenge', serverChallenge: B32, ts: 1 }).ok).toBe(true);
    expect(
      parseDeviceServerMessage({
        t: 'device.session_open',
        sessionId: U,
        assist: { name: 'T' },
        reason: 'r',
        unattended: true,
        decision: 'auto_grant',
        policy: DEFAULT_UNATTENDED_POLICY,
        recordingMode: 'assist_only',
        workerCredential: B32,
        workerCredentialExpiresAt: '2026-11-01T10:00:00.000Z',
      }).ok,
    ).toBe(true);
    expect(parseDeviceServerMessage({ t: 'wake.send', wakeId: U, targetMacSealed: { epk: B32, nonce: 'A'.repeat(32), ct: 'A'.repeat(40) } }).ok).toBe(true);
  });
  it('S->A pushes join the /signal server union', () => {
    expect(parseServerSignal({ t: 'device.woke', wakeId: U, deviceId: U2, method: 'wol', via: U, elapsedMs: 10 }).ok).toBe(true);
    expect(parseServerSignal({ t: 'device.wake_failed', wakeId: U, deviceId: U2, cause: 'no_waker' }).ok).toBe(true);
    expect(parseClientSignal({ t: 'device.hello' }).ok).toBe(false);
  });
  it('rule 6.2a: session.local_user_arrived is an S->A push, never a client frame', () => {
    expect(parseServerSignal({ t: 'session.local_user_arrived', sessionId: U, decision: 'continue', levelDroppedTo: 'view' }).ok).toBe(true);
    expect(parseServerSignal({ t: 'session.local_user_arrived', sessionId: U, decision: 'ended', levelDroppedTo: null }).ok).toBe(true);
    // The same fields as the chained desk.event (section 13.3), and no other decision or level.
    expect(parseServerSignal({ t: 'session.local_user_arrived', sessionId: U, decision: 'continue', levelDroppedTo: 'control' }).ok).toBe(false);
    expect(parseServerSignal({ t: 'session.local_user_arrived', sessionId: U, decision: 'dismissed', levelDroppedTo: null }).ok).toBe(false);
    expect(parseServerSignal({ t: 'session.local_user_arrived', sessionId: U, decision: 'continue' }).ok).toBe(false);
    expect(parseClientSignal({ t: 'session.local_user_arrived', sessionId: U, decision: 'continue', levelDroppedTo: null }).ok).toBe(false);
  });
});

describe('desk.hello / session.created (section 4.2, 3.5)', () => {
  it('exactly one of token and workerCredential; handover only beside token', () => {
    expect(parseClientSignal({ t: 'desk.hello', token: 'ia1.x' }).ok).toBe(true);
    expect(parseClientSignal({ t: 'desk.hello', workerCredential: B32 }).ok).toBe(true);
    expect(parseClientSignal({ t: 'desk.hello' }).ok).toBe(false);
    expect(parseClientSignal({ t: 'desk.hello', token: 'ia1.x', workerCredential: B32 }).ok).toBe(false);
    expect(parseClientSignal({ t: 'desk.hello', workerCredential: B32, handover: 'h' }).ok).toBe(false);
    expect(parseClientSignal({ t: 'desk.hello', workerCredential: 'short' }).ok).toBe(false);
  });
  it('P4 session.created carries device and unattended, with a null tokenId', () => {
    const msg = {
      t: 'session.created',
      sessionId: U,
      tokenId: null,
      tier: 'p4_installed',
      state: 'consent_pending',
      consentState: 'pending',
      assist: { id: U2, name: 'T' },
      desk: { label: 'PC' },
      org: { displayName: 'O', accentColor: null, logoData: null },
      polite: true,
      device: { id: U, name: 'PC', keyId: '0123456789abcdef', publicKey: B32 },
      unattended: true,
    };
    expect(parseSignalMessage(msg).ok).toBe(true);
  });
  it('sections 6.2 / 13.2: session.created carries the policy snapshot and who authorised it (both optional)', () => {
    const base = {
      t: 'session.created',
      sessionId: U,
      tokenId: null,
      tier: 'p4_installed',
      state: 'active',
      consentState: 'granted',
      assist: { id: U2, name: 'T' },
      desk: { label: 'PC' },
      org: { displayName: 'O', accentColor: null, logoData: null },
      polite: true,
      unattended: true,
    };
    const full = parseSignalMessage({ ...base, policySnapshot: DEFAULT_UNATTENDED_POLICY, approvedBy: 'policy' });
    expect(full.ok).toBe(true);
    expect(full.ok && full.msg.t === 'session.created' && full.msg.policySnapshot?.mode).toBe('approval_only');
    expect(full.ok && full.msg.t === 'session.created' && full.msg.approvedBy).toBe('policy');
    // Additive: a pre-snapshot session.created still parses, and the snapshot is the full strict policy.
    expect(parseSignalMessage(base).ok).toBe(true);
    expect(parseSignalMessage({ ...base, approvedBy: 'someone' }).ok).toBe(false);
    expect(parseSignalMessage({ ...base, policySnapshot: { mode: 'allow' } }).ok).toBe(false);
  });
});

describe('the device override and the session policy snapshot (sections 6.2, 13.1a, 13.2)', () => {
  const DEVICE = {
    id: U,
    name: 'RECEPTION-01',
    platform: 'windows',
    status: 'enrolled',
    online: true,
    keyId: '0123456789abcdef',
    osVersion: null,
    arch: null,
    agentVersion: null,
    serviceVersion: null,
    groupId: null,
    tags: [],
    capabilities: CAPS,
    interactive: null,
    amt: null,
    tamperState: 'ok',
    lanSegmentHash: null,
    notifyEmail: null,
    lastSeenAt: null,
    firstSeenAt: null,
    enrolledAt: null,
    lastIp: null,
  };
  it('Device carries the stored override as a patch, null, or (additively) not at all', () => {
    expect(deviceSchema.parse({ ...DEVICE, unattendedPolicy: { mode: 'allow', maxUnattendedMinutes: 30 } }).unattendedPolicy).toEqual({
      mode: 'allow',
      maxUnattendedMinutes: 30,
    });
    expect(deviceSchema.parse({ ...DEVICE, unattendedPolicy: null }).unattendedPolicy).toBeNull();
    expect(deviceSchema.parse(DEVICE).unattendedPolicy).toBeUndefined();
    // It is an override (a patch), never a full policy with invented keys.
    expect(deviceSchema.safeParse({ ...DEVICE, unattendedPolicy: { mode: 'sometimes' } }).success).toBe(false);
    expect(deviceSchema.safeParse({ ...DEVICE, unattendedPolicy: { nope: true } }).success).toBe(false);
  });
  it('SessionSummary carries the snapshot and approvedBy of the session, not the device', () => {
    const summary = {
      id: U,
      state: 'ended',
      unattended: true,
      policySnapshot: { ...DEFAULT_UNATTENDED_POLICY, mode: 'allow' },
      approvedBy: 'auto_after_timeout',
      assist: { id: U2, name: 'T' },
      knockedAt: '2026-11-01T10:00:00.000Z',
      startedAt: null,
      endedAt: null,
      endReason: null,
    };
    expect(sessionSummarySchema.parse(summary).policySnapshot?.mode).toBe('allow');
    expect(sessionSummarySchema.parse(summary).approvedBy).toBe('auto_after_timeout');
    const { policySnapshot: _p, approvedBy: _a, ...older } = summary;
    expect(sessionSummarySchema.safeParse(older).success).toBe(true);
    expect(sessionSummarySchema.safeParse({ ...summary, approvedBy: 'the_boss' }).success).toBe(false);
  });
});

describe('the branded installer manifest (sections 12.1, 12.2, 13.4)', () => {
  const BUILD = { arch: 'x64', version: '0.4.0', size: 12345, sha256: H, signed: true, minOs: '10.0.17763' };
  it('file name, wire manifest and the dist manifest with its optional bare file name', () => {
    expect(installerFileName('x64', '0.4.0')).toBe('IndiansAssist-Agent-0.4.0-windows-x64.msi');
    expect(installerFileName('arm64', '1.0.0-rc.1')).toBe('IndiansAssist-Agent-1.0.0-rc.1-windows-arm64.msi');
    expect(installerManifestSchema.parse({ v: 1, builds: [BUILD] }).builds[0]?.arch).toBe('x64');
    // Nothing configured on this node is a valid answer, not an error.
    expect(installerManifestSchema.parse({ v: 1, builds: [] }).builds).toEqual([]);
    expect(installerDistManifestSchema.parse({ v: 1, builds: [{ ...BUILD, file: 'custom.msi' }] }).builds[0]?.file).toBe('custom.msi');
    expect(installerDistManifestSchema.parse({ v: 1, builds: [BUILD] }).builds[0]?.file).toBeUndefined();
  });
  it('refuses a platform that is not a Windows arch, a bad version or a traversing file name', () => {
    expect(installerManifestSchema.safeParse({ v: 1, builds: [{ ...BUILD, arch: 'universal' }] }).success).toBe(false);
    expect(installerManifestSchema.safeParse({ v: 1, builds: [{ ...BUILD, version: 'latest' }] }).success).toBe(false);
    expect(installerManifestSchema.safeParse({ v: 1, builds: [{ ...BUILD, sha256: 'abc' }] }).success).toBe(false);
    // The wire manifest is strict: no `file` leaks the server's layout to the console.
    expect(installerManifestSchema.safeParse({ v: 1, builds: [{ ...BUILD, file: 'a.msi' }] }).success).toBe(false);
    expect(installerDistManifestSchema.safeParse({ v: 1, builds: [{ ...BUILD, file: '../escape.msi' }] }).success).toBe(false);
    expect(installerDistManifestSchema.safeParse({ v: 1, builds: [{ ...BUILD, file: 'sub/dir.msi' }] }).success).toBe(false);
  });
  it('the download names the enrollment token it is audited against', () => {
    expect(installerDownloadQuerySchema.safeParse({ tokenId: U }).success).toBe(true);
    expect(installerDownloadQuerySchema.safeParse({}).success).toBe(false);
    expect(installerDownloadQuerySchema.safeParse({ tokenId: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('P4 audit actions (section 13.3)', () => {
  it('every P4 action is in AUDIT_ACTIONS with exactly one actor', () => {
    for (const a of P4_AUDIT_ACTIONS) {
      expect(AUDIT_ACTIONS).toContain(a);
      expect(['user', 'system', 'desk', 'device']).toContain(P4_ACTION_ACTORS[a]);
    }
  });
  it('session.knock / session.accepted P4 branches', () => {
    expect(auditDataSchema('session.knock').safeParse({ deviceId: U, keyId: '0123456789abcdef' }).success).toBe(true);
    expect(auditDataSchema('session.knock').safeParse({ tokenId: U, deskLabelHash: H, userAgentHash: H }).success).toBe(true);
    expect(auditDataSchema('session.accepted').safeParse({ deviceId: U, unattended: true, reason: 'x', onBehalfOf: null }).success).toBe(true);
    expect(auditDataSchema('session.accepted').safeParse({ deviceId: U, unattended: true, reason: 'x', onBehalfOf: U2 }).success).toBe(false);
  });
  it('elevation.granted.mode and sec.verified.method', () => {
    expect(auditDataSchema('elevation.granted').safeParse({ opId: '0123456789abcdef', elevation: 'admin', claimed: true, mode: 'service' }).success).toBe(true);
    expect(auditDataSchema('sec.verified').safeParse({ sas: '123456', gen: 0, method: 'device_key' }).success).toBe(true);
    expect(auditDataSchema('sec.verified').safeParse({ sas: '123456', gen: 0, method: 'telepathy' }).success).toBe(false);
  });
  it('chain shapes are strict', () => {
    expect(auditDataSchema('session.unattended_started').safeParse({ approvedBy: 'policy', policySnapshot: DEFAULT_UNATTENDED_POLICY, reason: 'r' }).success).toBe(true);
    expect(auditDataSchema('tamper.alert').safeParse({ deviceId: U, eventId: U2, cause: 'stopped', at: 'x', detail: null, extra: 1 }).success).toBe(false);
    expect(auditDataSchema('consent.receipt_sent').safeParse({ sessionId: null, actionIds: [U], channel: 'email', toHash: null, delivered: false, cause: 'no_mailer' }).success).toBe(true);
  });
});
