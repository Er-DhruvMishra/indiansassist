/**
 * Phase D device actions and the offline action queue (docs/specs/phase-d-contracts.md section 9): queue at `POST`
 * (rule 9.9 `deny` check), dispatch at once to an online device or at its next check-in (`device.hello.ok.queued`),
 * the dispatch-time policy gate (hold outside `allowedHours`, privileged needs `allowPrivileged`), vault secrets
 * sealed at dispatch only (rule 9.8), the signed `device.action_result` transitions with their chain entries, and the
 * expiry sweep. Every finished action produces a receipt (section 6.4).
 */
import {
  decideDeviceAction,
  deviceSigInput,
  isPrivilegedAction,
  sealToDevice,
  validatePlaybookArgs,
  verifyDeviceSignature,
  type DeviceAction,
  type DeviceActionRequest,
  type DeviceClientOf,
  type PlaybookParam,
  type UnattendedPolicy,
} from '@indiansassist/shared';
import {
  expireDeviceActions,
  getDevice,
  getDeviceAction,
  getOrg,
  getPlaybookScoped,
  insertDeviceAction,
  listQueuedActions,
  transitionDeviceAction,
  type DeviceActionRow,
  type DeviceRow,
  type OrgRow,
  type PlaybookRow,
} from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { systemActor, userActor, writeAudit } from '../lib/audit.js';
import { refOf, userRefs } from '../lib/lookup.js';
import { iso, isoOrNull } from '../lib/time.js';
import type { Principal } from '../plugins/auth.js';
import type { DeviceConn, DeviceHub } from '../signal/device.js';
import { deviceActor, effectivePolicyFor, interactiveOf, isDeviceOnline } from './common.js';
import { onDeviceActionFinished } from './receipts.js';
import { readVaultSecret, VaultUnavailableError } from './vault.js';

export function toDeviceAction(a: DeviceActionRow, createdBy: { id: string; name: string }): DeviceAction {
  return {
    id: a.id,
    deviceId: a.deviceId,
    kind: a.kind,
    payload: a.payload,
    state: a.state,
    reason: a.reason ?? null,
    approvedBy: (a.approvedBy as DeviceAction['approvedBy']) ?? null,
    result: (a.result as DeviceAction['result']) ?? null,
    createdBy,
    createdAt: iso(a.createdAt),
    dispatchedAt: isoOrNull(a.dispatchedAt),
    completedAt: isoOrNull(a.completedAt),
    expiresAt: iso(a.expiresAt),
  };
}

async function playbookOf(ctx: AppContext, a: Pick<DeviceActionRow, 'kind' | 'payload' | 'orgId'>): Promise<PlaybookRow | null> {
  if (a.kind !== 'playbook_run') return null;
  return getPlaybookScoped(ctx.db, String(a.payload['playbookId']), a.orgId);
}

function vaultRefsOf(pb: PlaybookRow | null): { env: string; path: string }[] {
  return pb?.vaultRefs ?? [];
}

// ---------- queue (POST) ----------

/**
 * `POST /devices/:id/actions` after scope: validates the playbook against the catalogue (rule 9.3), the reason rules,
 * the rule 9.9 `deny` check, inserts, chains `device.action_queued` and dispatches at once when the device is online.
 */
export async function queueDeviceAction(ctx: AppContext, p: Principal, d: DeviceRow, body: DeviceActionRequest): Promise<{ actionId: string; state: 'queued' | 'dispatched' }> {
  let payload: Record<string, unknown> = { ...body.payload };
  let vaultRefs = 0;
  if (body.kind === 'playbook_run') {
    const pb = await getPlaybookScoped(ctx.db, body.payload.playbookId, d.orgId);
    if (!pb) fail('not_found', 'playbook not found');
    if (!pb.enabled) fail('playbook_disabled', 'this playbook is disabled');
    if (pb.requiresElevation !== body.payload.requiresElevation) fail('validation_failed', 'requiresElevation must match the playbook');
    vaultRefs = vaultRefsOf(pb).length;
    if ((pb.requiresElevation || vaultRefs > 0) && body.reason === undefined) fail('validation_failed', 'reason: a privileged playbook run needs a reason');
    const args = validatePlaybookArgs((Array.isArray(pb.parameters) ? pb.parameters : []) as PlaybookParam[], body.payload.args, pb.interpreter);
    if (!args.ok) fail('validation_failed', `${args.param ?? 'args'}: ${args.error}`, { param: args.param ?? null });
    payload = { playbookId: pb.id, name: pb.name, args: args.args, requiresElevation: pb.requiresElevation, bodyHash: pb.bodySha256 };
  }
  const policy = await effectivePolicyFor(ctx, d, p.org);
  const gate = decideDeviceAction({ stage: 'queue', kind: body.kind, privileged: isPrivilegedAction(body, { vaultRefs }), policy, interactive: interactiveOf(d) });
  if (gate.outcome === 'refuse') fail('unattended_denied', 'the policy of this device denies unattended actions');
  const row = await ctx.db.transaction(async (tx) => {
    const r = await insertDeviceAction(tx, { orgId: d.orgId, deviceId: d.id, createdBy: p.user.id, kind: body.kind, payload, reason: body.reason ?? null });
    await writeAudit(ctx, tx, p.org, {
      actor: userActor(p.user),
      action: 'device.action_queued',
      reason: body.reason ?? null,
      data: { actionId: r.id, deviceId: d.id, kind: r.kind, reason: body.reason ?? null },
    });
    return r;
  });
  let state: 'queued' | 'dispatched' = 'queued';
  if (await isDeviceOnline(ctx, d.id)) {
    const after = await dispatchDeviceAction(ctx, row.id);
    if (after?.state === 'dispatched') state = 'dispatched';
  }
  return { actionId: row.id, state };
}

// ---------- dispatch ----------

type Prepared = { row: DeviceActionRow; frame: Record<string, unknown>; wire: DeviceAction };

async function failAction(ctx: AppContext, a: DeviceActionRow, error: string): Promise<DeviceActionRow | null> {
  const r = await transitionDeviceAction(ctx.db, a.id, 'failed', ['queued', 'dispatched', 'awaiting_approval'], { result: { error }, completedAt: new Date() });
  if (r) await onDeviceActionFinished(ctx, r).catch((err: unknown) => ctx.log.warn({ err }, 'action receipt failed'));
  return r;
}

/**
 * The dispatch-time gate and the frame for one queued action; null when it stays queued (hold) or failed. `deliver`
 * transitions it to `dispatched` and chains `device.action_dispatched` (and `secret.injected`).
 */
async function prepare(ctx: AppContext, a: DeviceActionRow, d: DeviceRow, org: OrgRow, policy: UnattendedPolicy): Promise<Prepared | 'held' | 'failed'> {
  const pb = await playbookOf(ctx, a);
  const refs = vaultRefsOf(pb);
  const gate = decideDeviceAction({ stage: 'dispatch', kind: a.kind, privileged: isPrivilegedAction(a, { vaultRefs: refs.length }), policy, interactive: interactiveOf(d) });
  if (gate.outcome === 'hold') return 'held';
  if (gate.outcome === 'fail' || gate.outcome === 'refuse') {
    await failAction(ctx, a, 'policy');
    return 'failed';
  }
  let payload: Record<string, unknown> = a.payload;
  if (a.kind === 'playbook_run') {
    if (!pb || !pb.enabled || pb.bodySha256 !== a.payload['bodyHash']) {
      await failAction(ctx, a, 'playbook_changed');
      return 'failed';
    }
    payload = { ...a.payload, body: pb.body, interpreter: pb.interpreter, timeoutSec: pb.timeoutSec };
  }
  let secrets: { env: string; sealed: ReturnType<typeof sealToDevice> }[] | undefined;
  if (refs.length > 0) {
    if (!d.kexPublicKey) {
      await failAction(ctx, a, 'vault_unavailable');
      return 'failed';
    }
    try {
      secrets = [];
      for (const r of refs) {
        const value = await readVaultSecret(ctx, d.orgId, r.path);
        if (value === null) throw new VaultUnavailableError(`no secret at ${r.path}`);
        secrets.push({ env: r.env, sealed: sealToDevice(d.kexPublicKey, d.id, 'vault-secret', value) });
      }
    } catch (err) {
      if (!(err instanceof VaultUnavailableError)) throw err;
      await failAction(ctx, a, 'vault_unavailable');
      return 'failed';
    }
    await writeAudit(ctx, ctx.db, org, {
      actor: systemActor,
      action: 'secret.injected',
      reason: a.reason ?? null,
      data: { actionId: a.id, deviceId: d.id, refs: refs.map((r) => ({ env: r.env, path: r.path })), reason: a.reason ?? null },
    });
  }
  const tech = refOf(await userRefs(ctx.db, [a.createdBy]), a.createdBy);
  const frame = {
    t: 'device.action',
    actionId: a.id,
    kind: a.kind,
    payload,
    reason: a.reason ?? null,
    technician: { name: tech.name },
    ...(secrets ? { secrets } : {}),
  };
  return { row: a, frame, wire: { ...toDeviceAction(a, tech), payload, state: 'dispatched' } };
}

async function markDispatched(ctx: AppContext, a: DeviceActionRow, org: OrgRow): Promise<DeviceActionRow | null> {
  const r = await transitionDeviceAction(ctx.db, a.id, 'dispatched', ['queued'], { dispatchedAt: new Date() });
  if (r) await writeAudit(ctx, ctx.db, org, { actor: systemActor, action: 'device.action_dispatched', data: { actionId: a.id, deviceId: a.deviceId, kind: a.kind } });
  return r;
}

/** Dispatches one queued action to its (online) device; returns the row after the attempt. */
export async function dispatchDeviceAction(ctx: AppContext, actionId: string): Promise<DeviceActionRow | null> {
  const a = await getDeviceAction(ctx.db, actionId);
  if (!a || a.state !== 'queued') return a;
  const d = await getDevice(ctx.db, a.deviceId);
  const org = d ? await getOrg(ctx.db, d.orgId) : null;
  if (!d || !org || d.status !== 'enrolled') return a;
  const policy = await effectivePolicyFor(ctx, d, org);
  const prep = await prepare(ctx, a, d, org, policy);
  if (prep === 'held' || prep === 'failed') return getDeviceAction(ctx.db, a.id);
  const r = await markDispatched(ctx, a, org);
  if (!r) return getDeviceAction(ctx.db, a.id);
  if (!(await ctx.hub.devices.push(d.id, prep.frame))) {
    // The device went offline between the check and the push: back to the queue for its next check-in.
    return (await transitionDeviceAction(ctx.db, a.id, 'queued', ['dispatched'], { dispatchedAt: null })) ?? r;
  }
  return r;
}

/**
 * Section 3.4: the actions delivered in `device.hello.ok.queued` (marked dispatched); vault-backed ones are returned
 * separately and pushed as `device.action` with their secrets right after the hello reply.
 */
export async function helloQueue(ctx: AppContext, d: DeviceRow, org: OrgRow, policy: UnattendedPolicy): Promise<{ wire: DeviceAction[]; vault: string[] }> {
  const wire: DeviceAction[] = [];
  const vault: string[] = [];
  for (const a of await listQueuedActions(ctx.db, d.id)) {
    const pb = await playbookOf(ctx, a);
    if (vaultRefsOf(pb).length > 0) {
      vault.push(a.id);
      continue;
    }
    const prep = await prepare(ctx, a, d, org, policy);
    if (prep === 'held' || prep === 'failed') continue;
    if (await markDispatched(ctx, a, org)) wire.push(prep.wire);
  }
  return { wire, vault };
}

export async function pushVaultQueue(ctx: AppContext, _d: DeviceRow, _org: OrgRow, ids: readonly string[]): Promise<void> {
  for (const id of ids) await dispatchDeviceAction(ctx, id);
}

/** Sweeper: re-dispatches the queue of devices online on this node (held actions whose window opened). */
export async function redispatchQueues(ctx: AppContext): Promise<void> {
  for (const deviceId of ctx.hub.devices.byDevice.keys()) {
    for (const a of await listQueuedActions(ctx.db, deviceId)) await dispatchDeviceAction(ctx, a.id);
  }
}

/** Sweeper: non-final actions past `expires_at` go `expired` (each gets its receipt). */
export async function expireActions(ctx: AppContext): Promise<void> {
  for (const a of await expireDeviceActions(ctx.db)) await onDeviceActionFinished(ctx, a).catch((err: unknown) => ctx.log.warn({ err }, 'action receipt failed'));
}

/** `POST /devices/:id/actions/:actionId/cancel`. */
export async function cancelDeviceAction(ctx: AppContext, p: Principal, a: DeviceActionRow): Promise<DeviceActionRow> {
  const r = await ctx.db.transaction(async (tx) => {
    const x = await transitionDeviceAction(tx, a.id, 'cancelled', ['queued', 'dispatched', 'awaiting_approval'], { completedAt: new Date() });
    if (!x) return null;
    await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'device.action_cancelled', data: { actionId: a.id, deviceId: a.deviceId, kind: a.kind } });
    return x;
  });
  if (!r) fail('bad_state', `the action is ${a.state}`);
  await onDeviceActionFinished(ctx, r).catch((err: unknown) => ctx.log.warn({ err }, 'action receipt failed'));
  return r;
}

// ---------- results (rule 9.7) ----------

export async function handleActionResult(dh: DeviceHub, conn: DeviceConn, msg: DeviceClientOf<'device.action_result'>): Promise<void> {
  const { ctx } = dh;
  const d = await getDevice(ctx.db, conn.deviceId!);
  if (!d?.publicKey) return conn.error('bad_state', 'device not found', msg.id);
  const input = deviceSigInput.action({ deviceId: d.id, actionId: msg.actionId, state: msg.state, approvedBy: msg.approvedBy, result: msg.result });
  if (!verifyDeviceSignature(input, msg.sig, d.publicKey)) return conn.error('device_bad_signature', 'the action result signature did not verify', msg.id);
  const a = await getDeviceAction(ctx.db, msg.actionId);
  if (!a || a.deviceId !== d.id) return conn.error('bad_state', 'unknown action', msg.id);
  const org = await getOrg(ctx.db, d.orgId);
  if (!org) return;
  const actor = deviceActor(d.id);
  if (msg.state === 'awaiting_approval') {
    await transitionDeviceAction(ctx.db, a.id, 'awaiting_approval', ['dispatched']);
    return;
  }
  if (msg.state === 'running') {
    const approvedBy = msg.approvedBy ?? 'policy';
    await ctx.db.transaction(async (tx) => {
      const r = await transitionDeviceAction(tx, a.id, 'running', ['dispatched', 'awaiting_approval'], { approvedBy });
      if (r) await writeAudit(ctx, tx, org, { actor, action: 'device.action_started', data: { actionId: a.id, deviceId: d.id, kind: a.kind, approvedBy } });
    });
    return;
  }
  const done = await ctx.db.transaction(async (tx) => {
    const r = await transitionDeviceAction(tx, a.id, msg.state, ['dispatched', 'awaiting_approval', 'running'], {
      result: (msg.result ?? {}) as Record<string, unknown>,
      completedAt: new Date(),
      ...(msg.approvedBy && !a.approvedBy ? { approvedBy: msg.approvedBy } : {}),
    });
    if (!r) return null;
    await writeAudit(ctx, tx, org, {
      actor,
      action: 'device.action_completed',
      data: {
        actionId: a.id,
        deviceId: d.id,
        kind: a.kind,
        state: msg.state as 'done' | 'failed',
        ...(msg.result?.exit !== undefined ? { exit: msg.result.exit } : {}),
        ...(msg.result?.ranAs !== undefined ? { ranAs: msg.result.ranAs } : {}),
      },
    });
    return r;
  });
  if (done) await onDeviceActionFinished(ctx, done).catch((err: unknown) => ctx.log.warn({ err }, 'action receipt failed'));
}
