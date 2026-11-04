/**
 * Phase D fleet REST endpoints of the web app (docs/specs/phase-d-contracts.md section 7.2): the device list and
 * detail, the device admin actions, device sessions, wake, AMT, the action queue, device groups, technician group
 * assignment, the two org policies and the branded installer download (sections 12.1, 13.4). Every reply is checked
 * against the shared schema of `schemas/rest-fleet.ts` or `fleet/installer.ts`.
 */
import {
  deviceActionQueuedReplySchema,
  deviceActionSchema,
  deviceActionsPageSchema,
  deviceDetailSchema,
  deviceGroupSchema,
  deviceSchema,
  deviceSessionReplySchema,
  devicesPageSchema,
  fleetPolicySchema,
  installerManifestSchema,
  unattendedPolicySchema,
  userSchema,
  wakeReplySchema,
  type AmtBootTarget,
  type Device,
  type DeviceAction,
  type DeviceActionState,
  type DeviceDetail,
  type DeviceGroup,
  type DevicePatch,
  type DeviceStatus,
  type InstallerArch,
  type InstallerFormat,
  type InstallerManifest,
  type Page,
  type UnattendedPolicy,
  type UnattendedPolicyPatch,
  type User,
  type WakeMethod,
  type WakeReply,
} from '@indiansassist/shared';
import { z } from 'zod';
import { API_BASE } from '../config';
import { api, request } from './api';

export type DeviceListQuery = {
  group?: string;
  tag?: string;
  status?: DeviceStatus;
  online?: boolean;
  q?: string;
  limit?: number;
  cursor?: string;
};

export type FleetPolicy = z.infer<typeof fleetPolicySchema>;

const groupsPageSchema = z.object({ items: z.array(deviceGroupSchema) });
const rotateReplySchema = z.object({ rotationArmed: z.boolean() });
const solReplySchema = z.object({ solId: z.string(), via: z.string() });
const bootReplySchema = z.object({ cmdId: z.string(), via: z.string() });

export type DeviceActionBody =
  | { kind: 'playbook_run'; payload: { playbookId: string; args: Record<string, string | number | boolean>; requiresElevation: boolean }; reason?: string }
  | { kind: 'file_push'; payload: { fileRef: string; name: string; bytes: number; sha256: string }; reason?: string }
  | { kind: 'print'; payload: { fileRef: string; name: string; printer?: string }; reason?: string }
  | { kind: 'message'; payload: { title: string; body: string }; reason?: string };

export const devicesApi = {
  list: (q: DeviceListQuery = {}) =>
    api.get<Page<Device>>('/devices', {
      schema: devicesPageSchema,
      query: { group: q.group, tag: q.tag, status: q.status, online: q.online === undefined ? undefined : String(q.online), q: q.q, limit: q.limit, cursor: q.cursor },
    }),
  get: (id: string) => api.get<DeviceDetail>(`/devices/${id}`, { schema: deviceDetailSchema }),
  patch: (id: string, patch: DevicePatch) => api.patch<Device>(`/devices/${id}`, patch, { schema: deviceSchema }),
  disable: (id: string) => api.post<Device>(`/devices/${id}/disable`, undefined, { schema: deviceSchema }),
  enable: (id: string) => api.post<Device>(`/devices/${id}/enable`, undefined, { schema: deviceSchema }),
  retire: (id: string) => request<void>('DELETE', `/devices/${id}`),
  rotateKey: (id: string) => api.post<{ rotationArmed: boolean }>(`/devices/${id}/rotate-key`, undefined, { schema: rotateReplySchema }),
  acknowledgeTamper: (id: string, note?: string) =>
    api.post<Device>(`/devices/${id}/tamper/acknowledge`, note ? { note } : {}, { schema: deviceSchema }),

  /** Section 3.5 / 6.2: `reason` is required when `unattended`. A 409 carries one of the section 6.2 codes. */
  openSession: (id: string, body: { unattended: boolean; reason?: string; monitors?: number[] }) =>
    api.post<{ sessionId: string }>(`/devices/${id}/sessions`, body, { schema: deviceSessionReplySchema }),

  wake: (id: string, body: { method: WakeMethod; reason?: string }) =>
    api.post<WakeReply>(`/devices/${id}/wake`, body, { schema: wakeReplySchema }),

  openSol: (id: string, reason: string) =>
    api.post<{ solId: string; via: string }>(`/devices/${id}/amt/sol`, { reason }, { schema: solReplySchema }),
  closeSol: (id: string, solId: string) => api.post<unknown>(`/devices/${id}/amt/sol/${solId}/close`),
  bootRedirect: (id: string, target: AmtBootTarget, reason: string) =>
    api.post<{ cmdId: string; via: string }>(`/devices/${id}/amt/boot`, { target, reason }, { schema: bootReplySchema }),

  queueAction: (id: string, body: DeviceActionBody) =>
    api.post<{ actionId: string; state: 'queued' | 'dispatched' }>(`/devices/${id}/actions`, body, { schema: deviceActionQueuedReplySchema }),
  listActions: (id: string, q: { state?: DeviceActionState; limit?: number; cursor?: string } = {}) =>
    api.get<Page<DeviceAction>>(`/devices/${id}/actions`, { schema: deviceActionsPageSchema, query: q }),
  cancelAction: (id: string, actionId: string) =>
    api.post<DeviceAction>(`/devices/${id}/actions/${actionId}/cancel`, undefined, { schema: deviceActionSchema }),
};

export type DeviceGroupBody = {
  name?: string;
  description?: string | null;
  defaultPolicy?: UnattendedPolicyPatch;
  defaultTags?: string[];
  notifyEmail?: string | null;
};

export const deviceGroupsApi = {
  list: () => api.get<{ items: DeviceGroup[] }>('/orgs/current/device-groups', { schema: groupsPageSchema }),
  create: (body: DeviceGroupBody & { name: string }) =>
    api.post<DeviceGroup>('/orgs/current/device-groups', body, { schema: deviceGroupSchema }),
  patch: (id: string, body: DeviceGroupBody) =>
    api.patch<DeviceGroup>(`/orgs/current/device-groups/${id}`, body, { schema: deviceGroupSchema }),
  remove: (id: string) => request<void>('DELETE', `/orgs/current/device-groups/${id}`),
  /** Section 7.1: `null` and `[]` both mean no devices once fleet scoping is on. */
  setUserGroups: (userId: string, groupIds: string[] | null) =>
    request<User>('PUT', `/orgs/current/users/${userId}/device-groups`, { body: { groupIds }, schema: userSchema }),
};

/**
 * The branded installer this server serves (sections 12.1, 13.4). `manifest` says whether to offer the download at
 * all (`builds: []` = nothing configured on this node); `url` is a plain authenticated GET, so the browser can follow
 * it straight from a link and the server audits it as `download.served` against the enrollment token. Phase F
 * section 8.11: the list carries every platform's packages, and `url` names the format of a non-MSI one.
 */
export const installerApi = {
  manifest: () => api.get<InstallerManifest>('/download/installer', { schema: installerManifestSchema }),
  url: (arch: InstallerArch, tokenId: string, format: InstallerFormat = 'msi') =>
    `${API_BASE}/download/installer/${arch}?tokenId=${encodeURIComponent(tokenId)}${format === 'msi' ? '' : `&format=${format}`}`,
};

export const fleetPolicyApi = {
  getUnattended: () => api.get<UnattendedPolicy>('/orgs/current/policy/unattended', { schema: unattendedPolicySchema }),
  /** The org default is a full policy (section 6.1). */
  setUnattended: (policy: UnattendedPolicy) =>
    api.patch<UnattendedPolicy>('/orgs/current/policy/unattended', policy, { schema: unattendedPolicySchema }),
  getFleet: () => api.get<FleetPolicy>('/orgs/current/policy/fleet', { schema: fleetPolicySchema }),
  setFleet: (patch: Partial<FleetPolicy>) => api.patch<FleetPolicy>('/orgs/current/policy/fleet', patch, { schema: fleetPolicySchema }),
};
