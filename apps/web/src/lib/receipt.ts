/**
 * Desk consent receipt (contracts section 12.1 D6), built from local state plus the `session.ended`
 * payload; no authenticated call is needed. Downloadable as JSON (contract) and as plain text.
 */
import { REGION_LABELS, type Region, type SessionEnded } from '@indiansassist/shared';
import { formatBytes } from './fileChunker';
import { fmtDuration } from './format';

export type ReceiptFile = {
  direction: 'sent' | 'received';
  name: string;
  bytes: number;
  sha256: string | null;
  reported: boolean;
};

export type ConsentReceipt = {
  receipt: 'indiansassist.consent-receipt';
  v: 1;
  sessionId: string;
  technician: { id: string; name: string };
  org: string;
  region: Region | null;
  startedAt: string | null;
  endedAt: string;
  durationMs: number | null;
  endReason: string;
  surface: string;
  shared: string;
  files: ReceiptFile[];
  recorded: boolean;
  /** Phase A.2 U3: the server recorder joined this session (`session.ended.serverRecording`, absent = false). */
  serverRecording: boolean;
  hashChainTail: string | null;
  generatedAt: string;
};

const SURFACE_TEXT: Record<string, string> = {
  monitor: 'Your entire screen',
  window: 'A single application window',
  browser: 'A browser tab',
  unknown: 'Your screen (the browser did not report which surface)',
};

export function surfaceText(surface: string | null | undefined): string {
  return SURFACE_TEXT[surface ?? 'unknown'] ?? SURFACE_TEXT.unknown!;
}

export function buildReceipt(input: {
  ended: SessionEnded;
  org: string;
  region: Region | null;
  files: ReceiptFile[];
  recordingSeen: boolean;
  now?: Date;
}): ConsentReceipt {
  const { ended } = input;
  const surface = ended.surface ?? 'unknown';
  return {
    receipt: 'indiansassist.consent-receipt',
    v: 1,
    sessionId: ended.sessionId,
    technician: { id: ended.assist.id, name: ended.assist.name },
    org: input.org,
    region: input.region,
    startedAt: ended.startedAt,
    endedAt: ended.endedAt,
    durationMs: ended.durationMs,
    endReason: ended.endReason,
    surface,
    shared: surfaceText(surface),
    files: input.files,
    recorded: ended.recordingStarted || input.recordingSeen,
    serverRecording: ended.serverRecording ?? false,
    hashChainTail: ended.hashChainTail,
    generatedAt: (input.now ?? new Date()).toISOString(),
  };
}

export function receiptToText(r: ConsentReceipt): string {
  const lines = [
    'IndiansAssist consent receipt',
    '=============================',
    `Session id:        ${r.sessionId}`,
    `Technician:        ${r.technician.name} (${r.technician.id})`,
    `Organisation:      ${r.org}`,
    `Data region:       ${r.region ? REGION_LABELS[r.region] : 'unknown'}`,
    `Started:           ${r.startedAt ?? 'not started'}`,
    `Ended:             ${r.endedAt}`,
    `Duration:          ${fmtDuration(r.durationMs)}`,
    `End reason:        ${r.endReason.replace(/_/g, ' ')}`,
    `What was shared:   ${r.shared}`,
    `Recorded:          ${r.recorded ? 'yes, the technician recorded this session' : 'no'}`,
    `Server recording:  ${r.serverRecording ? 'yes' : 'no'}`,
    `Audit chain tail:  ${r.hashChainTail ?? 'not available'} (at session end)`,
    '',
    `Files (${r.files.length}):`,
  ];
  if (r.files.length === 0) lines.push('  none');
  for (const f of r.files) {
    lines.push(
      `  ${f.direction === 'sent' ? 'Sent    ' : 'Received'} ${f.name} (${formatBytes(f.bytes)})`,
      `           sha256 ${f.sha256 ?? 'n/a'}${f.reported ? ', reported to the server' : ', not reported'}`,
    );
  }
  lines.push('', `Generated ${r.generatedAt}`, '');
  return lines.join('\n');
}

export function downloadText(content: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
