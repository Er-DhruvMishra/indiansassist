/** /app dashboard: stats cards, active sessions, recent sessions, recent tokens, quick create. */
import { useState } from 'react';
import { Link } from 'react-router';
import type { CreateTokenResponse } from '@indiansassist/shared';
import { useAuth } from '../auth/AuthContext';
import { can } from '../auth/permissions';
import { Alert, Card, PageHeader, Spinner, Stat } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { usePageTitle } from '../hooks/usePageTitle';
import { errorMessage } from '../lib/api';
import { sessionsApi, tokensApi } from '../lib/endpoints';
import { fmtDuration, fmtRelative } from '../lib/format';
import { SessionsTable } from './SessionsPage';
import { KnockPanel } from './signal/KnockPanel';
import { CreateTokenForm, TokenCreatedPanel } from './tokens/CreateTokenDialog';
import { TokenStatusBadge } from './tokens/TokensPage';

export function DashboardPage() {
  usePageTitle('Dashboard');
  const { me } = useAuth();
  const role = me?.user.role;
  const [created, setCreated] = useState<CreateTokenResponse | null>(null);
  const stats = useAsync(() => sessionsApi.stats(), []);
  const sessions = useAsync(() => sessionsApi.list({ limit: 25 }), []);
  const tokens = useAsync(() => (can(role, 'tokens.list') ? tokensApi.list({ limit: 5 }) : Promise.resolve(null)), [role]);
  const active = (sessions.data?.items ?? []).filter((s) => s.state !== 'ended');
  const recent = (sessions.data?.items ?? []).filter((s) => s.state === 'ended').slice(0, 8);

  return (
    <>
      <PageHeader title={`Welcome, ${me?.user.name ?? ''}`} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.loading ? (
          <Spinner label="Loading statistics" />
        ) : stats.data ? (
          <>
            <Stat label="Sessions (30 days)" value={stats.data.total} />
            <Stat label="Active now" value={stats.data.active} />
            <Stat label="Average duration" value={fmtDuration(stats.data.avgDurationMs)} />
            <Stat
              label="P2P / Relay"
              value={`${stats.data.byPath.p2p} / ${stats.data.byPath.relay}`}
            />
          </>
        ) : (
          <Alert>{errorMessage(stats.error)}</Alert>
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          {can(role, 'ws.assist') && (
            <Card title="Support requests">
              <KnockPanel />
            </Card>
          )}
          <Card title="Active sessions">
            {sessions.loading ? <Spinner /> : <SessionsTable sessions={active} caption="Active sessions" />}
          </Card>
          <Card title="Recent sessions" actions={<Link to="/app/sessions" className="text-sm font-medium text-teal-800 underline dark:text-teal-300">All sessions</Link>}>
            {sessions.loading ? <Spinner /> : <SessionsTable sessions={recent} caption="Recent sessions" />}
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          {can(role, 'tokens.create') && (
            <Card title="Quick create token">
              {created ? (
                <div className="flex flex-col gap-3">
                  <TokenCreatedPanel result={created} />
                  <button type="button" className="self-start text-sm font-medium text-teal-800 underline dark:text-teal-300" onClick={() => setCreated(null)}>
                    Create another
                  </button>
                </div>
              ) : (
                <CreateTokenForm
                  seatTier={me?.seat?.tier ?? null}
                  onCreated={(r) => {
                    setCreated(r);
                    tokens.reload();
                  }}
                />
              )}
            </Card>
          )}
          {can(role, 'tokens.list') && (
            <Card title="Recent tokens" actions={<Link to="/app/tokens" className="text-sm font-medium text-teal-800 underline dark:text-teal-300">All tokens</Link>}>
              {tokens.loading && <Spinner />}
              <ul className="flex flex-col gap-2 text-sm">
                {(tokens.data?.items ?? []).map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">
                      {t.label ?? t.shortCodeDisplay}
                      <span className="block text-xs text-slate-600 dark:text-slate-400">expires {fmtRelative(t.expiresAt)}</span>
                    </span>
                    <TokenStatusBadge status={t.status} />
                  </li>
                ))}
                {tokens.data && tokens.data.items.length === 0 && <li className="text-slate-600 dark:text-slate-400">No tokens yet.</li>}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
