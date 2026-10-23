/**
 * Offline verifier for an exported JSONL file (contracts sections 5.5 and 12): reads the header, runs
 * `verifyChain` (via the shared `verifyAuditJsonl`) in a Web Worker; falls back to the main thread when
 * workers are unavailable. A file without a header is malformed.
 */
import { useState } from 'react';
import { verifyAuditJsonl, type JsonlVerifyResult } from '@indiansassist/shared';
import { Alert, Card } from '../../components/ui';

export function runVerify(text: string): Promise<JsonlVerifyResult> {
  if (typeof Worker === 'undefined') return Promise.resolve(verifyAuditJsonl(text));
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./verifyWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(verifyAuditJsonl(text));
      return;
    }
    worker.onmessage = (e: MessageEvent<{ ok: boolean; result?: JsonlVerifyResult; error?: string }>) => {
      worker.terminate();
      resolve(e.data.ok && e.data.result ? e.data.result : { ok: false, checked: 0, tail: null, malformed: e.data.error });
    };
    worker.onerror = () => {
      worker.terminate();
      resolve(verifyAuditJsonl(text));
    };
    worker.postMessage(text);
  });
}

export function OfflineVerifier() {
  const [result, setResult] = useState<JsonlVerifyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState('');

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setFileName(file.name);
    setResult(null);
    try {
      setResult(await runVerify(await file.text()));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Verify an export offline">
      <p className="mb-3 text-sm text-slate-700 dark:text-slate-300">
        Choose an exported JSONL file. It is checked in your browser against the keys in its header; nothing is uploaded.
      </p>
      <label htmlFor="jsonl-file" className="mb-1 block text-sm font-medium">
        JSONL export file
      </label>
      <input
        id="jsonl-file"
        type="file"
        accept=".jsonl,application/x-ndjson,application/json,text/plain"
        onChange={(e) => void onFile(e.target.files?.[0])}
        className="block text-sm file:mr-3 file:rounded file:border-0 file:bg-teal-700 file:px-3 file:py-2 file:text-white"
      />
      <div className="mt-3" aria-live="polite">
        {busy && <p className="text-sm">Verifying {fileName}...</p>}
        {result && result.malformed && <Alert>Malformed export: {result.malformed}</Alert>}
        {result && !result.malformed && result.ok && (
          <Alert tone="green">
            {fileName}: chain verified, {result.checked} entries
            {result.countMatches === false ? ' (warning: header count differs from the entries)' : ''}. Tail{' '}
            <span className="break-all font-mono text-xs">{result.tail}</span>
          </Alert>
        )}
        {result && !result.malformed && !result.ok && (
          <Alert>
            {fileName}: broken at seq {result.failure?.seq} ({result.failure?.kind.replace(/_/g, ' ')}), {result.checked} entries checked.
          </Alert>
        )}
      </div>
    </Card>
  );
}
