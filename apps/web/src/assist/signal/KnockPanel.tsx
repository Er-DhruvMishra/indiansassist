/**
 * Knock toasts / panel (contracts sections 7.3 and 12): Desk display name, token id and label, who
 * created the token, countdown. Accept / Deny / Deny and revoke token render only when `canAct`.
 */
import type { AssistKnock } from '@indiansassist/shared';
import { Button } from '../../components/ui';
import { useNow } from '../../hooks/useAsync';
import { shortId } from '../../lib/format';
import { useAssistSignal } from './AssistSignalProvider';

export function KnockCard({ knock, now }: { knock: AssistKnock; now: number }) {
  const signal = useAssistSignal();
  const left = Math.max(0, Math.round((new Date(knock.expiresAt).getTime() - now) / 1000));
  return (
    <article
      aria-label={`Support request from ${knock.deskLabel ?? 'Desk'}`}
      className="rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm shadow-md dark:border-amber-700 dark:bg-amber-950"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{knock.deskLabel ?? 'Desk'} is asking for support</p>
          <p className="text-slate-700 dark:text-slate-300">
            Token <span className="font-mono">{shortId(knock.tokenId)}</span>
            {knock.tokenLabel ? ` (${knock.tokenLabel})` : ''}, created by {knock.tokenCreatedBy.name}
          </p>
          {knock.userAgent && <p className="mt-0.5 truncate text-xs text-slate-600 dark:text-slate-400">{knock.userAgent}</p>}
        </div>
        <span className="shrink-0 font-mono text-xs" aria-label={`${left} seconds left`}>
          {left}s
        </span>
      </div>
      {knock.canAct ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => signal?.accept(knock.sessionId)}>
            Accept
          </Button>
          <Button size="sm" variant="secondary" onClick={() => signal?.deny(knock.sessionId)}>
            Deny
          </Button>
          <Button size="sm" variant="danger" onClick={() => signal?.deny(knock.sessionId, { revokeToken: true })}>
            Deny and revoke token
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-slate-700 dark:text-slate-300">
          Only {knock.tokenCreatedBy.name}, a senior technician or an admin can accept this request.
        </p>
      )}
    </article>
  );
}

/** Fixed toast stack for the whole shell, plus the polite live region (A4). */
export function KnockToasts() {
  const signal = useAssistSignal();
  const now = useNow(1000);
  const knocks = signal?.knocks ?? [];
  return (
    <>
      <div aria-live="polite" className="sr-only">
        {signal?.announcement}
      </div>
      {knocks.length > 0 && (
        <aside aria-label="Support requests" className="fixed bottom-4 right-4 z-40 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
          {knocks.map((k) => (
            <KnockCard key={k.sessionId} knock={k} now={now} />
          ))}
        </aside>
      )}
    </>
  );
}

/** Inline panel for the console (knocks on this session or any pending ones). */
export function KnockPanel({ sessionId }: { sessionId?: string }) {
  const signal = useAssistSignal();
  const now = useNow(1000);
  const list = (signal?.knocks ?? []).filter((k) => !sessionId || k.sessionId === sessionId);
  if (list.length === 0) return <p className="text-sm text-slate-600 dark:text-slate-400">No pending support requests.</p>;
  return (
    <div className="flex flex-col gap-2">
      {list.map((k) => (
        <KnockCard key={k.sessionId} knock={k} now={now} />
      ))}
    </div>
  );
}
