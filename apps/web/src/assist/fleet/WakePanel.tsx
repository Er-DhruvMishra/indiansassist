/**
 * `WakePanel` (docs/specs/phase-d-contracts.md sections 8.1-8.4, 13.4): the method picker (`auto` / `wol` / `amt`),
 * the resolved `via` (which waker or AMT proxy the server elected), the live `pending -> dispatched -> woke | failed`
 * state with honest failure causes, and - for senior_technician / org_admin, with the policy flag on and a typed
 * reason - **Open SOL console** and **Boot redirect** with a read-only SOL pane.
 *
 * The state comes from the `202` of `POST /devices/:id/wake` and the S->A pushes `device.woke` /
 * `device.wake_failed` on `/signal` (rule W2); nothing is inferred that the server has not said.
 */
import { useEffect, useState } from 'react';
import {
  AMT_BOOT_TARGETS,
  LIMITS,
  WAKE_METHODS,
  type AmtBootTarget,
  type AmtInventory,
  type UnattendedPolicy,
  type WakeFailCause,
  type WakeMethod,
  type WakeReply,
} from '@indiansassist/shared';
import { Alert, Badge, Button, Field, Input, Select } from '../../components/ui';
import { fmtDuration, shortId } from '../../lib/format';
import { coldPowerOnText, refusalText, WAKE_FAIL_TEXT } from './fleetText';

export type WakeProgress =
  | { state: 'idle' }
  | { state: 'requesting' }
  | { state: 'pending'; wakeId: string; method: WakeMethod; via: string | null }
  | { state: 'dispatched'; wakeId: string; method: WakeMethod; via: string }
  | { state: 'woke'; wakeId: string; method: WakeMethod; via: string | null; elapsedMs: number }
  | { state: 'failed'; wakeId: string; method: WakeMethod; cause: WakeFailCause };

/** Rule 8.3: a `202` with a `via` is already dispatched; `via: null` means no peer was elected yet. */
export function progressFromReply(r: WakeReply): WakeProgress {
  return r.via === null
    ? { state: 'pending', wakeId: r.wakeId, method: r.method, via: null }
    : { state: 'dispatched', wakeId: r.wakeId, method: r.method, via: r.via };
}

/** The two S->A pushes of rule W2 (`schemas/signal-device.ts`), narrowed to what the panel reads. */
export type WakeEvent =
  | { t: 'device.woke'; wakeId: string; deviceId: string; via: string | null; method: WakeMethod; elapsedMs: number }
  | { t: 'device.wake_failed'; wakeId: string; deviceId: string; cause: WakeFailCause };

/** Applies a `device.woke` / `device.wake_failed` push; a push for another attempt is ignored. */
export function applyWakeEvent(p: WakeProgress, ev: WakeEvent): WakeProgress {
  if (p.state !== 'pending' && p.state !== 'dispatched') return p;
  if (p.wakeId !== ev.wakeId) return p;
  return ev.t === 'device.woke'
    ? { state: 'woke', wakeId: ev.wakeId, method: ev.method, via: ev.via, elapsedMs: ev.elapsedMs }
    : { state: 'failed', wakeId: ev.wakeId, method: p.method, cause: ev.cause };
}

const METHOD_LABEL: Record<WakeMethod, string> = {
  auto: 'Automatic (AMT if set up, otherwise wake on LAN)',
  wol: 'Wake on LAN through another device on the same network',
  amt: 'AMT cold power on (Intel vPro)',
};

export function wakeStatusText(p: WakeProgress): string {
  switch (p.state) {
    case 'idle':
      return 'No wake has been asked for.';
    case 'requesting':
      return 'Asking the server to wake this device...';
    case 'pending':
      return 'Wake requested. The server is choosing a device on the same network to send it.';
    case 'dispatched':
      return `Wake sent via device ${shortId(p.via)}. Waiting up to ${LIMITS.wakeConfirmSec} seconds for the machine to come back.`;
    case 'woke':
      return `The device came back after ${fmtDuration(p.elapsedMs)}${p.via ? ` (via device ${shortId(p.via)})` : ''}.`;
    case 'failed':
      return `Wake failed: ${WAKE_FAIL_TEXT[p.cause]}`;
  }
}

/** The `WAKE_STATES` word for the live region, so the state is text and not a colour. */
export function wakeStateWord(p: WakeProgress): string {
  return p.state === 'requesting' ? 'pending' : p.state;
}

export type SolLine = { seq: number; text: string };

export type WakePanelProps = {
  deviceId: string;
  deviceName: string;
  online: boolean;
  amt: AmtInventory | null;
  policy: UnattendedPolicy;
  /** Section 7.1: wake needs `fleet.act`; the SOL console and boot redirect need `fleet.amt`. */
  canWake: boolean;
  canAmt: boolean;
  onWake: (method: WakeMethod, reason: string | undefined) => Promise<WakeReply>;
  onOpenSol?: (reason: string) => Promise<{ solId: string; via: string }>;
  onCloseSol?: (solId: string) => Promise<void>;
  onBoot?: (target: AmtBootTarget, reason: string) => Promise<{ cmdId: string; via: string }>;
  /** Subscribes to the S->A wake pushes; returns an unsubscribe. */
  subscribe?: (fn: (ev: WakeEvent) => void) => () => void;
  solLines?: SolLine[];
};

export function WakePanel({
  deviceId,
  deviceName,
  online,
  amt,
  policy,
  canWake,
  canAmt,
  onWake,
  onOpenSol,
  onCloseSol,
  onBoot,
  subscribe,
  solLines = [],
}: WakePanelProps) {
  const [method, setMethod] = useState<WakeMethod>('auto');
  const [reason, setReason] = useState('');
  const [progress, setProgress] = useState<WakeProgress>({ state: 'idle' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!subscribe) return;
    return subscribe((ev) => {
      if (ev.deviceId !== deviceId) return;
      setProgress((p) => applyWakeEvent(p, ev));
    });
  }, [subscribe, deviceId]);

  const wake = async () => {
    setError(null);
    setProgress({ state: 'requesting' });
    try {
      setProgress(progressFromReply(await onWake(method, reason.trim() || undefined)));
    } catch (e) {
      setProgress({ state: 'idle' });
      setError(refusalText(e, 'The wake request was refused.'));
    }
  };

  const busy = progress.state === 'requesting' || progress.state === 'pending' || progress.state === 'dispatched';

  return (
    <section aria-label="Wake" className="flex flex-col gap-3">
      <h3 className="text-base font-semibold">Wake</h3>
      {online ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">{deviceName} is online; it does not need waking.</p>
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-400">{deviceName} is offline. A wake is sent through another device on its network, or through AMT.</p>
      )}
      <p className="text-sm">{coldPowerOnText(amt)}</p>

      {!canWake ? (
        <Alert tone="blue">Your role may view this device but not wake it.</Alert>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Method">
              {(f) => (
                <Select id={f.id} value={method} onChange={(e) => setMethod(e.target.value as WakeMethod)} disabled={busy}>
                  {WAKE_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {METHOD_LABEL[m]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Reason (optional)" hint={`At most ${LIMITS.reasonMax} characters; written to the audit trail.`}>
              {(f) => (
                <Input id={f.id} aria-describedby={f.describedBy} maxLength={LIMITS.reasonMax} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
              )}
            </Field>
          </div>
          <div>
            <Button onClick={() => void wake()} disabled={busy}>
              {busy ? 'Waking...' : 'Wake this device'}
            </Button>
          </div>
        </>
      )}

      {error && <Alert>{error}</Alert>}
      <div role="status" aria-live="polite" className="flex flex-col gap-1 text-sm">
        <span>
          <Badge tone={progress.state === 'woke' ? 'green' : progress.state === 'failed' ? 'red' : progress.state === 'idle' ? 'neutral' : 'amber'}>
            <span className="sr-only">Wake state: </span>
            {wakeStateWord(progress)}
          </Badge>
        </span>
        <p data-testid="wake-status">{wakeStatusText(progress)}</p>
      </div>

      {canAmt && (policy.allowAmtSol || policy.allowAmtBootRedirect) && (
        <AmtOutOfBand
          policy={policy}
          amt={amt}
          solLines={solLines}
          onOpenSol={onOpenSol}
          onCloseSol={onCloseSol}
          onBoot={onBoot}
        />
      )}
    </section>
  );
}

function AmtOutOfBand({
  policy,
  amt,
  solLines,
  onOpenSol,
  onCloseSol,
  onBoot,
}: Pick<WakePanelProps, 'policy' | 'amt' | 'onOpenSol' | 'onCloseSol' | 'onBoot'> & { solLines: SolLine[] }) {
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState<AmtBootTarget>('hdd');
  const [sol, setSol] = useState<{ solId: string; via: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reasonOk = reason.trim().length >= 1;

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setError(refusalText(e, 'The request was refused.'));
    }
  };

  return (
    <section aria-label="Out-of-band access (AMT)" className="flex flex-col gap-3 rounded border border-amber-300 p-3 dark:border-amber-800">
      <h4 className="text-sm font-semibold">Out-of-band access (AMT)</h4>
      <p className="text-xs text-slate-700 dark:text-slate-300">
        Nothing is shown on the device&apos;s own screen for these. A reason is required and every use is on the audit trail and in the device&apos;s receipts.
      </p>
      {!amt?.provisioned && <Alert tone="amber">This device&apos;s AMT firmware is not set up for management, so these will be refused.</Alert>}
      {amt && amt.tls === false && <Alert tone="amber">AMT on this device answers over plain HTTP; the residency report flags it.</Alert>}
      <Field label="Reason" error={!reasonOk && (note !== null || error !== null) ? 'Enter a reason.' : null}>
        {(f) => <Input id={f.id} aria-describedby={f.describedBy} maxLength={LIMITS.reasonMax} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
      <div className="flex flex-wrap items-end gap-2">
        {policy.allowAmtSol && onOpenSol && (
          <Button
            variant="secondary"
            disabled={!reasonOk || sol !== null}
            onClick={() => void run(async () => setSol(await onOpenSol(reason.trim())))}
          >
            Open SOL console
          </Button>
        )}
        {policy.allowAmtSol && sol && onCloseSol && (
          <Button
            variant="secondary"
            onClick={() =>
              void run(async () => {
                await onCloseSol(sol.solId);
                setSol(null);
                setNote('The serial console was closed.');
              })
            }
          >
            Close SOL console
          </Button>
        )}
        {policy.allowAmtBootRedirect && onBoot && (
          <>
            <Field label="Boot device">
              {(f) => (
                <Select id={f.id} className="w-32" value={target} onChange={(e) => setTarget(e.target.value as AmtBootTarget)}>
                  {AMT_BOOT_TARGETS.map((t) => (
                    <option key={t} value={t}>
                      {t.toUpperCase()}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button
              variant="secondary"
              disabled={!reasonOk}
              onClick={() =>
                void run(async () => {
                  const r = await onBoot(target, reason.trim());
                  setNote(`Boot redirect to ${target.toUpperCase()} sent (command ${shortId(r.cmdId)}, via device ${shortId(r.via)}).`);
                })
              }
            >
              Redirect next boot
            </Button>
          </>
        )}
      </div>
      {error && <Alert>{error}</Alert>}
      {note && <Alert tone="blue">{note}</Alert>}
      {sol && (
        <div className="flex flex-col gap-1" aria-live="polite">
          <p className="text-xs">
            Serial console {shortId(sol.solId)} through device {shortId(sol.via)}. It is read only: there is no input path from this console, and it closes
            after {LIMITS.amtSolMaxMinutes} minutes.
          </p>
          <pre aria-label="Serial console output" tabIndex={0} className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2 font-mono text-xs text-slate-100">
            {solLines.length === 0 ? '(no output yet)' : solLines.map((l) => l.text).join('')}
          </pre>
        </div>
      )}
    </section>
  );
}
