/**
 * The one way a session reaches `ended` (contracts sections 7.3, 7.4): in a single transaction the row-level
 * transition, any caller-supplied entries (`session.denied`, `session.consent_revoked`), `chat.relayed` when the
 * relay carried messages, `session.ended` and closing the participant rows; after commit the signaling hub pushes
 * `session.ended` / `knock.closed` and applies the socket rules.
 */
import { recorderActor, type SessionEndReason, type SessionState } from '@indiansassist/shared';
import {
  closeAllParticipants,
  getOrgOrThrow,
  getSession,
  transitionSession,
  type OrgRow,
  type SessionRow,
  type Tx,
} from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { writeAudit, type Actor } from '../lib/audit.js';
import { relayUsed } from '../signal/relay-p2.js';

export type EndOptions = {
  reason: SessionEndReason;
  actor: Actor;
  /** Stored in `reason` of the `session.ended` entry (sanitised, max 500). */
  note?: string | null;
  /** Restrict the source states (timeouts end only from the state whose deadline passed). */
  from?: readonly SessionState[];
  /** Extra entries written before `chat.relayed` / `session.ended` in the same transaction. */
  before?: (tx: Tx, org: OrgRow, current: SessionRow) => Promise<void>;
  /** Work after `session.ended` in the same transaction (token auto-revoke). */
  after?: (tx: Tx, org: OrgRow, ended: SessionRow) => Promise<void>;
  /** After commit, before the hub pushes `session.ended` (e.g. the `consent.ok { state: 'ended' }` reply). */
  beforePush?: (ended: EndedSession) => void | Promise<void>;
};

export type EndedSession = { session: SessionRow; previousState: SessionState; org: OrgRow };

/** Ends a session; throws SessionAlreadyEndedError (409 already_ended) or InvalidSessionTransitionError. */
export async function endSessionFlow(ctx: AppContext, sessionId: string, opts: EndOptions): Promise<EndedSession> {
  const chatCount = await ctx.hub.chatCount(sessionId);
  const relay = await ctx.hub.relayCounters(sessionId);
  const recorderId = ctx.hub.recorderStopForEnd(sessionId);
  const result = await ctx.db.transaction(async (tx) => {
    const current = await getSession(tx, sessionId);
    if (!current) throw new Error(`session ${sessionId} not found`);
    const org = await getOrgOrThrow(tx, current.orgId);
    const ended = await transitionSession(tx, sessionId, 'ended', {
      set: { endReason: opts.reason },
      ...(opts.from ? { from: opts.from } : {}),
    });
    if (opts.before) await opts.before(tx, org, current);
    // Phase A.2 section 6: the server recorder stops with the session, before `chat.relayed` / `session.ended`.
    if (recorderId !== null)
      await writeAudit(ctx, tx, org, {
        sessionId,
        actor: recorderActor(recorderId),
        action: 'recording.server_stopped',
        data: { recorderId, reason: 'session_ended' },
      });
    if (chatCount > 0)
      await writeAudit(ctx, tx, org, {
        sessionId,
        actor: { type: 'system', id: null, label: 'system' },
        action: 'chat.relayed',
        data: { count: chatCount },
      });
    // Phase B 4.6: the WS relay counters, immediately before `session.ended`.
    if (relayUsed(relay))
      await writeAudit(ctx, tx, org, {
        sessionId,
        actor: { type: 'system', id: null, label: 'system' },
        action: 'mirror.relayed',
        data: { ...relay },
      });
    const durationMs =
      ended.startedAt && ended.endedAt ? Math.max(0, ended.endedAt.getTime() - ended.startedAt.getTime()) : null;
    await writeAudit(ctx, tx, org, {
      sessionId,
      actor: opts.actor,
      action: 'session.ended',
      reason: opts.note ?? null,
      data: { endReason: opts.reason, durationMs, path: ended.path },
    });
    await closeAllParticipants(tx, sessionId, ended.endedAt ?? new Date());
    if (opts.after) await opts.after(tx, org, ended);
    return { previousState: current.state, org };
  });
  const fresh = (await getSession(ctx.db, sessionId))!;
  const out: EndedSession = { session: fresh, previousState: result.previousState, org: result.org };
  if (opts.beforePush) await opts.beforePush(out);
  await ctx.hub.sessionEnded(out);
  return out;
}

/** Like endSessionFlow but swallows "already ended" / lost races (timers, sweeper, cascades). */
export async function endSessionQuietly(
  ctx: AppContext,
  sessionId: string,
  opts: EndOptions,
): Promise<EndedSession | null> {
  try {
    return await endSessionFlow(ctx, sessionId, opts);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'already_ended' || code === 'invalid_transition') return null;
    throw err;
  }
}
