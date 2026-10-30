/**
 * `desk.event`: the Desk's attestations (contracts section 7.3, 8.3; Phase B 3.6). The chain is not a sink for
 * anonymous input (section 5.3), so an attestation is accepted only (SEC-04):
 * - from the registered Desk socket of a session that reached `active` (`started_at` set), until `ended_at + 60 s`;
 * - within a per-session budget (5 / s, burst 20); repeated violations close the socket `4429`.
 * File attestations (`file.*`) are written once per transfer (`direction` + `fileId <= MAX_ATTESTED_FILE_ID`); a
 * repeat answers `event.ok` with the entry already written. The Phase B actions (P2 sessions only) are written as
 * sent, with the wire `host` mapped to `hostHash` and the plaintext kept in `session_host`.
 */
import {
  deskEventDataSchema,
  DESK_EVENT_P2_ACTIONS,
  DESK_EVENT_REASON_ACTIONS,
  fileEventDataSchema,
  hostToHash,
  sanitiseFileName,
  WS_CLOSE,
  type DeskEventP2Action,
  type SignalOf,
} from '@indiansassist/shared';
import { getSession, upsertSessionFile, upsertSessionHost, type SessionRow } from '@indiansassist/db';
import { deskActor, piiHash, writeAudit } from '../lib/audit.js';
import type { Conn, Live } from './conn.js';
import type { SignalHub } from './hub.js';
import { orgOf } from './messages.js';
import { authorizeSession } from './relay.js';
import { p3Event } from './desk-events-p3.js';

/** Highest `fileId` attested per session (the data channel numbers transfers from 1). */
export const MAX_ATTESTED_FILE_ID = 10_000;

const re = (id: string | undefined) => (id !== undefined ? { re: id } : {});

export async function handleDeskEvent(hub: SignalHub, conn: Conn, msg: SignalOf<'desk.event'>): Promise<void> {
  const { ctx } = hub;
  const live = await authorizeSession(hub, conn, msg.sessionId, msg.t, msg.id);
  if (!live) return;
  if (!ctx.config.rateLimitDisabled && !live.eventBucket.take()) {
    ctx.metrics.rateLimited.inc();
    conn.error('rate_limited', 'too many attestations for this session', msg.id, { retryAfterSec: 1 });
    if (conn.strike()) conn.close(WS_CLOSE.rateLimited, 'rate limited');
    return;
  }
  const s = await getSession(ctx.db, msg.sessionId);
  if (!s || s.startedAt === null)
    return conn.error('consent_required', 'attestations need a session that reached active', msg.id);
  if (s.endedAt && Date.now() > s.endedAt.getTime() + ctx.timing.eventGraceMs)
    return conn.error('bad_state', 'session ended too long ago', msg.id);
  if (msg.action === 'file.sent' || msg.action === 'file.received') return fileEvent(hub, conn, live, s, msg, msg.action);
  if (s.tier === 'p3_portable') return p3Event(hub, conn, s, msg);
  if (!(DESK_EVENT_P2_ACTIONS as readonly string[]).includes(msg.action))
    return conn.error('bad_payload', `${msg.action} is attested in P3 sessions only`, msg.id);
  return p2Event(hub, conn, s, msg, msg.action as DeskEventP2Action);
}

async function fileEvent(
  hub: SignalHub,
  conn: Conn,
  live: Live,
  s: SessionRow,
  msg: SignalOf<'desk.event'>,
  action: 'file.sent' | 'file.received',
): Promise<void> {
  const { ctx } = hub;
  const d = fileEventDataSchema.parse(msg.data);
  if (d.fileId > MAX_ATTESTED_FILE_ID) return conn.error('bad_payload', `fileId must be at most ${MAX_ATTESTED_FILE_ID}`, msg.id);
  const key = `${d.direction}:${d.fileId}`;
  const prior = live.deskAttested.get(key);
  if (prior) return conn.send({ t: 'event.ok', ...re(msg.id), sessionId: s.id, entryId: prior });
  const org = await orgOf(hub, s.orgId);
  const name = sanitiseFileName(d.name, d.fileId);
  const entry = await ctx.db.transaction(async (tx) => {
    const e = await writeAudit(ctx, tx, org, {
      sessionId: s.id,
      actor: deskActor(s.deskRef),
      action,
      data: { fileId: d.fileId, direction: d.direction, nameHash: piiHash(org, name), bytes: d.bytes, sha256: d.sha256 },
    });
    await upsertSessionFile(tx, {
      sessionId: s.id,
      direction: d.direction,
      fileId: d.fileId,
      name,
      bytes: d.bytes,
      sha256: d.sha256,
      side: 'desk',
      entryId: e.id,
    });
    return e;
  });
  live.deskAttested.set(key, entry.id);
  conn.send({ t: 'event.ok', ...re(msg.id), sessionId: s.id, entryId: entry.id });
}

async function p2Event(hub: SignalHub, conn: Conn, s: SessionRow, msg: SignalOf<'desk.event'>, action: DeskEventP2Action): Promise<void> {
  const { ctx } = hub;
  if (s.tier !== 'p2_extension') return conn.error('bad_payload', `${action} is attested in P2 sessions only`, msg.id);
  if (s.state !== 'active' && s.state !== 'ended') return conn.error('bad_state', `session is ${s.state}`, msg.id);
  const parsed = deskEventDataSchema(action).safeParse(msg.data);
  if (!parsed.success) return conn.error('bad_payload', `invalid ${action} data`, msg.id);
  const org = await orgOf(hub, s.orgId);
  const { data, host } = hostToHash(parsed.data as Record<string, unknown>, (h) => piiHash(org, h));
  const withReason = (DESK_EVENT_REASON_ACTIONS as readonly string[]).includes(action);
  const entry = await ctx.db.transaction(async (tx) => {
    const e = await writeAudit(ctx, tx, org, {
      sessionId: s.id,
      actor: deskActor(s.deskRef),
      action,
      reason: withReason ? (msg.reason ?? null) : null,
      data,
    });
    if (host !== null) await upsertSessionHost(tx, { sessionId: s.id, orgId: s.orgId, hostHash: data.hostHash!, host });
    return e;
  });
  conn.send({ t: 'event.ok', ...re(msg.id), sessionId: s.id, entryId: entry.id });
}
