/**
 * Phase E section 5.3b-c: the console's redacted transcript, re-redacted by the api and held in presence under
 * `ia:sumin:<sessionId>` for at most `LIMITS.summaryTranscriptTtlSec`. It is never written to the database, a log or
 * the chain; the chain gets only `summary.transcript_received` with its sha256 and counts.
 */
import {
  LIMITS,
  REDACTION_KINDS,
  canonicalJsonBytes,
  newRedactionState,
  redactText,
  sha256Hex,
  type AiProvider,
  type RedactionCounts,
  type SummaryTranscriptUpload,
} from '@indiansassist/shared';
import type { AppContext } from '../context.js';

/** What is held for one session (already re-redacted by the api). */
export type HeldTranscript = {
  noticeSentAt: string;
  noticeProvider: AiProvider;
  messages: { from: 'technician' | 'user'; at: string; text: string }[];
  playbookOutputs: { runId: string; stdoutTail: string; stderrTail: string }[];
  sha256: string;
  redactions: RedactionCounts;
};

export const transcriptKey = (sessionId: string): string => `ia:sumin:${sessionId}`;

/**
 * 5.3c: re-applies `redactText` with one state in upload order (every message, then every playbook tail), keeps only
 * the playbook outputs whose `runId` belongs to a `playbook.run` of the session, and computes the sha256 the chain
 * records. Pure apart from the state it creates.
 */
export function prepareTranscript(upload: SummaryTranscriptUpload, runIds: ReadonlySet<string>): HeldTranscript {
  const state = newRedactionState();
  const messages = upload.messages.map((m) => ({ from: m.from, at: m.at, text: redactText(m.text, state).slice(0, 4000) }));
  const playbookOutputs = upload.playbookOutputs
    .filter((p) => runIds.has(p.runId))
    .map((p) => ({ runId: p.runId, stdoutTail: redactText(p.stdoutTail, state).slice(-4000), stderrTail: redactText(p.stderrTail, state).slice(-2000) }));
  const body = { noticeSentAt: upload.noticeSentAt, noticeProvider: upload.noticeProvider, messages, playbookOutputs };
  return { ...body, sha256: sha256Hex(canonicalJsonBytes(body)), redactions: state.counts };
}

export async function holdTranscript(ctx: Pick<AppContext, 'presence' | 'metrics'>, sessionId: string, held: HeldTranscript): Promise<void> {
  await ctx.presence.setKey(transcriptKey(sessionId), JSON.stringify(held), LIMITS.summaryTranscriptTtlSec);
  for (const kind of REDACTION_KINDS) if (held.redactions[kind] > 0) ctx.metrics.redactions.inc({ kind }, held.redactions[kind]);
}

export async function getHeldTranscript(ctx: Pick<AppContext, 'presence'>, sessionId: string): Promise<HeldTranscript | null> {
  const raw = await ctx.presence.getKey(transcriptKey(sessionId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HeldTranscript;
  } catch {
    return null;
  }
}

/** 5.3c: deleted when the version it fed reaches `ready` or a final `failed` (else its TTL removes it). */
export async function dropHeldTranscript(ctx: Pick<AppContext, 'presence'>, sessionId: string): Promise<void> {
  await ctx.presence.delKey(transcriptKey(sessionId));
}
