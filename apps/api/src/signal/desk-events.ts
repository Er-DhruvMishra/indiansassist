/**
 * `desk.event`: the Desk's file attestation (contracts sections 7.3, 8.3). The chain is not a sink for anonymous
 * input (section 5.3), so an attestation is accepted only (SEC-04):
 * - from the registered Desk socket of a session that reached `active` (`started_at` set; a file can only exist
 *   over the data channel of an active session), until `ended_at + 60 s`;
 * - once per transfer (`direction` + `fileId`, `fileId <= MAX_ATTESTED_FILE_ID`): a repeat answers `event.ok` with
 *   the entry already written and appends nothing;
 * - within a per-session budget (5 / s, burst 20); repeated violations close the socket `4429`.
 */
import { sanitiseFileName, WS_CLOSE, type SignalOf } from '@indiansassist/shared';
import { getSession, upsertSessionFile } from '@indiansassist/db';
import { deskActor, piiHash, writeAudit } from '../lib/audit.js';
import type { Conn } from './conn.js';
import type { SignalHub } from './hub.js';
import { orgOf } from './messages.js';
import { authorizeSession } from './relay.js';

/** Highest `fileId` attested per session (the data channel numbers transfers from 1). */
export const MAX_ATTESTED_FILE_ID = 10_000;

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
  if (msg.data.fileId > MAX_ATTESTED_FILE_ID)
    return conn.error('bad_payload', `fileId must be at most ${MAX_ATTESTED_FILE_ID}`, msg.id);
  const s = await getSession(ctx.db, msg.sessionId);
  if (!s || s.startedAt === null)
    return conn.error('consent_required', 'file attestations need a session that reached active', msg.id);
  if (s.endedAt && Date.now() > s.endedAt.getTime() + ctx.timing.eventGraceMs)
    return conn.error('bad_state', 'session ended too long ago', msg.id);
  const key = `${msg.data.direction}:${msg.data.fileId}`;
  const prior = live.deskAttested.get(key);
  if (prior) return conn.send({ t: 'event.ok', ...(msg.id !== undefined ? { re: msg.id } : {}), sessionId: s.id, entryId: prior });
  const org = await orgOf(hub, s.orgId);
  const name = sanitiseFileName(msg.data.name, msg.data.fileId);
  const entry = await ctx.db.transaction(async (tx) => {
    const e = await writeAudit(ctx, tx, org, {
      sessionId: s.id,
      actor: deskActor(s.deskRef),
      action: msg.action,
      data: {
        fileId: msg.data.fileId,
        direction: msg.data.direction,
        nameHash: piiHash(org, name),
        bytes: msg.data.bytes,
        sha256: msg.data.sha256,
      },
    });
    await upsertSessionFile(tx, {
      sessionId: s.id,
      direction: msg.data.direction,
      fileId: msg.data.fileId,
      name,
      bytes: msg.data.bytes,
      sha256: msg.data.sha256,
      side: 'desk',
      entryId: e.id,
    });
    return e;
  });
  live.deskAttested.set(key, entry.id);
  conn.send({ t: 'event.ok', ...(msg.id !== undefined ? { re: msg.id } : {}), sessionId: s.id, entryId: entry.id });
}
