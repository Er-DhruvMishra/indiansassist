/**
 * session repository (contracts sections 4.2, 6.8, 7.4-7.6). State changes go through `transitionSession`, a
 * row-level `UPDATE ... WHERE state IN (allowed)` so concurrent nodes cannot both win the same edge.
 */
import { LIMITS, type SessionEndReason, type SessionState } from '@indiansassist/shared';
import { and, eq, gte, inArray, isNotNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { InvalidSessionTransitionError, NotFoundError, SessionAlreadyEndedError } from '../errors.js';
import { session, token, type NewSessionRow, type SessionRow } from '../schema/index.js';
import { clampLimit, timeIdAfter, timeIdCursorOf, timeIdOrder, toPage, type Page, type PageQuery } from './page.js';
import { canTransition, NON_ENDED_STATES, statesLeadingTo } from './session-state.js';

export type CreateSessionInput = Pick<
  NewSessionRow,
  'orgId' | 'tokenId' | 'assistUserId' | 'deskRef' | 'tier' | 'region' | 'nodeId'
> &
  Partial<
    Pick<
      NewSessionRow,
      'id' | 'deskLabel' | 'deskUserAgent' | 'resumeKeyHash' | 'knockedAt' | 'knockExpiresAt' | 'deskClient' | 'deviceId' | 'unattended' | 'unattendedPolicy' | 'recordingMode'
    >
  >;

/** Creates a `knocked` session; `knock_expires_at` defaults to `knocked_at + 120 s`. */
export async function createSession(exec: Executor, input: CreateSessionInput): Promise<SessionRow> {
  const knockedAt = input.knockedAt ?? new Date();
  const [row] = await exec
    .insert(session)
    .values({
      ...input,
      state: 'knocked',
      knockedAt,
      knockExpiresAt: input.knockExpiresAt ?? new Date(knockedAt.getTime() + LIMITS.knockTimeoutSec * 1000),
    })
    .returning();
  return row!;
}

export async function getSession(exec: Executor, id: string): Promise<SessionRow | null> {
  const [row] = await exec.select().from(session).where(eq(session.id, id)).limit(1);
  return row ?? null;
}

/**
 * Row-locks a session (`select ... for update`) and returns it. The first statement of any transaction that touches a
 * session's child rows (participants, files) before transitioning it, so the session row is always locked first
 * (lock order, see audit.ts).
 */
export async function lockSession(exec: Executor, id: string): Promise<SessionRow | null> {
  const [row] = await exec.select().from(session).where(eq(session.id, id)).limit(1).for('update');
  return row ?? null;
}

/** The non-ended session on a token, if any (`token_busy`, resume). */
export async function findOpenSessionByToken(exec: Executor, tokenId: string): Promise<SessionRow | null> {
  const [row] = await exec
    .select()
    .from(session)
    .where(and(eq(session.tokenId, tokenId), ne(session.state, 'ended')))
    .limit(1);
  return row ?? null;
}

export async function listOpenSessionsByToken(exec: Executor, tokenId: string): Promise<SessionRow[]> {
  return exec
    .select()
    .from(session)
    .where(and(eq(session.tokenId, tokenId), ne(session.state, 'ended')));
}

export type TransitionSet = Partial<
  Pick<
    SessionRow,
    | 'assistUserId'
    | 'consentSurface'
    | 'path'
    | 'nodeId'
    | 'consentDeadlineAt'
    | 'endReason'
    | 'consentLevel'
    | 'consentScope'
    | 'consentBackstage'
    | 'recordingMode'
    | 'consentMonitors'
    | 'consentClipboard'
  >
>;

export type TransitionOptions = {
  /** Restrict the source state(s); each must be allowed to reach `to`. Defaults to every allowed source. */
  from?: SessionState | readonly SessionState[];
  now?: Date;
  set?: TransitionSet;
};

function sideEffects(to: SessionState, now: Date, set: TransitionSet): Record<string, unknown> {
  switch (to) {
    case 'accepted':
      return { acceptedAt: now, knockExpiresAt: null };
    case 'consent_pending':
      return {
        consentState: 'pending',
        consentDeadlineAt: set.consentDeadlineAt ?? new Date(now.getTime() + LIMITS.consentTimeoutSec * 1000),
      };
    case 'active':
      return {
        consentState: 'granted',
        consentAt: now,
        startedAt: sql`coalesce(${session.startedAt}, ${now.toISOString()}::timestamptz)`,
        consentDeadlineAt: null,
      };
    case 'ended': {
      if (!set.endReason) throw new Error('ending a session requires endReason');
      const out: Record<string, unknown> = { endedAt: now, knockExpiresAt: null, consentDeadlineAt: null };
      if (set.endReason === 'consent_revoked') out['consentState'] = 'revoked';
      return out;
    }
    default:
      return {};
  }
}

/**
 * Moves a session to `to` if the section 7.4 machine allows it from the row's current state.
 * Throws InvalidSessionTransitionError (disallowed edge, or the row is no longer in an allowed source state),
 * SessionAlreadyEndedError (row is `ended`) or NotFoundError.
 */
export async function transitionSession(
  exec: Executor,
  id: string,
  to: SessionState,
  opts: TransitionOptions = {},
): Promise<SessionRow> {
  let sources = statesLeadingTo(to);
  if (opts.from !== undefined) {
    const requested: readonly SessionState[] = typeof opts.from === 'string' ? [opts.from] : opts.from;
    for (const f of requested) if (!canTransition(f, to)) throw new InvalidSessionTransitionError(f, to);
    sources = [...requested];
  }
  if (sources.length === 0) throw new InvalidSessionTransitionError(null, to);
  const now = opts.now ?? new Date();
  const set = opts.set ?? {};
  if (to !== 'ended' && set.endReason) throw new Error('endReason is only valid when ending a session');
  const values = { ...set, ...sideEffects(to, now, set), state: to };
  const [row] = await exec
    .update(session)
    .set(values)
    .where(and(eq(session.id, id), inArray(session.state, sources)))
    .returning();
  if (row) return row;
  const current = await getSession(exec, id);
  if (!current) throw new NotFoundError('session', id);
  if (current.state === 'ended') throw new SessionAlreadyEndedError(to);
  throw new InvalidSessionTransitionError(current.state, to);
}

/** Ends a non-ended session (`409 already_ended` maps from SessionAlreadyEndedError). */
export async function endSession(
  exec: Executor,
  id: string,
  endReason: SessionEndReason,
  opts: Omit<TransitionOptions, 'set'> = {},
): Promise<SessionRow> {
  return transitionSession(exec, id, 'ended', { ...opts, set: { endReason } });
}

/** Non-state columns. State and its timestamps only change through transitionSession / endSession. */
export type SessionPatch = Partial<
  Pick<
    SessionRow,
    | 'path'
    | 'lastStats'
    | 'nodeId'
    | 'resumeKeyHash'
    | 'consentSurface'
    | 'deskLabel'
    | 'deskUserAgent'
    | 'consentLevel'
    | 'consentBackstage'
    | 'deskClient'
    | 'recordingMode'
    | 'consentMonitors'
    | 'consentClipboard'
    | 'elevation'
    | 'handoverHash'
    | 'handoverOpid'
    | 'handoverExpiresAt'
  >
>;

const PATCHABLE = new Set([
  // Phase C section 13.2
  'consentMonitors',
  'consentClipboard',
  'elevation',
  'handoverHash',
  'handoverOpid',
  'handoverExpiresAt',
  'recordingMode',
  'consentLevel',
  'consentBackstage',
  'deskClient',
  'path',
  'lastStats',
  'nodeId',
  'resumeKeyHash',
  'consentSurface',
  'deskLabel',
  'deskUserAgent',
]);

export async function updateSession(exec: Executor, id: string, patch: SessionPatch): Promise<SessionRow> {
  for (const k of Object.keys(patch)) if (!PATCHABLE.has(k)) throw new Error(`session column ${k} is not patchable`);
  const [row] = await exec.update(session).set(patch).where(eq(session.id, id)).returning();
  if (!row) throw new NotFoundError('session', id);
  return row;
}

/**
 * Pins the P3 playbook manifest hashes (playbook id -> body hash) on a session, write-once (only when still null), so
 * the `playbook_changed` run check reads them from the row on any node (Phase C section 8.3, F6). Returns the stored
 * pins: the ones just written, or the ones a concurrent writer already set.
 */
export async function pinSessionPlaybooks(exec: Executor, id: string, pins: Record<string, string>): Promise<Record<string, string> | null> {
  const rows = await exec
    .update(session)
    .set({ playbookPins: pins })
    .where(and(eq(session.id, id), sql`${session.playbookPins} is null`))
    .returning({ pins: session.playbookPins });
  if (rows[0]) return rows[0].pins ?? null;
  return (await getSession(exec, id))?.playbookPins ?? null;
}

/** Sets `server_recording` once (Phase A.2 section 6); true only for the first call. */
export async function markServerRecording(exec: Executor, id: string): Promise<boolean> {
  const rows = await exec
    .update(session)
    .set({ serverRecording: true })
    .where(and(eq(session.id, id), eq(session.serverRecording, false)))
    .returning({ id: session.id });
  return rows.length > 0;
}

/** Sets `recording_started` once; true only for the first call (deduplication, section 6.8). */
export async function markRecordingStarted(exec: Executor, id: string): Promise<boolean> {
  const rows = await exec
    .update(session)
    .set({ recordingStarted: true })
    .where(and(eq(session.id, id), eq(session.recordingStarted, false)))
    .returning({ id: session.id });
  return rows.length > 0;
}

export type ListSessionsQuery = PageQuery & {
  state?: SessionState;
  /** Half-open `[from, to)` on `knocked_at`. */
  from?: Date;
  to?: Date;
  /** `own` scope: sessions where assist_user_id = user OR token.created_by = user (section 2.3). */
  ownUserId?: string;
  /** Phase D: sessions of one device. */
  deviceId?: string;
};

/** Sessions of an org, newest first (`created_at desc, id desc`). */
export async function listSessionsByOrg(
  exec: Executor,
  orgId: string,
  q: ListSessionsQuery = {},
): Promise<Page<SessionRow>> {
  const limit = clampLimit(q.limit);
  const conds: SQL[] = [eq(session.orgId, orgId)];
  if (q.state) conds.push(eq(session.state, q.state));
  if (q.from) conds.push(gte(session.knockedAt, q.from));
  if (q.to) conds.push(lt(session.knockedAt, q.to));
  if (q.ownUserId) {
    const ownTokens = exec.select({ id: token.id }).from(token).where(eq(token.createdBy, q.ownUserId));
    conds.push(or(eq(session.assistUserId, q.ownUserId), inArray(session.tokenId, ownTokens))!);
  }
  if (q.deviceId) conds.push(eq(session.deviceId, q.deviceId));
  const after = timeIdAfter(session.createdAt, session.id, q.cursor, 'desc');
  if (after) conds.push(after);
  const rows = await exec
    .select()
    .from(session)
    .where(and(...conds))
    .orderBy(...timeIdOrder(session.createdAt, session.id, 'desc'))
    .limit(limit + 1);
  return toPage(rows, limit, timeIdCursorOf);
}

/** Sweeper (section 7.6 N4): knocks and consent windows whose deadline passed. */
export async function listSessionsPastDeadline(exec: Executor, now: Date = new Date()): Promise<SessionRow[]> {
  return exec
    .select()
    .from(session)
    .where(
      or(
        and(eq(session.state, 'knocked'), isNotNull(session.knockExpiresAt), lt(session.knockExpiresAt, now)),
        and(
          eq(session.state, 'consent_pending'),
          isNotNull(session.consentDeadlineAt),
          lt(session.consentDeadlineAt, now),
        ),
      ),
    );
}

/** Non-ended sessions owned by a node (boot cleanup N3, lost-node sweep N4). */
export async function listOpenSessionsByNode(exec: Executor, nodeId: string): Promise<SessionRow[]> {
  return exec
    .select()
    .from(session)
    .where(and(eq(session.nodeId, nodeId), inArray(session.state, [...NON_ENDED_STATES])));
}

/** Sweeper backstop for revocation (sections 6.7, 7.4): non-ended sessions whose token is `revoked`. */
export async function listOpenSessionsOnRevokedTokens(exec: Executor): Promise<SessionRow[]> {
  const rows = await exec
    .select({ s: session })
    .from(session)
    .innerJoin(token, eq(token.id, session.tokenId))
    .where(and(inArray(session.state, [...NON_ENDED_STATES]), eq(token.status, 'revoked')));
  return rows.map((r) => r.s);
}
