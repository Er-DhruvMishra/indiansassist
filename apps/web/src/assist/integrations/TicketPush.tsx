/**
 * The ticket push of an ended session (docs/specs/phase-e-contracts.md sections 4.4, 4.7, 13.4, stream tickets),
 * rendered by the foundation's `<TicketPushSlot/>` in `EndedView`: the push dialog (an enabled integration, create a
 * ticket or append a note to an existing one, the AI summary with its version or a manual note, optional title,
 * priority and requester email labelled with where it is sent) and the session's push list with states in words,
 * links, and a manual retry that warns first when the last failure was ambiguous (rule 4.4e). Results are announced in
 * a live region. Renders nothing for a session that has not ended, for observers, and when there is nothing to show.
 */
import { useId, useMemo, useState, type FormEvent } from 'react';
import {
  TICKET_PRIORITIES,
  type IntegrationType,
  type SessionDetail,
  type TicketPriority,
  type TicketPush as TicketPushRecord,
  type TicketPushRequest,
} from '@indiansassist/shared';
import { useAuth } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { Dialog } from '../../components/Dialog';
import { Alert, Badge, Button, Card, Field, Input, Select } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { errorMessage } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { CAUSE_WORDS, integrationsApi, isAmbiguous, TYPE_LABELS } from './api';

const STATE_WORDS: Record<TicketPushRecord['state'], string> = { pending: 'Sending', delivered: 'Delivered', retrying: 'Retrying', failed: 'Failed' };
const STATE_TONES = { pending: 'blue', delivered: 'green', retrying: 'amber', failed: 'red' } as const;

function newClientPushId(): string {
  return globalThis.crypto.randomUUID();
}

/** One sentence describing a push outcome (the live-region text). */
export function outcomeText(p: TicketPushRecord): string {
  const where = TYPE_LABELS[p.type];
  if (p.state === 'delivered') return `Delivered to ${where}${p.externalId ? ` as ${p.externalId}` : ''}.`;
  if (p.state === 'retrying')
    return `Not delivered yet: ${p.lastFailure ? CAUSE_WORDS[p.lastFailure.cause] : 'waiting'}. Retrying automatically${p.nextAttemptAt ? ` at ${fmtDateTime(p.nextAttemptAt)}` : ''}.`;
  if (p.state === 'failed') return `Failed: ${p.lastFailure ? CAUSE_WORDS[p.lastFailure.cause] : 'unknown cause'}.`;
  return `Sending to ${where}.`;
}

type Draft = {
  type: IntegrationType | '';
  mode: 'create' | 'append';
  externalId: string;
  source: 'summary' | 'manual';
  summaryVersion: string;
  note: string;
  title: string;
  priority: TicketPriority | '';
  requesterEmail: string;
};

function PushDialog({
  session,
  types,
  readyVersions,
  open,
  onClose,
  onPushed,
}: {
  session: SessionDetail;
  types: IntegrationType[];
  readyVersions: number[];
  open: boolean;
  onClose: () => void;
  onPushed: (p: TicketPushRecord) => void;
}) {
  const [clientPushId] = useState(newClientPushId);
  const [draft, setDraft] = useState<Draft>(() => ({
    type: types[0] ?? '',
    mode: 'create',
    externalId: '',
    source: readyVersions.length > 0 ? 'summary' : 'manual',
    summaryVersion: readyVersions.length > 0 ? String(readyVersions[readyVersions.length - 1]) : '',
    note: '',
    title: '',
    priority: '',
    requesterEmail: '',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modeName = useId();
  const sourceName = useId();
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const where = draft.type ? TYPE_LABELS[draft.type] : 'the ticketing system';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.type) return;
    setBusy(true);
    setError(null);
    const body: TicketPushRequest = {
      sessionId: session.id,
      clientPushId,
      mode: draft.mode,
      source: draft.source,
      ...(draft.mode === 'append' ? { externalId: draft.externalId.trim() } : {}),
      ...(draft.source === 'summary' && draft.summaryVersion ? { summaryVersion: Number(draft.summaryVersion) } : {}),
      ...(draft.source === 'manual' ? { note: draft.note } : {}),
      ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
      ...(draft.priority ? { priority: draft.priority } : {}),
      ...(draft.requesterEmail.trim() ? { requesterEmail: draft.requesterEmail.trim() } : {}),
    };
    try {
      const { push } = await integrationsApi.push(draft.type, body);
      onPushed(push);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title="Push to ticketing" onClose={onClose} wide>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Field label="Integration">
          {({ id }) => (
            <Select id={id} value={draft.type} onChange={(e) => set({ type: e.target.value as IntegrationType })} data-autofocus>
              {types.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">What to do</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={modeName} checked={draft.mode === 'create'} onChange={() => set({ mode: 'create' })} />
            Create a new ticket
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={modeName} checked={draft.mode === 'append'} onChange={() => set({ mode: 'append' })} />
            Add a note to an existing ticket
          </label>
        </fieldset>
        {draft.mode === 'append' && (
          <Field label="Existing ticket id" hint={`The ticket's id or key in ${where}.`}>
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} required maxLength={100} value={draft.externalId} onChange={(e) => set({ externalId: e.target.value })} />
            )}
          </Field>
        )}
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">Content</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={sourceName} checked={draft.source === 'summary'} disabled={readyVersions.length === 0} onChange={() => set({ source: 'summary' })} />
            The AI summary{readyVersions.length === 0 ? ' (no ready summary for this session)' : ''}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={sourceName} checked={draft.source === 'manual'} onChange={() => set({ source: 'manual' })} />A note I write
          </label>
        </fieldset>
        {draft.source === 'summary' && readyVersions.length > 0 && (
          <Field label="Summary version">
            {({ id }) => (
              <Select id={id} value={draft.summaryVersion} onChange={(e) => set({ summaryVersion: e.target.value })}>
                {[...readyVersions].reverse().map((v, i) => (
                  <option key={v} value={String(v)}>
                    Version {v}
                    {i === 0 ? ' (latest)' : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {draft.source === 'manual' && (
          <Field label="Note">
            {({ id }) => (
              <textarea
                id={id}
                required
                maxLength={20000}
                rows={6}
                className="min-h-24 w-full rounded-md border border-slate-400 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
                value={draft.note}
                onChange={(e) => set({ note: e.target.value })}
              />
            )}
          </Field>
        )}
        <Field label="Title (optional)" hint="Default: Remote support session <date> — <technician>.">
          {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} maxLength={200} value={draft.title} onChange={(e) => set({ title: e.target.value })} />}
        </Field>
        <Field label="Priority (optional)">
          {({ id }) => (
            <Select id={id} value={draft.priority} onChange={(e) => set({ priority: e.target.value as TicketPriority | '' })}>
              <option value="">Integration default</option>
              {TICKET_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p[0]!.toUpperCase() + p.slice(1)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={`Requester email (optional, sent to ${where})`} hint={`Only what you type here leaves this server with the ticket.`}>
          {({ id, describedBy }) => (
            <Input id={id} type="email" aria-describedby={describedBy} maxLength={254} value={draft.requesterEmail} onChange={(e) => set({ requesterEmail: e.target.value })} />
          )}
        </Field>
        {error && <Alert>{error}</Alert>}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !draft.type}>
            {busy ? 'Pushing...' : 'Push ticket'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function PushRow({ push, canRetry, onChanged, announce }: { push: TicketPushRecord; canRetry: boolean; onChanged: (p: TicketPushRecord) => void; announce: (s: string) => void }) {
  const [warn, setWarn] = useState(false);
  const [busy, setBusy] = useState(false);
  const where = TYPE_LABELS[push.type];
  const retry = async () => {
    setBusy(true);
    try {
      const { push: p } = await integrationsApi.retry(push.id);
      setWarn(false);
      announce(outcomeText(p));
      onChanged(p);
    } catch (err) {
      announce(`Retry refused: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-col gap-1 border-b border-slate-200 py-2 last:border-b-0 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={STATE_TONES[push.state]}>{STATE_WORDS[push.state]}</Badge>
        <span className="font-medium">{where}</span>
        <span>{push.mode === 'create' ? 'new ticket' : 'note on a ticket'}</span>
        <span>{push.source === 'summary' ? `AI summary v${push.summary?.version ?? '?'}` : 'manual note'}</span>
        {push.externalId &&
          (push.externalUrl ? (
            <a className="text-teal-800 underline dark:text-teal-300" href={push.externalUrl} target="_blank" rel="noopener noreferrer">
              {push.externalId}
            </a>
          ) : (
            <span>{push.externalId}</span>
          ))}
      </div>
      <p className="text-xs text-slate-600 dark:text-slate-400">
        {push.createdBy.name}, {fmtDateTime(push.createdAt)}. Attempts: {push.attempts}
        {push.manualRetries > 0 ? `, manual retries: ${push.manualRetries}` : ''}.{' '}
        {push.state !== 'delivered' && push.state !== 'pending' ? outcomeText(push) : ''}
      </p>
      {push.state === 'failed' && canRetry && !warn && (
        <div>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => (isAmbiguous(push.lastFailure?.cause) ? setWarn(true) : void retry())}>
            Retry push to {where}
          </Button>
        </div>
      )}
      {warn && (
        <div className="flex flex-wrap items-center gap-2">
          <Alert tone="amber">The ticket may already exist in {where}. Check before retrying.</Alert>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void retry()}>
            Retry anyway
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setWarn(false)}>
            Do not retry
          </Button>
        </div>
      )}
    </li>
  );
}

function TicketPushPanel({ session }: { session: SessionDetail }) {
  const { me } = useAuth();
  const role = me?.user.role;
  const canPush = can(role, 'integrations.push');
  const orgWide = role === 'senior_technician' || role === 'org_admin';
  const available = useAsync(() => (canPush ? integrationsApi.available() : Promise.resolve({ items: [] })), [canPush]);
  const pushes = useAsync(() => integrationsApi.sessionPushes(session.id), [session.id]);
  const summaries = useAsync(
    () => (canPush ? integrationsApi.summaries(session.id).catch(() => null) : Promise.resolve(null)),
    [session.id, canPush],
  );
  const [open, setOpen] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);
  const [live, setLive] = useState('');
  const types = useMemo(() => (available.data?.items ?? []).map((i) => i.type), [available.data]);
  const readyVersions = useMemo(
    () => (summaries.data?.versions ?? []).filter((v) => v.state === 'ready').map((v) => v.version).sort((a, b) => a - b),
    [summaries.data],
  );
  const items = pushes.data?.items ?? [];

  const upsert = (p: TicketPushRecord) => {
    const rest = items.filter((x) => x.id !== p.id);
    pushes.setData({ items: [p, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  };

  if (types.length === 0 && items.length === 0) return null;
  return (
    <Card
      title="Tickets"
      actions={
        canPush && types.length > 0 ? (
          <Button
            size="sm"
            onClick={() => {
              setDialogKey((k) => k + 1);
              setOpen(true);
            }}
          >
            Push to ticketing
          </Button>
        ) : undefined
      }
    >
      <div aria-live="polite" role="status" className="text-sm">
        {live}
      </div>
      {pushes.error !== null && <Alert>{errorMessage(pushes.error)}</Alert>}
      {items.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">Nothing pushed from this session yet.</p>
      ) : (
        <ul aria-label="Ticket pushes">
          {items.map((p) => (
            <PushRow key={p.id} push={p} canRetry={canPush && (orgWide || p.createdBy.id === me?.user.id)} onChanged={upsert} announce={setLive} />
          ))}
        </ul>
      )}
      {open && (
        <PushDialog
          key={dialogKey}
          session={session}
          types={types}
          readyVersions={readyVersions}
          open={open}
          onClose={() => setOpen(false)}
          onPushed={(p) => {
            setOpen(false);
            setLive(outcomeText(p));
            upsert(p);
          }}
        />
      )}
    </Card>
  );
}

export function TicketPush({ session }: { session: SessionDetail }) {
  // Pushes exist only for ended sessions (W68); the slot also renders for other states and for partial objects.
  if (session.state !== 'ended') return null;
  return <TicketPushPanel session={session} />;
}
