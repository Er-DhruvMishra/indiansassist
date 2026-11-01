/**
 * Fleet console wording and badge tones (docs/specs/phase-d-contracts.md sections 6.2, 8.1, 9, 10.5, 13.4). Every
 * status carries text, never colour alone (section 13.5 accessibility), and every refusal is said in plain words with
 * the next step (P8: no invented capability, no silent failure).
 */
import {
  type AmtInventory,
  type ApprovedBy,
  type Device,
  type DeviceActionKind,
  type DeviceActionState,
  type InteractiveState,
  type TamperState,
  type UnattendedMode,
  type UnattendedPolicy,
  type WakeFailCause,
} from '@indiansassist/shared';
import { isApiError } from '../../lib/api';

export type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue';

/** Section 13.1a: `online` is folded from presence, so "offline" never means "gone". */
export function onlineBadge(d: Pick<Device, 'online' | 'status'>): { text: string; tone: Tone } {
  if (d.status !== 'enrolled') return { text: 'Not enrolled', tone: 'neutral' };
  return d.online ? { text: 'Online', tone: 'green' } : { text: 'Offline', tone: 'neutral' };
}

/** Section 3.4: who is at the machine right now, as last reported. */
export function presenceText(i: InteractiveState | null): string {
  if (!i) return 'Not reported';
  if (i.state === 'active') return 'Someone is at the device';
  if (i.state === 'locked') return 'Signed in, screen locked';
  return 'Nobody signed in';
}

export function presenceShort(i: InteractiveState | null): string {
  if (!i) return 'Unknown';
  return i.state === 'active' ? 'Present' : i.state === 'locked' ? 'Locked' : 'Signed out';
}

/** Rule 10.5: `suspected` is the server's silence suspicion, `alerted` a signed device report. */
export function tamperBadge(s: TamperState): { text: string; tone: Tone } {
  if (s === 'alerted') return { text: 'Tamper reported', tone: 'red' };
  if (s === 'suspected') return { text: 'Silent, tamper suspected', tone: 'amber' };
  return { text: 'No tamper', tone: 'green' };
}

/**
 * Rule 8.4a: "Cold power on: available" only when the firmware is present and provisioned. Whether an AMT proxy
 * exists for the device is the server's election at `POST /wake`, so the console says what it can see and no more.
 */
export function coldPowerOnText(amt: AmtInventory | null): string {
  if (!amt || !amt.present) return 'Cold power on: not available';
  if (!amt.provisioned) return 'Cold power on: not available (AMT present but not set up)';
  return 'Cold power on: available (needs an AMT proxy on the same network)';
}

export const UNATTENDED_MODE_TEXT: Record<UnattendedMode, string> = {
  allow: 'Unattended allowed',
  approval_only: 'Approval needed at the device',
  deny: 'Unattended refused',
};

export function unattendedModeTone(m: UnattendedMode): Tone {
  return m === 'allow' ? 'amber' : m === 'deny' ? 'neutral' : 'blue';
}

export const ACTION_KIND_TEXT: Record<DeviceActionKind, string> = {
  playbook_run: 'Run a playbook',
  file_push: 'Save a file',
  print: 'Print a document',
  message: 'Show a message',
};

/** Rule 9.2 states; `awaiting_approval` is shown as the contract words it (section 13.4). */
export const ACTION_STATE_TEXT: Record<DeviceActionState, string> = {
  queued: 'Queued',
  dispatched: 'Sent to the device',
  awaiting_approval: 'Waiting for someone at the device',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

export function actionStateTone(s: DeviceActionState): Tone {
  if (s === 'done') return 'green';
  if (s === 'failed') return 'red';
  if (s === 'awaiting_approval') return 'amber';
  if (s === 'cancelled' || s === 'expired') return 'neutral';
  return 'blue';
}

export const APPROVED_BY_TEXT: Record<ApprovedBy, string> = {
  policy: 'authorised by policy',
  local_user: 'approved by someone at the device',
  auto_after_timeout: 'auto-allowed after the countdown',
};

/** Rule W3: honest failure causes, each with the next step. */
export const WAKE_FAIL_TEXT: Record<WakeFailCause, string> = {
  no_waker: 'No other device was online on that network to send the wake packet. Try AMT cold power on, or ask someone to switch the machine on.',
  no_confirm: 'The wake was sent but the machine did not come back within 2 minutes. It may be unplugged, or wake on LAN may be off in its firmware.',
  amt_unavailable: 'No AMT proxy is available for this device, so cold power on cannot be attempted.',
  amt_unreachable: 'The AMT firmware did not answer. It may be unprovisioned, on another network, or powered off at the mains.',
  waker_error: 'The device that was asked to send the wake packet reported an error.',
};

/**
 * Section 6.2 / 7.2: the refusals of a device session, wake or action in plain words with the next step. Anything
 * else falls back to the server's own message.
 */
const REFUSALS: Record<string, string> = {
  device_offline: 'The device is not connected. Wake it first, then try again.',
  device_busy: 'This device already has a session open. End it before starting another.',
  nobody_present: 'Nobody is signed in at the device, so an attended session cannot be answered. Start an unattended session instead if the policy allows it.',
  unattended_denied: 'The policy for this device refuses unattended entry. Ask someone at the device to be there and start an attended session.',
  approval_required: 'This group requires someone at the device to approve. Nobody is there now, so the session cannot start.',
  outside_policy_window: 'This is outside the allowed hours in the policy. Try again inside the window, or ask an org admin to change it.',
  prelogin_not_permitted: 'Nobody is signed in and the policy does not allow access to the Windows sign-in screen for this device.',
  recorder_required: 'The policy requires recording and no recorder could be assigned. Try again shortly.',
  policy_forbidden: 'The policy for this device does not allow this. An org admin can change it on the group or the device.',
  amt_unavailable: 'Cold power on is not available for this device: no AMT proxy could be found on its network.',
  device_disabled: 'This device is disabled. Enable it before starting a session.',
  capability_mismatch: 'The installed agent on this device does not support this.',
  vault_unavailable: 'The credential vault could not be reached, so this action cannot run.',
  forbidden: 'Your role, or your device groups, do not allow this.',
};

export function refusalText(e: unknown, fallback: string): string {
  if (isApiError(e) && REFUSALS[e.code]) return REFUSALS[e.code]!;
  if (isApiError(e)) return e.message || fallback;
  return fallback;
}

/** The technician-visible policy state of a session or device (section 13.4), as short sentences. */
export function policyHighlights(p: UnattendedPolicy): string[] {
  const out = [UNATTENDED_MODE_TEXT[p.mode]];
  out.push(p.recordingRequired ? 'Recording required' : 'Recording not required');
  if (p.mode === 'allow' && p.requireLocalApprovalWhenPresent) out.push('Approval needed when someone is at the device');
  if (p.allowedHours)
    out.push(`Allowed hours: ${p.allowedHours.windows.map((w) => `${w.days.map(dayName).join('/')} ${w.from}-${w.to}`).join(', ')} (${p.allowedHours.tz})`);
  else out.push('Allowed at any time');
  out.push(p.allowLogonScreen ? 'Windows sign-in screen allowed' : 'Windows sign-in screen not allowed');
  out.push(p.allowSecureDesktop ? 'Security screens (UAC, lock) allowed' : 'Security screens (UAC, lock) hidden');
  out.push(p.allowPrivileged ? 'Privileged mode allowed' : 'Privileged mode not allowed');
  out.push(p.allowInputLock ? 'Input lock allowed' : 'Input lock not allowed');
  out.push(p.allowPrivacyScreen ? 'Privacy screen allowed' : 'Privacy screen not allowed');
  if (p.allowAmtSol) out.push('AMT serial console allowed');
  if (p.allowAmtBootRedirect) out.push('AMT boot redirect allowed');
  out.push(p.maxUnattendedMinutes === 0 ? 'No unattended time limit' : `Unattended time limit ${p.maxUnattendedMinutes} min`);
  return out;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function dayName(iso: number): string {
  return DAYS[iso - 1] ?? String(iso);
}
