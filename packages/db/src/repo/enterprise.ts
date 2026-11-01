/**
 * Phase E repository functions the streams share (docs/specs/phase-e-contracts.md section 13.2a). The names are fixed
 * because another stream reads them; the stream that owns a table may add more beside them. Plain reads and writes
 * only: no chain entries, no secrets opened (the api's `lib/org-secrets.ts` seals and opens).
 */
import {
  parseSsoConfig,
  ssoLastTestSchema,
  type IntegrationType,
  type SsoConfig,
  type SsoLastTest,
  type SsoProtocol,
} from '@indiansassist/shared';
import { and, asc, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { SummaryNotReadyError } from '../errors.js';
import {
  authSession,
  integration,
  org,
  sessionSummary,
  ssoDomain,
  ssoIdentity,
  ticketPush,
  user,
  type IntegrationRow,
  type NewSessionSummaryRow,
  type NewTicketPushRow,
  type SessionSummaryRow,
  type SsoDomainRow,
  type SsoIdentityRow,
  type TicketPushRow,
} from '../schema/index.js';

// ---------- SSO ----------

/** The SSO columns of an org, parsed (residency, discovery and the admin routes read this). */
export type OrgSsoState = {
  orgId: string;
  slug: string;
  /** null when `org.sso_config` is null or does not parse (section 3.1: "SSO not configured"). */
  config: SsoConfig | null;
  required: boolean;
  clientSecret: { setAt: Date | null; fingerprint: string | null };
  spKey: { setAt: Date | null; fingerprint: string | null };
  spCertPem: string | null;
  lastTest: SsoLastTest | null;
  /** Active and disabled users flagged `sso_break_glass`. */
  breakGlassUserIds: string[];
};

export async function getOrgSsoState(exec: Executor, orgId: string): Promise<OrgSsoState | null> {
  const [o] = await exec.select().from(org).where(eq(org.id, orgId)).limit(1);
  if (!o) return null;
  const bg = await exec
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.orgId, orgId), eq(user.ssoBreakGlass, true)))
    .orderBy(asc(user.createdAt));
  const lt = ssoLastTestSchema.safeParse(o.ssoLastTest);
  return {
    orgId: o.id,
    slug: o.slug,
    config: parseSsoConfig(o.ssoConfig),
    required: o.ssoRequired,
    clientSecret: { setAt: o.ssoSecretSetAt, fingerprint: o.ssoSecretFp },
    spKey: { setAt: o.ssoSpKeySetAt, fingerprint: o.ssoSpKeyFp },
    spCertPem: o.ssoSpCert,
    lastTest: lt.success ? lt.data : null,
    breakGlassUserIds: bg.map((r) => r.id),
  };
}

/** The `verified` domains of an org (routing, linking and JIT read only these). */
export async function listVerifiedDomainsByOrg(exec: Executor, orgId: string): Promise<SsoDomainRow[]> {
  return exec
    .select()
    .from(ssoDomain)
    .where(and(eq(ssoDomain.orgId, orgId), eq(ssoDomain.status, 'verified')))
    .orderBy(asc(ssoDomain.domain));
}

/** The one row of this region holding `domain` verified (partial unique index), or null. */
export async function findVerifiedDomain(exec: Executor, domain: string): Promise<SsoDomainRow | null> {
  const [row] = await exec
    .select()
    .from(ssoDomain)
    .where(and(eq(ssoDomain.domain, domain), eq(ssoDomain.status, 'verified')))
    .limit(1);
  return row ?? null;
}

export type SsoIdentityKey = { orgId: string; protocol: SsoProtocol; issuer: string; subject: string };

export async function findSsoIdentity(exec: Executor, key: SsoIdentityKey): Promise<SsoIdentityRow | null> {
  const [row] = await exec
    .select()
    .from(ssoIdentity)
    .where(
      and(
        eq(ssoIdentity.orgId, key.orgId),
        eq(ssoIdentity.protocol, key.protocol),
        eq(ssoIdentity.issuer, key.issuer),
        eq(ssoIdentity.subject, key.subject),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertSsoIdentity(exec: Executor, input: SsoIdentityKey & { userId: string }): Promise<SsoIdentityRow> {
  const [row] = await exec
    .insert(ssoIdentity)
    .values({ orgId: input.orgId, userId: input.userId, protocol: input.protocol, issuer: input.issuer, subject: input.subject })
    .returning();
  return row!;
}

// ---------- integrations ----------

export async function getIntegration(exec: Executor, orgId: string, type: IntegrationType): Promise<IntegrationRow | null> {
  const [row] = await exec
    .select()
    .from(integration)
    .where(and(eq(integration.orgId, orgId), eq(integration.type, type)))
    .limit(1);
  return row ?? null;
}

export async function listIntegrations(exec: Executor, orgId: string): Promise<IntegrationRow[]> {
  return exec.select().from(integration).where(eq(integration.orgId, orgId)).orderBy(asc(integration.type));
}

export type UpsertIntegrationInput = {
  orgId: string;
  type: IntegrationType;
  enabled: boolean;
  config: Record<string, unknown>;
  updatedBy: string | null;
  /**
   * Section 2.1 write rule: absent = unchanged; `null` clears the sealed value with its set-at and fingerprint; an
   * object sets all three (`setAt` defaults to now).
   */
  credentials?: { enc: string; fingerprint: string; setAt?: Date } | null;
};

/** Inserts or updates the org's one row of `type` (unique `(org_id, type)`, W67). */
export async function upsertIntegration(exec: Executor, input: UpsertIntegrationInput): Promise<IntegrationRow> {
  const cred =
    input.credentials === undefined
      ? {}
      : input.credentials === null
        ? { credentialsEnc: null, credentialsSetAt: null, credentialsFp: null }
        : {
            credentialsEnc: input.credentials.enc,
            credentialsSetAt: input.credentials.setAt ?? new Date(),
            credentialsFp: input.credentials.fingerprint,
          };
  const set = { enabled: input.enabled, config: input.config, updatedBy: input.updatedBy, updatedAt: new Date(), ...cred };
  const [row] = await exec
    .insert(integration)
    .values({ orgId: input.orgId, type: input.type, ...set })
    .onConflictDoUpdate({ target: [integration.orgId, integration.type], set })
    .returning();
  return row!;
}

// ---------- ticket pushes ----------

export async function insertTicketPush(exec: Executor, values: NewTicketPushRow): Promise<TicketPushRow> {
  const [row] = await exec.insert(ticketPush).values(values).returning();
  return row!;
}

/** Org-scoped: a push of another org is null (cross-org ids are `404 not_found`). */
export async function getTicketPush(exec: Executor, orgId: string, id: string): Promise<TicketPushRow | null> {
  const [row] = await exec
    .select()
    .from(ticketPush)
    .where(and(eq(ticketPush.orgId, orgId), eq(ticketPush.id, id)))
    .limit(1);
  return row ?? null;
}

/** Newest first (`GET /sessions/:id/tickets`). */
export async function listTicketPushesBySession(exec: Executor, orgId: string, sessionId: string): Promise<TicketPushRow[]> {
  return exec
    .select()
    .from(ticketPush)
    .where(and(eq(ticketPush.orgId, orgId), eq(ticketPush.sessionId, sessionId)))
    .orderBy(desc(ticketPush.createdAt), desc(ticketPush.id));
}

/** `retrying` pushes whose `next_attempt_at` has passed, oldest due first (the sweeper, rule 4.4d). */
export async function listDueTicketPushes(exec: Executor, now: Date, limit: number): Promise<TicketPushRow[]> {
  return exec
    .select()
    .from(ticketPush)
    .where(and(eq(ticketPush.state, 'retrying'), lte(ticketPush.nextAttemptAt, now)))
    .orderBy(asc(ticketPush.nextAttemptAt))
    .limit(limit);
}

// ---------- session summaries ----------

export async function insertSessionSummary(exec: Executor, values: NewSessionSummaryRow): Promise<SessionSummaryRow> {
  const [row] = await exec.insert(sessionSummary).values(values).returning();
  return row!;
}

/**
 * The latest `ready` version of a session's summary when `version` is not named (null when there is none); a named
 * version that exists but is not `ready` throws SummaryNotReadyError (`409 summary_not_ready`); a named version that
 * does not exist is null.
 */
export async function getSessionSummary(exec: Executor, sessionId: string, version?: number): Promise<SessionSummaryRow | null> {
  if (version === undefined) {
    const [row] = await exec
      .select()
      .from(sessionSummary)
      .where(and(eq(sessionSummary.sessionId, sessionId), eq(sessionSummary.state, 'ready')))
      .orderBy(desc(sessionSummary.version))
      .limit(1);
    return row ?? null;
  }
  const [row] = await exec
    .select()
    .from(sessionSummary)
    .where(and(eq(sessionSummary.sessionId, sessionId), eq(sessionSummary.version, version)))
    .limit(1);
  if (!row) return null;
  if (row.state !== 'ready') throw new SummaryNotReadyError(sessionId, version, row.state);
  return row;
}

/** Every version of a session's summary, oldest first. */
export async function listSessionSummaries(exec: Executor, sessionId: string): Promise<SessionSummaryRow[]> {
  return exec.select().from(sessionSummary).where(eq(sessionSummary.sessionId, sessionId)).orderBy(asc(sessionSummary.version));
}

/** `pending` versions whose `next_attempt_at` has passed, oldest due first (the worker, rule 5.8c). */
export async function listDueSummaries(exec: Executor, now: Date, limit: number): Promise<SessionSummaryRow[]> {
  return exec
    .select()
    .from(sessionSummary)
    .where(and(eq(sessionSummary.state, 'pending'), lte(sessionSummary.nextAttemptAt, now)))
    .orderBy(asc(sessionSummary.nextAttemptAt))
    .limit(limit);
}

// ---------- residency counts (section 6.2 activity30d) ----------

/** Summary versions of the org that reached `ready` since `since` (generated and edited versions alike). */
export async function countSummariesSince(exec: Executor, orgId: string, since: Date): Promise<number> {
  const [r] = await exec
    .select({ n: count() })
    .from(sessionSummary)
    .where(and(eq(sessionSummary.orgId, orgId), eq(sessionSummary.state, 'ready'), gte(sessionSummary.completedAt, since)));
  return Number(r?.n ?? 0);
}

/** Ticket pushes the org requested since `since`, whatever their state. */
export async function countTicketPushesSince(exec: Executor, orgId: string, since: Date): Promise<number> {
  const [r] = await exec
    .select({ n: count() })
    .from(ticketPush)
    .where(and(eq(ticketPush.orgId, orgId), gte(ticketPush.createdAt, since)));
  return Number(r?.n ?? 0);
}

/** Sessions minted by SSO (`auth_session.login_method` `oidc` or `saml`) for the org's users since `since`. */
export async function countSsoLoginsSince(exec: Executor, orgId: string, since: Date): Promise<number> {
  const [r] = await exec
    .select({ n: count() })
    .from(authSession)
    .innerJoin(user, eq(user.id, authSession.userId))
    .where(and(eq(user.orgId, orgId), inArray(authSession.loginMethod, ['oidc', 'saml']), gte(authSession.createdAt, since)));
  return Number(r?.n ?? 0);
}

// ---------- sealed columns (section 2.1 rotation) ----------

/** Every sealed org-secret column (section 2.1): the lazy re-seal and `pnpm secrets:reseal` write these only. */
export const SEALED_COLUMNS = ['org.sso_secret_enc', 'org.sso_sp_key_enc', 'integration.credentials_enc'] as const;
export type SealedColumn = (typeof SEALED_COLUMNS)[number];

/**
 * Compare-and-set of one sealed value (section 2.1 rotation): `UPDATE ... SET col = next WHERE id = $id AND col = old`.
 * Returns false when the row no longer holds `old` (another request re-sealed or replaced it), which is not an error.
 */
export async function compareAndSetSealed(
  exec: Executor,
  target: SealedColumn,
  id: string,
  old: string,
  next: string,
): Promise<boolean> {
  let rows: { id: string }[];
  if (target === 'integration.credentials_enc') {
    rows = await exec
      .update(integration)
      .set({ credentialsEnc: next })
      .where(and(eq(integration.id, id), eq(integration.credentialsEnc, old)))
      .returning({ id: integration.id });
  } else if (target === 'org.sso_secret_enc') {
    rows = await exec
      .update(org)
      .set({ ssoSecretEnc: next })
      .where(and(eq(org.id, id), eq(org.ssoSecretEnc, old)))
      .returning({ id: org.id });
  } else {
    rows = await exec
      .update(org)
      .set({ ssoSpKeyEnc: next })
      .where(and(eq(org.id, id), eq(org.ssoSpKeyEnc, old)))
      .returning({ id: org.id });
  }
  return rows.length === 1;
}

/** One stored sealed value: its row, org and (for integration rows) the integration type, which picks the purpose. */
export type SealedRow = { id: string; orgId: string; value: string; integrationType: IntegrationType | null };

/** Every non-null value of a sealed column (the eager re-seal). */
export async function listSealed(exec: Executor, target: SealedColumn): Promise<SealedRow[]> {
  if (target === 'integration.credentials_enc') {
    const rows = await exec
      .select({ id: integration.id, orgId: integration.orgId, value: integration.credentialsEnc, type: integration.type })
      .from(integration)
      .where(sql`${integration.credentialsEnc} is not null`);
    return rows.map((r) => ({ id: r.id, orgId: r.orgId, value: r.value!, integrationType: r.type }));
  }
  const col = target === 'org.sso_secret_enc' ? org.ssoSecretEnc : org.ssoSpKeyEnc;
  const rows = await exec.select({ id: org.id, value: col }).from(org).where(sql`${col} is not null`);
  return rows.map((r) => ({ id: r.id, orgId: r.id, value: r.value!, integrationType: null }));
}
