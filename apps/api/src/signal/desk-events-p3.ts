/**
 * The native Desk's attestations in a P3 session (docs/specs/phase-c-contracts.md section 3.8): `control.input` with
 * `mode: 'os'`, `input.text_burst`, `clipboard.sync`, `elevation.denied` (with the technician's reason),
 * `elevation.failed`, `playbook.run` (paired with the server's `playbook.run_requested` by `opId`), `sec.failed`,
 * `a11y.state` and the P3-family `consent.level_refused`. Content never enters the chain.
 */
import {
  DESK_EVENT_P3_DATA,
  deskEventDataSchema,
  isAgentConsentLevel,
  opIdFor,
  type SignalOf,
} from '@indiansassist/shared';
import { completePlaybookRun, type SessionRow } from '@indiansassist/db';
import { deskActor, writeAudit } from '../lib/audit.js';
import type { Conn } from './conn.js';
import type { SignalHub } from './hub.js';
import { orgOf } from './messages.js';

const re = (id: string | undefined) => (id !== undefined ? { re: id } : {});
const REASON_ACTIONS = new Set(['elevation.denied', 'consent.level_refused']);

export async function p3Event(hub: SignalHub, conn: Conn, s: SessionRow, msg: SignalOf<'desk.event'>): Promise<void> {
  const { ctx } = hub;
  const action = msg.action;
  if (s.state !== 'active' && s.state !== 'ended') return conn.error('bad_state', `session is ${s.state}`, msg.id);
  let data: Record<string, unknown>;
  if (action === 'consent.level_refused') {
    const r = deskEventDataSchema('consent.level_refused').safeParse(msg.data);
    if (!r.success || !isAgentConsentLevel(r.data.from) || !isAgentConsentLevel(r.data.requested))
      return conn.error('bad_payload', 'consent.level_refused carries P3 levels in a P3 session', msg.id);
    data = r.data;
  } else {
    const schema = (DESK_EVENT_P3_DATA as Record<string, { safeParse: (v: unknown) => { success: boolean; data?: unknown } }>)[action];
    const r = schema?.safeParse(msg.data);
    if (!schema || !r?.success) return conn.error('bad_payload', `invalid ${action} data for a P3 session`, msg.id);
    data = r.data as Record<string, unknown>;
  }
  if (action === 'playbook.run' && data['opId'] !== opIdFor(s.id, String(data['runId'])))
    return conn.error('bad_payload', 'playbook.run opId must be opIdFor(sessionId, runId)', msg.id);
  const org = await orgOf(hub, s.orgId);
  const entry = await ctx.db.transaction(async (tx) => {
    if (action === 'playbook.run') {
      await completePlaybookRun(tx, s.id, String(data['runId']), {
        exitCode: (data['exit'] as number | null) ?? null,
        durationMs: Number(data['durationMs']),
        ranAs: String(data['ranAs']),
        error: (data['error'] as string | undefined) ?? null,
      });
    }
    return writeAudit(ctx, tx, org, {
      sessionId: s.id,
      actor: deskActor(s.deskRef),
      action: action as 'playbook.run',
      reason: REASON_ACTIONS.has(action) ? (msg.reason ?? null) : null,
      data: data as never,
    });
  });
  conn.send({ t: 'event.ok', ...re(msg.id), sessionId: s.id, entryId: entry.id });
}
