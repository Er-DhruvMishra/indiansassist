/**
 * File transfer panel shared by both sides (contracts section 8.3): send, progress both ways, the F6
 * accept dialog (name, extension, declared MIME, size, sender; executable warning needs a second click),
 * and save with the sniffed type shown.
 */
import { useRef, useState } from 'react';
import { formatBytes } from '../lib/fileChunker';
import { saveBlob, type Transfer } from '../lib/fileTransfer';
import { errorMessage } from '../lib/api';
import { Dialog } from './Dialog';
import { Alert, Badge, Button } from './ui';

function Progress({ t }: { t: Transfer }) {
  const pct = t.size > 0 ? Math.round((t.bytesDone / t.size) * 100) : 100;
  return (
    <div
      role="progressbar"
      aria-label={`${t.outgoing ? 'Sending' : 'Receiving'} ${t.name}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-2 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-700"
    >
      <div className="h-full bg-teal-700" style={{ width: `${pct}%` }} />
    </div>
  );
}

const STATUS_TONE: Record<Transfer['status'], 'neutral' | 'green' | 'amber' | 'red' | 'blue'> = {
  hashing: 'neutral',
  offered: 'amber',
  transferring: 'blue',
  verifying: 'blue',
  done: 'green',
  rejected: 'red',
  cancelled: 'red',
  failed: 'red',
};

function AcceptDialog({ t, sender, onAccept, onReject }: { t: Transfer; sender: string; onAccept: () => void; onReject: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <Dialog open title="Incoming file" onClose={onReject}>
      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="font-medium">Name</dt>
        <dd className="break-all">{t.name}</dd>
        <dt className="font-medium">Extension</dt>
        <dd>{t.extension ?? 'none'}</dd>
        <dt className="font-medium">Declared type</dt>
        <dd>{t.mime || 'unknown'}</dd>
        <dt className="font-medium">Size</dt>
        <dd>{formatBytes(t.size)}</dd>
        <dt className="font-medium">From</dt>
        <dd>{sender}</dd>
      </dl>
      {t.executable && (
        <Alert>
          <strong>This file type can run programs on your computer.</strong> Only accept it if you expected it.
        </Alert>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onReject}>
          Decline
        </Button>
        <Button
          variant={t.executable ? 'danger' : 'primary'}
          onClick={() => {
            if (t.executable && !armed) setArmed(true);
            else onAccept();
          }}
        >
          {t.executable && !armed ? 'Accept anyway' : t.executable ? 'Click again to accept' : 'Accept'}
        </Button>
      </div>
    </Dialog>
  );
}

export function FilePanel({
  transfers,
  peerName,
  canSend,
  onSend,
  onAccept,
  onReject,
  onCancel,
}: {
  transfers: Transfer[];
  peerName: string;
  canSend: boolean;
  onSend: (f: File) => Promise<void>;
  onAccept: (key: string) => void;
  onReject: (key: string) => void;
  onCancel: (key: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const offered = transfers.find((t) => !t.outgoing && t.status === 'offered');
  const busy = transfers.some((t) => t.outgoing && ['hashing', 'offered', 'transferring', 'verifying'].includes(t.status));

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    try {
      await onSend(f);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      if (input.current) input.current.value = '';
    }
  };

  return (
    <section aria-label="Files">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Files</h2>
        <input ref={input} id="file-send" type="file" className="sr-only" onChange={(e) => void pick(e.target.files?.[0])} disabled={!canSend || busy} />
        <Button size="sm" variant="secondary" disabled={!canSend || busy} onClick={() => input.current?.click()}>
          Send a file
        </Button>
      </div>
      <p className="mb-2 text-xs text-slate-600 dark:text-slate-400">Up to 256 MiB, sent directly and checked with sha256.</p>
      {error && <Alert>{error}</Alert>}
      <ul className="flex flex-col gap-2" aria-live="polite">
        {transfers.length === 0 && <li className="text-sm text-slate-600 dark:text-slate-400">No transfers yet.</li>}
        {transfers.map((t) => (
          <li key={t.key} className="rounded border border-slate-200 p-2 text-sm dark:border-slate-700">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-medium" title={t.name}>
                {t.outgoing ? 'To' : 'From'} {peerName}: {t.name}
              </span>
              <Badge tone={STATUS_TONE[t.status]}>{t.status}</Badge>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              <span>
                {formatBytes(t.bytesDone)} / {formatBytes(t.size)}
              </span>
              {t.status === 'done' && <span>{t.reported ? 'reported to the server' : 'not yet reported'}</span>}
              {t.error && <span className="text-red-700 dark:text-red-400">{t.error}</span>}
            </div>
            {['transferring', 'verifying'].includes(t.status) && <Progress t={t} />}
            {t.sha256 && t.status === 'done' && <p className="mt-1 break-all font-mono text-[10px]">sha256 {t.sha256}</p>}
            <div className="mt-1 flex gap-2">
              {['hashing', 'offered', 'transferring'].includes(t.status) && (t.outgoing || t.status === 'transferring') && (
                <Button size="sm" variant="ghost" onClick={() => onCancel(t.key)}>
                  Cancel
                </Button>
              )}
              {!t.outgoing && t.status === 'done' && t.blob && (
                <>
                  <Button size="sm" onClick={() => saveBlob(t.blob!, t.name)}>
                    Save
                  </Button>
                  <span className="self-center text-xs">Detected type: {t.sniffed ?? 'unknown'}</span>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {offered && <AcceptDialog key={offered.key} t={offered} sender={peerName} onAccept={() => onAccept(offered.key)} onReject={() => onReject(offered.key)} />}
    </section>
  );
}
