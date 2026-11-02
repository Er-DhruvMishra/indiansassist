/**
 * Phase F foundation (docs/specs/phase-f-contracts.md section 15.1): every new schema with valid and invalid
 * examples and strictness, the Linux-only `companion`, `deviceMachineSchema` accepting `linux`, the camera messages,
 * the certificate schema, the additive enum values of section 16.2, and every section 13.3 action in AUDIT_ACTIONS
 * with exactly one actor and a strict schema whose keys never name a token, code or reason.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AGENT_CONTROL_EVENT_KINDS,
  AGENT_PLATFORMS,
  API_ERROR_STATUS,
  AUDIT_ACTIONS,
  CAMERA_CLIENT_TYPES,
  CAMERA_STOP_REASONS,
  CAPTURE_CAUSES,
  CAPTURE_PATHS,
  DESK_OSES,
  ERASURE_STATES,
  ERASURE_STEPS,
  F_ACTION_ACTORS,
  F_AUDIT_ACTIONS,
  F_CHAIN_SCHEMAS,
  INSTALLER_FORMATS,
  INTEGRATION_VERIFICATION,
  LIMITS,
  MAIL_KINDS,
  NotBuiltError,
  ORG_SECRET_PURPOSES,
  PARTICIPANT_ROLES,
  PLAYBOOK_INTERPRETERS,
  RESET_OUTCOMES,
  SESSION_END_REASONS,
  SIGNAL_ERROR_CODES,
  WEBRTC_PEERS,
  agentBuildSchema,
  agentControlEventSchema,
  agentDistFileName,
  agentDistManifestSchema,
  agentPortalDistFileName,
  auditDataSchema,
  authOptionsSchema,
  cameraCommit,
  cameraLinkReplySchema,
  cameraSecFrameSchema,
  cameraSecurityCode,
  cameraSnapshotRequestSchema,
  chainDigestPageSchema,
  createGestureRecognizer,
  DEFAULT_GESTURE_CONFIG,
  deviceHelloClientSchema,
  deviceMachineSchema,
  erasureApproveSchema,
  erasureCertificateSchema,
  erasureRequestSchema,
  erasureSigningInput,
  erasureStatusReplySchema,
  formatCameraCode,
  installerBuildSchema,
  installerDownloadQuerySchema,
  installerFileName,
  interactiveStateSchema,
  internalRecordingMetaSchema,
  inviteRequestSchema,
  inviteResendReplySchema,
  inviteResponseSchema,
  mapGestureToOps,
  normaliseCameraCode,
  orgErasureSchema,
  parseClientSignal,
  parseServerSignal,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  residencyReportSchema,
  serviceCapabilitiesSchema,
  signErasureCertificate,
  turnRestCredentials,
  userSchema,
  verifyErasureCertificate,
} from '../src/index.js';

const U = '0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a';
const U2 = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const H = 'a'.repeat(64);
const B32 = 'A'.repeat(43);
const T = '2026-11-02T10:00:00.000Z';
const ok = (s: z.ZodType, v: unknown) => s.safeParse(v).success;

describe('Phase F enums and additive values (section 16.2)', () => {
  it('enums-f lists', () => {
    expect(MAIL_KINDS).toEqual(['invite', 'reset', 'reset_notice', 'break_glass', 'receipt', 'erasure']);
    expect(RESET_OUTCOMES).toEqual(['mailed', 'sso_notice', 'throttled', 'send_failed', 'no_mailer']);
    expect(ERASURE_STATES).toEqual([
      'pending_confirmation',
      'pending_approval',
      'cooling_off',
      'executing',
      'completed',
      'cancelled',
      'expired',
    ]);
    expect(ERASURE_STEPS).toEqual(['freeze', 'stop', 'chain', 'objects', 'rows', 'seal', 'verify', 'certify', 'notify']);
    expect(CAMERA_STOP_REASONS).toContain('permission_denied');
    expect(INSTALLER_FORMATS).toEqual(['msi', 'deb', 'rpm', 'pkg']);
  });
  it('appends to the A-E lists without reordering them', () => {
    expect(PARTICIPANT_ROLES.at(-1)).toBe('camera');
    expect(SESSION_END_REASONS.at(-1)).toBe('org_erased');
    expect(WEBRTC_PEERS).toEqual(['assist', 'recorder', 'camera']);
    expect(CAPTURE_PATHS.slice(-2)).toEqual(['portal', 'sck']);
    expect(CAPTURE_CAUSES.slice(-2)).toEqual(['portal_denied', 'portal_closed']);
    expect(AGENT_CONTROL_EVENT_KINDS.at(-1)).toBe('keep');
    expect(AGENT_PLATFORMS.at(-1)).toBe('macos');
    expect(DESK_OSES.at(-1)).toBe('ios');
    expect(PLAYBOOK_INTERPRETERS.at(-1)).toBe('zsh');
    expect(ORG_SECRET_PURPOSES.at(-1)).toBe('erasure-carry');
    expect(SIGNAL_ERROR_CODES.slice(-3)).toEqual(['camera_link_invalid', 'camera_busy', 'org_erasing']);
  });
  it('LIMITS and the section 2.4 REST codes', () => {
    expect(LIMITS.passwordResetTtlMin).toBe(30);
    expect(LIMITS.erasureSoloCoolingOffDays).toBe(14);
    expect(LIMITS.cameraLinkTtlSec).toBe(600);
    expect(LIMITS.cameraMaxBitrateKbps).toBe(1500);
    expect(API_ERROR_STATUS.reset_invalid).toBe(400);
    expect(API_ERROR_STATUS.org_erasing).toBe(409);
    expect(API_ERROR_STATUS.erasure_confirm_mismatch).toBe(400);
    expect(API_ERROR_STATUS.prelogin_unsupported).toBe(409);
    expect(API_ERROR_STATUS.camera_unrecordable).toBe(409);
  });
  it('the keep control event', () => {
    expect(agentControlEventSchema.safeParse({ t: 'ctl.event', kind: 'keep', ts: 1, kept: true }).success).toBe(true);
    expect(agentControlEventSchema.safeParse({ t: 'ctl.event', kind: 'keep', ts: 1 }).success).toBe(false);
    expect(agentControlEventSchema.safeParse({ t: 'ctl.event', kind: 'capture', ts: 1, monitorId: 1, path: 'portal', cause: 'portal_closed' }).success).toBe(
      true,
    );
  });
  it('TURN principal camera:<id>', () => {
    const c = turnRestCredentials({ secret: 's', principal: `camera:${U}`, ttlSeconds: 60, nowMs: 0 });
    expect(c.username).toBe(`60:camera:${U}`);
  });
});

describe('agent download and installers (sections 8.11, 9.2, 17.8)', () => {
  const build = { platform: 'linux', arch: 'x64', version: '0.5.0', size: 1, sha256: H, signed: false, minOs: 'glibc 2.35' };
  it('companion is Linux only', () => {
    expect(ok(agentBuildSchema, build)).toBe(true);
    expect(ok(agentBuildSchema, { ...build, companion: { sha256: H, size: 10 } })).toBe(true);
    expect(ok(agentBuildSchema, { ...build, platform: 'windows', companion: { sha256: H, size: 10 } })).toBe(false);
    expect(ok(agentBuildSchema, { ...build, companion: { sha256: H, size: 10, extra: 1 } })).toBe(false);
    expect(ok(agentDistManifestSchema, { v: 1, builds: [{ ...build, platform: 'windows', companion: { sha256: H, size: 1 } }] })).toBe(false);
    expect(ok(agentDistManifestSchema, { v: 1, builds: [{ ...build, companion: { sha256: H, size: 1 }, file: 'x' }] })).toBe(true);
  });
  it('file names', () => {
    expect(agentPortalDistFileName('0.5.0')).toBe('IndiansAssist-linux-portal-x64-0.5.0');
    expect(agentDistFileName('macos', 'arm64', '0.5.0')).toBe('IndiansAssist-macos-arm64-0.5.0.app.zip');
    expect(agentDistFileName('linux', 'x64', '0.5.0')).toBe('IndiansAssist-linux-x64-0.5.0');
    expect(installerFileName('x64', '0.5.0')).toBe('IndiansAssist-Agent-0.5.0-windows-x64.msi');
    expect(installerFileName('x64', '0.5.0', 'deb')).toBe('IndiansAssist-Agent-0.5.0-linux-x64.deb');
    expect(installerFileName('x64', '0.5.0', 'rpm')).toBe('IndiansAssist-Agent-0.5.0-linux-x64.rpm');
    expect(installerFileName('arm64', '0.5.0', 'pkg')).toBe('IndiansAssist-Agent-0.5.0-macos-arm64.pkg');
  });
  it('installer platform and format are optional', () => {
    const ib = { arch: 'x64', version: '0.5.0', size: 1, sha256: H, signed: false, minOs: '' };
    expect(ok(installerBuildSchema, ib)).toBe(true);
    expect(ok(installerBuildSchema, { ...ib, platform: 'linux', format: 'deb' })).toBe(true);
    expect(ok(installerBuildSchema, { ...ib, format: 'zip' })).toBe(false);
    expect(ok(installerDownloadQuerySchema, { tokenId: U, format: 'rpm' })).toBe(true);
    expect(ok(installerDownloadQuerySchema, { tokenId: U })).toBe(true);
  });
});

describe('fleet (sections 8.3, 8.7)', () => {
  const caps = {
    monitors: 1,
    elevation: 'user',
    features: ['screen', 'multi_monitor', 'input'],
    encoders: ['vp8', 'vp9'],
    hwEncoder: false,
    interpreters: ['sh'],
    serviceVersion: '0.5.0',
  };
  const machine = {
    name: 'build-box',
    platform: 'linux',
    osVersion: 'Ubuntu 24.04 LTS',
    arch: 'x64',
    serviceVersion: '0.5.0',
    hwFingerprint: H,
    wakeMac: null,
    amt: null,
    capabilities: caps,
    interactive: { state: 'active', idleSec: 3, at: 1, display: 'x11' },
  };
  it('deviceMachineSchema accepts linux, a user-level service and the display type', () => {
    expect(ok(serviceCapabilitiesSchema, caps)).toBe(true);
    expect(ok(deviceMachineSchema, machine)).toBe(true);
    expect(ok(deviceMachineSchema, { ...machine, platform: 'macos' })).toBe(true);
    expect(ok(deviceMachineSchema, { ...machine, platform: 'android' })).toBe(false);
    expect(ok(interactiveStateSchema, { state: 'none', idleSec: null, at: 1, display: null })).toBe(true);
    expect(ok(interactiveStateSchema, { state: 'none', idleSec: null, at: 1 })).toBe(true);
    expect(ok(interactiveStateSchema, { state: 'none', idleSec: null, at: 1, display: 'mir' })).toBe(false);
  });
  it('device.hello client os is optional', () => {
    const client = {
      serviceVersion: '0.5.0',
      agentVersion: '0.5.0',
      osVersion: 'x',
      arch: 'x64',
      capabilities: caps,
      lanSegment: { subnetHash: H, gatewayMacHash: H },
      wakeMac: null,
      amt: null,
      interactive: { state: 'active', idleSec: 0, at: 1 },
    };
    expect(ok(deviceHelloClientSchema, client)).toBe(true);
    expect(ok(deviceHelloClientSchema, { ...client, os: 'linux' })).toBe(true);
    expect(ok(deviceHelloClientSchema, { ...client, os: 'beos' })).toBe(false);
  });
});

describe('camera (section 6)', () => {
  it('code helpers (section 6.2a)', () => {
    expect(normaliseCameraCode('abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN');
    expect(normaliseCameraCode('0OIl 1234 5678')).toBe('0011' + '12345678');
    expect(normaliseCameraCode('ABCD-EFGH-JKMU')).toBeNull();
    expect(normaliseCameraCode('ABCD-EFGH-JKM')).toBeNull();
    expect(formatCameraCode('ABCDEFGHJKMN')).toBe('ABCD-EFGH-JKMN');
    expect(() => formatCameraCode('abc')).toThrow();
  });
  it('the commit and the six-digit security code (section 6.5)', () => {
    const nA = new Uint8Array(32).fill(1);
    const nP = new Uint8Array(32).fill(2);
    expect(cameraCommit(nA)).toMatch(/^[0-9a-f]{64}$/);
    const code = cameraSecurityCode('sha-256 AA:BB', 'sha-256 CC:DD', nA, nP);
    expect(code).toMatch(/^\d{6}$/);
    expect(cameraSecurityCode('sha-256 AA:BB', 'sha-256 CC:DD', nA, nP)).toBe(code);
    expect(cameraSecurityCode('sha-256 AA:BB', 'sha-256 CC:DE', nA, nP)).not.toBe(code);
    expect(() => cameraSecurityCode('a', 'b', new Uint8Array(31), nP)).toThrow();
    expect(ok(cameraSecFrameSchema, { t: 'commit', c: H })).toBe(true);
    expect(ok(cameraSecFrameSchema, { t: 'nonce', n: B32 })).toBe(true);
    expect(ok(cameraSecFrameSchema, { t: 'reveal', n: B32, x: 1 })).toBe(false);
  });
  it('REST shapes', () => {
    expect(ok(cameraLinkReplySchema, { cameraId: U, url: 'https://x/c/ABCDEFGHJKMN', code: 'ABCDEFGHJKMN', expiresAt: T })).toBe(true);
    expect(ok(cameraLinkReplySchema, { cameraId: U, url: 'x', code: 'ABCD-EFGH-JKMN', expiresAt: T })).toBe(false);
    expect(ok(cameraSnapshotRequestSchema, { sha256: H, width: 1280, height: 720 })).toBe(true);
    expect(ok(cameraSnapshotRequestSchema, { sha256: H, width: 0, height: 720 })).toBe(false);
  });
  it('signal messages are joined into the unions', () => {
    expect(parseClientSignal({ t: 'camera.hello', code: 'ABCD-EFGH-JKMN' }).ok).toBe(true);
    expect(parseClientSignal({ t: 'camera.hello', resumeKey: B32 }).ok).toBe(true);
    expect(parseClientSignal({ t: 'camera.hello', code: 'x', resumeKey: B32 }).ok).toBe(false);
    expect(parseClientSignal({ t: 'camera.hello' }).ok).toBe(false);
    expect(parseClientSignal({ t: 'camera.ready', cameraId: U, width: 1280, height: 720, facing: 'environment' }).ok).toBe(true);
    expect(parseClientSignal({ t: 'camera.stop', cameraId: U, reason: 'declined' }).ok).toBe(true);
    expect(parseClientSignal({ t: 'webrtc.offer', sessionId: U, sdp: 'v=0', peer: 'camera' }).ok).toBe(true);
    const helloOk = {
      t: 'camera.hello.ok',
      cameraId: U,
      sessionId: U2,
      org: { displayName: 'Acme' },
      technician: { name: 'Asha' },
      iceServers: [{ urls: ['stun:example.test'] }],
      resumeKey: B32,
      limits: { maxBitrateKbps: 1500 },
      recording: { server: false, console: true },
    };
    expect(parseServerSignal(helloOk).ok).toBe(true);
    expect(parseServerSignal({ ...helloOk, recording: { server: false } }).ok).toBe(false);
    expect(parseServerSignal({ t: 'camera.state', cameraId: U, state: 'live' }).ok).toBe(true);
    expect(parseServerSignal({ t: 'camera.closed', reason: 'session_ended' }).ok).toBe(true);
    expect(parseServerSignal({ t: 'recorder.camera', sessionId: U, cameraId: U2 }).ok).toBe(true);
    expect(parseClientSignal(helloOk).ok).toBe(false);
    expect(CAMERA_CLIENT_TYPES).toEqual(['camera.hello', 'camera.ready', 'camera.stop', 'webrtc.offer', 'webrtc.answer', 'webrtc.ice', 'ping', 'pong']);
  });
  it('recorder camera support and the internal meta (section 6.5a)', () => {
    const hello = { t: 'recorder.hello', token: 't', recorderId: 'rec-1', version: '1', region: 'in-mum' };
    expect(parseClientSignal(hello).ok).toBe(true);
    expect(parseClientSignal({ ...hello, features: ['camera'] }).ok).toBe(true);
    expect(parseClientSignal({ ...hello, features: ['teleport'] }).ok).toBe(false);
    const meta = { sessionId: U, recorderId: 'rec-1', mime: 'video/webm', durationMs: 1, bytes: 1, sha256: H };
    expect(ok(internalRecordingMetaSchema, meta)).toBe(true);
    expect(ok(internalRecordingMetaSchema, { ...meta, source: 'camera', cameraId: U2 })).toBe(true);
    expect(ok(internalRecordingMetaSchema, { ...meta, source: 'camera' })).toBe(false);
    expect(ok(internalRecordingMetaSchema, { ...meta, cameraId: U2 })).toBe(false);
    expect(ok(internalRecordingMetaSchema, { ...meta, source: 'desk' })).toBe(true);
    expect(auditDataSchema('recording.stored').safeParse({ recordingId: U, sha256: H, bytes: 1, mime: 'video/webm', storageKey: 'k', source: 'server', cameraId: U2 }).success).toBe(
      true,
    );
    expect(auditDataSchema('recording.started').safeParse({}).success).toBe(true);
    expect(auditDataSchema('recording.started').safeParse({ cameraId: 'nope' }).success).toBe(false);
  });
});

describe('mail (section 4)', () => {
  it('REST shapes', () => {
    expect(ok(authOptionsSchema, { passwordReset: true, inviteMail: false })).toBe(true);
    expect(ok(authOptionsSchema, { passwordReset: true })).toBe(false);
    expect(ok(passwordResetRequestSchema, { email: 'a@example.test' })).toBe(true);
    expect(ok(passwordResetRequestSchema, { email: '' })).toBe(false);
    expect(ok(passwordResetConfirmSchema, { token: B32, newPassword: 'correct horse battery' })).toBe(true);
    expect(ok(passwordResetConfirmSchema, { token: 'short', newPassword: 'correct horse battery' })).toBe(false);
    expect(ok(passwordResetConfirmSchema, { token: B32, newPassword: 'short' })).toBe(false);
    expect(ok(inviteResendReplySchema, { inviteUrl: 'https://x/invite#i=y', mailed: false, inviteExpiresAt: T })).toBe(true);
    expect(ok(inviteRequestSchema, { email: 'a@example.test', name: 'A', role: 'technician', sendEmail: false })).toBe(true);
    const user = { id: U, orgId: U2, email: 'a@example.test', name: 'A', role: 'technician', status: 'invited', createdAt: T, lastLoginAt: null };
    expect(ok(userSchema, { ...user, inviteMailedAt: T })).toBe(true);
    expect(ok(userSchema, { ...user, inviteMailedAt: null })).toBe(true);
    expect(ok(inviteResponseSchema, { user, inviteUrl: 'x', mailed: true })).toBe(true);
    expect(ok(inviteResponseSchema, { user, inviteUrl: 'x' })).toBe(true);
  });
});

describe('erasure (section 5)', () => {
  const erasure = {
    id: U,
    state: 'cooling_off',
    requestedBy: { id: U2, name: 'Asha' },
    requestedAt: T,
    approvedBy: { id: U, name: 'Ravi' },
    approvedAt: T,
    coolingOffUntil: T,
    cancelledBy: null,
    cancelledAt: null,
    executedAt: null,
    completedAt: null,
    certificateUrl: `https://api.example.test/api/v1/erasures/${U}/certificate`,
  };
  it('REST shapes', () => {
    expect(ok(orgErasureSchema, erasure)).toBe(true);
    expect(ok(orgErasureSchema, { ...erasure, state: 'paused' })).toBe(false);
    expect(ok(orgErasureSchema, { ...erasure, reason: 'x' })).toBe(false);
    expect(ok(erasureStatusReplySchema, { erasure: null })).toBe(true);
    expect(ok(erasureStatusReplySchema, { notice: { state: 'cooling_off', coolingOffUntil: T, certificateUrl: null } })).toBe(true);
    expect(ok(erasureStatusReplySchema, { notice: { state: 'cooling_off', coolingOffUntil: T, certificateUrl: null, requestedBy: 'x' } })).toBe(false);
    expect(ok(erasureRequestSchema, { confirmSlug: 'acme', solo: true })).toBe(true);
    expect(ok(erasureRequestSchema, { confirmSlug: 'acme', reason: 'x'.repeat(501) })).toBe(false);
    expect(ok(erasureApproveSchema, { confirmSlug: 'Acme Corp' })).toBe(false);
    expect(ok(chainDigestPageSchema, { items: [{ seq: 1, hash: H, prevHash: H }], nextAfter: null })).toBe(true);
    expect(ok(chainDigestPageSchema, { items: [{ seq: 1, hash: H, prevHash: H, action: 'x' }], nextAfter: null })).toBe(false);
  });
  it('the residency erasure block is widened (section 5.7)', () => {
    const note =
      "Erasure destroys this organisation's personal data and the audit pepper after two administrators approve it and a 7-day cooling-off period (an organisation with a single administrator: a mailed confirmation and a 14-day cooling-off period). Technician display names and typed reasons stay in the audit chain.";
    const shape = residencyReportSchema.shape.erasure.unwrap();
    expect(ok(shape, { available: true, state: 'none', scheduledFor: null, note })).toBe(true);
    expect(ok(shape, { available: false, note: 'x' })).toBe(true);
    expect(ok(shape, { available: true, state: 'later', note: 'x' })).toBe(false);
  });
  it('the certificate schema; signing and verifying are the erasure stream', async () => {
    const entry = {
      seq: 9,
      org_id: U,
      session_id: null,
      actor: { id: null, label: 'system', type: 'system' },
      action: 'org.erased',
      reason: null,
      region: 'in-mum',
      ts: T,
      data: { erasureId: U2, entriesBefore: 8, counts: {} },
      prev_hash: H,
      hash: H,
    };
    const cert = {
      v: 1,
      erasureId: U2,
      orgId: U,
      region: 'in-mum',
      requestedAt: T,
      approvedAt: T,
      executedAt: T,
      completedAt: T,
      chain: { entries: 9, tail: H, verified: true, failure: null, finalEntry: entry },
      deleted: { auth_session: 4, recordingObjects: 2 },
      scrubbed: { user: 3 },
      objectBytes: 1024,
      externalFlows: ['mail'],
      backups: 'backup retention not stated',
      signature: { alg: 'Ed25519', domain: 'ia-erasure-v1', kid: '0123456789abcdef', pub: 'AA', sig: 'A'.repeat(86), sha256: H, signedAt: T },
    };
    expect(ok(erasureCertificateSchema, cert)).toBe(true);
    expect(ok(erasureCertificateSchema, { ...cert, v: 2 })).toBe(false);
    expect(ok(erasureCertificateSchema, { ...cert, externalFlows: ['carrier_pigeon'] })).toBe(false);
    expect(ok(erasureCertificateSchema, { ...cert, signature: { ...cert.signature, domain: 'ia-residency-v1' } })).toBe(false);
    expect(ok(erasureCertificateSchema, { ...cert, chain: { ...cert.chain, extra: 1 } })).toBe(false);
    expect(() => erasureSigningInput(cert)).toThrow(NotBuiltError);
    expect(() => verifyErasureCertificate(cert, [])).toThrow(NotBuiltError);
    await expect(signErasureCertificate(cert as never, '00'.repeat(32), '0123456789abcdef')).rejects.toThrow(NotBuiltError);
  });
});

describe('touch gestures (section 7.2): types and thresholds only', () => {
  it('the mobile stream fills the recognizer and the mapping', () => {
    expect(DEFAULT_GESTURE_CONFIG.longPressMs).toBe(500);
    expect(DEFAULT_GESTURE_CONFIG.pinchRatio).toBe(0.15);
    expect(() => createGestureRecognizer(DEFAULT_GESTURE_CONFIG, { zoom: 1, trackpad: false, scrollWhileZoomed: false })).toThrow(NotBuiltError);
    expect(() => mapGestureToOps({ kind: 'tap', x: 0.5, y: 0.5 }, { kind: 'native', control: true })).toThrow(NotBuiltError);
  });
});

describe('integration verification record (section 3.3 V4)', () => {
  it('every vendor type is present and unverified until the fixes stream fills it', () => {
    expect(Object.keys(INTEGRATION_VERIFICATION).sort()).toEqual(['freshdesk', 'jira', 'servicenow', 'zoho_desk']);
    for (const v of Object.values(INTEGRATION_VERIFICATION)) expect(v).toEqual({ verified: false, sources: [], unconfirmed: [] });
  });
});

describe('Phase F audit actions (section 13.3)', () => {
  it('every action is in AUDIT_ACTIONS with exactly one actor and a strict schema', () => {
    expect(F_AUDIT_ACTIONS).toHaveLength(16);
    for (const a of F_AUDIT_ACTIONS) {
      expect(AUDIT_ACTIONS).toContain(a);
      expect(['user', 'system', 'desk']).toContain(F_ACTION_ACTORS[a]);
      const schema = F_CHAIN_SCHEMAS[a] as unknown as z.ZodObject;
      expect(schema.safeParse({ __extra: 1 }).success).toBe(false);
    }
    expect(Object.keys(F_ACTION_ACTORS).sort()).toEqual([...F_AUDIT_ACTIONS].sort());
    expect(F_ACTION_ACTORS['camera.started']).toBe('desk');
    expect(F_ACTION_ACTORS['org.erased']).toBe('system');
  });
  it('no chain schema has a key named like a token, code, secret, password, email or reason', () => {
    for (const a of F_AUDIT_ACTIONS) {
      const keys = Object.keys((F_CHAIN_SCHEMAS[a] as unknown as z.ZodObject).shape);
      for (const k of keys) expect(k, `${a}.${k}`).not.toMatch(/token|code|secret|password|email|reason|link|url/i);
    }
  });
  it('valid and invalid examples', () => {
    expect(auditDataSchema('user.invite_mailed').safeParse({ userId: U, delivered: false, cause: 'no_mailer' }).success).toBe(true);
    expect(auditDataSchema('auth.password_reset_requested').safeParse({ userId: U, outcome: 'throttled' }).success).toBe(true);
    expect(auditDataSchema('auth.password_reset_requested').safeParse({ userId: U, outcome: 'unknown' }).success).toBe(false);
    expect(auditDataSchema('org.erasure_requested').safeParse({ erasureId: U, solo: false }).success).toBe(true);
    expect(auditDataSchema('org.erasure_cancelled').safeParse({ erasureId: U, fromState: 'executing' }).success).toBe(false);
    const counts = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`t${i}`, 1]));
    expect(auditDataSchema('org.erased').safeParse({ erasureId: U, entriesBefore: 3, counts: { user: 2 } }).success).toBe(true);
    expect(auditDataSchema('org.erased').safeParse({ erasureId: U, entriesBefore: 3, counts }).success).toBe(false);
    expect(auditDataSchema('camera.started').safeParse({ cameraId: U, width: 1280, height: 720, facing: 'environment' }).success).toBe(true);
    expect(auditDataSchema('camera.ended').safeParse({ cameraId: U, by: 'assist', durationMs: null }).success).toBe(true);
    expect(auditDataSchema('camera.snapshot').safeParse({ cameraId: U, sha256: 'x', width: 1, height: 1 }).success).toBe(false);
    expect(auditDataSchema('download.served').safeParse({ tokenId: U, platform: 'linux', arch: 'x64', version: '0.5.0', sha256: H, companion: true, format: 'deb' }).success).toBe(
      true,
    );
  });
});
