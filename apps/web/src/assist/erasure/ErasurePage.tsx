/**
 * /app/settings/erasure (docs/specs/phase-f-contracts.md sections 5.2, 5.6, 13.4): org erasure in words. The state
 * and the two-person steps (request, approval or the single administrator's mailed confirmation, the cooling-off
 * date, the erasure and its certificate); each step asks for the organisation slug typed out and a sign-in from the
 * last 15 minutes ("Sign in again" when it is older); Cancel for every org_admin until the erasure starts; the audit
 * export and the signed residency report to download before the date; the certificate link. State changes are
 * announced in a live region. Readable by org_admins and auditors (section 2.1); only org_admins act.
 */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { LIMITS, type ErasureStatusReply, type OrgErasure } from '@indiansassist/shared';
import { useAuth } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { Alert, Button, Card, Field, Input, PageHeader, Spinner } from '../../components/ui';
import { usePageTitle } from '../../hooks/usePageTitle';
import { errorMessage, isApiError, request as apiRequest } from '../../lib/api';
import { auditApi } from '../../lib/endpoints';
import { saveBlob } from '../../lib/fileTransfer';
import { announceErasureChanged, clearConfirmToken, ERASURE_CHANGED_EVENT, erasureApi, fmtWhen, isOpen, recordOf, stateWords, takeConfirmToken } from './erasureApi';

type Load = { reply: ErasureStatusReply | null; erasing: boolean; error: string | null };

const STEP_DONE = 'text-green-800 dark:text-green-300';

/** The steps of section 5.1 in words, each with its state. */
function Steps({ e }: { e: OrgErasure }) {
  const solo = e.approvedBy === null && e.approvedAt !== null;
  const items: { label: string; detail: string; done: boolean }[] = [
    { label: 'Requested', detail: `by ${e.requestedBy.name} on ${fmtWhen(e.requestedAt)}`, done: true },
    e.state === 'pending_confirmation' || solo
      ? {
          label: 'Confirmed from the mailed link',
          detail: e.approvedAt ? `on ${fmtWhen(e.approvedAt)}` : `by ${e.requestedBy.name}, within ${LIMITS.erasureConfirmTtlHours} hours of the request`,
          done: e.approvedAt !== null,
        }
      : {
          label: 'Approved by a second administrator',
          detail: e.approvedBy ? `by ${e.approvedBy.name} on ${fmtWhen(e.approvedAt)}` : `within ${LIMITS.erasureApprovalTtlDays} days of the request`,
          done: e.approvedBy !== null,
        },
    {
      label: 'Cooling-off period',
      detail: e.coolingOffUntil ? `until ${fmtWhen(e.coolingOffUntil)}; any administrator can cancel until then` : 'starts after the approval',
      done: e.executedAt !== null,
    },
    { label: 'Erased, with a signed certificate', detail: e.completedAt ? `on ${fmtWhen(e.completedAt)}` : 'after the cooling-off period', done: e.completedAt !== null },
  ];
  return (
    <ol className="flex flex-col gap-2" aria-label="Erasure steps">
      {items.map((s, i) => (
        <li key={s.label} className="flex gap-2 text-sm">
          <span aria-hidden="true" className={s.done ? STEP_DONE : 'text-slate-500'}>
            {s.done ? '✓' : `${i + 1}.`}
          </span>
          <span>
            <span className="font-medium">{s.label}</span>
            <span className="sr-only">{s.done ? ' (done)' : ' (not yet)'}</span>: {s.detail}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The typed-slug control shared by request and approve. */
function SlugField({ slug, value, onChange }: { slug: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Type the organisation slug to confirm" hint={<>Type <span className="font-mono">{slug}</span> exactly.</>}>
      {(p) => <Input id={p.id} aria-describedby={p.describedBy} autoComplete="off" spellCheck={false} value={value} onChange={(ev) => onChange(ev.target.value)} required />}
    </Field>
  );
}

export function ErasurePage() {
  usePageTitle('Organisation erasure');
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ reply: null, erasing: false, error: null });
  const [loading, setLoading] = useState(true);
  const [announce, setAnnounce] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);
  const [soloOffered, setSoloOffered] = useState(false);
  const [shownLink, setShownLink] = useState<string | null>(null);
  const [slug, setSlug] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [token] = useState<string | null>(() => takeConfirmToken());
  const lastState = useRef<string | null>(null);
  const reasonId = useId();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const reply = await erasureApi.status();
      setLoad({ reply, erasing: false, error: null });
    } catch (e) {
      setLoad({ reply: null, erasing: isApiError(e, 'org_erasing'), error: isApiError(e, 'org_erasing') ? null : errorMessage(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    globalThis.addEventListener(ERASURE_CHANGED_EVENT, onChange);
    return () => globalThis.removeEventListener(ERASURE_CHANGED_EVENT, onChange);
  }, [refresh]);

  const e = recordOf(load.reply ?? undefined);
  useEffect(() => {
    const st = e?.state ?? 'none';
    if (lastState.current !== null && lastState.current !== st) setAnnounce(e ? `The erasure is now ${stateWords(e.state)}.` : 'There is no erasure.');
    lastState.current = st;
  }, [e]);

  if (!me) return null;
  const role = me.user.role;
  const admin = can(role, 'erasure.admin');
  const orgSlug = me.org.slug;

  /** Runs one action; `reauth_required` asks for a new sign-in instead of an error. */
  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    setReauth(false);
    try {
      await fn();
      setSlug('');
      announceErasureChanged();
    } catch (err) {
      if (isApiError(err, 'reauth_required')) setReauth(true);
      else if (isApiError(err, 'erasure_second_admin') && err.details?.['soloAvailable'] === true) setSoloOffered(true);
      else setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const signInAgain = async () => {
    await logout();
    navigate('/login', { replace: true, state: { from: '/app/settings/erasure' } });
  };

  const submitRequest = (ev: FormEvent, solo: boolean) => {
    ev.preventDefault();
    void act(solo ? 'solo' : 'request', async () => {
      const r = await erasureApi.request({ confirmSlug: slug.trim(), ...(reason.trim() ? { reason: reason.trim() } : {}), ...(solo ? { solo: true } : {}) });
      setShownLink(r.confirmUrl ?? null);
      setReason('');
      setSoloOffered(false);
    });
  };

  const approve = (ev: FormEvent) => {
    ev.preventDefault();
    if (!e) return;
    void act('approve', async () => {
      await erasureApi.approve(e.id, slug.trim());
    });
  };

  const confirm = () => {
    if (!e || !token) return;
    void act('confirm', async () => {
      await erasureApi.confirm(e.id, token);
      clearConfirmToken();
      setShownLink(null);
    });
  };

  const cancel = () => {
    if (!e) return;
    void act('cancel', async () => {
      await erasureApi.cancel(e.id);
      clearConfirmToken();
      setShownLink(null);
    });
  };

  const exportAudit = () =>
    void act('export', async () => {
      const { blob, filename } = await auditApi.export({});
      saveBlob(blob, filename);
    });

  const downloadResidency = () =>
    void act('residency', async () => {
      const res = await apiRequest<Response>('GET', '/orgs/current/residency/signed.json', { raw: true });
      const cd = res.headers.get('Content-Disposition') ?? '';
      const m = /filename="?([^";]+)"?/.exec(cd);
      saveBlob(new Blob([await res.text()], { type: 'application/json' }), m?.[1] ?? 'residency.json');
    });

  const open = e !== null && isOpen(e.state);
  const mine = e !== null && e.requestedBy.id === me.user.id;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Organisation erasure" />
      <p className="sr-only" role="status" aria-live="polite" data-testid="erasure-live">
        {announce}
      </p>
      {loading && !load.reply && !load.erasing && <Spinner label="Loading the erasure status" />}
      {load.erasing && <Alert tone="amber">This organisation is being erased now. Nobody can sign in any more; its signed certificate will be at the link you were given.</Alert>}
      {load.error && <Alert>{load.error}</Alert>}
      {error && <Alert>{error}</Alert>}
      {reauth && (
        <Alert tone="amber">
          <span>For your safety, erasure needs a sign-in from the last {LIMITS.erasureReauthMin} minutes. </span>
          <Button size="sm" variant="secondary" onClick={() => void signInAgain()}>
            Sign in again
          </Button>
        </Alert>
      )}

      <Card title="What erasure does">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>It permanently deletes or scrubs the personal data of {me.org.name}: users, sessions, recordings, devices, integrations and the rest, and destroys the audit pepper, so the hashes in the audit chain can no longer be linked to anyone.</li>
          <li>The audit chain itself is kept and still verifies. Technician display names and typed reasons stay in it.</li>
          <li>It needs two administrators (the second one an administrator for at least {LIMITS.erasureApproverMinDays} days, not invited or promoted by the first), then a {LIMITS.erasureCoolingOffDays}-day cooling-off period. An organisation with a single administrator uses a mailed confirmation and a {LIMITS.erasureSoloCoolingOffDays}-day cooling-off period.</li>
          <li>Any administrator can cancel it until it starts. After it runs nobody can sign in, so download what you need to keep first.</li>
        </ul>
      </Card>

      {e && (
        <Card title={`Erasure: ${stateWords(e.state)}`}>
          <div className="flex flex-col gap-3" data-testid="erasure-state" data-state={e.state}>
            <Steps e={e} />
            {e.certificateUrl && (
              <p className="text-sm">
                {e.state === 'completed' ? 'Signed certificate: ' : 'Its signed certificate will be at '}
                <a className="font-mono break-all underline" href={e.certificateUrl}>
                  {e.certificateUrl}
                </a>
                {e.state === 'completed' ? '' : ' (keep this link; it works once the erasure has run)'}
              </p>
            )}
            {e.cancelledBy && <p className="text-sm">Cancelled by {e.cancelledBy.name} on {fmtWhen(e.cancelledAt)}.</p>}
            {shownLink && (
              <Alert tone="amber">
                <span>
                  No mail server is configured, so the confirmation link is shown here once and never again. Open it within {LIMITS.erasureConfirmTtlHours} hours:{' '}
                  <a className="font-mono break-all underline" href={shownLink}>
                    {shownLink}
                  </a>
                </span>
              </Alert>
            )}
            {admin && e.state === 'pending_confirmation' && mine && token && (
              <div className="flex flex-col gap-2">
                <p className="text-sm">You opened the confirmation link. Confirming starts the {LIMITS.erasureSoloCoolingOffDays}-day cooling-off period.</p>
                <Button variant="danger" onClick={confirm} disabled={busy !== null}>
                  {busy === 'confirm' ? 'Confirming...' : 'Confirm the erasure'}
                </Button>
              </div>
            )}
            {admin && e.state === 'pending_approval' && !mine && (
              <form onSubmit={approve} className="flex flex-col gap-2" aria-label="Approve the erasure">
                <SlugField slug={orgSlug} value={slug} onChange={setSlug} />
                <Button type="submit" variant="danger" disabled={busy !== null || slug.trim() !== orgSlug}>
                  {busy === 'approve' ? 'Approving...' : 'Approve the erasure'}
                </Button>
              </form>
            )}
            {admin && e.state === 'pending_approval' && mine && <p className="text-sm">Another administrator must approve it. They can approve on this page.</p>}
            {admin && open && e.state !== 'executing' && (
              <div>
                <Button variant="secondary" onClick={cancel} disabled={busy !== null}>
                  {busy === 'cancel' ? 'Cancelling...' : 'Cancel the erasure'}
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {(open || admin) && !load.erasing && (
        <Card title="Before the date: keep your records">
          <p className="mb-2 text-sm">Download the audit export and the signed data residency report now. After the erasure nobody of the organisation can sign in.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={exportAudit} disabled={busy !== null}>
              {busy === 'export' ? 'Exporting...' : 'Download the audit export'}
            </Button>
            <Button variant="secondary" onClick={downloadResidency} disabled={busy !== null}>
              {busy === 'residency' ? 'Downloading...' : 'Download the signed residency report'}
            </Button>
          </div>
        </Card>
      )}

      {admin && !open && !load.erasing && load.reply && (
        <Card title="Request erasure">
          <form onSubmit={(ev) => submitRequest(ev, soloOffered)} className="flex flex-col gap-3" aria-label="Request erasure">
            {soloOffered && (
              <Alert tone="amber">
                You are the only administrator. You can erase the organisation alone: a confirmation link is mailed to you, you open it within {LIMITS.erasureConfirmTtlHours} hours, and the erasure runs after a {LIMITS.erasureSoloCoolingOffDays}-day cooling-off period.
              </Alert>
            )}
            <SlugField slug={orgSlug} value={slug} onChange={setSlug} />
            <div className="flex flex-col gap-1">
              <label htmlFor={reasonId} className="text-sm font-medium">
                Reason (optional, kept with the request and erased with it; never in the audit chain)
              </label>
              <textarea
                id={reasonId}
                className="min-h-20 rounded-md border border-slate-400 bg-white p-2 text-sm dark:border-slate-500 dark:bg-slate-900"
                maxLength={LIMITS.reasonMax}
                value={reason}
                onChange={(ev) => setReason(ev.target.value)}
              />
            </div>
            <Button type="submit" variant="danger" disabled={busy !== null || slug.trim() !== orgSlug}>
              {busy === 'request' || busy === 'solo' ? 'Requesting...' : soloOffered ? 'Request erasure as the only administrator' : 'Request erasure'}
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}

/** Erasure error codes in words. */
function errorText(err: unknown): string {
  if (isApiError(err, 'erasure_second_admin'))
    return `An erasure needs a second administrator who has been an administrator for at least ${LIMITS.erasureApproverMinDays} days and was not invited or promoted by the one who asked for it.`;
  if (isApiError(err, 'erasure_confirm_mismatch')) return 'The typed slug does not match this organisation.';
  if (isApiError(err, 'erasure_exists')) return 'An erasure of this organisation is already open.';
  if (isApiError(err, 'erasure_confirm_invalid')) return 'This confirmation link is unknown, used or expired.';
  if (isApiError(err, 'erasure_not_cancellable')) return 'This erasure can no longer be cancelled.';
  return errorMessage(err);
}
