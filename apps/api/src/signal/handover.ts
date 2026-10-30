/**
 * Just-in-time elevation on the signaling side (docs/specs/phase-c-contracts.md section 7.2): `desk.elevation` mints
 * the one-time hand-over value (presence `ia:ho:<hash>` + the session row fields + the `elevation_handover` log,
 * chained as `elevation.handover_minted`); a `desk.hello { handover }` from the elevated instance runs the binding
 * order of checks in `handoverHello` (handover-hello.ts) and replaces the Desk socket.
 */
import { randomBytes } from 'node:crypto';
import {
  agentLevelAtLeast,
  LIMITS,
  sha256Hex,
  type Region,
  type SignalOf,
} from '@indiansassist/shared';
import { countHandoversSince, getSession, insertHandover, settleHandover, updateSession } from '@indiansassist/db';
import { deskActor, writeAudit } from '../lib/audit.js';
import { iso } from '../lib/time.js';
import { agentOfRow, type Conn } from './conn.js';
import type { SignalHub } from './hub.js';
import { orgOf } from './messages.js';
import { authorizeSession } from './relay.js';

/** The presence entry of an outstanding hand-over (section 7.2). */
export type HandoverEntry = {
  sessionId: string;
  tokenId: string;
  orgId: string;
  region: Region;
  assistUserId: string;
  opId: string;
  expiresAt: number;
};

export const handoverKey = (hash: string) => `ia:ho:${hash}`;

const re = (id: string | undefined) => (id !== undefined ? { re: id } : {});

type DeskClientLike = { kind?: string; os?: string; capabilities?: { features?: string[] }; platform?: { arch?: string } } | null;

export async function handleDeskElevation(hub: SignalHub, conn: Conn, msg: SignalOf<'desk.elevation'>): Promise<void> {
  const { ctx } = hub;
  const live = await authorizeSession(hub, conn, msg.sessionId, msg.t, msg.id);
  if (!live) return;
  const s = await getSession(ctx.db, msg.sessionId);
  const client = (s?.deskClient ?? null) as DeskClientLike;
  const agent = s ? (live.agent ?? agentOfRow(s)) : null;
  const ok =
    s !== null &&
    s.state === 'active' &&
    s.tier === 'p3_portable' &&
    client?.kind === 'native' &&
    client.os === 'windows' &&
    (client.capabilities?.features ?? []).includes('elevation') &&
    agent !== null &&
    agentLevelAtLeast(agent.level, 'control');
  if (!ok || !s) return conn.error('bad_state', 'elevation needs an active P3 Windows session at control level', msg.id);
  const since = new Date(Date.now() - 10 * 60_000);
  if ((await countHandoversSince(ctx.db, s.id, since)) >= LIMITS.handoverMintsPer10Min) {
    ctx.metrics.rateLimited.inc();
    return conn.error('rate_limited', 'too many elevation attempts for this session', msg.id, { retryAfterSec: 600 });
  }
  const handover = randomBytes(32).toString('base64url');
  const hash = sha256Hex(handover);
  const expiresAt = new Date(Date.now() + LIMITS.handoverTtlSec * 1000);
  // One outstanding hand-over per session: the previous value dies now.
  if (s.handoverHash) {
    await ctx.presence.delKey(handoverKey(s.handoverHash));
    await settleHandover(ctx.db, s.handoverHash, 'superseded');
  }
  const entry: HandoverEntry = {
    sessionId: s.id,
    tokenId: s.tokenId,
    orgId: s.orgId,
    region: s.region,
    assistUserId: s.assistUserId,
    opId: msg.opId,
    expiresAt: expiresAt.getTime(),
  };
  await ctx.presence.setKey(handoverKey(hash), JSON.stringify(entry), LIMITS.handoverTtlSec);
  const org = await orgOf(hub, s.orgId);
  await ctx.db.transaction(async (tx) => {
    await updateSession(tx, s.id, { handoverHash: hash, handoverOpid: msg.opId, handoverExpiresAt: expiresAt });
    await insertHandover(tx, { sessionId: s.id, orgId: s.orgId, tokenHash: hash, opId: msg.opId, expiresAt });
    await writeAudit(ctx, tx, org, {
      sessionId: s.id,
      actor: deskActor(s.deskRef),
      action: 'elevation.handover_minted',
      data: { opId: msg.opId, expiresAt: iso(expiresAt) },
    });
  });
  conn.send({ t: 'elevation.handover', ...re(msg.id), sessionId: s.id, handover, expiresAt: iso(expiresAt) });
}
