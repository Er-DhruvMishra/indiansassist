/** REST calls of the AI summary routes (docs/specs/phase-e-contracts.md section 5.9, stream ai). */
import {
  aiCapabilitiesSchema,
  aiPolicyReplySchema,
  aiSessionSummaryReplySchema,
  aiSessionSummarySchema,
  sessionSummaryListSchema,
  summaryInputReplySchema,
  type AiCapabilities,
  type AiPolicyPatch,
  type AiPolicyReply,
  type AiSessionSummary,
  type SessionSummaryOutput,
  type SummaryTranscriptUpload,
} from '@indiansassist/shared';
import type { z } from 'zod';
import { api, request } from '../../lib/api';

export type SummaryList = z.infer<typeof sessionSummaryListSchema>;
export type SummaryInputReply = z.infer<typeof summaryInputReplySchema>;

export const summaryApi = {
  capabilities: () => api.get<AiCapabilities>('/ai/capabilities', { schema: aiCapabilitiesSchema }),
  policy: () => api.get<AiPolicyReply>('/orgs/current/ai-policy', { schema: aiPolicyReplySchema }),
  patchPolicy: (patch: AiPolicyPatch) => api.patch<AiPolicyReply>('/orgs/current/ai-policy', patch, { schema: aiPolicyReplySchema }),
  uploadInput: (sessionId: string, body: SummaryTranscriptUpload) =>
    api.post<SummaryInputReply>(`/sessions/${sessionId}/summary-input`, body, { schema: summaryInputReplySchema }),
  generate: (sessionId: string) =>
    api.post<{ summary: AiSessionSummary }>(`/sessions/${sessionId}/summary`, {}, { schema: aiSessionSummaryReplySchema }),
  list: (sessionId: string) => api.get<SummaryList>(`/sessions/${sessionId}/summary`, { schema: sessionSummaryListSchema }),
  version: (sessionId: string, version: number) =>
    api.get<AiSessionSummary>(`/sessions/${sessionId}/summary/versions/${version}`, { schema: aiSessionSummarySchema }),
  edit: (sessionId: string, baseVersion: number, output: SessionSummaryOutput) =>
    request<AiSessionSummary>('PUT', `/sessions/${sessionId}/summary`, { body: { baseVersion, output }, schema: aiSessionSummarySchema }),
};
