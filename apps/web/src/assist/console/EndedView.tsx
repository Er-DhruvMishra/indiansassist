/**
 * After a session ends (contracts section 12 /app/sessions/:id): session audit list with the integrity
 * badge, the org-level last verify result, file attestation table with mismatch flags, recording upload
 * progress, the stored sha256 and the recording verify button.
 */
import { useState } from 'react';
import type { Recording, RecordingVerifyResponse, SessionDetail } from '@indiansassist/shared';
import { useAuth } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { Alert, Badge, Button, Card, Spinner } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { errorMessage } from '../../lib/api';
import { auditApi, recordingsApi, sessionsApi } from '../../lib/endpoints';
import { formatBytes } from '../../lib/fileChunker';
import { fmtDateTime, fmtDuration, humanise } from '../../lib/format';
import { AuditTable, VerifyBadge } from '../audit/AuditPage';
import { PathBadge, sessionDuration } from '../SessionsPage';
import type { RecordingFailure, RecordingPhase } from './consoleRecording';

export function RecordingCard({
  recordingId,
  phase,
  failure,
  progress,
  result,
  onRetry,
}: {
  recordingId: string | null;
  phase?: RecordingPhase;
  failure?: RecordingFailure;
  progress?: number;
  result?: Recording | null;
  onRetry?: () => void;
}) {
  const [verify, setVerify] = useState<RecordingVerifyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = result?.id ?? recordingId;
  const meta = useAsync(() => (id && !result ? recordingsApi.get(id) : Promise.resolve(result ?? null)), [id, result]);
  const rec = result ?? meta.data ?? null;
  const doVerify = async () => {
    if (!id) return;
    setError(null);
    try {
      setVerify(await recordingsApi.verify(id));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const download = async () => {
    if (!id) return;
    try {
      const { url } = await recordingsApi.download(id);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Card title="Recording">
      {phase === 'uploading' && (
        <div className="mb-2">
          <p className="text-sm">Uploading recording... {Math.round((progress ?? 0) * 100)}%</p>
          <div role="progressbar" aria-label="Recording upload" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)} className="h-2 rounded bg-slate-200 dark:bg-slate-700">
            <div className="h-full rounded bg-teal-700" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
          </div>
        </div>
      )}
      {phase === 'failed' && failure === 'recorder' && (
        <Alert>The recording failed while capturing, so nothing was uploaded. One recording per session in this version.</Alert>
      )}
      {phase === 'failed' && failure !== 'recorder' && (
        <Alert>
          The recording upload failed. <Button size="sm" variant="secondary" onClick={onRetry}>Retry upload</Button>
        </Alert>
      )}
      {!id && phase !== 'uploading' && <p className="text-sm text-slate-600 dark:text-slate-400">No recording for this session.</p>}
      {rec && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="font-medium">Status</dt>
          <dd><Badge tone={rec.status === 'stored' ? 'green' : rec.status === 'failed' ? 'red' : 'amber'}>{rec.status}</Badge></dd>
          <dt className="font-medium">Size</dt>
          <dd>{formatBytes(rec.bytes)}{rec.durationMs ? `, ${fmtDuration(rec.durationMs)}` : ''}</dd>
          <dt className="font-medium">sha256</dt>
          <dd className="break-all font-mono text-xs" data-testid="recording-sha256">{rec.sha256 ?? 'pending'}</dd>
          <dt className="font-medium">Chained into</dt>
          <dd className="font-mono text-xs">{rec.chainedInto ?? '-'}</dd>
        </dl>
      )}
      {rec?.status === 'stored' && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void doVerify()}>Verify recording</Button>
          <Button size="sm" variant="secondary" onClick={() => void download()}>Download</Button>
        </div>
      )}
      {verify && (
        <div className="mt-2">
          <Alert tone={verify.ok ? 'green' : 'red'}>
            {verify.ok ? 'Recording verified: the stored file matches the hash in the audit chain.' : 'Recording verification FAILED.'}{' '}
            <span className="break-all font-mono text-xs">{verify.sha256}</span>
          </Alert>
        </div>
      )}
      {error && <Alert>{error}</Alert>}
    </Card>
  );
}

export function EndedView({
  detail,
  recording,
}: {
  detail: SessionDetail;
  recording?: { phase: RecordingPhase; failure?: RecordingFailure; progress: number; result: Recording | null; onRetry: () => void };
}) {
  const { me } = useAuth();
  const role = me?.user.role;
  const audit = useAsync(() => (can(role, 'audit.session') ? sessionsApi.audit(detail.id) : Promise.resolve(null)), [detail.id, role]);
  const orgVerify = useAsync(() => (can(role, 'audit.export') ? auditApi.lastVerify() : Promise.resolve(undefined)), [role]);
  const files = audit.data?.files ?? detail.files;
  return (
    <div className="flex flex-col gap-4">
      <Card title="Session summary">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <dt className="font-medium">Desk</dt><dd>{detail.deskLabel ?? 'Desk'}</dd>
          <dt className="font-medium">Accepted by</dt><dd>{detail.assist.name}</dd>
          <dt className="font-medium">Ended</dt><dd>{fmtDateTime(detail.endedAt)}</dd>
          <dt className="font-medium">Reason</dt><dd>{detail.endReason ? humanise(detail.endReason) : '-'}</dd>
          <dt className="font-medium">Duration</dt><dd>{fmtDuration(sessionDuration(detail))}</dd>
          <dt className="font-medium">Path</dt><dd><PathBadge path={detail.path} /></dd>
          <dt className="font-medium">Surface</dt><dd>{detail.consentSurface ?? '-'}</dd>
          <dt className="font-medium">Chain tail</dt><dd className="truncate font-mono text-xs" title={detail.hashChainTail ?? ''}>{detail.hashChainTail ?? '-'}</dd>
        </dl>
      </Card>
      {can(role, 'recordings') && (
        <RecordingCard recordingId={detail.recordingId} phase={recording?.phase} failure={recording?.failure} progress={recording?.progress} result={recording?.result} onRetry={recording?.onRetry} />
      )}
      <Card title="File attestations">
        {files.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">No files were transferred.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <caption className="sr-only">File attestations</caption>
            <thead className="text-xs uppercase text-slate-600 dark:text-slate-400">
              <tr><th scope="col">File</th><th scope="col">Direction</th><th scope="col">Size</th><th scope="col">Hashes</th></tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={`${f.direction}:${f.fileId}`} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-1.5">{f.name}</td>
                  <td>{humanise(f.direction)}</td>
                  <td>{formatBytes(f.bytes)}</td>
                  <td>
                    {f.match === null ? <Badge tone="amber">awaiting both sides</Badge> : f.match ? <Badge tone="green">match</Badge> : <Badge tone="red">MISMATCH</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {can(role, 'audit.session') && (
        <Card
          title="Session audit"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {audit.data && (
                <Badge tone={audit.data.integrity.ok ? 'green' : 'red'}>
                  {audit.data.integrity.ok
                    ? `Integrity ok (${audit.data.integrity.checked} entries)`
                    : `Integrity broken at seq ${audit.data.integrity.failure?.seq ?? '?'}`}
                </Badge>
              )}
              {orgVerify.data !== undefined && (
                <span className="text-xs">
                  Org chain: <VerifyBadge result={orgVerify.data} />
                </span>
              )}
            </div>
          }
        >
          {audit.loading && <Spinner label="Loading session audit" />}
          {Boolean(audit.error) && <Alert>{errorMessage(audit.error)}</Alert>}
          {audit.data && <AuditTable items={audit.data.items} />}
        </Card>
      )}
    </div>
  );
}
