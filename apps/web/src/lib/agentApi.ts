/**
 * Phase C REST endpoints of the web app (docs/specs/phase-c-contracts.md sections 2.2, 2.4, 8.2, 13.1, 13.3): the agent
 * download grant flow, the signed `.iaconfig`, the playbook catalogue and run endpoint, and the agent policy.
 */
import {
  agentPolicySchema,
  auditEntrySchema,
  downloadManifestSchema,
  downloadPrepareReplySchema,
  iaconfigReplySchema,
  playbookRunReplySchema,
  playbookSchema,
  playbooksPageSchema,
  type AgentArch,
  type AgentPlatform,
  type AuditEntry,
  type DownloadManifest,
  type DownloadPrepareReply,
  type Page,
  type Playbook,
  type PlaybookArgValue,
  type PlaybookParam,
  type PlaybookRunReply,
} from '@indiansassist/shared';
import { api, request } from './api';

export const downloadApi = {
  manifest: () => api.get<DownloadManifest>('/download/manifest', { schema: downloadManifestSchema }),
  prepare: (code: string, platform: AgentPlatform, arch: AgentArch) =>
    api.post<DownloadPrepareReply>('/download/prepare', { code, platform, arch }, { schema: downloadPrepareReplySchema }),
};

export const iaconfigApi = {
  /** `POST /tokens/:id/iaconfig` (org_admin and the token creator): the signed sidecar text. */
  issue: (tokenId: string, deskLabel?: string) =>
    api.post<{ iaconfig: string }>(`/tokens/${tokenId}/iaconfig`, deskLabel ? { deskLabel } : {}, { schema: iaconfigReplySchema }),
};

export type PlaybookBody = {
  name: string;
  description: string;
  interpreter: Playbook['interpreter'];
  body?: string;
  requiresElevation: boolean;
  parameters: PlaybookParam[];
  timeoutSec: number;
  enabled?: boolean;
};

export const playbooksApi = {
  list: (q: { enabled?: boolean; cursor?: string; limit?: number } = {}) =>
    api.get<Page<Playbook>>('/orgs/current/playbooks', {
      schema: playbooksPageSchema,
      query: { enabled: q.enabled === undefined ? undefined : String(q.enabled), cursor: q.cursor, limit: q.limit ?? 100 },
    }),
  create: (body: PlaybookBody) => api.post<Playbook>('/orgs/current/playbooks', body, { schema: playbookSchema }),
  update: (id: string, patch: Partial<PlaybookBody>) => api.patch<Playbook>(`/orgs/current/playbooks/${id}`, patch, { schema: playbookSchema }),
  remove: (id: string) => request<void>('DELETE', `/orgs/current/playbooks/${id}`),
  /** The body release point (section 8.2): `202` with the body, runId, opId and the canonical args. */
  run: (sessionId: string, playbookId: string, args: Record<string, PlaybookArgValue>, reason?: string) =>
    api.post<PlaybookRunReply>(`/sessions/${sessionId}/playbooks/${playbookId}/run`, reason ? { args, reason } : { args }, {
      schema: playbookRunReplySchema,
    }),
};

export const agentPolicyApi = {
  get: () => api.get<{ requireSasConfirm: boolean }>('/orgs/current/policy/agent', { schema: agentPolicySchema }),
  set: (requireSasConfirm: boolean) =>
    api.patch<{ requireSasConfirm: boolean }>('/orgs/current/policy/agent', { requireSasConfirm }, { schema: agentPolicySchema }),
};

/** `POST /sessions/:id/events` for the Phase C console actions (section 3.8). */
export function p3Event(sessionId: string, body: { action: string; data: Record<string, unknown>; reason?: string }): Promise<AuditEntry> {
  return api.post<AuditEntry>(`/sessions/${sessionId}/events`, body, { schema: auditEntrySchema });
}

/** Triggers a browser download of text (the `.iaconfig` sidecar). */
export function saveText(text: string, name: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
