/**
 * Phase D `/signal/device` handlers (docs/specs/phase-d-contracts.md sections 3.4, 3.6b, 3.7b, 4.2): `device.hello`
 * (signed challenge against `device.public_key`), the heartbeat and interactive reports, worker-credential requests,
 * key rotation, and the dispatch to the action, tamper, wake and AMT handlers.
 */
import {
  deviceSigInput,
  isRegionServed,
  kidOf,
  LIMITS,
  publicKeyFromBase64url,
  verifyDeviceSignature,
  type DeviceClientMessage,
  type DeviceClientOf,
} from '@indiansassist/shared';
import { getDevice, getOrg, listManifestPlaybooks, updateDevice, type DeviceRow } from '@indiansassist/db';
import { writeAudit } from '../lib/audit.js';
import { brandingPublic } from '../lib/mappers.js';
import { buildManifest } from '../signal/agent-manifest.js';
import type { DeviceConn, DeviceHub } from '../signal/device.js';
import { WS_CLOSE } from '@indiansassist/shared';
import { handleActionResult, helloQueue, pushVaultQueue } from './actions.js';
import { deviceActor, effectivePolicyFor, macPatch, setDevicePresence } from './common.js';
import { deliverPendingReceipts } from './receipts.js';
import { handleTamper } from './tamper.js';
import { confirmWakes, handleAmtResult, handleAmtSolData, handleWakeSent } from './wake.js';
import { handleWorkerCredentialRequest } from './worker.js';

const re = (id: string | undefined) => (id !== undefined ? { re: id } : {});

export async function handleDeviceMessage(dh: DeviceHub, conn: DeviceConn, msg: DeviceClientMessage): Promise<void> {
  switch (msg.t) {
    case 'device.hello':
      return deviceHello(dh, conn, msg);
    case 'device.heartbeat':
      return heartbeat(dh, conn, msg);
    case 'device.interactive':
      return interactive(dh, conn, msg);
    case 'device.worker_credential.request':
      return handleWorkerCredentialRequest(dh, conn, msg);
    case 'device.action_result':
      return handleActionResult(dh, conn, msg);
    case 'device.tamper':
      return handleTamper(dh, conn, msg);
    case 'device.rotate':
      return rotate(dh, conn, msg);
    case 'wake.sent':
      return handleWakeSent(dh, conn, msg);
    case 'amt.result':
      return handleAmtResult(dh, conn, msg);
    case 'amt.sol.data':
      return handleAmtSolData(dh, conn, msg);
    default:
      return conn.error('unknown_type', 'unknown message type', (msg as { id?: string }).id);
  }
}

export async function onDeviceSocketClosed(dh: DeviceHub, conn: DeviceConn): Promise<void> {
  dh.ctx.metrics.wsConnections.dec();
  dh.ctx.metrics.devicesConnected.dec();
  void conn;
}

function unauthenticated(dh: DeviceHub, conn: DeviceConn, reId: string | undefined, why: string): void {
  dh.ctx.metrics.deviceHello.inc({ result: 'unauthenticated' });
  dh.ctx.log.warn({ connectionId: conn.id, why }, 'device hello refused');
  conn.error('device_unauthenticated', 'the device could not be authenticated', reId);
  conn.close(WS_CLOSE.deviceUnauthenticated, 'device_unauthenticated');
}

/** Section 3.4 `device.hello`: verify, register the presence, update the facts, answer `device.hello.ok`, drain. */
async function deviceHello(dh: DeviceHub, conn: DeviceConn, msg: DeviceClientOf<'device.hello'>): Promise<void> {
  const { ctx } = dh;
  if (!ctx.config.rateLimitDisabled && !dh.helloBucket.take()) {
    ctx.metrics.rateLimited.inc();
    ctx.metrics.deviceHello.inc({ result: 'rate_limited' });
    conn.error('rate_limited', 'too many device hellos on this node; back off', msg.id, { retryAfterSec: 5 });
    return conn.close(WS_CLOSE.rateLimited, 'rate limited');
  }
  const d = await getDevice(ctx.db, msg.deviceId);
  if (!d || !d.publicKey || d.keyId !== msg.keyId) return unauthenticated(dh, conn, msg.id, 'unknown device or key id');
  let input: Uint8Array;
  try {
    input = deviceSigInput.hello({ deviceId: d.id, serverChallenge: conn.challenge, nonce: msg.nonce });
  } catch {
    return unauthenticated(dh, conn, msg.id, 'malformed hello');
  }
  if (!verifyDeviceSignature(input, msg.sig, d.publicKey)) return unauthenticated(dh, conn, msg.id, 'bad signature');
  if (d.status !== 'enrolled') {
    ctx.metrics.deviceHello.inc({ result: 'disabled' });
    conn.error('device_disabled', `this device is ${d.status}`, msg.id, { status: d.status, retryAfterSec: LIMITS.deviceDisabledRetrySec });
    return conn.close(WS_CLOSE.deviceUnauthenticated, 'device_disabled');
  }
  if (!isRegionServed(d.region, ctx.config.servedRegions)) {
    ctx.metrics.deviceHello.inc({ result: 'region_mismatch' });
    conn.error('region_mismatch', 'this device belongs to another region', msg.id, { region: d.region });
    return conn.close(WS_CLOSE.forbidden, 'region_mismatch');
  }
  const org = await getOrg(ctx.db, d.orgId);
  if (!org) return unauthenticated(dh, conn, msg.id, 'org gone');
  dh.register(conn, d.id, d.orgId);
  ctx.metrics.wsConnections.inc();
  ctx.metrics.devicesConnected.inc();
  ctx.metrics.deviceHello.inc({ result: 'ok' });
  const c = msg.client;
  const now = new Date();
  const mac = macPatch(ctx, d, c.wakeMac);
  const fresh = (await updateDevice(ctx.db, d.id, {
    lastSeenAt: now,
    lastIp: conn.ip,
    ...(d.firstSeenAt ? {} : { firstSeenAt: now }),
    serviceVersion: c.serviceVersion,
    agentVersion: c.agentVersion,
    osVersion: c.osVersion,
    arch: c.arch,
    capabilities: c.capabilities as Record<string, unknown>,
    lanSegment: c.lanSegment as Record<string, unknown>,
    interactive: c.interactive as Record<string, unknown>,
    amt: c.amt && c.amt.present ? (c.amt as Record<string, unknown>) : null,
    ...(mac ?? {}),
  }))!;
  conn.lastSeenWrite = Date.now();
  await setDevicePresence(ctx, d.id, { connectionId: conn.id, nodeId: ctx.config.nodeId, region: d.region });
  const policy = await effectivePolicyFor(ctx, fresh, org);
  const queued = await helloQueue(ctx, fresh, org, policy);
  const rows = await listManifestPlaybooks(ctx.db, d.orgId, c.capabilities.interpreters, LIMITS.playbookCatalogueMax + 1);
  const manifest = buildManifest(rows);
  conn.send({
    t: 'device.hello.ok',
    ...re(msg.id),
    deviceId: d.id,
    orgDisplayName: brandingPublic(org).displayName,
    region: d.region,
    policy,
    groupId: fresh.groupId ?? null,
    queued: queued.wire,
    playbooks: manifest.msg.playbooks,
    rotationNonce: fresh.rotationNonce ?? null,
  });
  await pushVaultQueue(ctx, fresh, org, queued.vault);
  await confirmWakes(ctx, fresh, org);
  await deliverPendingReceipts(ctx, d.id);
}

async function refreshPresence(dh: DeviceHub, conn: DeviceConn, d: DeviceRow): Promise<void> {
  await setDevicePresence(dh.ctx, d.id, { connectionId: conn.id, nodeId: dh.ctx.config.nodeId, region: d.region });
}

async function heartbeat(dh: DeviceHub, conn: DeviceConn, msg: DeviceClientOf<'device.heartbeat'>): Promise<void> {
  const { ctx } = dh;
  const d = await getDevice(ctx.db, conn.deviceId!);
  if (!d || d.status !== 'enrolled') {
    conn.error('device_disabled', 'this device can no longer connect');
    return conn.close(WS_CLOSE.deviceUnauthenticated, 'device_disabled');
  }
  await refreshPresence(dh, conn, d);
  // Section 13.5: the gap between the previous check-in and this heartbeat (about 30 s when the device is healthy).
  if (d.lastSeenAt) ctx.metrics.deviceHeartbeatLag.observe(Math.max(0, Date.now() - d.lastSeenAt.getTime()) / 1000);
  const mac = macPatch(ctx, d, msg.wakeMac);
  await updateDevice(ctx.db, d.id, {
    lastSeenAt: new Date(),
    ...(msg.lanSegment ? { lanSegment: msg.lanSegment as Record<string, unknown> } : {}),
    ...(msg.interactive ? { interactive: msg.interactive as Record<string, unknown> } : {}),
    ...(msg.amt ? { amt: msg.amt.present ? (msg.amt as Record<string, unknown>) : null } : {}),
    ...(mac ?? {}),
  });
}

/** Section 3.4: within 2 s of a `WTS_SESSION_*` change; feeds the section 6.2 rules and the rule 9.9 gate. */
async function interactive(dh: DeviceHub, conn: DeviceConn, msg: DeviceClientOf<'device.interactive'>): Promise<void> {
  const d = await getDevice(dh.ctx.db, conn.deviceId!);
  if (!d) return;
  await refreshPresence(dh, conn, d);
  await updateDevice(dh.ctx.db, d.id, { interactive: msg.interactive as Record<string, unknown>, lastSeenAt: new Date() });
}

/** Rule 3.7b `device.rotate`: both signatures verified, keys swapped, nonce cleared, `device.key_rotated` chained. */
async function rotate(dh: DeviceHub, conn: DeviceConn, msg: DeviceClientOf<'device.rotate'>): Promise<void> {
  const { ctx } = dh;
  const d = await getDevice(ctx.db, conn.deviceId!);
  if (!d || !d.publicKey || !d.keyId) return conn.error('bad_state', 'device not found', msg.id);
  if (!d.rotationNonce) return conn.error('bad_state', 'no key rotation is armed', msg.id);
  let ok: boolean;
  try {
    ok =
      verifyDeviceSignature(
        deviceSigInput.rotate({ deviceId: d.id, rotationNonce: d.rotationNonce, newPublicKey: msg.newPublicKey, newKexPublicKey: msg.newKexPublicKey }),
        msg.oldKeySig,
        d.publicKey,
      ) && verifyDeviceSignature(deviceSigInput.rotateNew({ deviceId: d.id, rotationNonce: d.rotationNonce, oldKeyId: d.keyId }), msg.newKeyProof, msg.newPublicKey);
  } catch {
    ok = false;
  }
  if (!ok) return conn.error('device_bad_signature', 'a rotation signature did not verify', msg.id);
  const toKeyId = kidOf(publicKeyFromBase64url(msg.newPublicKey));
  const org = await getOrg(ctx.db, d.orgId);
  if (!org) return;
  await ctx.db.transaction(async (tx) => {
    await updateDevice(tx, d.id, { publicKey: msg.newPublicKey, keyId: toKeyId, kexPublicKey: msg.newKexPublicKey, rotationNonce: null });
    await writeAudit(ctx, tx, org, { actor: deviceActor(d.id), action: 'device.key_rotated', data: { deviceId: d.id, fromKeyId: d.keyId!, toKeyId } });
  });
  conn.send({ t: 'device.rotate.ok', ...re(msg.id), keyId: toKeyId });
}
