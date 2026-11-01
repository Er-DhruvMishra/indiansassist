/**
 * Phase D device REST (docs/specs/phase-d-contracts.md sections 3.2, 3.5, 3.7, 7.2, 8, 9, 10.5): enrollment (the only
 * device create, bearer = the enrollment token inside the region-signed `enroll.iaconfig`), the enroll config, the
 * fleet list / detail / patch, disable / enable / retire / rotate-key, the signed deregister (the only
 * device-authenticated REST call), session open, wake, AMT SOL / boot, actions and tamper acknowledgement.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  amtBootRequestSchema,
  amtSolRequestSchema,
  deviceActionRequestSchema,
  deviceActionsListQuerySchema,
  deviceDeregisterSchema,
  deviceEnrollRequestSchema,
  deviceSessionRequestSchema,
  deviceSigInput,
  devicePatchSchema,
  devicesListQuerySchema,
  enrollConfigQuerySchema,
  isRegionServed,
  kidOf,
  publicKeyFromBase64url,
  resolveUnattendedPolicy,
  signEnrollConfig,
  tamperAcknowledgeSchema,
  verifyDeviceSignature,
  verifyEnrollConfig,
  wakeRequestSchema,
  type DeviceDetail,
  type UnattendedPolicy,
} from '@indiansassist/shared';
import {
  countEnrollment,
  findEnrolledByFingerprint,
  findOpenSessionByDevice,
  findTokenByTid,
  getAmtSol,
  getDevice,
  getOrg,
  getDeviceAction,
  getDeviceGroupScoped,
  insertDevice,
  listDeviceActions,
  listDevicesByOrg,
  listEnrolledDevices,
  listRecentSessionsByDevice,
  lockToken,
  setDeviceStatus,
  updateDevice,
  type DeviceRow,
} from '@indiansassist/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { systemActor, userActor, writeAudit, type Actor } from '../lib/audit.js';
import { approvedByOf, refOf, userRefs } from '../lib/lookup.js';
import { compactOf, effectiveStatus } from '../lib/mappers.js';
import { iso, isoOrNull } from '../lib/time.js';
import { parseOr400 } from '../lib/validate.js';
import { authenticate, type Principal } from '../plugins/auth.js';
import { wsOrigin } from '../routes/health.js';
import { endSessionQuietly } from '../services/session-end.js';
import { verifyTokenInput } from '../services/token-verify.js';
import { cancelDeviceAction, queueDeviceAction, toDeviceAction } from './actions.js';
import { deviceActor, effectivePolicy, encryptMac, groupOf, isDeviceOnline, onlineSet, pushPolicies, toDevice } from './common.js';
import { openDeviceSession } from './device-sessions.js';
import { requireFleetRole, scopedDevice, technicianGroups } from './scope.js';
import { bootRedirect, finishSol, openSol, requestWake } from './wake.js';

const withIp = (p: Principal) => p.user.role === 'org_admin' || p.user.role === 'auditor';

async function limit(ctx: AppContext, key: string, max: number, windowMs = 60_000): Promise<void> {
  const lim = await ctx.limiter.hit(key, max, windowMs);
  if (!lim.allowed) {
    ctx.metrics.rateLimited.inc();
    fail('rate_limited', 'too many requests', { retryAfterSec: lim.retryAfterSec });
  }
}

/** Ends the live session of a device (disable / retire / deregister) with `device_disabled`. */
async function endDeviceSession(ctx: AppContext, deviceId: string, actor: Actor): Promise<void> {
  const s = await findOpenSessionByDevice(ctx.db, deviceId);
  if (s) await endSessionQuietly(ctx, s.id, { reason: 'device_disabled', actor });
}

export async function deviceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // ---------- enrollment (section 3.2) ----------

  app.post('/api/v1/devices/enroll', async (req, reply) => {
    await limit(ctx, `enroll-ip:${req.ip}`, 60);
    const body = parseOr400(deviceEnrollRequestSchema, req.body);
    const cfg = await verifyEnrollConfig(body.enrollConfig, ctx.keys.all);
    if (!cfg) fail('invalid_enroll_config', 'the enrollment configuration is not signed by this region');
    if (!isRegionServed(cfg.region, ctx.config.servedRegions)) fail('region_mismatch', 'this enrollment configuration belongs to another region', { region: cfg.region });
    const v = await verifyTokenInput(ctx, cfg.token, { ip: req.ip });
    if (!v.ok) fail(v.code, v.message, v.details);
    const tok0 = v.token;
    await limit(ctx, `enroll-token:${tok0.id}`, 120);
    if (tok0.typ !== 'enrollment' || tok0.tier !== 'p4_installed') fail('invalid_token_type', 'this is not a p4_installed enrollment token');
    if (tok0.region !== cfg.region) fail('invalid_enroll_config', 'the configuration region does not match its token');
    const group = cfg.groupId ? await getDeviceGroupScoped(ctx.db, cfg.groupId, tok0.orgId) : null;
    if (cfg.groupId && !group) fail('invalid_group', 'the group of this configuration does not exist');
    let proofOk: boolean;
    try {
      proofOk = verifyDeviceSignature(
        deviceSigInput.enroll({ tokenId: tok0.id, devicePublicKey: body.devicePublicKey, deviceKexPublicKey: body.deviceKexPublicKey }),
        body.deviceKeyProof,
        body.devicePublicKey,
      );
    } catch {
      proofOk = false;
    }
    if (!proofOk) fail('token_bad_signature', 'the device key proof did not verify');
    const org = v.org;
    const keyId = kidOf(publicKeyFromBase64url(body.devicePublicKey));
    const m = body.machine;
    const deviceId = randomUUID();
    const result = await ctx.db.transaction(async (tx) => {
      const locked = await lockToken(tx, tok0.id);
      if (!locked || effectiveStatus(locked) !== 'active') fail('token_gone', `token is ${locked ? effectiveStatus(locked) : 'gone'}`);
      const counted = await countEnrollment(tx, locked);
      if (!counted) fail('token_used', 'this enrollment token has no capacity left');
      const prior = await findEnrolledByFingerprint(tx, org.id, m.hwFingerprint);
      const now = new Date();
      const d = await insertDevice(tx, {
        id: deviceId,
        orgId: org.id,
        name: m.name,
        region: tok0.region,
        platform: m.platform,
        publicKey: body.devicePublicKey,
        keyId,
        kexPublicKey: body.deviceKexPublicKey,
        osVersion: m.osVersion,
        serviceVersion: m.serviceVersion,
        arch: m.arch,
        hwFingerprint: m.hwFingerprint,
        lastIp: req.ip,
        groupId: group?.id ?? null,
        tags: group?.defaultTags ?? [],
        capabilities: m.capabilities as Record<string, unknown>,
        interactive: m.interactive as Record<string, unknown>,
        amt: m.amt && m.amt.present ? (m.amt as Record<string, unknown>) : null,
        enrolledByTokenId: tok0.id,
        enrolledAt: now,
        ...(m.wakeMac ? encryptMac(ctx, deviceId, m.wakeMac) : {}),
      });
      if (prior) {
        await setDeviceStatus(tx, prior.id, 'superseded', ['enrolled']);
        await writeAudit(ctx, tx, org, { actor: systemActor, action: 'device.superseded', data: { fromDeviceId: prior.id, toDeviceId: d.id } });
      }
      await writeAudit(ctx, tx, org, {
        actor: systemActor,
        action: 'device.enrolled',
        data: { deviceId: d.id, tokenId: tok0.id, keyId, platform: d.platform, groupId: d.groupId ?? null, devicesEnrolled: counted.devicesEnrolled, maxDevices: counted.maxDevices },
      });
      return { d, prior };
    });
    if (result.prior) await ctx.hub.devices.kick(result.prior.id, 'device_disabled', 'superseded by a re-enrollment');
    const policy = effectivePolicy(result.d, group, org);
    return reply.status(201).send({
      deviceId: result.d.id,
      orgId: org.id,
      region: result.d.region,
      apiOrigin: ctx.config.apiOrigin,
      signalUrl: `${wsOrigin(ctx.config.apiOrigin)}/signal/device`,
      keyId,
      group: group ? { id: group.id, name: group.name } : null,
      policy,
    });
  });

  app.get('/api/v1/devices/enroll-config', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    const q = parseOr400(enrollConfigQuerySchema, req.query);
    const tok = await findTokenByTid(ctx.db, q.tokenId);
    if (!tok || tok.orgId !== p.org.id) fail('not_found', 'token not found');
    if (tok.typ !== 'enrollment' || tok.tier !== 'p4_installed') fail('invalid_token_type', 'an enrollment config needs a p4_installed enrollment token');
    const status = effectiveStatus(tok);
    if (status !== 'active') fail('token_gone', `token is ${status}`, { status });
    const group = q.groupId ? await getDeviceGroupScoped(ctx.db, q.groupId, p.org.id) : null;
    if (q.groupId && !group) fail('invalid_group', 'group not found');
    let iaconfig: string;
    try {
      iaconfig = await signEnrollConfig(
        {
          v: 1,
          apiOrigin: ctx.config.apiOrigin,
          signalUrl: `${wsOrigin(ctx.config.apiOrigin)}/signal/device`,
          region: tok.region,
          token: compactOf(tok),
          groupId: group?.id ?? null,
          kid: ctx.keys.kid,
        },
        ctx.keys.seedHex,
      );
    } catch {
      // Never issue a config the installer would reject (C section 2.4: plain http / ws only for localhost).
      fail('bad_state', 'API_ORIGIN cannot be used in an enrollment config: it must be https (plain http only for localhost)');
    }
    await writeAudit(ctx, ctx.db, p.org, { actor: userActor(p.user), action: 'device.enroll_config_issued', data: { tokenId: tok.id, groupId: group?.id ?? null } });
    return { iaconfig };
  });

  // ---------- fleet list / detail (section 7.2) ----------

  app.get('/api/v1/devices', async (req) => {
    const p = await authenticate(ctx, req);
    requireFleetRole(p, 'read');
    const q = parseOr400(devicesListQuerySchema, req.query);
    const groups = technicianGroups(p.org, p.user);
    let ids: string[] | undefined;
    let excludeIds: string[] | undefined;
    if (q.online !== undefined) {
      const all = (await listEnrolledDevices(ctx.db, p.org.id)).map((d) => d.id);
      const on = [...(await onlineSet(ctx, all))];
      if (q.online) ids = on;
      else excludeIds = on;
    }
    const page = await listDevicesByOrg(ctx.db, p.org.id, {
      limit: q.limit,
      cursor: q.cursor ?? null,
      ...(q.group ? { groupId: q.group } : {}),
      ...(groups !== null ? { groupIds: groups } : {}),
      ...(q.tag ? { tag: q.tag } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { q: q.q } : {}),
      ...(ids ? { ids } : {}),
      ...(excludeIds ? { excludeIds } : {}),
    });
    const online = await onlineSet(ctx, page.items.map((d) => d.id));
    return { items: page.items.map((d) => toDevice(d, online.has(d.id), { withIp: withIp(p) })), nextCursor: page.nextCursor };
  });

  app.get<{ Params: { id: string } }>('/api/v1/devices/:id', async (req): Promise<DeviceDetail> => {
    const p = await authenticate(ctx, req);
    const d = await scopedDevice(ctx, p, req.params.id, 'read');
    const group = await groupOf(ctx, d);
    const recent = await listRecentSessionsByDevice(ctx.db, d.id, 10);
    const names = await userRefs(ctx.db, recent.map((s) => s.assistUserId));
    const approvals = await approvedByOf(ctx.db, recent);
    const base = toDevice(d, await isDeviceOnline(ctx, d.id), { withIp: withIp(p) });
    return {
      ...base,
      group: group ? { id: group.id, name: group.name } : null,
      policy: effectivePolicy(d, group, p.org),
      amt: base.amt,
      recentSessions: recent.map((s) => ({
        id: s.id,
        state: s.state,
        unattended: s.unattended ?? null,
        policySnapshot: (s.unattendedPolicy as UnattendedPolicy | null) ?? null,
        approvedBy: approvals.get(s.id) ?? null,
        assist: refOf(names, s.assistUserId),
        knockedAt: iso(s.knockedAt),
        startedAt: isoOrNull(s.startedAt),
        endedAt: isoOrNull(s.endedAt),
        endReason: s.endReason ?? null,
      })),
    };
  });

  app.patch<{ Params: { id: string } }>('/api/v1/devices/:id', async (req) => {
    const p = await authenticate(ctx, req);
    const d = await scopedDevice(ctx, p, req.params.id, 'admin');
    const body = parseOr400(devicePatchSchema, req.body);
    const fields = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
    let group = await groupOf(ctx, d);
    if (body.groupId !== undefined && body.groupId !== null) {
      group = await getDeviceGroupScoped(ctx.db, body.groupId, p.org.id);
      if (!group) fail('invalid_group', 'group not found');
    } else if (body.groupId === null) group = null;
    const override = body.unattendedPolicy === undefined ? d.unattendedPolicy : body.unattendedPolicy;
    try {
      resolveUnattendedPolicy({ unattendedPolicy: override }, group ? { defaultPolicy: group.defaultPolicy } : null, p.org.unattendedPolicy);
    } catch {
      fail('validation_failed', 'unattendedPolicy: the merged policy is not valid');
    }
    const row = await ctx.db.transaction(async (tx) => {
      const r = await updateDevice(tx, d.id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.groupId !== undefined ? { groupId: body.groupId } : {}),
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
        ...(body.unattendedPolicy !== undefined ? { unattendedPolicy: body.unattendedPolicy as Record<string, unknown> | null } : {}),
        ...(body.notifyEmail !== undefined ? { notifyEmail: body.notifyEmail } : {}),
      });
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'device.updated', data: { deviceId: d.id, fields } });
      return r!;
    });
    if (body.groupId !== undefined || body.unattendedPolicy !== undefined) await pushPolicies(ctx, [row]);
    return toDevice(row, await isDeviceOnline(ctx, row.id), { withIp: withIp(p) });
  });

  // ---------- lifecycle (rule 3.7) ----------

  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/disable', async (req) => {
    const p = await authenticate(ctx, req);
    const d = await scopedDevice(ctx, p, req.params.id, 'admin');
    const row = await ctx.db.transaction(async (tx) => {
      const r = await setDeviceStatus(tx, d.id, 'disabled', ['enrolled']);
      if (!r) fail('bad_state', `the device is ${d.status}`);
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'device.disabled', data: { deviceId: d.id } });
      return r;
    });
    await ctx.hub.devices.kick(d.id, 'device_disabled', 'this device was disabled by an administrator');
    await endDeviceSession(ctx, d.id, userActor(p.user));
    return toDevice(row, false, { withIp: withIp(p) });
  });

  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/enable', async (req) => {
    const p = await authenticate(ctx, req);
    const d = await scopedDevice(ctx, p, req.params.id, 'admin');
    const row = await ctx.db.transaction(async (tx) => {
      const r = await setDeviceStatus(tx, d.id, 'enrolled', ['disabled']);
      if (!r) fail('bad_state', `the device is ${d.status}`);
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'device.enabled', data: { deviceId: d.id } });
      return r;
    });
    return toDevice(row, false, { withIp: withIp(p) });
  });

  app.delete<{ Params: { id: string } }>('/api/v1/devices/:id', async (req, reply) => {
    const p = await authenticate(ctx, req);
    const d = await scopedDevice(ctx, p, req.params.id, 'admin');
    await ctx.db.transaction(async (tx) => {
      const r = await setDeviceStatus(tx, d.id, 'retired', ['enrolled', 'disabled', 'superseded', 'deregistered'], { publicKey: null, keyId: null, rotationNonce: null });
      if (!r) fail('bad_state', `the device is ${d.status}`);
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'device.retired', data: { deviceId: d.id } });
    });
    await ctx.hub.devices.kick(d.id, 'device_disabled', 'this device was retired');
    await endDeviceSession(ctx, d.id, userActor(p.user));
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/rotate-key', async (req) => {
    const p = await authenticate(ctx, req);
    const d = await scopedDevice(ctx, p, req.params.id, 'admin');
    if (d.status !== 'enrolled') fail('bad_state', `the device is ${d.status}`);
    await ctx.db.transaction(async (tx) => {
      await updateDevice(tx, d.id, { rotationNonce: randomBytes(16).toString('base64url') });
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'device.key_rotation_armed', data: { deviceId: d.id } });
    });
    return { rotationArmed: true };
  });

  /** Section 7.2: device-authenticated (no cookie), signed `ia-dereg-v1`; bad signature / stale ts / reused nonce -> 401. */
  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/deregister', async (req, reply) => {
    await limit(ctx, `deregister-ip:${req.ip}`, 10);
    const body = parseOr400(deviceDeregisterSchema, req.body);
    const d = await getDevice(ctx.db, req.params.id);
    const bad = () => fail('device_unauthenticated', 'the deregistration could not be authenticated');
    if (!d || !d.publicKey || Math.abs(Date.now() - body.ts) > 300_000) bad();
    const dev = d as DeviceRow;
    let ok: boolean;
    try {
      ok = verifyDeviceSignature(deviceSigInput.deregister({ deviceId: dev.id, ts: body.ts, nonce: body.nonce }), body.sig, dev.publicKey!);
    } catch {
      ok = false;
    }
    if (!ok) bad();
    const nonceKey = `ia:dereg:${dev.id}:${body.nonce}`;
    if ((await ctx.presence.incr(nonceKey, 600)) > 1) bad();
    const org = await getOrg(ctx.db, dev.orgId);
    if (!org) bad();
    await ctx.db.transaction(async (tx) => {
      const r = await setDeviceStatus(tx, dev.id, 'deregistered', ['enrolled', 'disabled']);
      if (r) await writeAudit(ctx, tx, org!, { actor: deviceActor(dev.id), action: 'device.deregistered', data: { deviceId: dev.id } });
    });
    await ctx.hub.devices.kick(dev.id, 'device_disabled', 'this device was uninstalled');
    await endDeviceSession(ctx, dev.id, deviceActor(dev.id));
    return reply.status(204).send();
  });

  // ---------- sessions, wake, AMT (sections 3.5, 8) ----------

  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/sessions', async (req, reply) => {
    const p = await authenticate(ctx, req);
    const d = await scopedDevice(ctx, p, req.params.id, 'act');
    const body = parseOr400(deviceSessionRequestSchema, req.body);
    const r = await openDeviceSession(ctx, p, d, body);
    return reply.status(201).send({ sessionId: r.sessionId });
  });

  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/wake', async (req, reply) => {
    const p = await authenticate(ctx, req);
    const d = await scopedDevice(ctx, p, req.params.id, 'act');
    const body = parseOr400(wakeRequestSchema, req.body ?? {});
    return reply.status(202).send(await requestWake(ctx, p, d, body.method, body.reason ?? null));
  });

  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/amt/sol', async (req, reply) => {
    const p = await authenticate(ctx, req);
    const d = await scopedDevice(ctx, p, req.params.id, 'amt');
    const body = parseOr400(amtSolRequestSchema, req.body);
    if (!effectivePolicy(d, await groupOf(ctx, d), p.org).allowAmtSol) fail('policy_forbidden', 'the policy of this device does not allow the AMT SOL console');
    return reply.status(201).send(await openSol(ctx, p, d, body.reason));
  });

  app.post<{ Params: { id: string; solId: string } }>('/api/v1/devices/:id/amt/sol/:solId/close', async (req) => {
    const p = await authenticate(ctx, req);
    const d = await scopedDevice(ctx, p, req.params.id, 'read');
    const sol = await getAmtSol(ctx.db, req.params.solId);
    if (!sol || sol.deviceId !== d.id) fail('not_found', 'SOL session not found');
    if (sol.openedBy !== p.user.id && p.user.role !== 'org_admin') fail('forbidden', 'only the opener or an org_admin may close this console');
    return { closed: await finishSol(ctx, sol.id) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/amt/boot', async (req, reply) => {
    const p = await authenticate(ctx, req);
    const d = await scopedDevice(ctx, p, req.params.id, 'amt');
    const body = parseOr400(amtBootRequestSchema, req.body);
    if (!effectivePolicy(d, await groupOf(ctx, d), p.org).allowAmtBootRedirect) fail('policy_forbidden', 'the policy of this device does not allow AMT boot redirection');
    return reply.status(202).send(await bootRedirect(ctx, p, d, body.target, body.reason));
  });

  // ---------- actions (section 9) ----------

  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/actions', async (req, reply) => {
    const p = await authenticate(ctx, req);
    const d = await scopedDevice(ctx, p, req.params.id, 'act');
    if (d.status !== 'enrolled') fail('bad_state', `the device is ${d.status}`);
    const body = parseOr400(deviceActionRequestSchema, req.body);
    return reply.status(202).send(await queueDeviceAction(ctx, p, d, body));
  });

  app.get<{ Params: { id: string } }>('/api/v1/devices/:id/actions', async (req) => {
    const p = await authenticate(ctx, req);
    const d = await scopedDevice(ctx, p, req.params.id, 'queue');
    const q = parseOr400(deviceActionsListQuerySchema, req.query);
    const page = await listDeviceActions(ctx.db, d.id, { limit: q.limit, cursor: q.cursor ?? null, ...(q.state ? { state: q.state } : {}) });
    const names = await userRefs(ctx.db, page.items.map((a) => a.createdBy));
    return { items: page.items.map((a) => toDeviceAction(a, refOf(names, a.createdBy))), nextCursor: page.nextCursor };
  });

  app.post<{ Params: { id: string; actionId: string } }>('/api/v1/devices/:id/actions/:actionId/cancel', async (req) => {
    const p = await authenticate(ctx, req);
    const d = await scopedDevice(ctx, p, req.params.id, 'act');
    const a = await getDeviceAction(ctx.db, req.params.actionId);
    if (!a || a.deviceId !== d.id) fail('not_found', 'action not found');
    const r = await cancelDeviceAction(ctx, p, a);
    return toDeviceAction(r, refOf(await userRefs(ctx.db, [r.createdBy]), r.createdBy));
  });

  // ---------- tamper (rule 10.5) ----------

  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/tamper/acknowledge', async (req) => {
    const p = await authenticate(ctx, req);
    const d = await scopedDevice(ctx, p, req.params.id, 'admin');
    const body = parseOr400(tamperAcknowledgeSchema, req.body ?? {});
    const row = await ctx.db.transaction(async (tx) => {
      const r = await updateDevice(tx, d.id, { tamperState: 'ok' });
      await writeAudit(ctx, tx, p.org, {
        actor: userActor(p.user),
        action: 'tamper.acknowledged',
        data: { deviceId: d.id, cause: d.tamperState === 'ok' ? null : d.tamperState, note: body.note ?? null },
      });
      return r!;
    });
    return toDevice(row, await isDeviceOnline(ctx, row.id), { withIp: withIp(p) });
  });
}
