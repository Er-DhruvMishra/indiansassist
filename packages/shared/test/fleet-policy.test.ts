/**
 * Phase D unattended policy (docs/specs/phase-d-contracts.md sections 6.1, 6.2, rule 9.9): the org / group / device
 * merge with strict re-validation, allowed hours across a time-zone boundary, every row of the section 6.2 decision
 * table and of rule 9.9, and the safe defaults.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UNATTENDED_POLICY,
  decideDeviceAction,
  decideDeviceSession,
  isWithinPolicyWindow,
  nextPolicyWindowStart,
  resolveUnattendedPolicy,
  unattendedPolicyPatchSchema,
  unattendedPolicySchema,
  type UnattendedPolicy,
} from '../src/index.js';

const P = (o: Partial<UnattendedPolicy> = {}): UnattendedPolicy => ({ ...DEFAULT_UNATTENDED_POLICY, ...o });
const present = { state: 'active' as const };
const locked = { state: 'locked' as const };
const none = { state: 'none' as const };
// Monday 2026-11-02 10:00 IST = 04:30 UTC.
const MON_10_IST = new Date('2026-11-02T04:30:00.000Z');
const office = { tz: 'Asia/Kolkata', windows: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }] };

describe('defaults (section 6.1, W42)', () => {
  it('ship safe: approval_only, recording required, pre-login / secure desktop / lock / privacy / AMT off', () => {
    expect(unattendedPolicySchema.parse(DEFAULT_UNATTENDED_POLICY)).toEqual(DEFAULT_UNATTENDED_POLICY);
    expect(DEFAULT_UNATTENDED_POLICY.mode).toBe('approval_only');
    expect(DEFAULT_UNATTENDED_POLICY.recordingRequired).toBe(true);
    for (const k of ['allowLogonScreen', 'allowSecureDesktop', 'allowInputLock', 'allowPrivacyScreen', 'allowAmtSol', 'allowAmtBootRedirect'] as const)
      expect(DEFAULT_UNATTENDED_POLICY[k]).toBe(false);
    expect(DEFAULT_UNATTENDED_POLICY.maxUnattendedMinutes).toBe(120);
  });
  it('every key of a full policy is required; a patch is strict and all-optional', () => {
    const { mode: _m, ...missing } = DEFAULT_UNATTENDED_POLICY;
    void _m;
    expect(unattendedPolicySchema.safeParse(missing).success).toBe(false);
    expect(unattendedPolicySchema.safeParse({ ...DEFAULT_UNATTENDED_POLICY, extra: 1 }).success).toBe(false);
    expect(unattendedPolicyPatchSchema.safeParse({}).success).toBe(true);
    expect(unattendedPolicyPatchSchema.safeParse({ mode: 'allow' }).success).toBe(true);
    expect(unattendedPolicyPatchSchema.safeParse({ nope: true }).success).toBe(false);
    expect(unattendedPolicyPatchSchema.safeParse({ autoAllowAfterSec: 5 }).success).toBe(false);
    expect(unattendedPolicyPatchSchema.safeParse({ maxUnattendedMinutes: 1441 }).success).toBe(false);
  });
  it('allowedHours: IANA zone, from < to, 1..14 windows', () => {
    expect(unattendedPolicySchema.safeParse(P({ allowedHours: office })).success).toBe(true);
    expect(unattendedPolicySchema.safeParse(P({ allowedHours: { tz: 'Mars/Olympus', windows: office.windows } })).success).toBe(false);
    expect(unattendedPolicySchema.safeParse(P({ allowedHours: { tz: 'UTC', windows: [{ days: [1], from: '22:00', to: '06:00' }] } })).success).toBe(false);
    expect(unattendedPolicySchema.safeParse(P({ allowedHours: { tz: 'UTC', windows: [] } })).success).toBe(false);
  });
});

describe('resolveUnattendedPolicy (section 2.2)', () => {
  it('device override ?? group ?? org default, key by key', () => {
    const org = P({ mode: 'deny', maxUnattendedMinutes: 30 });
    const r = resolveUnattendedPolicy({ unattendedPolicy: { allowLogonScreen: true } }, { defaultPolicy: { mode: 'allow', recordingRequired: false } }, org);
    expect(r.mode).toBe('allow');
    expect(r.recordingRequired).toBe(false);
    expect(r.allowLogonScreen).toBe(true);
    expect(r.maxUnattendedMinutes).toBe(30);
  });
  it('no group / no override falls back to the org default; null org falls back to the shipped default', () => {
    expect(resolveUnattendedPolicy(null, null, P({ mode: 'allow' })).mode).toBe('allow');
    expect(resolveUnattendedPolicy({ unattendedPolicy: null }, { defaultPolicy: {} }, null)).toEqual(DEFAULT_UNATTENDED_POLICY);
  });
  it('re-validates the merge strictly', () => {
    expect(() => resolveUnattendedPolicy({ unattendedPolicy: { mode: 'sometimes' } as never }, null, P())).toThrow();
  });
});

describe('isWithinPolicyWindow (section 6.1)', () => {
  it('null hours = any time', () => {
    expect(isWithinPolicyWindow(P(), new Date('2026-11-01T03:00:00Z'))).toBe(true);
  });
  it('evaluates in the policy time zone, not UTC (Monday 10:00 IST is Monday 04:30 UTC)', () => {
    const p = P({ allowedHours: office });
    expect(isWithinPolicyWindow(p, MON_10_IST)).toBe(true);
    // Monday 08:30 IST (03:00 UTC): before the window although UTC is a weekday morning.
    expect(isWithinPolicyWindow(p, new Date('2026-11-02T03:00:00Z'))).toBe(false);
    // Friday 23:30 UTC is Saturday 05:00 IST: the day boundary differs between the zones.
    expect(isWithinPolicyWindow(P({ allowedHours: { tz: 'Asia/Kolkata', windows: [{ days: [6], from: '04:00', to: '06:00' }] } }), new Date('2026-11-06T23:30:00Z'))).toBe(true);
    // `to` is exclusive: 18:00 IST = 12:30 UTC.
    expect(isWithinPolicyWindow(p, new Date('2026-11-02T12:30:00Z'))).toBe(false);
    expect(isWithinPolicyWindow(p, new Date('2026-11-02T12:29:00Z'))).toBe(true);
  });
  it('nextPolicyWindowStart finds the next opening', () => {
    const p = P({ allowedHours: office });
    // Saturday 2026-11-07 12:00 UTC -> Monday 09:00 IST = Monday 03:30 UTC.
    expect(nextPolicyWindowStart(p, new Date('2026-11-07T12:00:00Z'))?.toISOString()).toBe('2026-11-09T03:30:00.000Z');
    expect(nextPolicyWindowStart(P(), new Date())).toBeNull();
  });
});

describe('decideDeviceSession: every row of the section 6.2 table', () => {
  const d = (unattended: boolean, policy: UnattendedPolicy, interactive: { state: 'none' | 'locked' | 'active' } | null) =>
    decideDeviceSession({ unattended, policy, interactive, now: MON_10_IST });
  it('attended, any mode, user present -> local_consent', () => {
    for (const mode of ['allow', 'approval_only', 'deny'] as const) expect(d(false, P({ mode }), present)).toEqual({ decision: 'local_consent' });
  });
  it('attended, nobody present -> 409 nobody_present', () => {
    for (const i of [locked, none, null]) expect(d(false, P({ mode: 'allow' }), i)).toEqual({ error: 'nobody_present' });
  });
  it('unattended, deny, any presence -> 409 unattended_denied', () => {
    for (const i of [present, locked, none]) expect(d(true, P({ mode: 'deny' }), i)).toEqual({ error: 'unattended_denied' });
  });
  it('unattended, approval_only, present -> local_approval', () => {
    expect(d(true, P({ mode: 'approval_only' }), present)).toEqual({ decision: 'local_approval' });
  });
  it('unattended, approval_only, nobody present -> 409 approval_required', () => {
    expect(d(true, P({ mode: 'approval_only' }), locked)).toEqual({ error: 'approval_required' });
    expect(d(true, P({ mode: 'approval_only', allowLogonScreen: true }), none)).toEqual({ error: 'approval_required' });
  });
  it('unattended, allow, present and requireLocalApprovalWhenPresent -> local_approval', () => {
    expect(d(true, P({ mode: 'allow', requireLocalApprovalWhenPresent: true }), present)).toEqual({ decision: 'local_approval' });
  });
  it('unattended, allow, present, approval not required -> auto_grant', () => {
    expect(d(true, P({ mode: 'allow', requireLocalApprovalWhenPresent: false }), present)).toEqual({ decision: 'auto_grant' });
  });
  it('unattended, allow, nobody present -> auto_grant', () => {
    expect(d(true, P({ mode: 'allow' }), locked)).toEqual({ decision: 'auto_grant' });
    expect(d(true, P({ mode: 'allow', allowLogonScreen: true }), none)).toEqual({ decision: 'auto_grant' });
  });
  it('then allowedHours (unattended only): 409 outside_policy_window; attended ignores it', () => {
    const night = P({ mode: 'allow', allowedHours: { tz: 'Asia/Kolkata', windows: [{ days: [6, 7], from: '00:00', to: '06:00' }] } });
    expect(d(true, night, locked)).toEqual({ error: 'outside_policy_window' });
    expect(d(false, night, present)).toEqual({ decision: 'local_consent' });
  });
  it('then the pre-login gate: nobody logged on without allowLogonScreen -> 409 prelogin_not_permitted', () => {
    expect(d(true, P({ mode: 'allow' }), none)).toEqual({ error: 'prelogin_not_permitted' });
    // an unknown presence counts as nobody logged on (fail closed)
    expect(d(true, P({ mode: 'allow' }), null)).toEqual({ error: 'prelogin_not_permitted' });
  });
  it('then recorder_required for every P4 session when recording is required and no recorder can be assigned', () => {
    const p = P({ mode: 'allow', recordingRequired: true });
    expect(decideDeviceSession({ unattended: true, policy: p, interactive: locked, now: MON_10_IST, recorderAvailable: false })).toEqual({ error: 'recorder_required' });
    expect(decideDeviceSession({ unattended: false, policy: p, interactive: present, recorderAvailable: false })).toEqual({ error: 'recorder_required' });
    expect(decideDeviceSession({ unattended: true, policy: { ...p, recordingRequired: false }, interactive: locked, now: MON_10_IST, recorderAvailable: false })).toEqual({ decision: 'auto_grant' });
  });
  it('the table answer wins over the later checks (order of section 6.2)', () => {
    const p = P({ mode: 'deny', allowedHours: { tz: 'UTC', windows: [{ days: [7], from: '00:00', to: '00:01' }] } });
    expect(decideDeviceSession({ unattended: true, policy: p, interactive: none, now: MON_10_IST, recorderAvailable: false })).toEqual({ error: 'unattended_denied' });
  });
});

describe('decideDeviceAction: rule 9.9', () => {
  const a = (stage: 'queue' | 'dispatch', policy: UnattendedPolicy, interactive: { state: 'none' | 'locked' | 'active' } | null, kind: 'playbook_run' | 'file_push' | 'print' | 'message' = 'playbook_run', privileged = false) =>
    decideDeviceAction({ stage, kind, privileged, policy, interactive, now: MON_10_IST });
  it('at POST: deny refuses every kind except message', () => {
    for (const k of ['playbook_run', 'file_push', 'print'] as const) expect(a('queue', P({ mode: 'deny' }), present, k)).toEqual({ outcome: 'refuse', error: 'unattended_denied' });
    expect(a('queue', P({ mode: 'deny' }), present, 'message')).toEqual({ outcome: 'accept' });
    expect(a('queue', P({ mode: 'approval_only' }), none)).toEqual({ outcome: 'accept' });
  });
  it('at dispatch: deny reached after queueing -> failed policy', () => {
    expect(a('dispatch', P({ mode: 'deny' }), none)).toEqual({ outcome: 'fail', error: 'policy' });
  });
  it('outside allowedHours -> held queued', () => {
    const p = P({ mode: 'allow', allowedHours: { tz: 'UTC', windows: [{ days: [7], from: '00:00', to: '01:00' }] } });
    expect(a('dispatch', p, none)).toEqual({ outcome: 'hold', reason: 'outside_policy_window' });
  });
  it('privileged needs allowPrivileged', () => {
    expect(a('dispatch', P({ mode: 'allow', allowPrivileged: false }), none, 'playbook_run', true)).toEqual({ outcome: 'fail', error: 'policy' });
    expect(a('dispatch', P({ mode: 'allow', allowPrivileged: true }), none, 'playbook_run', true)).toEqual({ outcome: 'run', approvedBy: 'policy', notify: false });
  });
  it('allow + nobody present -> runs (policy)', () => {
    expect(a('dispatch', P({ mode: 'allow' }), locked)).toEqual({ outcome: 'run', approvedBy: 'policy', notify: false });
  });
  it('allow + present, approval not required -> runs with the toast first', () => {
    expect(a('dispatch', P({ mode: 'allow', requireLocalApprovalWhenPresent: false }), present)).toEqual({ outcome: 'run', approvedBy: 'policy', notify: true });
  });
  it('allow + present + requireLocalApprovalWhenPresent -> the approval card, autoAllowAfterSec applies', () => {
    expect(a('dispatch', P({ mode: 'allow', autoAllowAfterSec: 30 }), present)).toEqual({ outcome: 'approval', autoAllowAfterSec: 30, waitForPresence: false });
  });
  it('approval_only -> the card always; with nobody present it waits for someone', () => {
    expect(a('dispatch', P({ mode: 'approval_only', autoAllowAfterSec: 30 }), present)).toEqual({ outcome: 'approval', autoAllowAfterSec: null, waitForPresence: false });
    expect(a('dispatch', P({ mode: 'approval_only' }), none)).toEqual({ outcome: 'approval', autoAllowAfterSec: null, waitForPresence: true });
  });
  it('message is never gated', () => {
    expect(a('dispatch', P({ mode: 'deny' }), present, 'message')).toEqual({ outcome: 'run', approvedBy: 'policy', notify: true });
  });
});
