/** Phase A.2 recorder schemas (docs/specs/phase-a2-recorder.md sections 3, 5, 6, 9). */
import { describe, expect, it } from 'vitest';
import {
  assistMayRecord,
  auditDataSchema,
  internalRecordingMetaSchema,
  parseClientSignal,
  parseServerSignal,
  recorderActor,
  recordingPolicySchema,
  serverRecords,
} from '../src/index.js';

const SID = '6f1c0a5e-2b3d-4c8e-9f10-112233445566';
const SHA = 'a'.repeat(64);

describe('recorder signaling schemas', () => {
  it('accepts every recorder message in the right direction only', () => {
    const client = [
      {
        t: 'recorder.hello',
        token: 'x'.repeat(32),
        recorderId: 'rec-1',
        version: '0.1.0',
        region: 'in-mum',
        maxSessions: 8,
      },
      { t: 'recorder.join', sessionId: SID },
      { t: 'recorder.leave', sessionId: SID, reason: 'track_ended' },
      { t: 'webrtc.offer', sessionId: SID, sdp: 'v=0', peer: 'recorder' },
    ];
    for (const m of client) expect(parseClientSignal(JSON.stringify(m)).ok, m.t).toBe(true);
    const server = [
      { t: 'recorder.hello.ok', connectionId: 'c', nodeId: 'n', regions: ['in-mum'] },
      {
        t: 'recorder.assign',
        sessionId: SID,
        orgId: SID,
        region: 'in-mum',
        tier: 'p1_browser',
        recordingMode: 'server',
        resume: false,
        deadlineAt: '2026-10-24T10:00:00.000Z',
      },
      { t: 'recorder.joined', sessionId: SID, resume: true },
      { t: 'recorder.pause', sessionId: SID, reason: 'consent_pending' },
      { t: 'session.recording', sessionId: SID, recording: true, source: 'server' },
      { t: 'webrtc.answer', sessionId: SID, sdp: 'v=0', peer: 'recorder' },
    ];
    for (const m of server) expect(parseServerSignal(JSON.stringify(m)).ok, m.t).toBe(true);
    expect(parseServerSignal(JSON.stringify(client[1])).ok).toBe(false);
    expect(parseClientSignal(JSON.stringify(server[1])).ok).toBe(false);
  });

  it('rejects bad recorder ids, modes and peers', () => {
    expect(
      parseClientSignal(
        JSON.stringify({ t: 'recorder.hello', token: 't', recorderId: 'Rec One', version: '1', region: 'in-mum' }),
      ).ok,
    ).toBe(false);
    expect(parseClientSignal(JSON.stringify({ t: 'recorder.leave', sessionId: SID, reason: 'bored' })).ok).toBe(false);
    expect(
      parseClientSignal(JSON.stringify({ t: 'webrtc.ice', sessionId: SID, candidate: null, peer: 'supervisor' })).ok,
    ).toBe(false);
    const assign = {
      t: 'recorder.assign',
      sessionId: SID,
      orgId: SID,
      region: 'in-mum',
      tier: 'p1_browser',
      recordingMode: 'assist_only',
      resume: false,
      deadlineAt: '2026-10-24T10:00:00.000Z',
    };
    expect(parseServerSignal(JSON.stringify(assign)).ok).toBe(false);
  });
});

describe('recording policy and upload meta', () => {
  it('validates the policy body strictly', () => {
    expect(recordingPolicySchema.safeParse({ recordingMode: 'both' }).success).toBe(true);
    expect(recordingPolicySchema.safeParse({ recordingMode: 'both', extra: 1 }).success).toBe(false);
    expect(assistMayRecord(null)).toBe(true);
    expect(assistMayRecord('server')).toBe(false);
    expect(serverRecords('both')).toBe(true);
    expect(serverRecords('assist_only')).toBe(false);
  });

  it('accepts WebM meta only', () => {
    const meta = {
      sessionId: SID,
      recorderId: 'rec-1',
      mime: 'video/webm;codecs="vp8,opus"',
      durationMs: 10,
      bytes: 5,
      sha256: SHA,
    };
    expect(internalRecordingMetaSchema.safeParse(meta).success).toBe(true);
    expect(internalRecordingMetaSchema.safeParse({ ...meta, mime: 'video/mp4' }).success).toBe(false);
    expect(internalRecordingMetaSchema.safeParse({ ...meta, bytes: 0 }).success).toBe(false);
  });
});

describe('A.2 audit data', () => {
  it('validates server start / stop and the optional source on recording.stored', () => {
    expect(
      auditDataSchema('recording.server_started').safeParse({ recorderId: 'rec-1', recordingMode: 'server' }).success,
    ).toBe(true);
    expect(
      auditDataSchema('recording.server_stopped').safeParse({ recorderId: 'rec-1', reason: 'session_ended' }).success,
    ).toBe(true);
    expect(auditDataSchema('recording.server_stopped').safeParse({ recorderId: 'rec-1', reason: 'x' }).success).toBe(
      false,
    );
    const stored = { recordingId: SID, sha256: SHA, bytes: 1, mime: 'video/webm', storageKey: 'k' };
    expect(auditDataSchema('recording.stored').parse(stored)).toEqual(stored);
    expect(auditDataSchema('recording.stored').safeParse({ ...stored, source: 'server' }).success).toBe(true);
    expect(auditDataSchema('recording.stored').safeParse({ ...stored, source: 'assist' }).success).toBe(false);
    expect(recorderActor('rec-1')).toEqual({ type: 'system', id: 'recorder:rec-1', label: 'recorder' });
  });
});
