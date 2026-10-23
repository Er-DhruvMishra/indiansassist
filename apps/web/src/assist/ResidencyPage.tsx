/** /app/residency (contracts section 6.3): one-page printable data residency report. */
import type { ReactNode } from 'react';
import { Alert, Badge, Button, Card, PageHeader, Spinner } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { usePageTitle } from '../hooks/usePageTitle';
import { errorMessage } from '../lib/api';
import { orgApi } from '../lib/endpoints';
import { formatBytes } from '../lib/fileChunker';
import { fmtDateTime, regionLabel } from '../lib/format';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-slate-100 py-2 sm:grid-cols-3 dark:border-slate-800">
      <dt className="text-sm font-medium text-slate-700 dark:text-slate-300">{label}</dt>
      <dd className="text-sm sm:col-span-2">{children}</dd>
    </div>
  );
}

function List({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <span className="text-slate-600 dark:text-slate-400">{empty}</span>;
  return (
    <ul className="list-inside list-disc">
      {items.map((u) => (
        <li key={u} className="break-all font-mono text-xs">
          {u}
        </li>
      ))}
    </ul>
  );
}

export function ResidencyPage() {
  usePageTitle('Data residency');
  const report = useAsync(() => orgApi.residency(), []);
  const r = report.data;
  return (
    <>
      <PageHeader title="Data residency report">
        <Button variant="secondary" className="no-print" onClick={() => window.print()}>
          Print
        </Button>
      </PageHeader>
      {report.loading && <Spinner label="Generating report" />}
      {Boolean(report.error) && <Alert>{errorMessage(report.error)}</Alert>}
      {r && (
        <div className="flex flex-col gap-4">
          <Alert tone="blue">{r.statement}</Alert>
          {r.ice.thirdPartyHosts.length > 0 && (
            <Alert tone="amber">
              Media candidates may be sent to third-party STUN/TURN hosts: {r.ice.thirdPartyHosts.join(', ')}.
            </Alert>
          )}
          <Card title="Organisation">
            <dl>
              <Row label="Name">{r.org.name} ({r.org.slug})</Row>
              <Row label="Data region">
                <Badge tone="blue">{regionLabel(r.org.dataRegion)}</Badge> <span className="font-mono text-xs">{r.org.dataRegion}</span>
              </Row>
              <Row label="Served by">
                {regionLabel(r.servedBy.region)}, {r.servedBy.apiOrigin}, node <span className="font-mono text-xs">{r.servedBy.nodeId}</span>
              </Row>
              <Row label="Generated">{fmtDateTime(r.generatedAt)}</Row>
            </dl>
          </Card>
          <Card title="Storage and network">
            <dl>
              <Row label="Object storage">
                {r.storage.driver}, bucket <span className="font-mono text-xs">{r.storage.bucket}</span>, prefix{' '}
                <span className="font-mono text-xs">{r.storage.prefix}</span>
              </Row>
              <Row label="STUN servers"><List items={r.ice.stunUrls} empty="None (host candidates only)" /></Row>
              <Row label="TURN servers"><List items={r.ice.turnUrls} empty="None configured" /></Row>
              <Row label="Third-party ICE hosts"><List items={r.ice.thirdPartyHosts} empty="None" /></Row>
            </dl>
          </Card>
          <Card title="Holdings">
            <dl>
              <Row label="Users">{r.counts.users}</Row>
              <Row label="Tokens">{r.counts.tokens}</Row>
              <Row label="Sessions">{r.counts.sessions}</Row>
              <Row label="Recordings">
                {r.counts.recordings} ({formatBytes(r.counts.recordingBytes)})
              </Row>
              <Row label="Audit entries">{r.counts.auditEntries}</Row>
            </dl>
          </Card>
          <Card title="Audit chain">
            <dl>
              <Row label="Length">{r.chain.length}</Row>
              <Row label="Tail"><span className="break-all font-mono text-xs">{r.chain.tail ?? 'empty'}</span></Row>
              <Row label="Last verified">
                {r.chain.lastVerifiedAt ? (
                  <>
                    {fmtDateTime(r.chain.lastVerifiedAt)}{' '}
                    <Badge tone={r.chain.lastVerifiedOk ? 'green' : 'red'}>{r.chain.lastVerifiedOk ? 'ok' : 'broken'}</Badge>
                  </>
                ) : (
                  'never'
                )}
              </Row>
              <Row label="Last anchor">
                {r.chain.lastAnchor ? (
                  <>
                    seq {r.chain.lastAnchor.seq}, key <span className="font-mono text-xs">{r.chain.lastAnchor.kid}</span>, {fmtDateTime(r.chain.lastAnchor.ts)}
                  </>
                ) : (
                  'none yet'
                )}
              </Row>
            </dl>
          </Card>
          <Card title="Retention">
            <dl>
              <Row label="Audit entries">{r.retention.auditEntries}</Row>
              <Row label="PII in the chain">{r.retention.piiInChain}</Row>
              <Row label="Recordings">{r.retention.recordings}</Row>
            </dl>
          </Card>
        </div>
      )}
    </>
  );
}
