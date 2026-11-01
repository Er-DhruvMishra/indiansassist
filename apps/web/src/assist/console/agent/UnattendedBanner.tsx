/**
 * The P4 additions to the technician console that say what kind of session this is (docs/specs/phase-d-contracts.md
 * sections 6.2, 13.4): the **Unattended** banner ("No one is at this device - session is policy-authorised and
 * recorded"), the "Someone is now at the device" arrival banner of rule 6.2a, and the technician-visible policy state
 * (what this policy lets the technician do, and what it does not). Both banners are polite live regions and carry
 * their state as text, never as colour alone (section 13.5).
 */
import type { ApprovedBy, UnattendedPolicy } from '@indiansassist/shared';
import { Alert, Badge } from '../../../components/ui';
import { APPROVED_BY_TEXT, policyHighlights } from '../../fleet/fleetText';

export type UnattendedSessionInfo = {
  /** `true` for a session opened with `unattended: true` (section 3.5). */
  unattended: boolean;
  deviceName: string;
  policy: UnattendedPolicy | null;
  approvedBy?: ApprovedBy | null;
  /** Rule 6.2a: the worker reported that someone arrived at the device. */
  userArrived?: boolean;
  /** Rule 6.2a: with `requireLocalApprovalWhenPresent` the session drops to view until they choose Continue. */
  levelDroppedToView?: boolean;
};

/** Rule 6.2a, as the server pushes it (`session.local_user_arrived`). */
export type LocalUserArrival = { decision: 'continue' | 'ended'; levelDroppedTo: 'view' | null };

/**
 * What the console shows for a device session (section 13.4), assembled in one place so the precedence is explicit:
 * the policy and the authorisation come from the session itself (`session.created.policySnapshot` / the REST session,
 * sections 6.2 and 13.2), and the device's current effective policy is only the fallback for a session opened before
 * the snapshot was exposed. Rule 6.2a folds in the worker's arrival report.
 */
export function unattendedInfo(a: {
  deviceId: string | null;
  deviceName: string;
  unattended: boolean | null;
  policySnapshot?: UnattendedPolicy | null | undefined;
  devicePolicy?: UnattendedPolicy | null | undefined;
  approvedBy?: ApprovedBy | null | undefined;
  arrival?: LocalUserArrival | null | undefined;
}): UnattendedSessionInfo | undefined {
  if (!a.deviceId) return undefined;
  return {
    unattended: a.unattended === true,
    deviceName: a.deviceName,
    policy: a.policySnapshot ?? a.devicePolicy ?? null,
    approvedBy: a.approvedBy ?? null,
    ...(a.arrival ? { userArrived: true, levelDroppedToView: a.arrival.levelDroppedTo === 'view' } : {}),
  };
}

export const UNATTENDED_TEXT = 'No one is at this device — session is policy-authorised and recorded.';

export function UnattendedBanner({ info }: { info: UnattendedSessionInfo }) {
  if (!info.unattended) return null;
  const recorded = info.policy?.recordingRequired ?? true;
  return (
    <div aria-live="polite" className="flex flex-col gap-2">
      <Alert tone="amber">
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone="amber">Unattended</Badge>
          <strong data-testid="unattended-banner">{recorded ? UNATTENDED_TEXT : 'No one is at this device — session is policy-authorised.'}</strong>
        </span>
        <p className="mt-1">
          {info.deviceName} was entered without a person agreeing at the machine
          {info.approvedBy ? `: ${APPROVED_BY_TEXT[info.approvedBy]}` : ''}. The pill, the tray icon and the recording dot are drawn on the device, a receipt
          is produced at the end, and every privileged step is on the audit trail.
          {recorded ? ' Recording is required by policy and cannot be turned off here.' : ' This policy does not force a recording.'}
        </p>
      </Alert>
      {info.userArrived && (
        <Alert tone="blue">
          <strong>Someone is now at the device.</strong>{' '}
          {info.levelDroppedToView
            ? 'They were asked to approve, so the session has dropped to view only, and input lock and privacy screen have been released, until they choose Continue.'
            : 'They have been shown who you are and why you are here, and can end the session at any moment.'}
        </Alert>
      )}
    </div>
  );
}

/** The technician-visible policy state (section 13.4): what this device's policy allows, in plain words. */
export function PolicyState({ policy, unattended }: { policy: UnattendedPolicy | null; unattended: boolean }) {
  if (!policy) return null;
  return (
    <section aria-label="Policy for this device" className="flex flex-col gap-1">
      <h2 className="text-sm font-semibold">Policy for this device</h2>
      <ul className="flex flex-col gap-0.5 text-xs">
        {policyHighlights(policy).map((h) => (
          <li key={h}>{h}</li>
        ))}
      </ul>
      {unattended && policy.maxUnattendedMinutes > 0 && (
        <p className="text-xs text-slate-600 dark:text-slate-400">
          This unattended session ends on its own after {policy.maxUnattendedMinutes} minutes; the clock pauses once a person at the device chooses Continue.
        </p>
      )}
      {!policy.allowSecureDesktop && (
        <p className="text-xs text-slate-600 dark:text-slate-400">
          Hidden by policy: UAC prompts and the lock screen are not shared, so the picture freezes while one is on screen.
        </p>
      )}
    </section>
  );
}
