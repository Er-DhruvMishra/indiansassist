/**
 * WS relay fallback of a P2 session (docs/specs/phase-b-contracts.md section 4.6, Y22): `mirror.relay` and
 * `control.relay` are forwarded to the other participant unchanged, never logged, never persisted, never
 * reassembled. Accepted only from the session's registered participants, while `active`, for `p2_extension` with
 * `policy.allowRelayFallback`. Limits: the per-session mirror budget (sliding 10 s), 16 KiB per control message,
 * 10 control frames / s per direction, the direction rules, and a consent-level gate on relayed `ctl.req` (the one
 * place the server can see a control request: a request above the Desk's granted level is refused with
 * `consent_required` and recorded as `control.refused`).
 */
import {
  levelAtLeast,
  LIMITS,
  minLevelFor,
  opIdFor,
  utf8Encode,
  type ControlOp,
  type SignalOf,
} from '@indiansassist/shared';
import { systemActor, writeAudit } from '../lib/audit.js';
import type { Conn, Live, RelayCounters } from './conn.js';
import type { SignalHub } from './hub.js';
import { livePolicy, orgOf } from './messages.js';
import { authorizeSession } from './relay.js';

const WINDOW_MS = LIMITS.mirrorRelayBudgetWindowSec * 1000;

/** The live P2 session whose relay `conn` may use, or an error reply and null. */
async function relayLive(hub: SignalHub, conn: Conn, sessionId: string, t: string, reId: string | undefined): Promise<Live | null> {
  const live = await authorizeSession(hub, conn, sessionId, t, reId);
  if (!live) return null;
  if (live.tier !== 'p2_extension' || live.state !== 'active') {
    conn.error('bad_state', 'the relay carries active P2 sessions only', reId);
    return null;
  }
  if (!(await livePolicy(hub, live)).allowRelayFallback) {
    conn.error('bad_state', 'this organisation does not allow server relay', reId);
    return null;
  }
  return live;
}

function peerOf(hub: SignalHub, conn: Conn, live: Live): Conn | null {
  return hub.conn(conn.side === 'assist' ? live.deskConnId : live.assistConnId);
}

/** Records `chars` against the sliding budget; returns 0 when allowed, else the seconds until it would fit. */
export function spendBudget(live: Live, chars: number, budget: number, now = Date.now()): number {
  live.relayWindow = live.relayWindow.filter(([at]) => at > now - WINDOW_MS);
  const used = live.relayWindow.reduce((n, [, c]) => n + c, 0);
  if (used + chars > budget) {
    const oldest = live.relayWindow[0]?.[0] ?? now;
    return Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
  }
  live.relayWindow.push([now, chars]);
  return 0;
}

export async function handleMirrorRelay(hub: SignalHub, conn: Conn, msg: SignalOf<'mirror.relay'>): Promise<void> {
  const live = await relayLive(hub, conn, msg.sessionId, msg.t, msg.id);
  if (!live) return;
  if (conn.side === 'assist' && msg.kind !== 'json')
    return conn.error('bad_payload', 'the Assist relays acks and nacks only (kind json)', msg.id);
  const retryAfterSec = spendBudget(live, msg.data.length, hub.ctx.config.mirrorRelayBudgetBytes);
  if (retryAfterSec > 0) {
    live.relay.dropped += 1;
    hub.ctx.metrics.rateLimited.inc();
    return conn.error('rate_limited', 'mirror relay budget exceeded', msg.id, { retryAfterSec });
  }
  live.relay.mirrorFrames += 1;
  live.relay.mirrorBytes += msg.data.length;
  peerOf(hub, conn, live)?.sendRaw(JSON.stringify(msg));
}

export async function handleControlRelay(hub: SignalHub, conn: Conn, msg: SignalOf<'control.relay'>): Promise<void> {
  const live = await relayLive(hub, conn, msg.sessionId, msg.t, msg.id);
  if (!live) return;
  const inner = msg.msg;
  if (utf8Encode(JSON.stringify(inner)).length > LIMITS.controlRelayMaxBytes)
    return conn.error('payload_too_large', `control messages are limited to ${LIMITS.controlRelayMaxBytes} bytes`, msg.id);
  const fromAssist = conn.side === 'assist';
  if (fromAssist ? inner.t !== 'ctl.req' : inner.t === 'ctl.req')
    return conn.error('bad_payload', fromAssist ? 'the Assist relays ctl.req only' : 'the Desk relays ctl.res and ctl.event only', msg.id);
  if (!hub.ctx.config.rateLimitDisabled && !live.controlBuckets[fromAssist ? 'assist' : 'desk'].take()) {
    live.relay.dropped += 1;
    hub.ctx.metrics.rateLimited.inc();
    return conn.error('rate_limited', 'too many control frames', msg.id, { retryAfterSec: 1 });
  }
  if (inner.t === 'ctl.req') {
    const required = minLevelFor(inner.op, inner.args);
    const granted = live.consent?.level ?? null;
    if (granted === null || !levelAtLeast(granted, required)) {
      const opId = opIdFor(live.id, inner.id);
      conn.error('consent_required', `${inner.op} needs ${required}; the Desk granted ${granted ?? 'nothing'}`, msg.id, {
        op: inner.op,
        opId,
        required,
        granted,
      });
      await recordRefusal(hub, live, inner.op, opId, required, granted);
      return;
    }
  }
  live.relay.controlFrames += 1;
  peerOf(hub, conn, live)?.sendRaw(JSON.stringify(msg));
}

/** `control.refused` (actor system), at most one entry per session per second; the rest are counted. */
async function recordRefusal(
  hub: SignalHub,
  live: Live,
  op: ControlOp,
  opId: string,
  required: string,
  granted: string | null,
): Promise<void> {
  const now = Date.now();
  if (now - live.refusedAt < 1000) {
    live.refusedSuppressed += 1;
    return;
  }
  const suppressed = live.refusedSuppressed;
  live.refusedAt = now;
  live.refusedSuppressed = 0;
  const org = await orgOf(hub, live.orgId);
  await writeAudit(hub.ctx, hub.ctx.db, org, {
    sessionId: live.id,
    actor: systemActor,
    action: 'control.refused',
    data: { op, opId, required, granted, transport: 'relay', ...(suppressed > 0 ? { suppressed } : {}) },
  });
}

/** True when any relay counter is non-zero (then `mirror.relayed` is written before `session.ended`). */
export function relayUsed(c: RelayCounters | null | undefined): c is RelayCounters {
  return !!c && (c.mirrorFrames > 0 || c.mirrorBytes > 0 || c.controlFrames > 0 || c.dropped > 0);
}
