/**
 * Phase D unattended policy and the consent decisions (docs/specs/phase-d-contracts.md sections 6.1, 6.2, rule 9.9).
 * `decideDeviceSession` is the section 6.2 table and `decideDeviceAction` rule 9.9: one implementation the api uses
 * and the Rust parity fixture checks. Strict schemas: every key of a full policy is required (`allowedHours` and
 * `autoAllowAfterSec` are the only nullable keys); a patch has the same keys, all optional.
 */
import { z } from 'zod';
import { LIMITS, UNATTENDED_MODES, type ConsentDecision, type DeviceActionKind } from '../enums.js';
import type { InteractiveStateName } from '../enums-p4.js';

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** True for an IANA zone the runtime knows (`Asia/Kolkata`, `UTC`, ...). */
export function isTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const policyWindowSchema = z
  .strictObject({
    days: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((d) => new Set(d).size === d.length, 'days must be unique'),
    from: z.string().regex(HHMM_RE, 'HH:MM'),
    to: z.string().regex(HHMM_RE, 'HH:MM'),
  })
  .refine((w) => w.from < w.to, 'from must be before to (write an overnight window as two windows)');

export const allowedHoursSchema = z.strictObject({
  tz: z.string().refine(isTimeZone, 'an IANA time zone'),
  windows: z.array(policyWindowSchema).min(1).max(14),
});
export type AllowedHours = z.infer<typeof allowedHoursSchema>;

const policyShape = {
  mode: z.enum(UNATTENDED_MODES),
  requireLocalApprovalWhenPresent: z.boolean(),
  autoAllowAfterSec: z.number().int().min(10).max(120).nullable(),
  allowedHours: allowedHoursSchema.nullable(),
  recordingRequired: z.boolean(),
  allowLogonScreen: z.boolean(),
  allowSecureDesktop: z.boolean(),
  allowPrivileged: z.boolean(),
  allowInputLock: z.boolean(),
  allowPrivacyScreen: z.boolean(),
  allowAmtSol: z.boolean(),
  allowAmtBootRedirect: z.boolean(),
  notifyLocalUser: z.boolean(),
  maxUnattendedMinutes: z.number().int().min(0).max(LIMITS.maxUnattendedMinutesCap),
};

/** `UnattendedPolicy` (section 6.1), strict, every key required. */
export const unattendedPolicySchema = z.strictObject(policyShape);
export type UnattendedPolicy = z.infer<typeof unattendedPolicySchema>;

/** A group's `default_policy` / a device's override: the same keys and rules, all optional, strict. */
export const unattendedPolicyPatchSchema = z.strictObject(
  Object.fromEntries(Object.entries(policyShape).map(([k, v]) => [k, v.optional()])) as {
    [K in keyof typeof policyShape]: z.ZodOptional<(typeof policyShape)[K]>;
  },
);
export type UnattendedPolicyPatch = z.infer<typeof unattendedPolicyPatchSchema>;

/** The org default (section 6.1): approval required until an admin opts a group into `allow` (W42). */
export const DEFAULT_UNATTENDED_POLICY: UnattendedPolicy = Object.freeze({
  mode: 'approval_only',
  requireLocalApprovalWhenPresent: true,
  autoAllowAfterSec: null,
  allowedHours: null,
  recordingRequired: true,
  allowLogonScreen: false,
  allowSecureDesktop: false,
  allowPrivileged: true,
  allowInputLock: false,
  allowPrivacyScreen: false,
  allowAmtSol: false,
  allowAmtBootRedirect: false,
  notifyLocalUser: true,
  maxUnattendedMinutes: 120,
}) as UnattendedPolicy;

/** Drops keys whose value is `undefined` (a patch never overrides with undefined). */
function definedOnly(o: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!o || typeof o !== 'object') return out;
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * `device override ?? group ?? org default` (section 2.2): `{ ...orgDefault, ...group.defaultPolicy,
 * ...device.unattendedPolicy }`, re-validated with the full schema (throws ZodError on an invalid combination).
 */
export function resolveUnattendedPolicy(
  device: { unattendedPolicy?: UnattendedPolicyPatch | Record<string, unknown> | null } | null,
  group: { defaultPolicy?: UnattendedPolicyPatch | Record<string, unknown> | null } | null,
  orgDefault: UnattendedPolicy | Record<string, unknown> | null,
): UnattendedPolicy {
  return unattendedPolicySchema.parse({
    ...DEFAULT_UNATTENDED_POLICY,
    ...definedOnly(orgDefault as Record<string, unknown>),
    ...definedOnly(group?.defaultPolicy as Record<string, unknown>),
    ...definedOnly(device?.unattendedPolicy as Record<string, unknown>),
  });
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** ISO weekday (Mon = 1) and `HH:MM` of `now` in `tz`. */
export function localDayTime(now: Date, tz: string): { day: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour').padStart(2, '0');
  return { day: WEEKDAY[get('weekday')] ?? 1, hhmm: `${hour}:${get('minute').padStart(2, '0')}` };
}

/** Section 6.1: `null` hours = any time; otherwise inside at least one window (`from` inclusive, `to` exclusive). */
export function isWithinPolicyWindow(policy: Pick<UnattendedPolicy, 'allowedHours'>, now: Date = new Date()): boolean {
  const h = policy.allowedHours;
  if (!h) return true;
  const { day, hhmm } = localDayTime(now, h.tz);
  return h.windows.some((w) => w.days.includes(day) && w.from <= hhmm && hhmm < w.to);
}

/** The next window start after `now` (ms), or null for "any time" / no window (used to hold queued actions). */
export function nextPolicyWindowStart(policy: Pick<UnattendedPolicy, 'allowedHours'>, now: Date = new Date()): Date | null {
  const h = policy.allowedHours;
  if (!h) return null;
  // Minute resolution over the next 8 days is exact enough and needs no tz arithmetic.
  const start = Math.ceil(now.getTime() / 60_000) * 60_000;
  for (let t = start; t < start + 8 * 86_400_000; t += 60_000) {
    const d = new Date(t);
    if (isWithinPolicyWindow(policy, d)) return d;
  }
  return null;
}

export type InteractiveLike = { state: InteractiveStateName } | null | undefined;

/** "Present" (section 3.4): a user is logged on and unlocked at the console. */
export function isPresent(interactive: InteractiveLike): boolean {
  return interactive?.state === 'active';
}

export type DeviceSessionRefusal =
  | 'nobody_present'
  | 'unattended_denied'
  | 'approval_required'
  | 'outside_policy_window'
  | 'prelogin_not_permitted'
  | 'recorder_required';

export type DeviceSessionDecision = { decision: ConsentDecision; error?: undefined } | { error: DeviceSessionRefusal; decision?: undefined };

/**
 * Section 6.2 (after the caller's `device_offline` / `device_busy` checks): the table, then for unattended sessions
 * `allowedHours` and the pre-login gate (an unknown `interactive` counts as nobody logged on, the safer reading), then
 * for every P4 session `recorder_required` when the policy requires recording and `recorderAvailable` is false.
 */
export function decideDeviceSession(p: {
  unattended: boolean;
  policy: UnattendedPolicy;
  interactive: InteractiveLike;
  now?: Date;
  recorderAvailable?: boolean;
}): DeviceSessionDecision {
  const { policy } = p;
  const present = isPresent(p.interactive);
  let decision: ConsentDecision;
  if (!p.unattended) {
    if (!present) return { error: 'nobody_present' };
    decision = 'local_consent';
  } else if (policy.mode === 'deny') {
    return { error: 'unattended_denied' };
  } else if (policy.mode === 'approval_only') {
    if (!present) return { error: 'approval_required' };
    decision = 'local_approval';
  } else {
    decision = present && policy.requireLocalApprovalWhenPresent ? 'local_approval' : 'auto_grant';
  }
  if (p.unattended) {
    if (!isWithinPolicyWindow(policy, p.now ?? new Date())) return { error: 'outside_policy_window' };
    if ((p.interactive?.state ?? 'none') === 'none' && !policy.allowLogonScreen) return { error: 'prelogin_not_permitted' };
  }
  if (policy.recordingRequired && p.recorderAvailable === false) return { error: 'recorder_required' };
  return { decision };
}

/**
 * Rule 9.9. `stage: 'queue'` is the `POST` check (only `mode = deny` refuses, for every kind except `message`);
 * `stage: 'dispatch'` runs at dispatch and again on the device before running:
 * - `hold`: outside `allowedHours` (stays `queued` until the next window start, or expires);
 * - `fail`: `deny` reached after queueing, or a privileged action without `allowPrivileged`;
 * - `run`: `allow` with nobody present, or present and approval not required (`notify`: show the toast first);
 * - `approval`: the action approval card (`waitForPresence`: nobody is present, wait in `awaiting_approval`).
 * `message` is never gated (it executes nothing); it runs with `approvedBy: 'policy'`.
 */
export type DeviceActionDecision =
  | { outcome: 'accept' }
  | { outcome: 'refuse'; error: 'unattended_denied' }
  | { outcome: 'hold'; reason: 'outside_policy_window' }
  | { outcome: 'fail'; error: 'policy' }
  | { outcome: 'run'; approvedBy: 'policy'; notify: boolean }
  | { outcome: 'approval'; autoAllowAfterSec: number | null; waitForPresence: boolean };

export function decideDeviceAction(p: {
  stage: 'queue' | 'dispatch';
  kind: DeviceActionKind;
  privileged: boolean;
  policy: UnattendedPolicy;
  interactive: InteractiveLike;
  now?: Date;
}): DeviceActionDecision {
  const { policy } = p;
  const present = isPresent(p.interactive);
  if (p.kind === 'message') return p.stage === 'queue' ? { outcome: 'accept' } : { outcome: 'run', approvedBy: 'policy', notify: present };
  if (p.stage === 'queue') return policy.mode === 'deny' ? { outcome: 'refuse', error: 'unattended_denied' } : { outcome: 'accept' };
  if (policy.mode === 'deny') return { outcome: 'fail', error: 'policy' };
  if (!isWithinPolicyWindow(policy, p.now ?? new Date())) return { outcome: 'hold', reason: 'outside_policy_window' };
  if (p.privileged && !policy.allowPrivileged) return { outcome: 'fail', error: 'policy' };
  if (policy.mode === 'approval_only') return { outcome: 'approval', autoAllowAfterSec: null, waitForPresence: !present };
  if (!present) return { outcome: 'run', approvedBy: 'policy', notify: false };
  if (!policy.requireLocalApprovalWhenPresent) return { outcome: 'run', approvedBy: 'policy', notify: true };
  return { outcome: 'approval', autoAllowAfterSec: policy.autoAllowAfterSec, waitForPresence: false };
}
