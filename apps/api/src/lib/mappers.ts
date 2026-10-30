/** Row -> wire object mapping for the section 6.3 shared response objects. */
import {
  base64urlEncode,
  canonicalJson,
  formatShortCode,
  TOKEN_PREFIX,
  utf8Encode,
  type AuditEntry,
  type Org,
  type Recording,
  type Seat,
  type Session,
  type SessionFile,
  type Token,
  type TokenPayload,
  type TokenStatus,
  type User,
} from '@indiansassist/shared';
import {
  sessionFileMatch,
  type AuditEntryRow,
  type OrgRow,
  type RecordingRow,
  type SessionFileRow,
  type SessionRow,
  type TechnicianSeatRow,
  type TokenRow,
  type UserRow,
} from '@indiansassist/db';
import { iso, isoOrNull, unixSeconds } from './time.js';

export type UserRef = { id: string; name: string };

export function toUser(u: UserRow): User {
  return {
    id: u.id,
    orgId: u.orgId,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    createdAt: iso(u.createdAt),
    lastLoginAt: isoOrNull(u.lastLoginAt),
  };
}

export function toOrg(o: OrgRow): Org {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    dataRegion: o.dataRegion,
    planTier: o.planTier,
    branding: { ...(o.branding ?? {}) },
    createdAt: iso(o.createdAt),
  };
}

export function toSeat(s: TechnicianSeatRow | null): Seat | null {
  return s ? { id: s.id, userId: s.userId, tier: s.tier, active: s.active } : null;
}

/** Branding as shown to the Desk (`desk.hello.ok`, `session.created`); displayName falls back to org.name. */
export function brandingPublic(o: OrgRow): { displayName: string; accentColor: string | null; logoData: string | null } {
  const b = o.branding ?? {};
  return { displayName: b.displayName ?? o.name, accentColor: b.accentColor ?? null, logoData: b.logoData ?? null };
}

export function tokenPayloadOf(t: TokenRow): TokenPayload {
  return {
    v: 1,
    tid: t.id,
    org: t.orgId,
    by: t.createdBy,
    tier: t.tier,
    typ: t.typ,
    reg: t.region,
    iat: unixSeconds(t.issuedAt),
    exp: unixSeconds(t.expiresAt),
    nonce: t.nonce,
  };
}

/** Rebuilds the compact string from the row (section 4.2: kid + payload fields + signature). */
export function compactOf(t: TokenRow): string {
  const payload = base64urlEncode(utf8Encode(canonicalJson(tokenPayloadOf(t))));
  return `${TOKEN_PREFIX}.${t.kid}.${payload}.${t.signature}`;
}

/** Effective status (section 6.7): an `active` row whose expiry passed reads as `expired`. */
export function effectiveStatus(t: Pick<TokenRow, 'status' | 'expiresAt'>, now = Date.now()): TokenStatus {
  return t.status === 'active' && t.expiresAt.getTime() <= now ? 'expired' : t.status;
}

export function joinUrlOf(webOrigin: string, compact: string): string {
  return `${webOrigin}/join#t=${compact}`;
}

export function toToken(t: TokenRow, createdBy: UserRef, webOrigin: string, status?: TokenStatus): Token {
  return {
    id: t.id,
    tier: t.tier,
    typ: t.typ,
    status: status ?? effectiveStatus(t),
    shortCode: t.shortCode,
    shortCodeDisplay: formatShortCode(t.shortCode),
    label: t.label ?? null,
    region: t.region,
    createdBy,
    issuedAt: iso(t.issuedAt),
    expiresAt: iso(t.expiresAt),
    usedAt: isoOrNull(t.usedAt),
    revokedAt: isoOrNull(t.revokedAt),
    deniedCount: t.deniedCount,
    joinUrl: joinUrlOf(webOrigin, compactOf(t)),
    joinHost: new URL(webOrigin).host,
  };
}

export type SessionRefs = {
  tokenCreatedBy: UserRef;
  assist: UserRef;
  recordingId: string | null;
  /** Phase A.2 M4. */
  serverRecordingId?: string | null;
};

const SURFACES = new Set(['monitor', 'window', 'browser', 'unknown']);

export function surfaceOf(s: Pick<SessionRow, 'consentSurface'>): Session['consentSurface'] {
  return s.consentSurface && SURFACES.has(s.consentSurface) ? (s.consentSurface as Session['consentSurface']) : null;
}

export function toSession(s: SessionRow, refs: SessionRefs): Session {
  return {
    id: s.id,
    tokenId: s.tokenId,
    tokenCreatedBy: refs.tokenCreatedBy,
    assist: refs.assist,
    deskLabel: s.deskLabel ?? null,
    tier: s.tier,
    state: s.state,
    consentState: s.consentState,
    consentSurface: surfaceOf(s),
    path: s.path,
    region: s.region,
    nodeId: s.nodeId,
    knockedAt: iso(s.knockedAt),
    acceptedAt: isoOrNull(s.acceptedAt),
    consentAt: isoOrNull(s.consentAt),
    startedAt: isoOrNull(s.startedAt),
    endedAt: isoOrNull(s.endedAt),
    endReason: s.endReason ?? null,
    lastStats: (s.lastStats as Session['lastStats']) ?? null,
    recordingStarted: s.recordingStarted,
    recordingId: refs.recordingId,
    hashChainTail: s.hashChainTail ?? null,
    consentLevel: s.consentLevel ?? null,
    consentScope: s.consentScope ?? null,
    consentBackstage: s.consentBackstage ?? null,
    deskClient: (s.deskClient as Session['deskClient']) ?? null,
    recordingMode: s.recordingMode ?? null,
    serverRecording: s.serverRecording,
    serverRecordingId: refs.serverRecordingId ?? null,
    consentMonitors: s.consentMonitors ?? null,
    consentClipboard: s.consentClipboard ?? null,
    elevation: s.elevation ?? null,
  };
}

export function toAuditEntry(r: AuditEntryRow): AuditEntry {
  return {
    id: r.id,
    seq: r.seq,
    sessionId: r.sessionId ?? null,
    actor: { type: r.actorType, id: r.actorId ?? null, label: r.actorLabel },
    action: r.action,
    reason: r.reason ?? null,
    region: r.region,
    ts: iso(r.ts),
    data: r.data as AuditEntry['data'],
    prevHash: r.prevHash,
    hash: r.hash,
  };
}

export function toRecording(r: RecordingRow): Recording {
  return {
    id: r.id,
    sessionId: r.sessionId,
    status: r.status,
    mime: r.mime,
    bytes: r.bytes,
    sha256: r.sha256 ?? null,
    durationMs: r.durationMs ?? null,
    storageKey: r.storageKey,
    chainedInto: r.chainedInto ?? null,
    region: r.region,
    createdAt: iso(r.createdAt),
    storedAt: isoOrNull(r.storedAt),
    deletedAt: isoOrNull(r.deletedAt),
    recordedBy: r.recordedBy,
  };
}

export function toSessionFile(f: SessionFileRow): SessionFile {
  return {
    fileId: f.fileId,
    direction: f.direction,
    name: f.name,
    bytes: f.bytes,
    assistSha256: f.assistSha256 ?? null,
    deskSha256: f.deskSha256 ?? null,
    match: sessionFileMatch(f),
  };
}
