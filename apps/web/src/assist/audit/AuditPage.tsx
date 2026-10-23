/**
 * /app/audit (contracts sections 6.9 and 12): org audit table with filters, chain verification badge
 * (`Verified <time>` / `Broken at seq N (<kind>)`), last anchor, JSONL export (POST, blob download) and
 * the offline verifier.
 */
import { useState, type FormEvent } from 'react';
import { AUDIT_ACTIONS, type AuditEntry, type AuditVerifyResponse } from '@indiansassist/shared';
import { useAuth } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { Alert, Badge, Button, Card, Input, PageHeader, Select, Spinner } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { usePageTitle } from '../../hooks/usePageTitle';
import { errorMessage } from '../../lib/api';
import { auditApi, type AuditFilters } from '../../lib/endpoints';
import { saveBlob } from '../../lib/fileTransfer';
import { fmtDateTime, shortId } from '../../lib/format';
import { OfflineVerifier } from './OfflineVerifier';

export function VerifyBadge({ result }: { result: AuditVerifyResponse | null | undefined }) {
  if (!result) return <Badge>Not verified yet</Badge>;
  if (result.ok) return <Badge tone="green">Verified {fmtDateTime(result.verifiedAt)}</Badge>;
  return (
    <Badge tone="red">
      Broken at seq {result.failure?.seq ?? '?'} ({result.failure?.kind.replace(/_/g, ' ') ?? 'unknown'})
    </Badge>
  );
}

function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function AuditTable({ items }: { items: AuditEntry[] }) {
  if (items.length === 0) return <p className="text-sm text-slate-600 dark:text-slate-400">No entries.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Audit entries</caption>
        <thead className="border-b border-slate-200 text-xs uppercase text-slate-600 dark:border-slate-700 dark:text-slate-400">
          <tr>
            <th scope="col" className="py-2 pr-3">Seq</th>
            <th scope="col" className="py-2 pr-3">Time</th>
            <th scope="col" className="py-2 pr-3">Action</th>
            <th scope="col" className="py-2 pr-3">Actor</th>
            <th scope="col" className="py-2 pr-3">Session</th>
            <th scope="col" className="py-2 pr-3">Data</th>
            <th scope="col" className="py-2">Hash</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id} className="border-b border-slate-100 align-top dark:border-slate-800">
              <td className="py-1.5 pr-3 font-mono">{e.seq}</td>
              <td className="whitespace-nowrap py-1.5 pr-3">{fmtDateTime(e.ts)}</td>
              <td className="py-1.5 pr-3 font-medium">{e.action}</td>
              <td className="py-1.5 pr-3">
                {e.actor.label} <span className="text-xs text-slate-600 dark:text-slate-400">({e.actor.type})</span>
              </td>
              <td className="py-1.5 pr-3 font-mono text-xs">{shortId(e.sessionId)}</td>
              <td className="max-w-xs py-1.5 pr-3">
                <code className="block truncate text-xs" title={JSON.stringify(e.data)}>
                  {JSON.stringify(e.data)}
                </code>
                {e.reason && <span className="text-xs">Reason: {e.reason}</span>}
              </td>
              <td className="py-1.5 font-mono text-xs" title={e.hash}>
                {e.hash.slice(0, 12)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AuditPage() {
  usePageTitle('Audit');
  const { me } = useAuth();
  const canExport = can(me?.user.role, 'audit.export');
  const [draft, setDraft] = useState({ action: '', sessionId: '', from: '', to: '' });
  const [filters, setFilters] = useState<AuditFilters>({});
  const [extra, setExtra] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'verify' | 'export' | null>(null);

  const list = useAsync(async () => {
    const page = await auditApi.list(filters);
    setExtra([]);
    setCursor(page.nextCursor);
    return page.items;
  }, [JSON.stringify(filters)]);
  const lastVerify = useAsync(() => (canExport ? auditApi.lastVerify() : Promise.resolve(null)), [canExport]);
  const anchor = useAsync(() => auditApi.list({ action: 'audit.anchored', limit: 1 }), []);
  const lastAnchor = anchor.data?.items[0]?.data as { seq?: number; kid?: string; ts?: string } | undefined;

  const apply = (e: FormEvent) => {
    e.preventDefault();
    setFilters({
      action: draft.action || undefined,
      sessionId: draft.sessionId.trim() || undefined,
      from: toIso(draft.from),
      to: toIso(draft.to),
    });
  };

  const loadMore = async () => {
    if (!cursor) return;
    try {
      const page = await auditApi.list({ ...filters, cursor });
      setExtra((x) => [...x, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const verify = async () => {
    setBusy('verify');
    setError(null);
    try {
      lastVerify.setData(await auditApi.verify());
      anchor.reload();
      list.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const exportJsonl = async () => {
    setBusy('export');
    setError(null);
    try {
      const { blob, filename } = await auditApi.export({ from: filters.from, to: filters.to });
      saveBlob(blob, filename);
      list.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader title="Audit log">
        {canExport && (
          <>
            <VerifyBadge result={lastVerify.data} />
            <Button onClick={() => void verify()} disabled={busy !== null}>
              {busy === 'verify' ? 'Verifying...' : 'Verify chain'}
            </Button>
            <Button variant="secondary" onClick={() => void exportJsonl()} disabled={busy !== null}>
              {busy === 'export' ? 'Exporting...' : 'Export JSONL'}
            </Button>
          </>
        )}
      </PageHeader>
      {error && <Alert>{error}</Alert>}
      <p className="mb-3 text-sm text-slate-700 dark:text-slate-300">
        Last anchor:{' '}
        {lastAnchor ? (
          <>
            seq <span className="font-mono">{lastAnchor.seq}</span>, key <span className="font-mono">{lastAnchor.kid}</span>
            {lastAnchor.ts ? `, ${fmtDateTime(lastAnchor.ts)}` : ''}
          </>
        ) : (
          'none yet'
        )}
      </p>
      <Card className="mb-4">
        <form onSubmit={apply} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label="Audit filters">
          <div>
            <label htmlFor="f-action" className="text-sm font-medium">Action</label>
            <Select id="f-action" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>
              <option value="">Any action</option>
              {AUDIT_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="f-session" className="text-sm font-medium">Session id</label>
            <Input id="f-session" value={draft.sessionId} onChange={(e) => setDraft({ ...draft, sessionId: e.target.value })} placeholder="uuid" />
          </div>
          <div>
            <label htmlFor="f-from" className="text-sm font-medium">From</label>
            <Input id="f-from" type="datetime-local" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          </div>
          <div>
            <label htmlFor="f-to" className="text-sm font-medium">To (exclusive)</label>
            <Input id="f-to" type="datetime-local" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </div>
          <div className="flex items-end">
            <Button type="submit" className="w-full">Apply filters</Button>
          </div>
        </form>
      </Card>
      <Card className="mb-4">
        {list.loading && <Spinner label="Loading audit entries" />}
        {Boolean(list.error) && <Alert>{errorMessage(list.error)}</Alert>}
        {list.data && <AuditTable items={[...list.data, ...extra]} />}
        {cursor && (
          <Button variant="secondary" className="mt-3" onClick={() => void loadMore()}>
            Load more
          </Button>
        )}
      </Card>
      <OfflineVerifier />
    </>
  );
}
