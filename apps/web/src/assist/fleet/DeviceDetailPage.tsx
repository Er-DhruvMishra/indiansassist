/**
 * `DeviceDetail` (docs/specs/phase-d-contracts.md section 13.4): status, capabilities, the effective policy, the AMT
 * inventory, recent sessions and the offline queue, with **Connect** (attended or unattended, a reason required for
 * unattended), **Wake**, **Run action** and the org_admin actions (rename, group, tags, notify address, policy
 * override, disable / enable / retire / rotate key / acknowledge tamper). A `409` from section 6.2 is shown in plain
 * words with the next step; what the signed-in role may not use is not rendered at all.
 */
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  LIMITS,
  type AmtBootTarget,
  type DeviceDetail,
  type SessionSummary,
  type UnattendedPolicy,
  type UnattendedPolicyPatch,
  type WakeMethod,
} from '@indiansassist/shared';
import { useAuth } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { Dialog } from '../../components/Dialog';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, Spinner } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { usePageTitle } from '../../hooks/usePageTitle';
import { fmtDateTime, humanise } from '../../lib/format';
import { playbooksApi } from '../../lib/agentApi';
import { devicesApi, deviceGroupsApi, fleetPolicyApi } from '../../lib/fleetApi';
import { useAssistSignal } from '../signal/AssistSignalProvider';
import { ActionQueue, RunActionForm } from './ActionQueue';
import {
  coldPowerOnText,
  onlineBadge,
  policyHighlights,
  presenceText,
  refusalText,
  tamperBadge,
  UNATTENDED_MODE_TEXT,
  unattendedModeTone,
} from './fleetText';
import { effectivePolicy, overriddenKeys, overrideKeys, POLICY_FIELD_LABELS } from './policyRules';
import { UnattendedPolicyEditor } from './UnattendedPolicyEditor';
import { WakePanel, type SolLine, type WakeEvent } from './WakePanel';

export function DeviceDetailPage() {
  const { id = '' } = useParams();
  const { me } = useAuth();
  const role = me?.user.role;
  const canAct = can(role, 'fleet.act');
  const canAmt = can(role, 'fleet.amt');
  const canQueue = can(role, 'fleet.queue');
  const admin = can(role, 'fleet.admin');
  const navigate = useNavigate();
  const signal = useAssistSignal();

  const device = useAsync(() => devicesApi.get(id), [id]);
  const groups = useAsync(() => (admin ? deviceGroupsApi.list() : Promise.resolve({ items: [] })), [admin]);
  const orgPolicy = useAsync(() => fleetPolicyApi.getUnattended(), []);
  const actions = useAsync(() => (canQueue ? devicesApi.listActions(id, { limit: 50 }) : Promise.resolve({ items: [], nextCursor: null })), [id, canQueue]);
  const playbooks = useAsync(() => (canAct ? playbooksApi.list() : Promise.resolve({ items: [], nextCursor: null })), [canAct]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [solLines, setSolLines] = useState<SolLine[]>([]);

  usePageTitle(device.data ? `Device ${device.data.name}` : 'Device');

  const subscribe = useCallback(
    (fn: (ev: WakeEvent) => void) => {
      const c = signal?.client;
      if (!c) return () => undefined;
      const offs = [
        c.on('device.woke', (m) => fn({ t: 'device.woke', wakeId: m.wakeId, deviceId: m.deviceId, via: m.via, method: m.method, elapsedMs: m.elapsedMs })),
        c.on('device.wake_failed', (m) => fn({ t: 'device.wake_failed', wakeId: m.wakeId, deviceId: m.deviceId, cause: m.cause })),
        c.on('amt.sol.data', (m) => setSolLines((l) => [...l, { seq: m.seq, text: decodeSol(m.data) }].slice(-500))),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
    [signal?.client],
  );

  const d = device.data;
  const inherited = useMemo<UnattendedPolicy | null>(
    () => (orgPolicy.data ? effectivePolicy(null, groupOf(d, groups.data?.items), orgPolicy.data) : null),
    [orgPolicy.data, groups.data, d],
  );

  if (device.loading) return <Spinner label="Loading the device" />;
  if (!d) return <Alert>{refusalText(device.error, 'This device could not be loaded.')}</Alert>;

  const on = onlineBadge(d);
  const tamper = tamperBadge(d.tamperState);
  const reported = (d.capabilities as { features?: unknown } | undefined)?.features;
  const features = Array.isArray(reported) ? (reported as string[]) : [];
  // Section 13.2 `device.unattended_policy`: what this device overrides itself, as stored. An api that does not send
  // the field yet falls back to diffing the effective policy against what the device inherits.
  const deviceOverride =
    d.unattendedPolicy === undefined ? (inherited ? overriddenKeys(inherited, d.policy) : []) : overrideKeys(d.unattendedPolicy);

  const act = async (what: string, fn: () => Promise<unknown>) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(what);
      device.reload();
    } catch (e) {
      setError(refusalText(e, `${what} did not work.`));
    }
  };

  return (
    <>
      <PageHeader title={d.name}>
        <Badge tone={on.tone}>{on.text}</Badge>
        <Badge tone={tamper.tone}>{tamper.text}</Badge>
        <Badge tone={unattendedModeTone(d.policy.mode)}>{UNATTENDED_MODE_TEXT[d.policy.mode]}</Badge>
        <Link to="/app/fleet" className="text-sm font-medium text-teal-800 underline dark:text-teal-300">
          All devices
        </Link>
      </PageHeader>

      {notice && (
        <div className="mb-3" aria-live="polite">
          <Alert tone="green">{notice}</Alert>
        </div>
      )}
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}
      {d.status !== 'enrolled' && (
        <div className="mb-3">
          <Alert tone="amber">This device is {humanise(d.status)}. No session or action can be started on it.</Alert>
        </div>
      )}
      {d.tamperState !== 'ok' && (
        <div className="mb-3">
          <Alert tone="amber">
            {d.tamperState === 'alerted'
              ? 'The agent on this device reported that it was stopped, disabled, deleted or changed. The reports are on the audit trail.'
              : 'This device went silent past its heartbeat grace with no disable, retire or deregister on record, so a killed agent is shown rather than an innocent "offline".'}
          </Alert>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_24rem]">
        <div className="flex flex-col gap-4">
          <Card title="This device">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Row label="Group" value={d.group?.name ?? 'No group (organisation default policy)'} />
              <Row label="At the device" value={presenceText(d.interactive)} />
              <Row label="Last seen" value={fmtDateTime(d.lastSeenAt)} />
              <Row label="First seen" value={fmtDateTime(d.firstSeenAt)} />
              <Row label="Enrolled" value={fmtDateTime(d.enrolledAt)} />
              <Row label="Platform" value={`${d.platform} ${d.arch ?? ''} ${d.osVersion ?? ''}`.trim()} />
              <Row label="Service version" value={d.serviceVersion ?? '-'} />
              <Row label="Desktop worker version" value={d.agentVersion ?? '-'} />
              <Row label="Device key" value={d.keyId ?? '-'} />
              <Row label="Receipt address" value={d.notifyEmail ?? (d.group ? 'Falls back to the group address' : 'None set')} />
              {d.lastIp !== null && <Row label="Last IP" value={d.lastIp} />}
              <Row label="Tags" value={d.tags.length > 0 ? d.tags.join(', ') : 'None'} />
            </dl>
            <h3 className="mt-4 text-sm font-semibold">What the installed agent can do</h3>
            {features.length === 0 ? (
              <p className="text-sm text-slate-600 dark:text-slate-400">No capabilities reported yet.</p>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-1">
                {features.map((f) => (
                  <li key={f}>
                    <Badge>{humanise(f)}</Badge>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-sm">{coldPowerOnText(d.amt)}</p>
            {d.amt?.present && (
              <p className="text-xs text-slate-600 dark:text-slate-400">
                AMT {d.amt.version ?? 'version unknown'}, {d.amt.provisioned ? 'set up for management' : 'not set up for management'},{' '}
                {d.amt.tls ? 'TLS' : 'plain HTTP (flagged in the residency report)'}
                {d.amt.powerState === undefined ? '' : `, power state ${d.amt.powerState}`}.
              </p>
            )}
          </Card>

          <Card title="Effective policy">
            <ul className="flex flex-col gap-1 text-sm">
              {policyHighlights(d.policy).map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
              This is the organisation default, then the group default, then this device&apos;s own override. It governs sessions and device actions alike.
            </p>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400" data-testid="device-override">
              {deviceOverride.length === 0
                ? 'Set on this device: nothing. Every field is inherited.'
                : `Set on this device: ${deviceOverride.map((k) => POLICY_FIELD_LABELS[k]).join(', ')}.`}
            </p>
          </Card>

          {canQueue && (
            <Card>
              <ActionQueue
                deviceId={d.id}
                actions={actions.data?.items}
                loading={actions.loading}
                error={actions.error}
                canAct={canAct}
                onCancel={async (actionId) => {
                  await devicesApi.cancelAction(d.id, actionId);
                }}
                onReload={actions.reload}
              />
            </Card>
          )}

          {canAct && (
            <Card>
              <RunActionForm
                playbooks={playbooks.data?.items}
                policy={d.policy}
                online={d.online}
                onQueue={async (body) => {
                  await devicesApi.queueAction(d.id, body);
                  actions.reload();
                }}
              />
            </Card>
          )}

          <Card title="Recent sessions">
            <RecentSessions items={d.recentSessions} />
          </Card>

          {admin && inherited && (
            <Card>
              <UnattendedPolicyEditor
                title="Policy override for this device"
                mode="override"
                value={d.policy}
                inherited={inherited}
                override={d.unattendedPolicy}
                inheritedLabel={d.group ? `the group "${d.group.name}"` : 'the organisation default'}
                onSavePatch={(patch) =>
                  void act('The policy override was saved.', () => devicesApi.patch(d.id, { unattendedPolicy: emptyToNull(patch) }))
                }
              />
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          {canAct && (
            <Card>
              <ConnectPanel detail={d} onOpened={(sessionId) => navigate(`/app/sessions/${sessionId}`)} />
            </Card>
          )}
          <Card>
            <WakePanel
              deviceId={d.id}
              deviceName={d.name}
              online={d.online}
              amt={d.amt}
              policy={d.policy}
              canWake={canAct}
              canAmt={canAmt}
              subscribe={subscribe}
              solLines={solLines}
              onWake={(method: WakeMethod, reason) => devicesApi.wake(d.id, { method, ...(reason ? { reason } : {}) })}
              onOpenSol={canAmt ? (reason) => devicesApi.openSol(d.id, reason) : undefined}
              onCloseSol={
                canAmt
                  ? async (solId) => {
                      await devicesApi.closeSol(d.id, solId);
                    }
                  : undefined
              }
              onBoot={canAmt ? (target: AmtBootTarget, reason) => devicesApi.bootRedirect(d.id, target, reason) : undefined}
            />
          </Card>

          {admin && (
            <>
              <Card>
                <DeviceAdminForm
                  detail={d}
                  groups={groups.data?.items ?? []}
                  onSaved={(m) => {
                    setError(null);
                    setNotice(m);
                  }}
                  onReload={device.reload}
                />
              </Card>
              <Card title="Device administration">
                <div className="flex flex-col gap-2">
                  {d.status === 'disabled' ? (
                    <Button variant="secondary" onClick={() => void act('The device was enabled.', () => devicesApi.enable(d.id))}>
                      Enable this device
                    </Button>
                  ) : (
                    <Button variant="danger" onClick={() => void act('The device was disabled; any live session ended.', () => devicesApi.disable(d.id))}>
                      Disable this device
                    </Button>
                  )}
                  <Button variant="secondary" onClick={() => void act('Key rotation is armed; the device rotates at its next check-in.', () => devicesApi.rotateKey(d.id))}>
                    Rotate the device key
                  </Button>
                  {d.tamperState !== 'ok' && (
                    <Button variant="secondary" onClick={() => void act('The tamper alert was acknowledged.', () => devicesApi.acknowledgeTamper(d.id))}>
                      Acknowledge the tamper alert
                    </Button>
                  )}
                  <RetireButton name={d.name} onRetire={() => void act('The device was retired.', () => devicesApi.retire(d.id))} />
                  <p className="text-xs text-slate-600 dark:text-slate-400">
                    Disabling closes the device&apos;s connection and ends any live session. Retiring is a soft retire: the row and its audit trail stay.
                  </p>
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-600 dark:text-slate-400">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function RecentSessions({ items }: { items: SessionSummary[] }) {
  if (items.length === 0) return <p className="text-sm text-slate-600 dark:text-slate-400">No sessions on this device yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Recent sessions on this device</caption>
        <thead className="border-b border-slate-200 text-xs uppercase text-slate-600 dark:border-slate-700 dark:text-slate-400">
          <tr>
            <th scope="col" className="py-2 pr-3">Technician</th>
            <th scope="col" className="py-2 pr-3">Kind</th>
            <th scope="col" className="py-2 pr-3">State</th>
            <th scope="col" className="py-2 pr-3">Started</th>
            <th scope="col" className="py-2 pr-3">Ended</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.id} className="border-b border-slate-100 dark:border-slate-800">
              <td className="py-2 pr-3">{s.assist.name}</td>
              <td className="py-2 pr-3">{s.unattended ? <Badge tone="amber">Unattended</Badge> : <Badge>Attended</Badge>}</td>
              <td className="py-2 pr-3">
                {humanise(s.state)}
                {s.endReason ? ` (${humanise(s.endReason)})` : ''}
              </td>
              <td className="py-2 pr-3 text-xs">{fmtDateTime(s.startedAt ?? s.knockedAt)}</td>
              <td className="py-2 pr-3 text-xs">{fmtDateTime(s.endedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
        <Link to="/app/sessions" className="underline">
          Every session
        </Link>{' '}
        is on the sessions page, and each one&apos;s record is on the audit trail.
      </p>
    </div>
  );
}

/** Section 3.5 / 6.2: attended or unattended, a reason required for unattended, refusals in plain words. */
export function ConnectPanel({ detail, onOpened }: { detail: DeviceDetail; onOpened: (sessionId: string) => void }) {
  const [unattended, setUnattended] = useState(detail.policy.mode !== 'deny');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const present = detail.interactive?.state === 'active';

  const connect = async () => {
    setError(null);
    if (unattended && reason.trim().length < 1) return setError('An unattended session needs a reason. It is written to the audit trail and the receipt.');
    setBusy(true);
    try {
      const r = await devicesApi.openSession(detail.id, { unattended, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      onOpened(r.sessionId);
    } catch (e) {
      setError(refusalText(e, 'The session could not be started.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Connect" className="flex flex-col gap-3">
      <h3 className="text-base font-semibold">Connect</h3>
      <p className="text-sm">{presenceText(detail.interactive)}</p>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">How to connect</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" className="mt-1" name="connect-kind" checked={!unattended} onChange={() => setUnattended(false)} />
          <span>
            Attended
            <span className="block text-xs text-slate-600 dark:text-slate-400">
              Someone at the device sees the consent window and chooses what to share. {present ? '' : 'Nobody is signed in now, so this will be refused.'}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" className="mt-1" name="connect-kind" checked={unattended} onChange={() => setUnattended(true)} disabled={detail.policy.mode === 'deny'} />
          <span>
            Unattended
            <span className="block text-xs text-slate-600 dark:text-slate-400">
              {detail.policy.mode === 'deny'
                ? 'This device’s policy refuses unattended entry.'
                : detail.policy.mode === 'approval_only'
                  ? 'Someone at the device must approve each session.'
                  : present && detail.policy.requireLocalApprovalWhenPresent
                    ? 'Someone is at the device, so they are asked to approve.'
                    : 'Policy-authorised; the device shows the pill and the session is recorded.'}
            </span>
          </span>
        </label>
      </fieldset>
      <Field
        label={unattended ? 'Reason (required)' : 'Reason (optional)'}
        hint={`At most ${LIMITS.reasonMax} characters. The person at the device is shown it, and so is the receipt.`}
      >
        {(f) => <Input id={f.id} aria-describedby={f.describedBy} maxLength={LIMITS.reasonMax} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
      {error && <Alert>{error}</Alert>}
      {detail.policy.recordingRequired && <p className="text-xs text-slate-600 dark:text-slate-400">The policy requires recording; the session will not start without a recorder.</p>}
      <div>
        <Button onClick={() => void connect()} disabled={busy || detail.status !== 'enrolled' || !detail.online}>
          {busy ? 'Starting...' : 'Start a session'}
        </Button>
      </div>
      {!detail.online && <p className="text-xs text-slate-600 dark:text-slate-400">The device is offline. Wake it first.</p>}
    </section>
  );
}

function DeviceAdminForm({
  detail,
  groups,
  onSaved,
  onReload,
}: {
  detail: DeviceDetail;
  groups: { id: string; name: string }[];
  onSaved: (message: string) => void;
  onReload: () => void;
}) {
  const [name, setName] = useState(detail.name);
  const [groupId, setGroupId] = useState(detail.groupId ?? 'none');
  const [tags, setTags] = useState(detail.tags.join(', '));
  const [email, setEmail] = useState(detail.notifyEmail ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await devicesApi.patch(detail.id, {
        name: name.trim(),
        groupId: groupId === 'none' ? null : groupId,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        notifyEmail: email.trim() === '' ? null : email.trim(),
      });
      onSaved('The device was saved.');
      onReload();
    } catch (e) {
      setError(refusalText(e, 'The device could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Device settings" className="flex flex-col gap-3">
      <h3 className="text-base font-semibold">Device settings</h3>
      <Field label="Name">{(f) => <Input id={f.id} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label="Group">
        {(f) => (
          <Select id={f.id} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="none">No group (organisation default policy)</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Tags" hint="Comma separated, at most 32.">
        {(f) => <Input id={f.id} aria-describedby={f.describedBy} value={tags} onChange={(e) => setTags(e.target.value)} />}
      </Field>
      <Field label="Receipt address" hint="Unattended session and action receipts are mailed here; empty falls back to the group's address.">
        {(f) => <Input id={f.id} aria-describedby={f.describedBy} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
      </Field>
      {error && <Alert>{error}</Alert>}
      <div>
        <Button onClick={() => void save()} disabled={busy}>
          Save the device
        </Button>
      </div>
    </section>
  );
}

function RetireButton({ name, onRetire }: { name: string; onRetire: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Retire this device
      </Button>
      <Dialog open={open} title={`Retire ${name}?`} onClose={() => setOpen(false)}>
        <p className="mb-4 text-sm">
          The device stops being reachable and its agent should be uninstalled. The row, its receipts and its audit trail stay for the retention period.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Keep the device
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setOpen(false);
              onRetire();
            }}
          >
            Retire the device
          </Button>
        </div>
      </Dialog>
    </>
  );
}

function groupOf(d: DeviceDetail | undefined, groups: { id: string; defaultPolicy: UnattendedPolicyPatch }[] | undefined) {
  if (!d?.groupId || !groups) return null;
  return groups.find((g) => g.id === d.groupId) ?? null;
}

/** An override with no keys is cleared (`unattendedPolicy: null`) rather than stored as an empty object. */
function emptyToNull(patch: UnattendedPolicyPatch): UnattendedPolicyPatch | null {
  return Object.keys(patch).length === 0 ? null : patch;
}

function decodeSol(b64u: string): string {
  try {
    const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
    return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  } catch {
    return '';
  }
}
