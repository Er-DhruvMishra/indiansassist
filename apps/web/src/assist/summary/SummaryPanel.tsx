/**
 * The AI summary panel of an ended session (docs/specs/phase-e-contracts.md sections 5.8, 5.9, 13.4, stream ai),
 * rendered by the foundation's `<SummaryPanelSlot/>` in `EndedView`. It shows the latest version's state, provider
 * and served model, the fallback note, "chat included" or "events only", the six output fields as an editable form
 * saved against the base version, regenerate, the version history, a warning when the redaction detector would
 * change the edited text, and the honest limit of section 5.4. States are always in words (WCAG 2.1 AA).
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  REDACTION_KINDS,
  SUMMARY_OUTCOMES,
  newRedactionState,
  redactText,
  type AiSessionSummary,
  type RedactionCounts,
  type SessionDetail,
  type SessionSummaryOutput,
} from '@indiansassist/shared';
import { useAuth } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { Alert, Badge, Button, Card, Field, Select, Spinner } from '../../components/ui';
import { errorMessage, isApiError } from '../../lib/api';
import { fmtDateTime, humanise } from '../../lib/format';
import { summaryApi, type SummaryList } from './summaryApi';
import { lastTranscriptUpload } from './useEnterpriseLiveHooks';

/** Section 5.4: stated wherever the transcript option is offered or used. */
export const HONEST_LIMIT =
  'Redaction removes email addresses, phone numbers, card and ID numbers, addresses of machines and recognised secrets. Personal names, postal addresses and other free-text personal details are not reliably detected and are not removed.';

const POLL_MS = 3000;

const STATE_TEXT: Record<AiSessionSummary['state'], string> = {
  pending: 'Waiting to generate',
  running: 'Generating',
  ready: 'Ready',
  failed: 'Failed',
};
const STATE_TONE = { pending: 'amber', running: 'blue', ready: 'green', failed: 'red' } as const;
const OUTCOME_TEXT: Record<SessionSummaryOutput['outcome'], string> = {
  resolved: 'Resolved',
  partially_resolved: 'Partially resolved',
  unresolved: 'Unresolved',
  unknown: 'Unknown',
};
const CAUSE_TEXT: Record<string, string> = {
  provider_disabled: 'AI summaries were turned off or the provider changed before it ran.',
  provider_unavailable: 'The summary service could not be reached.',
  rate_limited: 'The summary service was busy.',
  auth: 'The summary service refused the server credentials. Tell your operator.',
  bad_request: 'The summary service refused the request.',
  refused: 'The model declined to summarise this session.',
  truncated: 'The answer was cut off.',
  invalid_output: 'The answer was not a usable summary.',
  timeout: 'The summary service did not answer in time.',
};

type Draft = { summary: string; outcome: SessionSummaryOutput['outcome']; actionsTaken: string; issuesFound: string; followUps: string; ticketNote: string };

const toDraft = (o: SessionSummaryOutput): Draft => ({
  summary: o.summary,
  outcome: o.outcome,
  actionsTaken: o.actionsTaken.join('\n'),
  issuesFound: o.issuesFound.join('\n'),
  followUps: o.followUps.join('\n'),
  ticketNote: o.ticketNote,
});
const lines = (s: string, max: number) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, max)
    .map((l) => l.slice(0, 300));

export function fromDraft(d: Draft): SessionSummaryOutput {
  return {
    summary: d.summary.trim().slice(0, 1500),
    outcome: d.outcome,
    actionsTaken: lines(d.actionsTaken, 25),
    issuesFound: lines(d.issuesFound, 15),
    followUps: lines(d.followUps, 15),
    ticketNote: d.ticketNote.trim().slice(0, 6000),
  };
}

/** 5.8e: the redaction detector over an edit; the kinds it would replace (empty = nothing found). */
export function detectRedactions(o: SessionSummaryOutput): RedactionCounts {
  const state = newRedactionState();
  for (const t of [o.summary, ...o.actionsTaken, ...o.issuesFound, ...o.followUps, o.ticketNote]) redactText(t, state);
  return state.counts;
}

function countsText(c: RedactionCounts): string {
  return REDACTION_KINDS.filter((k) => c[k] > 0)
    .map((k) => `${c[k]} ${humanise(k)}`)
    .join(', ');
}

export function SummaryPanel({ session }: { session: SessionDetail }) {
  // Only an ended session has a summary; the slot renders nothing otherwise.
  if (session.state !== 'ended') return null;
  return <SummaryPanelBody sessionId={session.id} />;
}

function SummaryPanelBody({ sessionId }: { sessionId: string }) {
  const { me } = useAuth();
  const role = me?.user.role;
  const canRead = can(role, 'summary.read');
  const canWrite = can(role, 'summary.write');
  const [list, setList] = useState<SummaryList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [aiOff, setAiOff] = useState(false);
  const [viewing, setViewing] = useState<AiSessionSummary | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const l = await summaryApi.list(sessionId);
      setList(l);
      setLoadError(null);
      return l;
    } catch (e) {
      setLoadError(errorMessage(e));
      return null;
    }
  }, [sessionId]);

  useEffect(() => {
    if (!canRead) return;
    void load();
    void summaryApi
      .policy()
      .then((p) => setAiOff(p.provider === 'none'))
      .catch(() => undefined);
  }, [canRead, load]);

  const latest = list?.latest ?? null;
  const inFlight = latest?.state === 'pending' || latest?.state === 'running';
  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [inFlight, load]);

  // The editable form follows the latest ready version.
  useEffect(() => {
    if (latest?.state === 'ready' && latest.output) setDraft(toDraft(latest.output));
    setWarn(null);
  }, [latest?.id, latest?.state, latest?.output]);

  const output = useMemo(() => (draft ? fromDraft(draft) : null), [draft]);

  if (!canRead) return null;

  const generate = async () => {
    setBusy(true);
    setActionError(null);
    try {
      // 5.3b: on a regenerate the console sends the transcript again (the held copy is dropped once a version is ready).
      const held = lastTranscriptUpload(sessionId);
      if (held) await summaryApi.uploadInput(sessionId, held).catch(() => undefined);
      await summaryApi.generate(sessionId);
      setStatus('A new summary was requested.');
      await load();
    } catch (e) {
      setActionError(isApiError(e, 'ai_disabled') ? 'AI summaries are turned off for this organisation.' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async (e: FormEvent, confirmed = false) => {
    e.preventDefault();
    if (!latest || !output) return;
    if (!output.summary || !output.ticketNote) return setActionError('The summary and the ticket note cannot be empty.');
    const found = detectRedactions(output);
    if (!confirmed && REDACTION_KINDS.some((k) => found[k] > 0)) {
      setWarn(`This text looks like it contains personal data or secrets (${countsText(found)}). Edited text is saved as written.`);
      return;
    }
    setBusy(true);
    setActionError(null);
    setWarn(null);
    try {
      const v = await summaryApi.edit(sessionId, latest.version, output);
      setStatus(`Saved as version ${v.version}.`);
      await load();
    } catch (err) {
      setActionError(
        isApiError(err, 'summary_conflict') ? 'A newer version exists. Reload it before saving your edit.' : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const view = async (version: number) => {
    setActionError(null);
    try {
      setViewing(await summaryApi.version(sessionId, version));
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const set = (k: keyof Draft) => (ev: { target: { value: string } }) => setDraft((d) => (d ? { ...d, [k]: ev.target.value } : d));
  const area = 'min-h-20 w-full rounded-md border border-slate-400 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-950';
  const editable = canWrite && latest?.state === 'ready' && draft !== null;

  return (
    <Card
      title="AI summary"
      actions={
        canWrite && !aiOff ? (
          <Button size="sm" variant="secondary" disabled={busy || inFlight} onClick={() => void generate()}>
            {latest ? 'Regenerate' : 'Generate summary'}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p role="status" aria-live="polite" className="sr-only">
          {status}
        </p>
        {loadError && <Alert>{loadError}</Alert>}
        {actionError && <Alert>{actionError}</Alert>}
        {!list && !loadError && <Spinner label="Loading the summary" />}
        {list && !latest && <p>{aiOff ? 'AI summaries are turned off for this organisation.' : 'No summary yet.'}</p>}
        {latest && (
          <div className="flex flex-wrap items-center gap-2" aria-live="polite">
            <Badge tone={STATE_TONE[latest.state]}>{STATE_TEXT[latest.state]}</Badge>
            <span>
              Version {latest.version}, {humanise(latest.trigger)}, {latest.provider === 'local' ? 'in-region model' : latest.provider === 'anthropic' ? 'Anthropic (Claude)' : 'no provider'}
              {latest.servedModel ? ` (${latest.servedModel})` : ` (${latest.model})`}
            </span>
            <Badge tone="neutral">{latest.transcriptIncluded ? 'chat included' : 'events only'}</Badge>
            {inFlight && <Spinner label={STATE_TEXT[latest.state]} />}
          </div>
        )}
        {latest?.fallbackUsed && latest.servedModel && <p>Generated by {latest.servedModel} after a fallback.</p>}
        {latest?.normalised && <p>Parts of the generated text were shortened to fit the limits.</p>}
        {latest?.state === 'failed' && <Alert tone="amber">{CAUSE_TEXT[latest.cause ?? ''] ?? 'The summary could not be generated.'}</Alert>}
        {latest && latest.state === 'ready' && countsText(latest.redactions) && (
          <p>Removed before sending: {countsText(latest.redactions)}.</p>
        )}
        {editable && (
          <form className="flex flex-col gap-3" onSubmit={(e) => void save(e)} aria-label="Edit the summary">
            <Field label="Summary">
              {({ id }) => <textarea id={id} className={area} value={draft.summary} onChange={set('summary')} maxLength={1500} />}
            </Field>
            <Field label="Outcome">
              {({ id }) => (
                <Select id={id} value={draft.outcome} onChange={set('outcome')}>
                  {SUMMARY_OUTCOMES.map((o) => (
                    <option key={o} value={o}>
                      {OUTCOME_TEXT[o]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Actions taken" hint="One per line.">
              {({ id, describedBy }) => <textarea id={id} aria-describedby={describedBy} className={area} value={draft.actionsTaken} onChange={set('actionsTaken')} />}
            </Field>
            <Field label="Issues found" hint="One per line.">
              {({ id, describedBy }) => <textarea id={id} aria-describedby={describedBy} className={area} value={draft.issuesFound} onChange={set('issuesFound')} />}
            </Field>
            <Field label="Follow-ups" hint="One per line.">
              {({ id, describedBy }) => <textarea id={id} aria-describedby={describedBy} className={area} value={draft.followUps} onChange={set('followUps')} />}
            </Field>
            <Field label="Ticket note">
              {({ id }) => <textarea id={id} className={area} value={draft.ticketNote} onChange={set('ticketNote')} maxLength={6000} />}
            </Field>
            {warn && (
              <div role="alert" className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
                <p>{warn}</p>
                <div>
                  <Button size="sm" variant="secondary" onClick={(e) => void save(e, true)}>
                    Save anyway
                  </Button>
                </div>
              </div>
            )}
            <div>
              <Button type="submit" disabled={busy}>
                Save as a new version
              </Button>
            </div>
          </form>
        )}
        {!editable && latest?.state === 'ready' && latest.output && <OutputView output={latest.output} />}
        {list && list.versions.length > 0 && (
          <details>
            <summary className="cursor-pointer font-medium">Version history ({list.versions.length})</summary>
            <ul className="mt-2 flex flex-col gap-1" aria-label="Summary versions">
              {list.versions.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-2">
                  <span>
                    Version {v.version}: {humanise(v.trigger)}, {STATE_TEXT[v.state].toLowerCase()}, {fmtDateTime(v.createdAt)}
                    {v.editedBy ? `, edited by ${v.editedBy.name}` : v.createdBy ? `, by ${v.createdBy.name}` : ', automatic'}
                  </span>
                  {v.state === 'ready' && (
                    <Button size="sm" variant="ghost" onClick={() => void view(v.version)}>
                      View version {v.version}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
        {viewing?.output && (
          <section aria-label={`Version ${viewing.version}`} className="rounded-md border border-slate-200 p-3 dark:border-slate-700">
            <h3 className="mb-1 font-semibold">Version {viewing.version}</h3>
            <OutputView output={viewing.output} />
            <Button size="sm" variant="ghost" onClick={() => setViewing(null)}>
              Close version {viewing.version}
            </Button>
          </section>
        )}
        <p className="text-xs text-slate-600 dark:text-slate-400">{HONEST_LIMIT}</p>
      </div>
    </Card>
  );
}

function OutputView({ output }: { output: SessionSummaryOutput }) {
  const list = (title: string, items: string[]) =>
    items.length > 0 && (
      <div>
        <h4 className="font-medium">{title}</h4>
        <ul className="list-disc pl-5">
          {items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      <p>{output.summary}</p>
      <p>
        <span className="font-medium">Outcome:</span> {OUTCOME_TEXT[output.outcome]}
      </p>
      {list('Actions taken', output.actionsTaken)}
      {list('Issues found', output.issuesFound)}
      {list('Follow-ups', output.followUps)}
      <div>
        <h4 className="font-medium">Ticket note</h4>
        <p className="whitespace-pre-wrap">{output.ticketNote}</p>
      </div>
    </div>
  );
}

