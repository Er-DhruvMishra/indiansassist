/**
 * Ticket content (docs/specs/phase-e-contracts.md section 4.3): the exact `TicketContent` a push stores and sends. The
 * summary is read only through `getSessionSummary` and `sessionSummaryOutputSchema` (section 1.4); the body is
 * `renderTicketBody`; the session block links back to the console and says whether the session's audit entries
 * verify. `requesterEmail` is set only when the technician typed it in the push dialog.
 */
import {
  canonicalJsonBytes,
  renderTicketBody,
  sha256Hex,
  sessionSummaryOutputSchema,
  ticketContentSchema,
  type TicketContent,
  type TicketPushRequest,
} from '@indiansassist/shared';
import { getSessionSummary, getUser, listAuditBySession, SummaryNotReadyError, type SessionRow, type SessionSummaryRow } from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { sessionIntegrity } from '../services/audit-service.js';

/** `Remote support session <YYYY-MM-DD> — <technician>` (section 4.3), cut to the 200-character title limit. */
export function defaultTicketTitle(endedAt: Date, technician: string): string {
  return `Remote support session ${endedAt.toISOString().slice(0, 10)} — ${technician}`.slice(0, 200);
}

/** The summary version a push names (default: the latest `ready`), or `409 summary_not_ready`. */
export async function readySummary(ctx: AppContext, sessionId: string, version: number | undefined): Promise<SessionSummaryRow> {
  let row: SessionSummaryRow | null;
  try {
    row = await getSessionSummary(ctx.db, sessionId, version);
  } catch (err) {
    if (err instanceof SummaryNotReadyError) fail('summary_not_ready', 'that summary version is not ready');
    throw err;
  }
  if (!row) fail('summary_not_ready', version === undefined ? 'this session has no ready summary' : 'that summary version does not exist');
  return row;
}

/** Whether the session's own audit entries verify (null when it has none to check). */
async function chainVerified(ctx: AppContext, session: SessionRow): Promise<boolean | null> {
  const entries = await listAuditBySession(ctx.db, session.id);
  if (entries.length === 0) return null;
  return (await sessionIntegrity(ctx.db, session.orgId, entries)).ok;
}

export async function buildTicketContent(
  ctx: AppContext,
  session: SessionRow,
  req: TicketPushRequest,
): Promise<{ content: TicketContent; summary: SessionSummaryRow | null }> {
  const assist = await getUser(ctx.db, session.assistUserId);
  const technician = (assist?.name ?? 'Technician').slice(0, 80);
  const endedAt = session.endedAt ?? new Date();
  const sessionBlock: TicketContent['session'] = {
    id: session.id,
    url: `${ctx.config.webOrigin}/app/sessions/${session.id}`,
    tier: session.tier,
    startedAt: session.startedAt ? session.startedAt.toISOString() : null,
    endedAt: endedAt.toISOString(),
    technician,
    chainVerified: await chainVerified(ctx, session),
  };
  let summary: SessionSummaryRow | null = null;
  let body: string;
  if (req.source === 'summary') {
    summary = await readySummary(ctx, session.id, req.summaryVersion);
    const out = sessionSummaryOutputSchema.safeParse(summary.output);
    if (!out.success) fail('summary_not_ready', 'that summary version has no usable output');
    body = renderTicketBody({ source: 'summary', note: null, summary: out.data, session: sessionBlock });
    // summaryOutputSha256 (section 5.5) belongs to the ai stream; its definition is applied here directly.
    const sha = summary.outputSha256 ?? sha256Hex(canonicalJsonBytes(out.data));
    const content = ticketContentSchema.parse({
      title: req.title ?? defaultTicketTitle(endedAt, technician),
      body,
      source: 'summary',
      session: sessionBlock,
      summary: { id: summary.id, version: summary.version, sha256: sha },
      priority: req.priority ?? null,
      requesterEmail: req.requesterEmail ?? null,
    });
    return { content, summary };
  }
  body = renderTicketBody({ source: 'manual', note: req.note ?? '', summary: null, session: sessionBlock });
  const content = ticketContentSchema.parse({
    title: req.title ?? defaultTicketTitle(endedAt, technician),
    body,
    source: 'manual',
    session: sessionBlock,
    summary: null,
    priority: req.priority ?? null,
    requesterEmail: req.requesterEmail ?? null,
  });
  return { content, summary };
}
