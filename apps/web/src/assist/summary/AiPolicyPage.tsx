/**
 * /app/settings/ai (docs/specs/phase-e-contracts.md sections 5.2, 13.4, stream ai): the org AI policy. The provider
 * choice is limited to what `GET /ai/capabilities` reports for the org's region; choosing Anthropic shows the exact
 * acknowledgement text for the region's scope and needs a typed confirmation (the org name) before it is sent; the
 * auto-summarise and transcript switches carry their explanations and the honest limit of section 5.4. Everyone may
 * read it; only an org_admin may change it.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { REGION_LABELS, aiAckText, type AiCapabilities, type AiPolicyPatch, type AiPolicyReply, type AiProvider } from '@indiansassist/shared';
import { useAuth } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { Alert, Button, Card, Field, Input, PageHeader, Spinner } from '../../components/ui';
import { usePageTitle } from '../../hooks/usePageTitle';
import { errorMessage, isApiError } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { HONEST_LIMIT } from './SummaryPanel';
import { summaryApi } from './summaryApi';

type Form = { provider: AiProvider; autoSummarize: boolean; includeTranscript: boolean };

export function AiPolicyPage() {
  usePageTitle('AI summaries');
  const { me } = useAuth();
  const isAdmin = can(me?.user.role, 'ai.admin');
  const [caps, setCaps] = useState<AiCapabilities | null>(null);
  const [policy, setPolicy] = useState<AiPolicyReply | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [confirm, setConfirm] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([summaryApi.capabilities(), summaryApi.policy()])
      .then(([c, p]) => {
        if (!live) return;
        setCaps(c);
        setPolicy(p);
        setForm({ provider: p.provider, autoSummarize: p.autoSummarize, includeTranscript: p.includeTranscript });
      })
      .catch((e: unknown) => live && setLoadError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, []);

  if (loadError)
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="AI summaries" />
        <Alert>{loadError}</Alert>
      </div>
    );
  if (!caps || !policy || !form || !me)
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="AI summaries" />
        <Spinner label="Loading the AI policy" />
      </div>
    );

  const regionLabel = REGION_LABELS[caps.region];
  const scope = caps.anthropic.ackScope;
  const ackText = scope ? aiAckText(scope, me.org.name, regionLabel) : null;
  const needsAck = form.provider === 'anthropic' && (policy.provider !== 'anthropic' || policy.anthropicAck === null);
  const confirmed = confirm.trim() === me.org.name;
  const nothingServed = !caps.local && !caps.anthropic.available;

  const options: { value: AiProvider; label: string; detail: string; available: boolean }[] = [
    { value: 'none', label: 'Off', detail: 'No summaries are generated.', available: true },
    {
      value: 'local',
      label: 'In-region model',
      detail: `An automated assistant run by the operator inside ${regionLabel}. Session content does not leave the region.`,
      available: caps.local,
    },
    {
      value: 'anthropic',
      label: 'Anthropic (Claude)',
      detail:
        caps.anthropic.inferenceGeo === 'us'
          ? 'Redacted session content leaves IndiansAssist infrastructure; inference is requested in the United States.'
          : `Redacted session content leaves IndiansAssist infrastructure and the ${regionLabel} region.`,
      available: caps.anthropic.available,
    },
  ];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (needsAck && (!confirmed || !scope || !ackText)) return setError(`Type the organisation name (${me.org.name}) to confirm the acknowledgement.`);
    const patch: AiPolicyPatch = { provider: form.provider, autoSummarize: form.autoSummarize, includeTranscript: form.includeTranscript };
    if (needsAck && scope && ackText) patch.acknowledge = { scope, text: ackText };
    setBusy(true);
    try {
      const next = await summaryApi.patchPolicy(patch);
      setPolicy(next);
      setForm({ provider: next.provider, autoSummarize: next.autoSummarize, includeTranscript: next.includeTranscript });
      setConfirm('');
      setStatus('The AI policy was saved.');
    } catch (err) {
      setStatus('');
      setError(
        isApiError(err, 'ai_ack_required')
          ? 'The acknowledgement did not match. Reload the page and confirm it again.'
          : isApiError(err, 'ai_provider_unavailable')
            ? 'That provider is not available for this region on this server.'
            : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="AI summaries" />
      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
      {status && <Alert tone="green">{status}</Alert>}
      {error && <Alert>{error}</Alert>}
      {nothingServed && <Alert tone="blue">No AI summary provider is available for {regionLabel} on this server. Summaries stay off.</Alert>}
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" aria-label="AI policy">
        <Card title="Provider">
          <fieldset className="flex flex-col gap-3" disabled={!isAdmin}>
            <legend className="sr-only">Summary provider</legend>
            {options.map((o) => (
              <label key={o.value} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="provider"
                  value={o.value}
                  checked={form.provider === o.value}
                  disabled={!isAdmin || !o.available}
                  onChange={() => setForm({ ...form, provider: o.value })}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">{o.label}</span>
                  {!o.available && ' (not available on this server)'}
                  <span className="block text-slate-600 dark:text-slate-400">{o.detail}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {policy.anthropicAck && (
            <p className="mt-3 text-sm">
              Acknowledged by {policy.anthropicAck.by.name} on {fmtDateTime(policy.anthropicAck.at)} ({policy.anthropicAck.scope === 'in_geo' ? 'inference in the United States' : 'inference may run outside the region'}).
            </p>
          )}
          {needsAck && ackText && (
            <div className="mt-3 flex flex-col gap-2 text-sm">
              <h3 className="font-semibold">Acknowledgement</h3>
              <blockquote className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100" data-testid="ack-text">
                {ackText}
              </blockquote>
              <Field label={`Type the organisation name (${me.org.name}) to confirm`}>
                {({ id }) => <Input id={id} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />}
              </Field>
            </div>
          )}
        </Card>
        <Card title="When to summarise">
          <div className="flex flex-col gap-3 text-sm">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={form.autoSummarize}
                disabled={!isAdmin || form.provider === 'none'}
                onChange={(e) => setForm({ ...form, autoSummarize: e.target.checked })}
                className="mt-1"
              />
              <span>
                <span className="font-medium">Summarise every session when it ends</span>
                <span className="block text-slate-600 dark:text-slate-400">Otherwise a technician asks for a summary from the ended session.</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={form.includeTranscript}
                disabled={!isAdmin || form.provider === 'none'}
                onChange={(e) => setForm({ ...form, includeTranscript: e.target.checked })}
                className="mt-1"
              />
              <span>
                <span className="font-medium">Include the chat and playbook output</span>
                <span className="block text-slate-600 dark:text-slate-400">
                  The console first tells the person being helped, in the chat, who will read it. The text is redacted, held for at most 30 minutes and never stored.
                </span>
              </span>
            </label>
            <p className="text-xs text-slate-600 dark:text-slate-400">{HONEST_LIMIT}</p>
          </div>
        </Card>
        {isAdmin ? (
          <div>
            <Button type="submit" disabled={busy || (needsAck && !confirmed)}>
              Save AI policy
            </Button>
          </div>
        ) : (
          <p className="text-sm">Only an organisation administrator can change this policy.</p>
        )}
      </form>
    </div>
  );
}
