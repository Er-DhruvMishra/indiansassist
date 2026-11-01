/**
 * `UnattendedPolicyEditor` client rules (docs/specs/phase-d-contracts.md sections 6.1, 13.4): the field checks the
 * editor runs before it will save, the warnings on dangerous combinations, and the patch a group or device override
 * is reduced to (only the keys that differ from what it inherits, so an override stays a difference and not a copy).
 */
import {
  LIMITS,
  isTimeZone,
  resolveUnattendedPolicy,
  type AllowedHours,
  type UnattendedPolicy,
  type UnattendedPolicyPatch,
} from '@indiansassist/shared';
import { dayName } from './fleetText';

/**
 * Section 6.1 merge order (`{ ...orgDefault, ...group.defaultPolicy, ...device.unattendedPolicy }`), through the one
 * shared implementation. A combination the full schema refuses falls back to what it inherits rather than blanking
 * the screen; `GET /devices/:id` remains the authority for a single device's effective policy.
 */
export function effectivePolicy(
  device: { unattendedPolicy?: UnattendedPolicyPatch | null } | null,
  group: { defaultPolicy?: UnattendedPolicyPatch | null } | null,
  orgDefault: UnattendedPolicy,
): UnattendedPolicy {
  try {
    return resolveUnattendedPolicy(device, group, orgDefault);
  } catch {
    return orgDefault;
  }
}

export const POLICY_KEYS = [
  'mode',
  'requireLocalApprovalWhenPresent',
  'autoAllowAfterSec',
  'allowedHours',
  'recordingRequired',
  'allowLogonScreen',
  'allowSecureDesktop',
  'allowPrivileged',
  'allowInputLock',
  'allowPrivacyScreen',
  'allowAmtSol',
  'allowAmtBootRedirect',
  'notifyLocalUser',
  'maxUnattendedMinutes',
] as const satisfies readonly (keyof UnattendedPolicy)[];

export type PolicyKey = (typeof POLICY_KEYS)[number];

export const POLICY_FIELD_LABELS: Record<PolicyKey, string> = {
  mode: 'Unattended mode',
  requireLocalApprovalWhenPresent: 'Ask for approval when someone is at the device',
  autoAllowAfterSec: 'Auto-allow the approval card after',
  allowedHours: 'Allowed hours',
  recordingRequired: 'Require recording',
  allowLogonScreen: 'Allow the Windows sign-in screen (nobody signed in)',
  allowSecureDesktop: 'Allow security screens (UAC prompts, lock screen)',
  allowPrivileged: 'Allow privileged mode',
  allowInputLock: 'Allow locking the local keyboard and mouse',
  allowPrivacyScreen: 'Allow blanking the local screen',
  allowAmtSol: 'Allow the AMT serial console',
  allowAmtBootRedirect: 'Allow AMT boot redirection',
  notifyLocalUser: 'Show an extra toast when a session starts with nobody approving',
  maxUnattendedMinutes: 'End an unattended session after (minutes)',
};

/**
 * Section 6.1 field rules, checked in the browser so the editor explains itself before the server refuses.
 * The server (and `unattendedPolicySchema`) remains authoritative.
 */
export function policyProblems(p: UnattendedPolicy): string[] {
  const out: string[] = [];
  const auto = p.autoAllowAfterSec;
  if (auto !== null && (!Number.isInteger(auto) || auto < 10 || auto > 120)) out.push('Auto-allow must be between 10 and 120 seconds, or off.');
  const max = p.maxUnattendedMinutes;
  if (!Number.isInteger(max) || max < 0 || max > LIMITS.maxUnattendedMinutesCap)
    out.push(`The unattended time limit must be between 0 and ${LIMITS.maxUnattendedMinutesCap} minutes (0 = no limit).`);
  if (p.allowedHours) out.push(...allowedHoursProblems(p.allowedHours));
  return out;
}

export function allowedHoursProblems(h: AllowedHours): string[] {
  const out: string[] = [];
  if (!isTimeZone(h.tz)) out.push(`"${h.tz}" is not a time zone this browser knows. Use an IANA name such as Asia/Kolkata.`);
  if (h.windows.length === 0) out.push('Add at least one allowed-hours window, or set allowed hours to any time.');
  if (h.windows.length > 14) out.push('At most 14 allowed-hours windows.');
  h.windows.forEach((w, i) => {
    const n = i + 1;
    if (w.days.length === 0) out.push(`Window ${n}: choose at least one day.`);
    if (new Set(w.days).size !== w.days.length) out.push(`Window ${n}: a day is listed twice.`);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(w.from) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.to))
      out.push(`Window ${n}: use HH:MM times.`);
    else if (w.from >= w.to) out.push(`Window ${n}: the start must be before the end. Write an overnight window as two windows.`);
  });
  return out;
}

/**
 * Section 13.4: clear warnings on dangerous combinations. These never block a save; they say out loud what the
 * policy will let a technician do, so nobody enables it by accident.
 */
export function policyWarnings(p: UnattendedPolicy): string[] {
  const out: string[] = [];
  if (p.mode === 'allow') {
    const risky = (
      [
        [p.allowLogonScreen, 'the Windows sign-in screen'],
        [p.allowSecureDesktop, 'UAC prompts and the lock screen'],
        [p.allowPrivileged, 'privileged (admin) mode'],
        [p.allowAmtSol, 'the out-of-band AMT serial console'],
        [p.allowAmtBootRedirect, 'AMT boot redirection'],
      ] as const
    )
      .filter(([on]) => on)
      .map(([, text]) => text);
    if (risky.length > 0)
      out.push(
        `This group can be entered with nobody present and the technician can see ${joinWords(risky)}. Anyone with a technician seat in scope can do this without a person at the machine agreeing first.`,
      );
    else if (!p.requireLocalApprovalWhenPresent)
      out.push('This group can be entered with nobody present, and a person who is at the machine is only told, not asked.');
  }
  if (p.mode === 'allow' && (p.allowInputLock || p.allowPrivacyScreen))
    out.push('A technician can take the local keyboard and mouse away, or blank the local screen, during an unattended session.');
  if (!p.recordingRequired) out.push('Sessions on these devices are not forced to be recorded, so an unattended session may leave no video record.');
  if (p.autoAllowAfterSec !== null && (p.mode !== 'allow' || !p.requireLocalApprovalWhenPresent))
    out.push('Auto-allow only applies with unattended mode "allow" and approval required when someone is present; it is ignored here.');
  if (p.mode === 'allow' && p.maxUnattendedMinutes === 0) out.push('An unattended session on these devices never times out on its own.');
  return out;
}

function joinWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The keys of `value` that differ from `base` (what a group default or a device override actually overrides). */
export function overriddenKeys(base: UnattendedPolicy, value: UnattendedPolicy): PolicyKey[] {
  return POLICY_KEYS.filter((k) => !sameValue(base[k], value[k]));
}

/** `value` reduced to an `UnattendedPolicyPatch` against `base` (section 6.1 merge order). */
export function diffPolicy(base: UnattendedPolicy, value: UnattendedPolicy): UnattendedPolicyPatch {
  const patch: Record<string, unknown> = {};
  for (const k of overriddenKeys(base, value)) patch[k] = value[k];
  return patch as UnattendedPolicyPatch;
}

/** One line per window, for a read-only summary. */
export function allowedHoursSummary(h: AllowedHours | null): string {
  if (!h) return 'Any time';
  return `${h.windows.map((w) => `${w.days.map(dayName).join(', ')} ${w.from}-${w.to}`).join('; ')} (${h.tz})`;
}
