/**
 * Creating the `knocked` session for a Desk socket (contracts sections 7.3, 7.5), directly on `desk.knock` or on a
 * held Desk's behalf after an eligible `assist.hello`. This is the single choke point for knocks, so it re-checks
 * everything that may have changed since the frame was queued:
 * - the Desk socket is still open, has no session yet and (for a held knock) is still held (correctness-F4);
 * - the token row is locked and must still be `active` and unexpired (section 3.5 step 7, SEC-03 / correctness-F5);
 *   otherwise the Desk gets `token_gone` and is closed `4403`;
 * - at most one non-ended session per token, enforced by the row lock plus the `session_token_open_unique` index
 *   (correctness-F2); a lost race answers `token_busy`, except when the open session is this Desk's own knock.
 */
import { sanitiseText, SANITISE_LIMITS, sha256Hex, WS_CLOSE, type UserRole } from '@indiansassist/shared';
import {
  addParticipant,
  createSession,
  expireTokenIfDue,
  findOpenSessionByToken,
  findTokenByTid,
  isUniqueViolation,
  lockToken,
  type SessionRow,
  type TokenRow,
} from '@indiansassist/db';
import { deskActor, piiHash, writeAudit } from '../lib/audit.js';
import { randomSecret } from '../lib/crypto.js';
import { refOf, userRefs } from '../lib/lookup.js';
import { effectiveStatus } from '../lib/mappers.js';
import { canActOnToken } from '../lib/rbac.js';
import { iso } from '../lib/time.js';
import type { Conn } from './conn.js';
import type { SignalHub } from './hub.js';
import { assistKnockMsg, ensureLive, orgOf, startKnockTimer } from './messages.js';

export type KnockOptions = { reId?: string | undefined; onBehalf?: boolean };

type KnockOutcome =
  | { kind: 'ok'; row: SessionRow }
  | { kind: 'gone'; status: string }
  | { kind: 'busy'; open: SessionRow | null };

export async function performKnock(
  hub: SignalHub,
  conn: Conn,
  tok: TokenRow,
  label: string,
  opts: KnockOptions = {},
): Promise<void> {
  const { ctx } = hub;
  const d = conn.desk;
  if (conn.closed || !d || d.sessionId !== null || (opts.onBehalf === true && !d.held)) return;
  const org = await orgOf(hub, tok.orgId);
  const resumeKey = randomSecret(32);
  const ua = conn.userAgent ? sanitiseText(conn.userAgent, SANITISE_LIMITS.userAgent) : null;
  const now = new Date();
  let out: KnockOutcome;
  try {
    out = await ctx.db.transaction(async (tx): Promise<KnockOutcome> => {
      const fresh = await lockToken(tx, tok.id);
      const status = fresh ? effectiveStatus(fresh) : 'revoked';
      if (!fresh || status !== 'active') return { kind: 'gone', status };
      const open = await findOpenSessionByToken(tx, tok.id);
      if (open) return { kind: 'busy', open };
      const row = await createSession(tx, {
        orgId: tok.orgId,
        tokenId: tok.id,
        assistUserId: tok.createdBy,
        deskRef: conn.id,
        tier: tok.tier,
        region: org.dataRegion,
        nodeId: ctx.config.nodeId,
        deskLabel: label,
        deskUserAgent: ua,
        deskClient: d.client,
        resumeKeyHash: sha256Hex(resumeKey),
        knockedAt: now,
        knockExpiresAt: new Date(now.getTime() + ctx.timing.knockTimeoutMs),
      });
      await addParticipant(tx, { sessionId: row.id, role: 'desk', label, connectionId: conn.id });
      await writeAudit(ctx, tx, org, {
        sessionId: row.id,
        actor: deskActor(conn.id),
        action: 'session.knock',
        data: { tokenId: tok.id, deskLabelHash: piiHash(org, label), userAgentHash: piiHash(org, ua ?? '') },
      });
      return { kind: 'ok', row };
    });
  } catch (err) {
    if (!isUniqueViolation(err, 'session_token_open_unique')) throw err;
    out = { kind: 'busy', open: null };
  }
  if (out.kind === 'gone') {
    if (out.status === 'expired') await expireTokenIfDue(ctx.db, tok.id);
    await ctx.presence.clearTokenWaiting(tok.id, conn.id);
    d.held = false;
    conn.error('token_gone', `token is ${out.status}`, opts.reId, { status: out.status });
    conn.close(WS_CLOSE.forbidden, 'token gone');
    return;
  }
  if (out.kind === 'busy') {
    if (out.open?.deskRef === conn.id) return; // this Desk's own knock already exists (idempotent)
    return conn.error('token_busy', 'token is busy', opts.reId);
  }
  const s = out.row;
  const live = ensureLive(hub, s);
  live.deskConnId = conn.id;
  d.sessionId = s.id;
  d.held = false;
  d.heldLabel = null;
  await ctx.presence.setTokenSession(tok.id, s.id);
  await ctx.presence.clearTokenWaiting(tok.id, conn.id);
  startKnockTimer(hub, live);
  conn.send({
    t: 'knock.ok',
    ...(opts.reId !== undefined ? { re: opts.reId } : {}),
    sessionId: s.id,
    resumeKey,
    expiresAt: iso(s.knockExpiresAt ?? now),
  });
  const creator = refOf(await userRefs(ctx.db, [tok.createdBy]), tok.createdBy);
  hub.toAssists(tok, assistKnockMsg(s, tok, creator, true));
}

/** The fields of an Assist user that "knock accept / deny" depends on. */
export type KnockUser = { id: string; orgId: string; role: UserRole };

/**
 * Performs the held knocks of the Desks handled on this node that `user` may act on (section 7.5), after an eligible
 * `assist.hello` here or on another node. performKnock re-checks, once the Desk's queue reaches it, that the Desk is
 * still open and held and that the token is still active and unexpired (SEC-03, F4).
 */
export async function performHeldKnocks(hub: SignalHub, user: KnockUser): Promise<void> {
  const { ctx } = hub;
  for (const desk of hub.deskConns()) {
    const d = desk.desk;
    if (desk.closed || !d || !d.held || d.sessionId || d.orgId !== user.orgId) continue;
    const tok = await findTokenByTid(ctx.db, d.tokenId);
    if (!tok || !canActOnToken(user, tok)) continue;
    desk.queue = desk.queue
      .then(() => performKnock(hub, desk, tok, desk.desk?.heldLabel ?? 'Desk', { onBehalf: true }))
      .catch((err: unknown) => ctx.log.error({ err, connectionId: desk.id }, 'held knock failed'));
    await desk.queue;
  }
}
