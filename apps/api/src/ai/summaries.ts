/**
 * Phase E sections 5.1, 5.8, 5.9: summary versions. Version 1 is generated; later versions are regenerations or
 * technician edits; versions are never deleted or rewritten once terminal (5.8f). This module holds the version
 * insert (numbered under the session row lock), the automatic enqueue at session end (5.8a), the on-demand request
 * (5.8b), the edit (5.8e) and the wire mapping (5.9).
 */
import {
  LIMITS,
  REDACTION_KINDS,
  emptyRedactionCounts,
  summaryOutputSha256,
  type AiProvider,
  type AiSessionSummary,
  type RedactionCounts,
  type SessionSummaryMeta,
  type SessionSummaryOutput,
  type SummaryFailCause,
  type SummaryState,
  type SummaryTrigger,
} from '@indiansassist/shared';
import {
  getUser,
  insertSessionSummary,
  listSessionSummaries,
  lockSession,
  type Executor,
  type OrgRow,
  type SessionRow,
  type SessionSummaryRow,
} from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { systemActor, userActor, writeAudit } from '../lib/audit.js';
import type { EndedSession } from '../services/session-end.js';
import { orgPolicy } from './policy.js';
import { getHeldTranscript } from './transcript.js';

/** The model recorded on a pending version: the provider's configured model, else the operator default. */
export function modelFor(ctx: Pick<AppContext, 'summaryProviders' | 'config'>, region: OrgRow['dataRegion'], provider: AiProvider): string {
  if (provider === 'none') return 'none';
  const p = ctx.summaryProviders(region)[provider];
  return p?.model ?? (provider === 'local' ? ctx.config.ai.local.model : ctx.config.ai.anthropic.model);
}

type NewVersion = {
  state: SummaryState;
  trigger: SummaryTrigger;
  provider: AiProvider;
  model: string;
  nextAttemptAt?: Date | null;
  createdBy?: string | null;
  editedBy?: string | null;
  baseVersion?: number | null;
  output?: SessionSummaryOutput | null;
  outputSha256?: string | null;
  inputSha256?: string | null;
  redactionCounts?: RedactionCounts;
  transcriptIncluded?: boolean;
  completedAt?: Date | null;
};

/** Inserts version n+1 of the session's summary; the caller's transaction holds the session row lock. */
export async function insertNextVersion(tx: Executor, session: SessionRow, v: NewVersion): Promise<SessionSummaryRow> {
  await lockSession(tx, session.id);
  const versions = await listSessionSummaries(tx, session.id);
  const version = (versions.at(-1)?.version ?? 0) + 1;
  return insertSessionSummary(tx, {
    orgId: session.orgId,
    sessionId: session.id,
    version,
    state: v.state,
    trigger: v.trigger,
    provider: v.provider,
    model: v.model.slice(0, 100),
    nextAttemptAt: v.nextAttemptAt ?? null,
    createdBy: v.createdBy ?? null,
    editedBy: v.editedBy ?? null,
    baseVersion: v.baseVersion ?? null,
    output: (v.output ?? null) as Record<string, unknown> | null,
    outputSha256: v.outputSha256 ?? null,
    inputSha256: v.inputSha256 ?? null,
    redactionCounts: v.redactionCounts ?? emptyRedactionCounts(),
    transcriptIncluded: v.transcriptIncluded ?? false,
    completedAt: v.completedAt ?? null,
  });
}

/**
 * Rule 5.8a, registered in `onSessionEnded` (services/session-end.ts) by routes.ts: when the org policy has
 * `autoSummarize` and a provider other than `none`, version n+1 is inserted pending, due after the console's upload
 * grace, and `summary.auto_requested` is chained (actor system).
 */
export async function enqueueAutoSummary(ctx: AppContext, ended: EndedSession): Promise<void> {
  const policy = orgPolicy(ended.org);
  if (!policy.autoSummarize || policy.provider === 'none') return;
  const session = ended.session;
  const endedAt = session.endedAt ?? new Date();
  await ctx.db.transaction(async (tx) => {
    const row = await insertNextVersion(tx, session, {
      state: 'pending',
      trigger: 'session_end',
      provider: policy.provider,
      model: modelFor(ctx, ended.org.dataRegion, policy.provider),
      nextAttemptAt: new Date(endedAt.getTime() + LIMITS.summaryTranscriptGraceSec * 1000),
    });
    await writeAudit(ctx, tx, ended.org, {
      sessionId: session.id,
      actor: systemActor,
      action: 'summary.auto_requested',
      data: { summaryId: row.id, version: row.version },
    });
  });
}

/** Rule 5.8b: `POST /sessions/:id/summary`. */
export async function requestSummary(
  ctx: AppContext,
  org: OrgRow,
  session: SessionRow,
  user: { id: string; name: string },
  now: Date = new Date(),
): Promise<SessionSummaryRow> {
  const policy = orgPolicy(org);
  if (policy.provider === 'none') fail('ai_disabled', 'AI summaries are turned off for this organisation');
  if (session.state !== 'ended') fail('session_not_ended', 'a summary can be generated once the session has ended');
  // With the transcript on and nothing held yet, wait the upload grace so a console that uploads first is not raced.
  const wait = policy.includeTranscript && (await getHeldTranscript(ctx, session.id)) === null;
  const due = new Date(now.getTime() + (wait ? LIMITS.summaryTranscriptGraceSec * 1000 : 0));
  return ctx.db.transaction(async (tx) => {
    await lockSession(tx, session.id);
    const versions = await listSessionSummaries(tx, session.id);
    if (versions.some((v) => v.state === 'pending' || v.state === 'running')) fail('summary_running', 'a summary is already being generated');
    const row = await insertNextVersion(tx, session, {
      state: 'pending',
      trigger: 'on_demand',
      provider: policy.provider,
      model: modelFor(ctx, org.dataRegion, policy.provider),
      nextAttemptAt: due,
      createdBy: user.id,
    });
    await writeAudit(ctx, tx, org, { sessionId: session.id, actor: userActor(user), action: 'summary.requested', data: { summaryId: row.id, version: row.version } });
    return row;
  });
}

/**
 * Rule 5.8e: `PUT /sessions/:id/summary`. The base must be the latest version (`409 summary_conflict`) and `ready`
 * (`409 summary_not_ready`). Edited text is the technician's deliberate words and is not re-redacted.
 */
export async function editSummary(
  ctx: AppContext,
  org: OrgRow,
  session: SessionRow,
  user: { id: string; name: string },
  baseVersion: number,
  output: SessionSummaryOutput,
  now: Date = new Date(),
): Promise<SessionSummaryRow> {
  return ctx.db.transaction(async (tx) => {
    await lockSession(tx, session.id);
    const versions = await listSessionSummaries(tx, session.id);
    const latest = versions.at(-1);
    if (!latest) fail('summary_not_ready', 'this session has no summary to edit');
    if (latest.version !== baseVersion) fail('summary_conflict', `version ${baseVersion} is not the latest (${latest.version})`, { latest: latest.version });
    if (latest.state !== 'ready') fail('summary_not_ready', `version ${baseVersion} is ${latest.state}, not ready`);
    const sha256 = summaryOutputSha256(output);
    const row = await insertNextVersion(tx, session, {
      state: 'ready',
      trigger: 'edit',
      provider: latest.provider,
      model: latest.model,
      baseVersion,
      createdBy: user.id,
      editedBy: user.id,
      output,
      outputSha256: sha256,
      inputSha256: latest.inputSha256,
      redactionCounts: countsOf(latest.redactionCounts),
      transcriptIncluded: latest.transcriptIncluded,
      completedAt: now,
    });
    await writeAudit(ctx, tx, org, {
      sessionId: session.id,
      actor: userActor(user),
      action: 'summary.edited',
      data: { summaryId: row.id, version: row.version, baseVersion, sha256, previousSha256: latest.outputSha256 ?? sha256 },
    });
    return row;
  });
}

/** A stored `redaction_counts` (possibly `{}` or partial) as full RedactionCounts. */
export function countsOf(raw: Record<string, number> | null | undefined): RedactionCounts {
  const out = emptyRedactionCounts();
  for (const k of REDACTION_KINDS) {
    const v = raw?.[k];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[k] = v;
  }
  return out;
}

type UserRef = { id: string; name: string } | null;

async function userRefs(exec: Executor, ids: (string | null)[]): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>();
  for (const id of new Set(ids.filter((x): x is string => x !== null))) {
    const u = await getUser(exec, id);
    out.set(id, { id, name: u?.name ?? 'a former user' });
  }
  return out;
}

function meta(row: SessionSummaryRow, users: Map<string, { id: string; name: string }>): SessionSummaryMeta {
  const ref = (id: string | null): UserRef => (id ? (users.get(id) ?? { id, name: 'a former user' }) : null);
  return {
    id: row.id,
    sessionId: row.sessionId,
    version: row.version,
    state: row.state,
    trigger: row.trigger,
    provider: row.provider,
    model: row.model,
    servedModel: row.servedModel,
    inferenceGeo: row.inferenceGeo,
    fallbackUsed: row.fallbackUsed,
    transcriptIncluded: row.transcriptIncluded,
    normalised: row.normalised,
    redactions: countsOf(row.redactionCounts),
    sha256: row.outputSha256,
    inputSha256: row.inputSha256,
    cause: (row.cause as SummaryFailCause | null) ?? null,
    attempts: row.attempts,
    createdBy: ref(row.createdBy),
    editedBy: ref(row.editedBy),
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

/** Section 5.9 wire shapes of a list of versions (one user lookup per distinct id). */
export async function toSummaryWire(exec: Executor, rows: SessionSummaryRow[]): Promise<{ metas: SessionSummaryMeta[]; full: Map<number, AiSessionSummary> }> {
  const users = await userRefs(exec, rows.flatMap((r) => [r.createdBy, r.editedBy]));
  const metas = rows.map((r) => meta(r, users));
  const full = new Map<number, AiSessionSummary>();
  rows.forEach((r, i) => full.set(r.version, { ...metas[i]!, output: (r.output as SessionSummaryOutput | null) ?? null }));
  return { metas, full };
}

export async function toAiSessionSummary(exec: Executor, row: SessionSummaryRow): Promise<AiSessionSummary> {
  return (await toSummaryWire(exec, [row])).full.get(row.version)!;
}
