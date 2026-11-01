/**
 * The offline action queue (docs/specs/phase-d-contracts.md section 9, 13.4): the device's actions with
 * `awaiting_approval` shown as "waiting for someone at the device", a state filter, cancel, and the **Run action**
 * form. A reason is required exactly where rule 9.1 says (a privileged playbook run, a vault-backed playbook, a print
 * to a named printer); rule 9.9 refusals are shown in plain words.
 */
import { useMemo, useState } from 'react';
import {
  DEVICE_ACTION_KINDS,
  DEVICE_ACTION_STATES,
  LIMITS,
  isPrivilegedAction,
  type DeviceAction,
  type DeviceActionKind,
  type DeviceActionState,
  type Playbook,
  type UnattendedPolicy,
} from '@indiansassist/shared';
import { Alert, Badge, Button, Field, Input, Select, Spinner } from '../../components/ui';
import { fmtDateTime, humanise, shortId } from '../../lib/format';
import type { DeviceActionBody } from '../../lib/fleetApi';
import { typedArgs } from '../console/agent/PlaybookPanel';
import { ACTION_KIND_TEXT, ACTION_STATE_TEXT, actionStateTone, APPROVED_BY_TEXT, refusalText } from './fleetText';

const KIND_LABEL: Record<DeviceActionKind, string> = ACTION_KIND_TEXT;

/**
 * Rule 9.1 / 9.5: `file_push` needs an object-store presign and a size and digest of the uploaded bytes, and the api
 * exposes no console-side upload for device pushes, so the console does not pretend to offer it (P8).
 */
export const FILE_PUSH_UNAVAILABLE =
  'Saving a file to a device needs an upload the server does not expose to the console yet, so it cannot be queued from here.';

export function ActionQueue({
  deviceId,
  actions,
  loading,
  error,
  canAct,
  onCancel,
  onReload,
}: {
  deviceId: string;
  actions: DeviceAction[] | undefined;
  loading: boolean;
  error: unknown;
  canAct: boolean;
  onCancel: (actionId: string) => Promise<void>;
  onReload: () => void;
}) {
  const [state, setState] = useState<DeviceActionState | ''>('');
  const [msg, setMsg] = useState<string | null>(null);
  const shown = useMemo(() => (actions ?? []).filter((a) => state === '' || a.state === state), [actions, state]);

  const cancel = async (id: string) => {
    setMsg(null);
    try {
      await onCancel(id);
      onReload();
    } catch (e) {
      setMsg(refusalText(e, 'The action could not be cancelled.'));
    }
  };

  return (
    <section aria-label="Action queue" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h3 className="text-base font-semibold">Action queue</h3>
        <Field label="State">
          {(f) => (
            <Select id={f.id} className="w-56" value={state} onChange={(e) => setState(e.target.value as DeviceActionState | '')}>
              <option value="">Every state</option>
              {DEVICE_ACTION_STATES.map((s) => (
                <option key={s} value={s}>
                  {ACTION_STATE_TEXT[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <p className="text-xs text-slate-600 dark:text-slate-400">
        An action waits here while the device is offline and is delivered at its next check-in. Actions expire after {LIMITS.deviceActionTtlDays} days.
      </p>
      {msg && <Alert>{msg}</Alert>}
      {loading && <Spinner label="Loading the action queue" />}
      {Boolean(error) && <Alert>{refusalText(error, 'The action queue could not be loaded.')}</Alert>}
      {actions && shown.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-400">No actions{state === '' ? '' : ` in state "${ACTION_STATE_TEXT[state]}"`}.</p>}
      {shown.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Device actions</caption>
            <thead className="border-b border-slate-200 text-xs uppercase text-slate-600 dark:border-slate-700 dark:text-slate-400">
              <tr>
                <th scope="col" className="py-2 pr-3">What</th>
                <th scope="col" className="py-2 pr-3">State</th>
                <th scope="col" className="py-2 pr-3">Asked by</th>
                <th scope="col" className="py-2 pr-3">Reason</th>
                <th scope="col" className="py-2 pr-3">Result</th>
                {canAct && <th scope="col" className="py-2">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.id} className="border-b border-slate-100 align-top dark:border-slate-800">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{KIND_LABEL[a.kind]}</div>
                    <div className="text-xs text-slate-600 dark:text-slate-400">{payloadSummary(a)}</div>
                  </td>
                  <td className="py-2 pr-3">
                    <Badge tone={actionStateTone(a.state)}>{ACTION_STATE_TEXT[a.state]}</Badge>
                    {a.approvedBy && <div className="text-xs">{APPROVED_BY_TEXT[a.approvedBy]}</div>}
                  </td>
                  <td className="py-2 pr-3">
                    <div>{a.createdBy.name}</div>
                    <div className="text-xs">{fmtDateTime(a.createdAt)}</div>
                  </td>
                  <td className="py-2 pr-3 text-xs">{a.reason ?? '-'}</td>
                  <td className="py-2 pr-3 text-xs">{resultSummary(a)}</td>
                  {canAct && (
                    <td className="py-2">
                      {['queued', 'dispatched', 'awaiting_approval'].includes(a.state) && (
                        <Button size="sm" variant="secondary" onClick={() => void cancel(a.id)}>
                          Cancel
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="sr-only">Device {shortId(deviceId)}</p>
    </section>
  );
}

function payloadSummary(a: DeviceAction): string {
  const p = a.payload as Record<string, unknown>;
  if (a.kind === 'message') return String(p.title ?? '');
  if (a.kind === 'print') return `${String(p.name ?? '')}${p.printer ? ` to ${String(p.printer)}` : ' to the default printer'}`;
  if (a.kind === 'file_push') return String(p.name ?? '');
  return p.requiresElevation === true ? 'as administrator' : 'as the signed-in user';
}

function resultSummary(a: DeviceAction): string {
  if (!a.result) return a.state === 'expired' ? `expired ${fmtDateTime(a.expiresAt)}` : '-';
  const r = a.result;
  const parts: string[] = [];
  if (r.error) parts.push(humanise(r.error));
  if (r.exit !== undefined) parts.push(`exit ${r.exit}`);
  if (r.ranAs) parts.push(`ran as ${r.ranAs}`);
  if (r.pages !== undefined) parts.push(`${r.pages} page${r.pages === 1 ? '' : 's'}`);
  if (r.path) parts.push(r.path);
  return parts.join(', ') || '-';
}

export type RunActionFormProps = {
  playbooks: Playbook[] | undefined;
  policy: UnattendedPolicy;
  online: boolean;
  onQueue: (body: DeviceActionBody) => Promise<void>;
};

/** Rule 9.1: builds the `POST /devices/:id/actions` body and refuses to send one the server would reject. */
export function RunActionForm({ playbooks, policy, online, onQueue }: RunActionFormProps) {
  const [kind, setKind] = useState<DeviceActionKind>('message');
  const [reason, setReason] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [playbookId, setPlaybookId] = useState('');
  const [args, setArgs] = useState<Record<string, string | boolean>>({});
  const [fileRef, setFileRef] = useState('');
  const [docName, setDocName] = useState('');
  const [printer, setPrinter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enabled = (playbooks ?? []).filter((p) => p.enabled);
  const pb = enabled.find((p) => p.id === playbookId);
  const vaultBacked = (pb?.vaultRefs?.length ?? 0) > 0;
  const privileged =
    kind === 'playbook_run'
      ? isPrivilegedAction({ kind, payload: { requiresElevation: pb?.requiresElevation === true } }, { vaultRefs: pb?.vaultRefs?.length ?? 0 })
      : kind === 'print' && printer.trim().length > 0;
  const reasonRequired = privileged;
  const denyMode = policy.mode === 'deny';
  const denied = denyMode && kind !== 'message';

  const submit = async () => {
    setError(null);
    setNote(null);
    const r = reason.trim();
    if (reasonRequired && r.length < 1) return setError('This action needs a reason.');
    let payloadBody: DeviceActionBody;
    if (kind === 'message') {
      if (!title.trim() || !body.trim()) return setError('A message needs a title and a body.');
      payloadBody = { kind: 'message', payload: { title: title.trim(), body: body.trim() } };
    } else if (kind === 'playbook_run') {
      if (!pb) return setError('Choose a playbook.');
      payloadBody = {
        kind: 'playbook_run',
        payload: { playbookId: pb.id, args: typedArgs(pb.parameters, args), requiresElevation: pb.requiresElevation },
      };
    } else if (kind === 'print') {
      if (!/^https?:\/\//.test(fileRef.trim())) return setError('Give the document an http(s) address the device can fetch.');
      if (!docName.trim()) return setError('Give the document a file name.');
      payloadBody = { kind: 'print', payload: { fileRef: fileRef.trim(), name: docName.trim(), ...(printer.trim() ? { printer: printer.trim() } : {}) } };
    } else {
      return setError(FILE_PUSH_UNAVAILABLE);
    }
    setBusy(true);
    try {
      await onQueue(r ? { ...payloadBody, reason: r } : payloadBody);
      setNote(online ? 'Queued and sent to the device.' : 'Queued. It will be delivered the next time the device checks in.');
      setTitle('');
      setBody('');
      setReason('');
    } catch (e) {
      setError(refusalText(e, 'The action was refused.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Run an action" className="flex flex-col gap-3">
      <h3 className="text-base font-semibold">Run an action</h3>
      <p className="text-xs text-slate-600 dark:text-slate-400">
        An action outside a session is unattended access, so this device&apos;s policy governs it. Whoever is at the device sees a toast for every action that
        runs, and it appears in their Remote activity list and the receipts.
      </p>
      {denyMode && <Alert tone="amber">This device&apos;s policy refuses unattended access, so only a message can be sent.</Alert>}
      <Field label="Action">
        {(f) => (
          <Select id={f.id} value={kind} onChange={(e) => setKind(e.target.value as DeviceActionKind)}>
            {DEVICE_ACTION_KINDS.map((k) => (
              <option key={k} value={k} disabled={policy.mode === 'deny' && k !== 'message'}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {kind === 'message' && (
        <>
          <Field label="Title">{(f) => <Input id={f.id} maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
          <Field label="Message">{(f) => <Input id={f.id} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
        </>
      )}

      {kind === 'playbook_run' && (
        <>
          <Field label="Playbook" hint={pb?.description}>
            {(f) => (
              <Select
                id={f.id}
                aria-describedby={f.describedBy}
                value={playbookId}
                onChange={(e) => {
                  setPlaybookId(e.target.value);
                  setArgs({});
                }}
              >
                <option value="">Choose a playbook</option>
                {enabled.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.requiresElevation ? ' (admin)' : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {pb?.parameters.map((prm) => (
            <Field key={prm.name} label={`${prm.label || prm.name}${prm.required ? ' (required)' : ''}`}>
              {(f) =>
                prm.type === 'bool' ? (
                  <input id={f.id} type="checkbox" checked={args[prm.name] === true} onChange={(e) => setArgs((a) => ({ ...a, [prm.name]: e.target.checked }))} />
                ) : (
                  <Input
                    id={f.id}
                    type={prm.type === 'int' ? 'number' : 'text'}
                    value={String(args[prm.name] ?? '')}
                    onChange={(e) => setArgs((a) => ({ ...a, [prm.name]: e.target.value }))}
                  />
                )
              }
            </Field>
          ))}
          {privileged && !policy.allowPrivileged && (
            <Alert tone="amber">
              This playbook is privileged and the policy for this device does not allow privileged actions, so it will be queued and then fail. Change the
              policy first.
            </Alert>
          )}
          {vaultBacked && <Alert tone="blue">This playbook reads secrets from the vault. They are sealed to the device at dispatch and never stored in the queue.</Alert>}
        </>
      )}

      {kind === 'print' && (
        <>
          <Field label="Document address" hint="An http(s) address the device can fetch (an object-store link).">
            {(f) => <Input id={f.id} aria-describedby={f.describedBy} value={fileRef} onChange={(e) => setFileRef(e.target.value)} />}
          </Field>
          <Field label="File name">{(f) => <Input id={f.id} maxLength={255} value={docName} onChange={(e) => setDocName(e.target.value)} />}</Field>
          <Field label="Printer (optional)" hint="Leave empty for the device's default printer. A named printer is a privileged action and needs a reason.">
            {(f) => <Input id={f.id} aria-describedby={f.describedBy} maxLength={128} value={printer} onChange={(e) => setPrinter(e.target.value)} />}
          </Field>
        </>
      )}

      {kind === 'file_push' && <Alert tone="amber">{FILE_PUSH_UNAVAILABLE}</Alert>}

      <Field
        label={reasonRequired ? 'Reason (required)' : 'Reason (optional)'}
        hint={`At most ${LIMITS.reasonMax} characters; written to the audit trail and the receipt.`}
      >
        {(f) => <Input id={f.id} aria-describedby={f.describedBy} maxLength={LIMITS.reasonMax} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>

      {error && <Alert>{error}</Alert>}
      {note && <Alert tone="green">{note}</Alert>}
      <div>
        <Button onClick={() => void submit()} disabled={busy || kind === 'file_push' || denied}>
          Queue this action
        </Button>
      </div>
    </section>
  );
}
