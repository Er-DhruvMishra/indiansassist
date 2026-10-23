/** Typed wrappers for every REST endpoint the web app calls (contracts section 6), validated with shared schemas. */
import {
  auditEntrySchema,
  auditLastVerifyResponseSchema,
  auditPageSchema,
  auditVerifyResponseSchema,
  authResponseSchema,
  createTokenResponseSchema,
  iceResponseSchema,
  inviteResponseSchema,
  orgSchema,
  publicTokenSchema,
  recordingDownloadResponseSchema,
  recordingSchema,
  recordingVerifyResponseSchema,
  residencyReportSchema,
  sessionAuditResponseSchema,
  sessionDetailSchema,
  sessionSchema,
  sessionStatsResponseSchema,
  sessionsPageSchema,
  signupResponseSchema,
  tokenSchema,
  tokensPageSchema,
  userSchema,
  usersPageSchema,
  type AuditEntry,
  type AuditVerifyResponse,
  type AuthResponse,
  type BrandingPatchRequest,
  type CreateTokenResponse,
  type FileEventData,
  type IceResponse,
  type InviteResponse,
  type Org,
  type PackageTier,
  type Page,
  type PublicToken,
  type Recording,
  type RecordingDownloadResponse,
  type RecordingVerifyResponse,
  type Region,
  type ResidencyReport,
  type Session,
  type SessionAuditResponse,
  type SessionDetail,
  type SessionState,
  type SessionStatsResponse,
  type SignupResponse,
  type Token,
  type TokenStatus,
  type TokenType,
  type User,
  type UserRole,
  type UserWithSeat,
} from '@indiansassist/shared';
import { api, request } from './api';

// ---------- auth (6.5) ----------

export const authApi = {
  me: () => api.get<AuthResponse>('/auth/me', { schema: authResponseSchema }),
  login: (email: string, password: string) =>
    api.post<AuthResponse>('/auth/login', { email, password }, { schema: authResponseSchema }),
  signup: (body: { orgName: string; region?: Region; name: string; email: string; password: string }) =>
    api.post<SignupResponse>('/auth/signup', body, { schema: signupResponseSchema }),
  logout: () => api.post<void>('/auth/logout'),
  acceptInvite: (body: { invite: string; name: string; password: string }) =>
    api.post<AuthResponse>('/auth/accept-invite', body, { schema: authResponseSchema }),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<void>('/auth/password', { currentPassword, newPassword }),
};

// ---------- orgs and users (6.6) ----------

export const orgApi = {
  current: () => api.get<Org>('/orgs/current', { schema: orgSchema }),
  residency: () => api.get<ResidencyReport>('/orgs/current/residency', { schema: residencyReportSchema }),
  /** PRD 12.15 white label (section 6.6, org_admin): `null` clears a field; the logo is a data: URL only. */
  updateBranding: (patch: BrandingPatchRequest) => api.patch<Org>('/orgs/current/branding', patch, { schema: orgSchema }),
};

export const usersApi = {
  list: (cursor?: string) =>
    api.get<Page<UserWithSeat>>('/users', { schema: usersPageSchema, query: { cursor, limit: 100 } }),
  invite: (body: { email: string; name: string; role: UserRole; tier?: PackageTier }) =>
    api.post<InviteResponse>('/users/invite', body, { schema: inviteResponseSchema }),
  changeRole: (id: string, role: UserRole, tier?: PackageTier) =>
    api.patch<User>(`/users/${id}/role`, tier ? { role, tier } : { role }, { schema: userSchema }),
  changeStatus: (id: string, status: 'active' | 'disabled') =>
    api.patch<User>(`/users/${id}/status`, { status }, { schema: userSchema }),
};

// ---------- tokens (6.7) ----------

export type CreateTokenBody = {
  tier: PackageTier;
  typ: TokenType;
  ttlMinutes?: number;
  ttlDays?: number;
  label?: string;
};

export const tokensApi = {
  create: (body: CreateTokenBody) =>
    api.post<CreateTokenResponse>('/tokens', body, { schema: createTokenResponseSchema }),
  list: (q: { status?: TokenStatus; cursor?: string; limit?: number } = {}) =>
    api.get<Page<Token>>('/tokens', { schema: tokensPageSchema, query: q }),
  get: (id: string) => api.get<Token>(`/tokens/${id}`, { schema: tokenSchema }),
  revoke: (id: string) => api.post<Token>(`/tokens/${id}/revoke`, undefined, { schema: tokenSchema }),
  publicLookup: (code: string, signal?: AbortSignal) =>
    api.post<PublicToken>('/tokens/public-lookup', { code }, { schema: publicTokenSchema, signal }),
};

// ---------- sessions (6.8) ----------

export const sessionsApi = {
  list: (q: { state?: SessionState; from?: string; to?: string; cursor?: string; limit?: number } = {}) =>
    api.get<Page<Session>>('/sessions', { schema: sessionsPageSchema, query: q }),
  stats: (q: { from?: string; to?: string } = {}) =>
    api.get<SessionStatsResponse>('/sessions/stats', { schema: sessionStatsResponseSchema, query: q }),
  get: (id: string) => api.get<SessionDetail>(`/sessions/${id}`, { schema: sessionDetailSchema }),
  end: (id: string, note?: string) =>
    api.post<Session>(`/sessions/${id}/end`, note ? { note } : {}, { schema: sessionSchema }),
  fileEvent: (id: string, action: 'file.sent' | 'file.received', data: FileEventData) =>
    api.post<AuditEntry>(`/sessions/${id}/events`, { action, data }, { schema: auditEntrySchema }),
  recordingStarted: (id: string) =>
    api.post<AuditEntry>(
      `/sessions/${id}/events`,
      { action: 'recording.started', data: {} },
      { schema: auditEntrySchema },
    ),
  audit: (id: string) =>
    api.get<SessionAuditResponse>(`/sessions/${id}/audit`, { schema: sessionAuditResponseSchema }),
};

// ---------- audit (6.9) ----------

export type AuditFilters = { action?: string; sessionId?: string; from?: string; to?: string };

export const auditApi = {
  list: (f: AuditFilters & { cursor?: string; limit?: number }) =>
    api.get<Page<AuditEntry>>('/audit', { schema: auditPageSchema, query: f }),
  verify: () => api.post<AuditVerifyResponse>('/audit/verify', undefined, { schema: auditVerifyResponseSchema }),
  lastVerify: () =>
    api.get<AuditVerifyResponse | null>('/audit/verify', { schema: auditLastVerifyResponseSchema }),
  /** POST export (section 6.9); returns the blob and the server-suggested file name. */
  async export(range: { from?: string; to?: string } = {}): Promise<{ blob: Blob; filename: string }> {
    const res = await request<Response>('POST', '/audit/export', { body: range, raw: true });
    const cd = res.headers.get('Content-Disposition') ?? '';
    const m = /filename="?([^";]+)"?/.exec(cd);
    return { blob: await res.blob(), filename: m?.[1] ?? 'audit-export.jsonl' };
  },
};

// ---------- recordings (6.10) and ICE (6.11) ----------

export const recordingsApi = {
  get: (id: string) => api.get<Recording>(`/recordings/${id}`, { schema: recordingSchema }),
  download: (id: string) =>
    api.get<RecordingDownloadResponse>(`/recordings/${id}/download`, { schema: recordingDownloadResponseSchema }),
  verify: (id: string) =>
    api.post<RecordingVerifyResponse>(`/recordings/${id}/verify`, undefined, {
      schema: recordingVerifyResponseSchema,
    }),
};

export const iceApi = {
  get: (sessionId?: string) => api.get<IceResponse>('/ice', { schema: iceResponseSchema, query: { sessionId } }),
};
