/**
 * The erasure banner (docs/specs/phase-f-contracts.md section 5.2d), rendered by the foundation's
 * `<ErasureBannerSlot/>` in `AppShell` for every signed-in user. Fed by the notice of `GET /orgs/current/erasure`
 * (readable by every role): from the request on it shows the state in words, the date and the certificate link, and
 * for org_admins a Cancel button. It renders nothing while there is no open erasure.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { UserRole } from '@indiansassist/shared';
import { can } from '../../auth/permissions';
import { Button } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { errorMessage } from '../../lib/api';
import { announceErasureChanged, ERASURE_CHANGED_EVENT, erasureApi, fmtWhen, isOpen, noticeOf, recordOf, stateWords } from './erasureApi';

export function ErasureBanner({ role }: { role: UserRole }) {
  const status = useAsync((signal) => erasureApi.status(signal), []);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // The erasure page announces its changes, so the banner follows without a reload.
  const { reload } = status;
  useEffect(() => {
    globalThis.addEventListener(ERASURE_CHANGED_EVENT, reload);
    return () => globalThis.removeEventListener(ERASURE_CHANGED_EVENT, reload);
  }, [reload]);
  const notice = noticeOf(status.data);
  if (!notice || !isOpen(notice.state)) return msg ? <p role="status" className="mb-4 text-sm">{msg}</p> : null;
  const record = recordOf(status.data);
  const cancel = async () => {
    if (!record) return;
    setBusy(true);
    try {
      await erasureApi.cancel(record.id);
      setMsg('The erasure was cancelled.');
      announceErasureChanged();
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-labelledby="erasure-banner-title"
      data-testid="erasure-banner"
      className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-950 dark:border-red-800 dark:bg-red-950 dark:text-red-100"
    >
      <h2 id="erasure-banner-title" className="font-semibold">
        This organisation is scheduled for permanent erasure
      </h2>
      <p role="status" aria-live="polite">
        The erasure is {stateWords(notice.state)}.
        {notice.coolingOffUntil ? ` It runs on ${fmtWhen(notice.coolingOffUntil)}.` : ''} After it runs nobody can sign in to this organisation.
      </p>
      {notice.certificateUrl && (
        <p>
          Its signed certificate will be at{' '}
          <a className="font-mono break-all underline" href={notice.certificateUrl}>
            {notice.certificateUrl}
          </a>
          .
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {can(role, 'erasure.read') && (
          <Link className="underline" to="/app/settings/erasure">
            Erasure details
          </Link>
        )}
        {role === 'org_admin' && record && notice.state !== 'executing' && (
          <Button size="sm" variant="secondary" onClick={() => void cancel()} disabled={busy}>
            {busy ? 'Cancelling...' : 'Cancel the erasure'}
          </Button>
        )}
      </div>
      {msg && <p className="mt-1">{msg}</p>}
    </section>
  );
}
