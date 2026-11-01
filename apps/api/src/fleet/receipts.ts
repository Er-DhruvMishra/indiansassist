/**
 * Phase D consent receipts (docs/specs/phase-d-contracts.md section 6.4): built by the server from the chain at session
 * end (`DeviceReceipt`) and for each finished device action (`DeviceActionReceipt`); delivered to the device
 * (`device.receipt`, held in the presence store and re-sent at the next check-in when it is offline) and mailed to
 * `device.notify_email ?? device_group.notify_email` for unattended sessions and every action (actions batched per
 * device per `receiptDigestMinutes`). Every delivery chains `consent.receipt_sent` (actor system).
 */
import {
  LIMITS,
  type ApprovedBy,
  type DeviceActionReceipt,
  type DeviceReceipt,
  type JsonObject,
  type UnattendedPolicy,
} from '@indiansassist/shared';
import {
  getDevice,
  getDeviceGroupScoped,
  getOrg,
  getRecordingBySession,
  listAuditBySession,
  type DeviceActionRow,
  type DeviceRow,
  type OrgRow,
  type SessionRow,
} from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { piiHash, systemActor, writeAudit } from '../lib/audit.js';
import { refOf, userRefs } from '../lib/lookup.js';
import { brandingPublic } from '../lib/mappers.js';
import { iso, isoOrNull } from '../lib/time.js';
import type { EndedSession } from '../services/session-end.js';

const pendingKey = (deviceId: string) => `ia:rcpt:${deviceId}`;
const PENDING_TTL_SEC = 90 * 86_400;
const PENDING_MAX = 500;

type Pending = { receipt: DeviceReceipt | DeviceActionReceipt; sessionId: string | null; actionIds: string[] };

/** The address receipts go to (rule 6.4c), or null. */
async function notifyAddress(ctx: AppContext, d: DeviceRow): Promise<string | null> {
  if (d.notifyEmail) return d.notifyEmail;
  const g = d.groupId ? await getDeviceGroupScoped(ctx.db, d.groupId, d.orgId) : null;
  return g?.notifyEmail ?? null;
}

async function chainSent(
  ctx: AppContext,
  org: OrgRow,
  data: { sessionId: string | null; actionIds: string[]; channel: 'email' | 'device'; to: string | null; delivered: boolean; cause?: 'no_address' | 'no_mailer' | 'send_failed' },
): Promise<void> {
  await writeAudit(ctx, ctx.db, org, {
    sessionId: data.sessionId,
    actor: systemActor,
    action: 'consent.receipt_sent',
    data: {
      sessionId: data.sessionId,
      actionIds: data.actionIds,
      channel: data.channel,
      toHash: data.to ? piiHash(org, data.to.trim().toLowerCase()) : null,
      delivered: data.delivered,
      ...(data.cause ? { cause: data.cause } : {}),
    },
  });
}

/** Rule 6.4b: push to the device, or hold for the next check-in. */
async function toDevice(ctx: AppContext, org: OrgRow, deviceId: string, p: Pending): Promise<void> {
  const delivered = await ctx.hub.devices.push(deviceId, { t: 'device.receipt', receipt: p.receipt });
  if (!delivered) {
    const raw = await ctx.presence.getKey(pendingKey(deviceId));
    let list: Pending[];
    try {
      list = raw ? (JSON.parse(raw) as Pending[]) : [];
    } catch {
      list = [];
    }
    list.push(p);
    await ctx.presence.setKey(pendingKey(deviceId), JSON.stringify(list.slice(-PENDING_MAX)), PENDING_TTL_SEC);
  }
  await chainSent(ctx, org, { sessionId: p.sessionId, actionIds: p.actionIds, channel: 'device', to: null, delivered });
}

/** Re-sends receipts held while the device was offline (after `device.hello.ok`). */
export async function deliverPendingReceipts(ctx: AppContext, deviceId: string): Promise<void> {
  const raw = await ctx.presence.consume(pendingKey(deviceId));
  if (!raw) return;
  let list: Pending[];
  try {
    list = JSON.parse(raw) as Pending[];
  } catch {
    return;
  }
  const d = await getDevice(ctx.db, deviceId);
  const org = d ? await getOrg(ctx.db, d.orgId) : null;
  if (!org) return;
  for (const p of list) await toDevice(ctx, org, deviceId, p);
}

async function mail(ctx: AppContext, org: OrgRow, d: DeviceRow, subject: string, text: string, json: unknown, ref: { sessionId: string | null; actionIds: string[] }): Promise<void> {
  const to = await notifyAddress(ctx, d);
  if (!to) return chainSent(ctx, org, { ...ref, channel: 'email', to: null, delivered: false, cause: 'no_address' });
  if (ctx.mailer.driver === 'log') {
    await ctx.mailer.send({ to, subject, text, attachments: [{ name: 'receipt.json', json }] });
    return chainSent(ctx, org, { ...ref, channel: 'email', to, delivered: false, cause: 'no_mailer' });
  }
  try {
    await ctx.mailer.send({ to, subject, text, attachments: [{ name: 'receipt.json', json }] });
    await chainSent(ctx, org, { ...ref, channel: 'email', to, delivered: true });
  } catch (err) {
    ctx.log.warn({ err, deviceId: d.id }, 'receipt mail failed');
    await chainSent(ctx, org, { ...ref, channel: 'email', to, delivered: false, cause: 'send_failed' });
  }
}

/** Rule 6.4a: the session receipt, from the chain. */
export async function buildDeviceReceipt(ctx: AppContext, s: SessionRow, d: DeviceRow, org: OrgRow): Promise<DeviceReceipt> {
  const entries = await listAuditBySession(ctx.db, s.id);
  const data = (a: string) => entries.filter((e) => e.action === a).map((e) => ({ d: e.data as JsonObject, at: iso(e.ts) }));
  const accepted = data('session.accepted')[0]?.d;
  const started = data('session.unattended_started')[0]?.d;
  const granted = data('session.consent_granted')[0]?.d;
  const toggles = (a: string, key: string) =>
    data(a).map((x) => ({ on: x.d[key] === true, at: x.at, cause: (x.d['cause'] as DeviceReceipt['inputLock'][number]['cause']) ?? null }));
  const assist = refOf(await userRefs(ctx.db, [s.assistUserId]), s.assistUserId);
  const server = await getRecordingBySession(ctx.db, s.id, 'server');
  const console_ = server ? null : await getRecordingBySession(ctx.db, s.id, 'assist');
  return {
    sessionId: s.id,
    deviceId: d.id,
    deviceName: d.name,
    org: { displayName: brandingPublic(org).displayName },
    technician: { name: assist.name },
    reason: (accepted?.['reason'] as string | null | undefined) ?? null,
    unattended: s.unattended === true,
    approvedBy: (started?.['approvedBy'] as ApprovedBy | undefined) ?? null,
    policySnapshot: (started?.['policySnapshot'] as UnattendedPolicy | undefined) ?? ((s.unattendedPolicy as UnattendedPolicy | null) ?? null),
    startedAt: isoOrNull(s.startedAt),
    endedAt: iso(s.endedAt ?? new Date()),
    endReason: s.endReason ?? 'error',
    durationMs: s.startedAt && s.endedAt ? Math.max(0, s.endedAt.getTime() - s.startedAt.getTime()) : null,
    monitorsShared: typeof granted?.['monitors'] === 'number' ? (granted['monitors'] as number) : null,
    levelChanges: data('consent.level_changed')
      .filter((x) => x.d['to'] === 'view' || x.d['to'] === 'control' || x.d['to'] === 'elevated')
      .map((x) => ({ from: String(x.d['from']), to: x.d['to'] as 'view' | 'control' | 'elevated', at: x.at })),
    clipboard: typeof granted?.['clipboard'] === 'boolean' ? (granted['clipboard'] as boolean) : null,
    elevation: { granted: data('elevation.granted').length > 0 },
    playbooks: data('playbook.run').map((x) => ({
      playbookId: String(x.d['playbookId']),
      runId: String(x.d['runId']),
      exit: typeof x.d['exit'] === 'number' ? (x.d['exit'] as number) : null,
      ranAs: String(x.d['ranAs']),
    })),
    sas: data('sec.verified').map((x) => ({
      gen: Number(x.d['gen'] ?? 0),
      method: x.d['skipped'] === true ? ('skipped' as const) : x.d['method'] === 'device_key' ? ('device_key' as const) : ('read_out' as const),
    })),
    secureDesktop: data('capture.secure_desktop').map((x) => ({ surface: x.d['surface'] as 'logon' | 'uac' | 'lock', durationMs: Number(x.d['durationMs'] ?? 0) })),
    inputLock: toggles('input.lock_changed', 'locked'),
    privacyScreen: toggles('privacy.screen_changed', 'on'),
    localUserArrived: data('session.local_user_arrived').map((x) => ({ decision: x.d['decision'] as 'continue' | 'ended', at: x.at })),
    recording: { mode: s.recordingMode ?? 'assist_only', recordingId: server?.id ?? console_?.id ?? null },
    hashChainTail: s.hashChainTail ?? null,
  };
}

/** After a P4 session ended (endSessionFlow): the device copy always, the mail for unattended sessions. */
export async function onDeviceSessionEnded(ctx: AppContext, ended: EndedSession): Promise<void> {
  const s = ended.session;
  if (!s.deviceId) return;
  const d = await getDevice(ctx.db, s.deviceId);
  if (!d) return;
  const receipt = await buildDeviceReceipt(ctx, s, d, ended.org);
  await toDevice(ctx, ended.org, d.id, { receipt, sessionId: s.id, actionIds: [] });
  if (receipt.unattended && (receipt.approvedBy === 'policy' || receipt.approvedBy === 'auto_after_timeout')) {
    await mail(
      ctx,
      ended.org,
      d,
      `Remote session on ${d.name}`,
      `${receipt.technician.name} (${receipt.org.displayName}) ran an unattended remote session on ${d.name}.\nReason: ${receipt.reason ?? '-'}\nStarted: ${receipt.startedAt ?? '-'}\nEnded: ${receipt.endedAt} (${receipt.endReason})`,
      receipt,
      { sessionId: s.id, actionIds: [] },
    );
  }
}

// ---------- action receipts (digest per device) ----------

type Digest = { receipts: DeviceActionReceipt[]; timer: NodeJS.Timeout };
const digests = new Map<string, Digest>();

function actionName(a: DeviceActionRow): string {
  const p = a.payload as Record<string, unknown>;
  if (a.kind === 'message') return String(p['title'] ?? 'message');
  if (a.kind === 'playbook_run') return String(p['name'] ?? p['playbookId'] ?? 'playbook');
  return String(p['name'] ?? a.kind);
}

/** A finished action: its receipt to the device now, into the mail digest of the device. */
export async function onDeviceActionFinished(ctx: AppContext, a: DeviceActionRow): Promise<void> {
  const d = await getDevice(ctx.db, a.deviceId);
  const org = d ? await getOrg(ctx.db, d.orgId) : null;
  if (!d || !org) return;
  const tech = refOf(await userRefs(ctx.db, [a.createdBy]), a.createdBy);
  const receipt: DeviceActionReceipt = {
    actionId: a.id,
    deviceId: a.deviceId,
    kind: a.kind,
    name: actionName(a),
    technician: { name: tech.name },
    reason: a.reason ?? null,
    approvedBy: (a.approvedBy as ApprovedBy | null) ?? null,
    state: a.state,
    startedAt: isoOrNull(a.dispatchedAt),
    completedAt: isoOrNull(a.completedAt),
  };
  await toDevice(ctx, org, d.id, { receipt, sessionId: null, actionIds: [a.id] });
  let dg = digests.get(d.id);
  if (!dg) {
    const timer = setTimeout(() => {
      const cur = digests.get(d.id);
      digests.delete(d.id);
      if (cur) void flushDigest(ctx, d.id, cur.receipts).catch((err: unknown) => ctx.log.warn({ err }, 'receipt digest failed'));
    }, LIMITS.receiptDigestMinutes * 60_000);
    timer.unref?.();
    dg = { receipts: [], timer };
    digests.set(d.id, dg);
  }
  dg.receipts.push(receipt);
}

async function flushDigest(ctx: AppContext, deviceId: string, receipts: DeviceActionReceipt[]): Promise<void> {
  const d = await getDevice(ctx.db, deviceId);
  const org = d ? await getOrg(ctx.db, d.orgId) : null;
  if (!d || !org || receipts.length === 0) return;
  const lines = receipts.map((r) => `- ${r.completedAt ?? '-'} ${r.technician.name}: ${r.kind} "${r.name}" -> ${r.state}`);
  await mail(ctx, org, d, `Remote actions on ${d.name}`, `Device actions on ${d.name}:\n${lines.join('\n')}`, receipts, {
    sessionId: null,
    actionIds: receipts.map((r) => r.actionId),
  });
}

/** Tests / shutdown: flushes every pending digest now. */
export async function flushAllDigests(ctx: AppContext): Promise<void> {
  for (const [id, dg] of [...digests]) {
    clearTimeout(dg.timer);
    digests.delete(id);
    await flushDigest(ctx, id, dg.receipts);
  }
}
