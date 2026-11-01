/**
 * Phase D self-heal / tamper alerts (docs/specs/phase-d-contracts.md section 10): device-signed `device.tamper` events
 * are verified (all or nothing), chained `tamper.alert` (actor device) once per event id, acknowledged with
 * `device.tamper.ok { ids }` and flag the device `alerted`; a device silent past `tamperSilentGraceSec` with no
 * disable / retire / deregister on record goes `suspected` (`tamper.suspected`, actor system).
 */
import { deviceSigInput, LIMITS, verifyDeviceSignature, type DeviceClientOf } from '@indiansassist/shared';
import { auditEntry, device as deviceTable, getDevice, getOrg, updateDevice } from '@indiansassist/db';
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { systemActor, writeAudit } from '../lib/audit.js';
import type { DeviceConn, DeviceHub } from '../signal/device.js';
import { deviceActor, isDeviceOnline } from './common.js';

const re = (id: string | undefined) => (id !== undefined ? { re: id } : {});

async function alreadyChained(ctx: AppContext, orgId: string, eventId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: auditEntry.id })
    .from(auditEntry)
    .where(and(eq(auditEntry.orgId, orgId), eq(auditEntry.action, 'tamper.alert'), sql`${auditEntry.data}->>'eventId' = ${eventId}`))
    .limit(1);
  return row !== undefined;
}

export async function handleTamper(dh: DeviceHub, conn: DeviceConn, msg: DeviceClientOf<'device.tamper'>): Promise<void> {
  const { ctx } = dh;
  const d = await getDevice(ctx.db, conn.deviceId!);
  if (!d?.publicKey) return conn.error('bad_state', 'device not found', msg.id);
  for (const ev of msg.events) {
    let ok: boolean;
    try {
      ok = verifyDeviceSignature(deviceSigInput.tamper({ deviceId: d.id, event: ev }), ev.sig, d.publicKey);
    } catch {
      ok = false;
    }
    if (!ok) return conn.error('device_bad_signature', 'a tamper event signature did not verify', msg.id, { eventId: ev.id });
  }
  const org = await getOrg(ctx.db, d.orgId);
  if (!org) return;
  const ids: string[] = [];
  for (const ev of msg.events) {
    if (!(await alreadyChained(ctx, d.orgId, ev.id))) {
      await ctx.db.transaction(async (tx) => {
        await writeAudit(ctx, tx, org, {
          actor: deviceActor(d.id),
          action: 'tamper.alert',
          data: { deviceId: d.id, eventId: ev.id, cause: ev.cause, at: ev.at, detail: ev.detail ?? null },
        });
        await updateDevice(tx, d.id, { tamperState: 'alerted' });
      });
    }
    ids.push(ev.id);
  }
  conn.send({ t: 'device.tamper.ok', ...re(msg.id), ids });
}

/** Sweeper (rule 10.2): enrolled devices silent past the grace become `suspected`. */
export async function sweepSilentDevices(ctx: AppContext, now: Date = new Date()): Promise<void> {
  const before = new Date(now.getTime() - LIMITS.tamperSilentGraceSec * 1000);
  const rows = await ctx.db
    .select()
    .from(deviceTable)
    .where(and(eq(deviceTable.status, 'enrolled'), eq(deviceTable.tamperState, 'ok'), isNotNull(deviceTable.lastSeenAt), lt(deviceTable.lastSeenAt, before)));
  for (const d of rows) {
    if (await isDeviceOnline(ctx, d.id)) continue;
    const org = await getOrg(ctx.db, d.orgId);
    if (!org) continue;
    const silentSec = Math.floor((now.getTime() - d.lastSeenAt!.getTime()) / 1000);
    await ctx.db.transaction(async (tx) => {
      const [r] = await tx
        .update(deviceTable)
        .set({ tamperState: 'suspected' })
        .where(and(eq(deviceTable.id, d.id), eq(deviceTable.tamperState, 'ok')))
        .returning({ id: deviceTable.id });
      if (!r) return;
      await writeAudit(ctx, tx, org, {
        actor: systemActor,
        action: 'tamper.suspected',
        data: { deviceId: d.id, lastSeenAt: d.lastSeenAt!.toISOString(), silentSec },
      });
    });
  }
}
