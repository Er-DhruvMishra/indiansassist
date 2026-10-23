/** /app/sessions: list with state, path badge, duration, Desk label and acceptor. */
import { useState } from 'react';
import { Link } from 'react-router';
import { SESSION_STATES, type Session, type SessionPath, type SessionState } from '@indiansassist/shared';
import { Alert, Badge, Button, Card, PageHeader, Select, Spinner } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { usePageTitle } from '../hooks/usePageTitle';
import { errorMessage } from '../lib/api';
import { sessionsApi } from '../lib/endpoints';
import { fmtDateTime, fmtDuration, humanise } from '../lib/format';

export function PathBadge({ path }: { path: SessionPath }) {
  if (path === 'p2p') return <Badge tone="green">P2P</Badge>;
  if (path === 'relay') return <Badge tone="amber">Relay</Badge>;
  return <Badge>Unknown path</Badge>;
}

export function StateBadge({ state }: { state: SessionState }) {
  const tone = state === 'active' ? 'green' : state === 'ended' ? 'neutral' : 'amber';
  return <Badge tone={tone}>{humanise(state)}</Badge>;
}

export function sessionDuration(s: Session, now = Date.now()): number | null {
  if (!s.startedAt) return null;
  const end = s.endedAt ? new Date(s.endedAt).getTime() : now;
  return end - new Date(s.startedAt).getTime();
}

export function SessionsTable({ sessions, caption }: { sessions: Session[]; caption: string }) {
  if (sessions.length === 0) return <p className="text-sm text-slate-600 dark:text-slate-400">No sessions.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-slate-200 text-xs uppercase text-slate-600 dark:border-slate-700 dark:text-slate-400">
          <tr>
            <th scope="col" className="py-2 pr-3">Desk</th>
            <th scope="col" className="py-2 pr-3">State</th>
            <th scope="col" className="py-2 pr-3">Path</th>
            <th scope="col" className="py-2 pr-3">Duration</th>
            <th scope="col" className="py-2 pr-3">Accepted by</th>
            <th scope="col" className="py-2 pr-3">Knocked</th>
            <th scope="col" className="py-2">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id} className="border-b border-slate-100 dark:border-slate-800">
              <td className="py-2 pr-3 font-medium">{s.deskLabel ?? 'Desk'}</td>
              <td className="py-2 pr-3">
                <StateBadge state={s.state} />
                {s.endReason && <span className="ml-1 text-xs text-slate-600 dark:text-slate-400">{humanise(s.endReason)}</span>}
              </td>
              <td className="py-2 pr-3">
                <PathBadge path={s.path} />
              </td>
              <td className="py-2 pr-3 font-mono">{fmtDuration(sessionDuration(s))}</td>
              <td className="py-2 pr-3">{s.assist.name}</td>
              <td className="py-2 pr-3">{fmtDateTime(s.knockedAt)}</td>
              <td className="py-2">
                <Link to={`/app/sessions/${s.id}`} className="font-medium text-teal-800 underline dark:text-teal-300">
                  {s.state === 'ended' ? 'Details' : 'Open console'}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SessionsPage() {
  usePageTitle('Sessions');
  const [state, setState] = useState<SessionState | ''>('');
  const [extra, setExtra] = useState<Session[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const list = useAsync(async () => {
    const page = await sessionsApi.list(state ? { state } : {});
    setExtra([]);
    setCursor(page.nextCursor);
    return page.items;
  }, [state]);

  const loadMore = async () => {
    if (!cursor) return;
    try {
      const page = await sessionsApi.list({ ...(state ? { state } : {}), cursor });
      setExtra((x) => [...x, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setMoreError(errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader title="Sessions">
        <label htmlFor="session-state" className="text-sm font-medium">
          State
        </label>
        <Select id="session-state" className="w-44" value={state} onChange={(e) => setState(e.target.value as SessionState | '')}>
          <option value="">All</option>
          {SESSION_STATES.map((s) => (
            <option key={s} value={s}>
              {humanise(s)}
            </option>
          ))}
        </Select>
        <Button variant="secondary" onClick={list.reload}>
          Refresh
        </Button>
      </PageHeader>
      <Card>
        {list.loading && <Spinner label="Loading sessions" />}
        {Boolean(list.error) && <Alert>{errorMessage(list.error)}</Alert>}
        {moreError && <Alert>{moreError}</Alert>}
        {list.data && <SessionsTable sessions={[...list.data, ...extra]} caption="Sessions" />}
        {cursor && (
          <Button variant="secondary" className="mt-3" onClick={() => void loadMore()}>
            Load more
          </Button>
        )}
      </Card>
    </>
  );
}
