/**
 * Phase D fleet administration (docs/specs/phase-d-contracts.md section 7.2): device groups (org_admin; GET any
 * device-scope role), technician group assignment, and the org unattended / fleet policies (GET any role, PATCH
 * org_admin, `org.policy_updated`). A change that can alter devices' effective policy pushes `device.policy`.
 */
import {
  DEFAULT_UNATTENDED_POLICY,
  deviceGroupCreateSchema,
  deviceGroupPatchSchema,
  fleetPolicyPatchSchema,
  LIMITS,
  resolveUnattendedPolicy,
  unattendedPolicyBodySchema,
  unattendedPolicySchema,
  userDeviceGroupsSchema,
  type DeviceGroup,
  type UnattendedPolicy,
} from '@indiansassist/shared';
import {
  countDeviceGroups,
  DeviceGroupNameTakenError,
  deleteDeviceGroup,
  getDeviceGroupScoped,
  getUser,
  insertDeviceGroup,
  listDeviceGroups,
  listDevicesByGroup,
  listEnrolledDevices,
  updateDeviceGroup,
  updateOrg,
  updateUser,
  type DeviceGroupRow,
} from '@indiansassist/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { userActor, writeAudit } from '../lib/audit.js';
import { toUser } from '../lib/mappers.js';
import { iso } from '../lib/time.js';
import { parseOr400 } from '../lib/validate.js';
import { authenticate } from '../plugins/auth.js';
import { pushPolicies } from './common.js';
import { requireFleetRole } from './scope.js';

function toGroup(g: DeviceGroupRow): DeviceGroup {
  return {
    id: g.id,
    name: g.name,
    description: g.description ?? null,
    defaultPolicy: g.defaultPolicy as DeviceGroup['defaultPolicy'],
    defaultTags: g.defaultTags,
    notifyEmail: g.notifyEmail ?? null,
    createdAt: iso(g.createdAt),
    updatedAt: iso(g.updatedAt),
  };
}

async function nameGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DeviceGroupNameTakenError) fail('validation_failed', 'name: a device group with this name exists');
    throw err;
  }
}

function orgPolicy(raw: unknown): UnattendedPolicy {
  const r = unattendedPolicySchema.safeParse(raw);
  return r.success ? r.data : resolveUnattendedPolicy(null, null, (raw as Record<string, unknown>) ?? DEFAULT_UNATTENDED_POLICY);
}

export async function fleetAdminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/v1/orgs/current/device-groups', async (req) => {
    const p = await authenticate(ctx, req);
    requireFleetRole(p, 'read');
    return { items: (await listDeviceGroups(ctx.db, p.org.id)).map(toGroup) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/orgs/current/device-groups/:id', async (req) => {
    const p = await authenticate(ctx, req);
    requireFleetRole(p, 'read');
    const g = await getDeviceGroupScoped(ctx.db, req.params.id, p.org.id);
    if (!g) fail('not_found', 'group not found');
    return toGroup(g);
  });

  app.post('/api/v1/orgs/current/device-groups', async (req, reply) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    const body = parseOr400(deviceGroupCreateSchema, req.body);
    if ((await countDeviceGroups(ctx.db, p.org.id)) >= LIMITS.deviceGroupsPerOrgMax) fail('validation_failed', 'too many device groups');
    const fields = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
    const g = await nameGuard(() =>
      ctx.db.transaction(async (tx) => {
        const r = await insertDeviceGroup(tx, {
          orgId: p.org.id,
          name: body.name,
          description: body.description ?? null,
          defaultPolicy: (body.defaultPolicy ?? {}) as Record<string, unknown>,
          defaultTags: body.defaultTags ?? [],
          notifyEmail: body.notifyEmail ?? null,
          createdBy: p.user.id,
        });
        await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'device_group.created', data: { groupId: r.id, fields } });
        return r;
      }),
    );
    return reply.status(201).send(toGroup(g));
  });

  app.patch<{ Params: { id: string } }>('/api/v1/orgs/current/device-groups/:id', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    const body = parseOr400(deviceGroupPatchSchema, req.body);
    const cur = await getDeviceGroupScoped(ctx.db, req.params.id, p.org.id);
    if (!cur) fail('not_found', 'group not found');
    if (body.defaultPolicy !== undefined) {
      try {
        resolveUnattendedPolicy(null, { defaultPolicy: body.defaultPolicy }, p.org.unattendedPolicy);
      } catch {
        fail('validation_failed', 'defaultPolicy: the merged policy is not valid');
      }
    }
    const fields = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
    const g = await nameGuard(() =>
      ctx.db.transaction(async (tx) => {
        const r = await updateDeviceGroup(tx, cur.id, p.org.id, {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description ?? null } : {}),
          ...(body.defaultPolicy !== undefined ? { defaultPolicy: body.defaultPolicy as Record<string, unknown> } : {}),
          ...(body.defaultTags !== undefined ? { defaultTags: body.defaultTags } : {}),
          ...(body.notifyEmail !== undefined ? { notifyEmail: body.notifyEmail ?? null } : {}),
        });
        if (!r) fail('not_found', 'group not found');
        await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'device_group.updated', data: { groupId: r.id, fields } });
        return r;
      }),
    );
    if (body.defaultPolicy !== undefined) await pushPolicies(ctx, await listDevicesByGroup(ctx.db, p.org.id, g.id));
    return toGroup(g);
  });

  app.delete<{ Params: { id: string } }>('/api/v1/orgs/current/device-groups/:id', async (req, reply) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    const cur = await getDeviceGroupScoped(ctx.db, req.params.id, p.org.id);
    if (!cur) fail('not_found', 'group not found');
    const members = await listDevicesByGroup(ctx.db, p.org.id, cur.id);
    await ctx.db.transaction(async (tx) => {
      if (!(await deleteDeviceGroup(tx, cur.id, p.org.id))) fail('not_found', 'group not found');
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'device_group.deleted', data: { groupId: cur.id } });
    });
    await pushPolicies(ctx, members.map((d) => ({ ...d, groupId: null })));
    return reply.status(204).send();
  });

  app.put<{ Params: { id: string } }>('/api/v1/orgs/current/users/:id/device-groups', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    const body = parseOr400(userDeviceGroupsSchema, req.body);
    const target = /^[0-9a-f-]{36}$/.test(req.params.id) ? await getUser(ctx.db, req.params.id) : null;
    if (!target || target.orgId !== p.org.id) fail('not_found', 'user not found');
    for (const id of body.groupIds ?? []) if (!(await getDeviceGroupScoped(ctx.db, id, p.org.id))) fail('invalid_group', `group ${id} not found`);
    const u = await ctx.db.transaction(async (tx) => {
      const r = await updateUser(tx, target.id, { deviceGroupIds: body.groupIds });
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'user.device_groups_changed', data: { userId: target.id, groupIds: body.groupIds } });
      return r;
    });
    return toUser(u);
  });

  app.get('/api/v1/orgs/current/policy/unattended', async (req) => orgPolicy((await authenticate(ctx, req)).org.unattendedPolicy));

  app.patch('/api/v1/orgs/current/policy/unattended', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    const body = parseOr400(unattendedPolicyBodySchema, req.body);
    const org = await ctx.db.transaction(async (tx) => {
      const o = await updateOrg(tx, p.org.id, { unattendedPolicy: { ...body } });
      await writeAudit(ctx, tx, o, { actor: userActor(p.user), action: 'org.policy_updated', data: { fields: ['unattended'] } });
      return o;
    });
    await pushPolicies(ctx, await listEnrolledDevices(ctx.db, p.org.id));
    return orgPolicy(org.unattendedPolicy);
  });

  app.get('/api/v1/orgs/current/policy/fleet', async (req) => {
    const p = await authenticate(ctx, req);
    return { fleetScopingEnabled: p.org.fleetScopingEnabled, wakerMeshEnabled: p.org.wakerMeshEnabled };
  });

  app.patch('/api/v1/orgs/current/policy/fleet', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    const body = parseOr400(fleetPolicyPatchSchema, req.body);
    const fields = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
    if (fields.length === 0) return { fleetScopingEnabled: p.org.fleetScopingEnabled, wakerMeshEnabled: p.org.wakerMeshEnabled };
    const org = await ctx.db.transaction(async (tx) => {
      const o = await updateOrg(tx, p.org.id, {
        ...(body.fleetScopingEnabled !== undefined ? { fleetScopingEnabled: body.fleetScopingEnabled } : {}),
        ...(body.wakerMeshEnabled !== undefined ? { wakerMeshEnabled: body.wakerMeshEnabled } : {}),
      });
      await writeAudit(ctx, tx, o, { actor: userActor(p.user), action: 'org.policy_updated', data: { fields } });
      return o;
    });
    return { fleetScopingEnabled: org.fleetScopingEnabled, wakerMeshEnabled: org.wakerMeshEnabled };
  });
}
