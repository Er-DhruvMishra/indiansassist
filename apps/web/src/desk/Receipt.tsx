/** Consent receipt (contracts section 12.1 D6) with download as JSON and as text. */
import { useMemo } from 'react';
import { Button, Card } from '../components/ui';
import { formatBytes } from '../lib/fileChunker';
import { fmtDateTime, fmtDuration } from '../lib/format';
import { buildReceipt, downloadText, receiptToText, type ReceiptFile } from '../lib/receipt';
import type { DeskBrand } from './brand';
import type { DeskSnapshot } from './deskController';
import { DeskLayout } from './DeskLayout';

export function receiptFiles(snap: DeskSnapshot): ReceiptFile[] {
  return snap.transfers
    .filter((t) => t.status === 'done')
    .map((t) => ({ direction: t.outgoing ? 'sent' : 'received', name: t.name, bytes: t.size, sha256: t.sha256, reported: t.reported }));
}

export function Receipt({ snap, brand }: { snap: DeskSnapshot; brand?: DeskBrand | null }) {
  const ended = snap.ended;
  const receipt = useMemo(
    () =>
      ended
        ? buildReceipt({
            ended,
            org: snap.created?.org.displayName ?? snap.hello?.org.displayName ?? '',
            region: snap.hello?.region ?? null,
            files: receiptFiles(snap),
            recordingSeen: snap.recordingSeen,
          })
        : null,
    [ended, snap],
  );
  if (!receipt) return null;
  const base = `consent-receipt-${receipt.sessionId.slice(0, 8)}`;
  return (
    <DeskLayout brand={brand}>
      <h1 className="mb-2 text-2xl font-semibold">Session ended: your consent receipt</h1>
      <p className="mb-4 text-sm text-slate-700 dark:text-slate-300">Screen sharing has stopped. Keep this receipt for your records.</p>
      <Card>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="font-medium">Technician</dt>
          <dd>
            {receipt.technician.name} <span className="font-mono text-xs">({receipt.technician.id})</span>
          </dd>
          <dt className="font-medium">Organisation</dt>
          <dd>{receipt.org}</dd>
          <dt className="font-medium">Started</dt>
          <dd>{fmtDateTime(receipt.startedAt)}</dd>
          <dt className="font-medium">Ended</dt>
          <dd>{fmtDateTime(receipt.endedAt)}</dd>
          <dt className="font-medium">Duration</dt>
          <dd>{fmtDuration(receipt.durationMs)}</dd>
          <dt className="font-medium">What was shared</dt>
          <dd>{receipt.shared}</dd>
          <dt className="font-medium">Recorded</dt>
          <dd>{receipt.recorded ? 'Yes, the technician recorded this session' : 'No'}</dd>
          <dt className="font-medium">Server recording</dt>
          <dd>{receipt.serverRecording ? 'Yes' : 'No'}</dd>
          <dt className="font-medium">Files</dt>
          <dd>
            {receipt.files.length === 0 ? (
              'None'
            ) : (
              <ul className="flex flex-col gap-1">
                {receipt.files.map((f, i) => (
                  <li key={i}>
                    {f.direction === 'sent' ? 'Sent' : 'Received'} {f.name} ({formatBytes(f.bytes)}), {f.reported ? 'reported to the server' : 'not reported'}
                    <span className="block break-all font-mono text-[10px]">sha256 {f.sha256}</span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
          <dt className="font-medium">Session id</dt>
          <dd className="font-mono text-xs">{receipt.sessionId}</dd>
          <dt className="font-medium">Audit chain tail at session end</dt>
          <dd className="break-all font-mono text-xs">{receipt.hashChainTail ?? 'not available'}</dd>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => downloadText(receiptToText(receipt), `${base}.txt`, 'text/plain')}>Download receipt (text)</Button>
          <Button variant="secondary" onClick={() => downloadText(JSON.stringify(receipt, null, 2), `${base}.json`, 'application/json')}>
            Download receipt (JSON)
          </Button>
        </div>
      </Card>
    </DeskLayout>
  );
}
