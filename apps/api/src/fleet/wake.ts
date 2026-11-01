/**
 * Phase D wake on LAN, the waker mesh and AMT (docs/specs/phase-d-contracts.md section 8): `POST /devices/:id/wake`
 * resolves `auto` to AMT (present + provisioned + an online AMT proxy in the segment) or WoL through an elected waker
 * (rule 8.2b); the target MAC is decrypted in memory and sealed to the waker only (rule 8.2c); success is the target's
 * `device.hello` within the confirmation window, failure an honest cause (P8). SOL console and boot redirect go through
 * the AMT proxy with credentials read from the vault and sealed per command (rule 8.4c).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  sealToDevice,
  type AmtBootTarget,
  type AmtInventory,
  type DeviceClientOf,
  type WakeFailCause,
  type WakeMethod,
} from '@indiansassist/shared';
import {
  closeAmtSol,
  getAmtSol,
  getDevice,
  getOrg,
  getWakeAttempt,
  insertAmtSol,
  insertWakeAttempt,
  listDevicesInSegment,
  listOpenAmtSolsBefore,
  listOpenWakeAttempts,
  listStaleWakeAttempts,
  transitionWakeAttempt,
  type DeviceRow,
  type OrgRow,
  type WakeAttemptRow,
} from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { systemActor, userActor, writeAudit } from '../lib/audit.js';
import type { Principal } from '../plugins/auth.js';
import type { DeviceConn, DeviceHub } from '../signal/device.js';
import { decryptMac, featuresOf, isDeviceOnline } from './common.js';
import { readVaultSecret, VaultUnavailableError } from './vault.js';
import { LIMITS } from '@indiansassist/shared';

type AmtCmd = { op: 'power_on' | 'boot_redirect' | 'sol_open' | 'sol_close'; deviceId: string; proxyId: string; wakeId?: string; solId?: string };
const amtKey = (cmdId: string) => `ia:amt:${cmdId}`;
/** SOL transcripts buffered on the node that receives the proxy's bytes. */
const transcripts = new Map<string, { chunks: Buffer[]; bytes: number }>();
const TRANSCRIPT_MAX = 8 * 1024 * 1024;

function subnetOf(d: Pick<DeviceRow, 'lanSegment'>): string | null {
  const s = (d.lanSegment as { subnetHash?: unknown } | null)?.subnetHash;
  return typeof s === 'string' ? s : null;
}

/** Rule 8.2b election: online peers in the target's segment advertising `feature`, most recent heartbeat first. */
async function elect(ctx: AppContext, target: DeviceRow, feature: 'waker' | 'amt_proxy'): Promise<DeviceRow | null> {
  const subnet = subnetOf(target);
  if (!subnet) return null;
  const peers = (await listDevicesInSegment(ctx.db, target.orgId, subnet))
    .filter((p) => p.id !== target.id && featuresOf(p).includes(feature) && p.kexPublicKey)
    .sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0));
  for (const p of peers) if (await isDeviceOnline(ctx, p.id)) return p;
  return null;
}

function amtReady(d: DeviceRow): AmtInventory | null {
  const a = d.amt as AmtInventory | null;
  return a && a.present && a.provisioned && a.host ? a : null;
}

/** Rule 8.4a: "Cold power on: available" = present + provisioned + an AMT proxy online for it. */
export async function amtProxyFor(ctx: AppContext, d: DeviceRow): Promise<DeviceRow | null> {
  return amtReady(d) ? elect(ctx, d, 'amt_proxy') : null;
}

async function amtCredSealed(ctx: AppContext, target: DeviceRow, proxy: DeviceRow) {
  const cred = (await readVaultSecret(ctx, target.orgId, `amt/${target.id}`)) ?? (await readVaultSecret(ctx, target.orgId, 'amt/default'));
  if (cred === null) throw new VaultUnavailableError('no AMT credential in the vault');
  return sealToDevice(proxy.kexPublicKey!, proxy.id, 'amt-cred', cred);
}

async function sendAmt(ctx: AppContext, target: DeviceRow, proxy: DeviceRow, cmd: AmtCmd, args: { target?: AmtBootTarget }, cmdId: string = randomUUID()): Promise<string> {
  const amt = amtReady(target)!;
  const credSealed = await amtCredSealed(ctx, target, proxy);
  await ctx.presence.setKey(amtKey(cmdId), JSON.stringify(cmd), LIMITS.amtSolMaxMinutes * 60 + 300);
  const ok = await ctx.hub.devices.push(proxy.id, { t: 'amt.command', cmdId, targetDeviceId: target.id, amtHost: amt.host!, tls: amt.tls, op: cmd.op, args, credSealed });
  if (!ok) fail('amt_unavailable', 'the AMT proxy went offline');
  return cmdId;
}

async function wakeFailed(ctx: AppContext, org: OrgRow, w: WakeAttemptRow, cause: WakeFailCause, from: ('pending' | 'dispatched')[] = ['pending', 'dispatched']): Promise<void> {
  const r = await transitionWakeAttempt(ctx.db, w.id, 'failed', from, { cause });
  if (!r) return;
  ctx.metrics.wakeAttempts.inc({ method: w.method, result: cause });
  await writeAudit(ctx, ctx.db, org, { actor: systemActor, action: 'device.wake_failed', data: { deviceId: w.deviceId, wakeId: w.id, method: w.method, cause } });
  ctx.hub.toUser(w.createdBy, { t: 'device.wake_failed', wakeId: w.id, deviceId: w.deviceId, cause });
}

/** `POST /devices/:id/wake` after scope (section 8.1 W1-W2, 8.3). */
export async function requestWake(ctx: AppContext, p: Principal, target: DeviceRow, method: WakeMethod, reason: string | null): Promise<{ wakeId: string; method: WakeMethod; via: string | null }> {
  const org = p.org;
  let path: 'wol' | 'amt' = method === 'amt' ? 'amt' : 'wol';
  let proxy: DeviceRow | null = null;
  if (method !== 'wol') {
    proxy = await amtProxyFor(ctx, target);
    if (method === 'amt' && !proxy) fail('amt_unavailable', 'AMT power-on is not available for this device (no provisioned AMT or no AMT proxy online)');
    if (method === 'auto' && proxy) path = 'amt';
  }
  const w = await ctx.db.transaction(async (tx) => {
    const row = await insertWakeAttempt(tx, { orgId: org.id, deviceId: target.id, createdBy: p.user.id, method: path, reason });
    await writeAudit(ctx, tx, org, { actor: userActor(p.user), action: 'device.wake_requested', reason, data: { deviceId: target.id, wakeId: row.id, method: path, reason } });
    return row;
  });
  if (path === 'amt' && proxy) {
    try {
      await sendAmt(ctx, target, proxy, { op: 'power_on', deviceId: target.id, proxyId: proxy.id, wakeId: w.id }, {});
    } catch (err) {
      const cause: WakeFailCause = err instanceof VaultUnavailableError ? 'amt_unavailable' : 'amt_unreachable';
      await wakeFailed(ctx, org, w, cause);
      return { wakeId: w.id, method: path, via: proxy.id };
    }
    await transitionWakeAttempt(ctx.db, w.id, 'dispatched', ['pending'], { via: proxy.id });
    await writeAudit(ctx, ctx.db, org, { actor: systemActor, action: 'device.amt_poweron', data: { deviceId: target.id, wakeId: w.id, viaDeviceId: proxy.id } });
    return { wakeId: w.id, method: path, via: proxy.id };
  }
  const mac = target.macEnc ? decryptMac(ctx, target.id, target.macEnc) : null;
  const waker = org.wakerMeshEnabled && mac ? await elect(ctx, target, 'waker') : null;
  if (!waker || !mac) {
    await wakeFailed(ctx, org, w, 'no_waker');
    return { wakeId: w.id, method: 'wol', via: null };
  }
  const targetMacSealed = sealToDevice(waker.kexPublicKey!, waker.id, 'wake-mac', mac);
  if (!(await ctx.hub.devices.push(waker.id, { t: 'wake.send', wakeId: w.id, targetMacSealed }))) {
    await wakeFailed(ctx, org, w, 'no_waker');
    return { wakeId: w.id, method: 'wol', via: null };
  }
  await transitionWakeAttempt(ctx.db, w.id, 'dispatched', ['pending'], { via: waker.id });
  await writeAudit(ctx, ctx.db, org, { actor: systemActor, action: 'device.wake_dispatched', data: { deviceId: target.id, wakeId: w.id, viaDeviceId: waker.id } });
  return { wakeId: w.id, method: 'wol', via: waker.id };
}

/** W3: the target's `device.hello` inside the window confirms its open attempts. */
export async function confirmWakes(ctx: AppContext, d: DeviceRow, org: OrgRow): Promise<void> {
  const windowMs = ctx.config.fleet.wakeConfirmSec * 1000;
  for (const w of await listOpenWakeAttempts(ctx.db, d.id)) {
    const elapsedMs = Date.now() - w.createdAt.getTime();
    if (elapsedMs > windowMs) {
      await wakeFailed(ctx, org, w, 'no_confirm');
      continue;
    }
    if (w.state === 'pending') continue; // never sent anywhere (failed or in flight)
    const r = await transitionWakeAttempt(ctx.db, w.id, 'woke', ['dispatched'], { confirmedAt: new Date() });
    if (!r) continue;
    ctx.metrics.wakeAttempts.inc({ method: w.method, result: 'woke' });
    await writeAudit(ctx, ctx.db, org, { actor: systemActor, action: 'device.woke', data: { deviceId: d.id, wakeId: w.id, method: w.method, via: w.via ?? null, elapsedMs } });
    ctx.hub.toUser(w.createdBy, { t: 'device.woke', wakeId: w.id, deviceId: d.id, method: w.method, via: w.via ?? null, elapsedMs });
  }
}

/** `wake.sent { ok: false }` -> `failed { cause: 'waker_error' }`. */
export async function handleWakeSent(dh: DeviceHub, conn: DeviceConn, msg: DeviceClientOf<'wake.sent'>): Promise<void> {
  const w = await getWakeAttempt(dh.ctx.db, msg.wakeId);
  if (!w || w.via !== conn.deviceId) return conn.error('bad_state', 'unknown wake', msg.id);
  if (msg.ok) return;
  const org = await getOrg(dh.ctx.db, w.orgId);
  if (org) await wakeFailed(dh.ctx, org, w, 'waker_error');
}

async function cmdOf(ctx: AppContext, cmdId: string): Promise<AmtCmd | null> {
  const raw = await ctx.presence.getKey(amtKey(cmdId));
  try {
    return raw ? (JSON.parse(raw) as AmtCmd) : null;
  } catch {
    return null;
  }
}

export async function handleAmtResult(dh: DeviceHub, conn: DeviceConn, msg: DeviceClientOf<'amt.result'>): Promise<void> {
  const { ctx } = dh;
  const cmd = await cmdOf(ctx, msg.cmdId);
  if (!cmd || cmd.proxyId !== conn.deviceId) return conn.error('bad_state', 'unknown AMT command', msg.id);
  if (cmd.op === 'power_on' && cmd.wakeId && !msg.ok) {
    const w = await getWakeAttempt(ctx.db, cmd.wakeId);
    const org = w ? await getOrg(ctx.db, w.orgId) : null;
    if (w && org) await wakeFailed(ctx, org, w, 'amt_unreachable');
  }
  if (cmd.op === 'sol_open' && cmd.solId && !msg.ok) await finishSol(ctx, cmd.solId);
}

export async function handleAmtSolData(dh: DeviceHub, conn: DeviceConn, msg: DeviceClientOf<'amt.sol.data'>): Promise<void> {
  const { ctx } = dh;
  const cmd = await cmdOf(ctx, msg.cmdId);
  if (!cmd || cmd.proxyId !== conn.deviceId || cmd.op !== 'sol_open' || !cmd.solId) return conn.error('bad_state', 'unknown SOL session', msg.id);
  const sol = await getAmtSol(ctx.db, cmd.solId);
  if (!sol || sol.closedAt) return;
  const t = transcripts.get(sol.id) ?? { chunks: [], bytes: 0 };
  const bytes = Buffer.from(msg.data, 'base64url');
  if (t.bytes + bytes.length <= TRANSCRIPT_MAX) {
    t.chunks.push(bytes);
    t.bytes += bytes.length;
  }
  transcripts.set(sol.id, t);
  // Rule 8.4b: relayed read-only to the opener's consoles.
  ctx.hub.toUser(sol.openedBy, { t: 'amt.sol.data', solId: sol.id, seq: msg.seq, data: msg.data });
}

/** `POST /devices/:id/amt/sol` after scope, role, reason and policy checks. */
export async function openSol(ctx: AppContext, p: Principal, d: DeviceRow, reason: string): Promise<{ solId: string; via: string }> {
  const proxy = await amtProxyFor(ctx, d);
  if (!proxy) fail('amt_unavailable', 'no provisioned AMT or no AMT proxy online for this device');
  const sol = await insertAmtSol(ctx.db, { orgId: d.orgId, deviceId: d.id, openedBy: p.user.id, viaDeviceId: proxy.id, reason });
  try {
    await sendAmt(ctx, d, proxy, { op: 'sol_open', deviceId: d.id, proxyId: proxy.id, solId: sol.id }, {}, sol.id);
  } catch (err) {
    await closeAmtSol(ctx.db, sol.id);
    if (err instanceof VaultUnavailableError) fail('vault_unavailable', err.message);
    throw err;
  }
  await writeAudit(ctx, ctx.db, p.org, { actor: userActor(p.user), action: 'device.amt_sol_opened', reason, data: { deviceId: d.id, solId: sol.id, viaDeviceId: proxy.id, reason } });
  return { solId: sol.id, via: proxy.id };
}

/** Closes a SOL session: transcript to the object store, sha256 chained (`device.amt_sol_closed`, actor system). */
export async function finishSol(ctx: AppContext, solId: string): Promise<boolean> {
  const sol = await getAmtSol(ctx.db, solId);
  if (!sol || sol.closedAt) return false;
  const org = await getOrg(ctx.db, sol.orgId);
  if (!org) return false;
  const t = transcripts.get(sol.id);
  transcripts.delete(sol.id);
  let ref: string | null = null;
  let sha: string | null = null;
  if (t && t.bytes > 0) {
    const body = Buffer.concat(t.chunks);
    sha = createHash('sha256').update(body).digest('hex');
    ref = `${org.dataRegion}/${org.id}/amt-sol/${sol.id}.bin`;
    try {
      await ctx.storage.put(ref, body, { contentType: 'application/octet-stream', contentLength: body.length });
    } catch (err) {
      ctx.log.warn({ err, solId }, 'SOL transcript store failed');
      ref = null;
    }
  }
  const closed = await closeAmtSol(ctx.db, sol.id, { transcriptRef: ref, transcriptSha256: sha });
  if (!closed) return false;
  const proxy = await getDevice(ctx.db, sol.viaDeviceId);
  if (proxy) await ctx.hub.devices.push(proxy.id, { t: 'amt.command', ...(await solCloseFrame(ctx, sol.deviceId, proxy)) }).catch(() => false);
  await writeAudit(ctx, ctx.db, org, {
    actor: systemActor,
    action: 'device.amt_sol_closed',
    data: { deviceId: sol.deviceId, solId: sol.id, durationMs: Math.max(0, closed.closedAt!.getTime() - sol.openedAt.getTime()), transcriptSha256: sha },
  });
  return true;
}

async function solCloseFrame(ctx: AppContext, targetId: string, proxy: DeviceRow): Promise<Record<string, unknown>> {
  const target = await getDevice(ctx.db, targetId);
  const amt = target ? amtReady(target) : null;
  if (!target || !amt) return {};
  try {
    return { cmdId: randomUUID(), targetDeviceId: target.id, amtHost: amt.host, tls: amt.tls, op: 'sol_close', args: {}, credSealed: await amtCredSealed(ctx, target, proxy) };
  } catch {
    return {};
  }
}

/** `POST /devices/:id/amt/boot`. */
export async function bootRedirect(ctx: AppContext, p: Principal, d: DeviceRow, target: AmtBootTarget, reason: string): Promise<{ cmdId: string; via: string }> {
  const proxy = await amtProxyFor(ctx, d);
  if (!proxy) fail('amt_unavailable', 'no provisioned AMT or no AMT proxy online for this device');
  let cmdId: string;
  try {
    cmdId = await sendAmt(ctx, d, proxy, { op: 'boot_redirect', deviceId: d.id, proxyId: proxy.id }, { target });
  } catch (err) {
    if (err instanceof VaultUnavailableError) fail('vault_unavailable', err.message);
    throw err;
  }
  await writeAudit(ctx, ctx.db, p.org, { actor: userActor(p.user), action: 'device.amt_boot_redirected', reason, data: { deviceId: d.id, cmdId, target, viaDeviceId: proxy.id, reason } });
  return { cmdId, via: proxy.id };
}

/** Sweeper: unconfirmed wakes -> `no_confirm`; SOL sessions past `amtSolMaxMinutes` close. */
export async function sweepWakes(ctx: AppContext, now: Date = new Date()): Promise<void> {
  for (const w of await listStaleWakeAttempts(ctx.db, new Date(now.getTime() - ctx.config.fleet.wakeConfirmSec * 1000))) {
    const org = await getOrg(ctx.db, w.orgId);
    if (org) await wakeFailed(ctx, org, w, 'no_confirm');
  }
  for (const s of await listOpenAmtSolsBefore(ctx.db, new Date(now.getTime() - LIMITS.amtSolMaxMinutes * 60_000))) await finishSol(ctx, s.id);
}
