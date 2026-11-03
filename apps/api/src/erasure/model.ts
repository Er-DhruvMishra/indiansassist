/**
 * Phase F stream erasure (docs/specs/phase-f-contracts.md sections 5.1, 5.2, 5.6): the rules the routes and the sweep
 * share: the eligible approver (5.2b), the single-admin path (5.2f), the cooling-off and wait times (with the
 * development shortening of 5.2c), the `OrgErasure` wire shape, and the mails of 5.2d.
 */
import { LIMITS, sanitiseText, type OrgErasure } from '@indiansassist/shared';
import { auditEntry, user, type Executor, type OrgErasureRow, type OrgRow, type UserRow } from '@indiansassist/db';
import { and, eq, gte, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { refOf, userRefs } from '../lib/lookup.js';
import { iso, isoOrNull } from '../lib/time.js';

const DAY_MS = 86_400_000;

/**
 * Section 5.2c: `ERASURE_DEV_COOLING_OFF_SEC` (development only; refused in production as a boot problem) shortens a
 * waiting period to that many seconds. It also stands in for the approver's 7 days of 5.2b, the 7-day look-back of
 * 5.2f and the presence-key wait of step 8, so a smoke can run the whole flow on a throwaway org in seconds.
 */
export function devSeconds(ctx: Pick<AppContext, 'config'>): number | null {
  return ctx.config.erasure.devCoolingOffSec;
}

function shortened(ctx: Pick<AppContext, 'config'>, ms: number): number {
  const dev = devSeconds(ctx);
  return dev === null ? ms : Math.min(ms, dev * 1000);
}

/** `cooling_off_until` after an approval (7 days) or a solo confirmation (14 days). */
export function coolingOffUntil(ctx: Pick<AppContext, 'config'>, from: Date, solo: boolean): Date {
  const days = solo ? LIMITS.erasureSoloCoolingOffDays : LIMITS.erasureCoolingOffDays;
  return new Date(from.getTime() + shortened(ctx, days * DAY_MS));
}

/** How long an approver must have held org_admin (5.2b), and the look-back of the solo path (5.2f). */
export function approverMinAgeMs(ctx: Pick<AppContext, 'config'>): number {
  return shortened(ctx, LIMITS.erasureApproverMinDays * DAY_MS);
}

/**
 * Step 8: not before `max(summaryTranscriptTtlSec, amtSolMaxMinutes x 60 + 300)` seconds after step 2, so every
 * presence key the derivation of step 2 might have missed has expired.
 */
export function presenceWaitMs(ctx: Pick<AppContext, 'config'>): number {
  return shortened(ctx, Math.max(LIMITS.summaryTranscriptTtlSec, LIMITS.amtSolMaxMinutes * 60 + 300) * 1000);
}

/** Rule 5.2a: the caller's cookie session was minted within `LIMITS.erasureReauthMin` minutes. */
export function freshlyAuthenticated(authSession: { createdAt: Date }, now = Date.now()): boolean {
  return authSession.createdAt.getTime() >= now - LIMITS.erasureReauthMin * 60_000;
}

/**
 * Rule 5.2b: the active org_admins other than the requester whose role is at least 7 days old and was not granted by
 * the requester (the inviter of an invited user, the actor of the last role change; null for the signup admin).
 */
export async function eligibleApprovers(ctx: AppContext, exec: Executor, orgId: string, requesterId: string, now = new Date()): Promise<UserRow[]> {
  const cutoff = new Date(now.getTime() - approverMinAgeMs(ctx));
  return exec
    .select()
    .from(user)
    .where(
      and(
        eq(user.orgId, orgId),
        eq(user.role, 'org_admin'),
        eq(user.status, 'active'),
        ne(user.id, requesterId),
        lte(user.roleSince, cutoff),
        or(isNull(user.roleGrantedBy), ne(user.roleGrantedBy, requesterId)),
      ),
    );
}

/** True when `approver` is an eligible approver of an erasure requested by `requesterId` (5.2b). */
export function isEligibleApprover(ctx: AppContext, approver: UserRow, requesterId: string, now = new Date()): boolean {
  return (
    approver.role === 'org_admin' &&
    approver.status === 'active' &&
    approver.id !== requesterId &&
    approver.roleSince.getTime() <= now.getTime() - approverMinAgeMs(ctx) &&
    approver.roleGrantedBy !== requesterId
  );
}

/**
 * Rule 5.2f: the single-admin path is open when the org has exactly one active org_admin and no org_admin was demoted
 * or disabled within the look-back (read from the chain), so it cannot be reached by first removing the other admins.
 */
export async function soloAvailable(ctx: AppContext, exec: Executor, org: Pick<OrgRow, 'id'>, now = new Date()): Promise<boolean> {
  const admins = await exec
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.orgId, org.id), eq(user.role, 'org_admin'), eq(user.status, 'active')));
  if (admins.length !== 1) return false;
  const since = new Date(now.getTime() - approverMinAgeMs(ctx));
  const changes = await exec
    .select({ action: auditEntry.action, data: auditEntry.data })
    .from(auditEntry)
    .where(and(eq(auditEntry.orgId, org.id), inArray(auditEntry.action, ['user.role_changed', 'user.status_changed']), gte(auditEntry.ts, since)));
  const disabled: string[] = [];
  for (const c of changes) {
    const d = c.data as { userId?: unknown; from?: unknown; to?: unknown };
    if (c.action === 'user.role_changed' && d.from === 'org_admin' && d.to !== 'org_admin') return false;
    if (c.action === 'user.status_changed' && d.from === 'active' && d.to === 'disabled' && typeof d.userId === 'string') disabled.push(d.userId);
  }
  if (disabled.length === 0) return true;
  const roles = await exec.select({ role: user.role }).from(user).where(and(eq(user.orgId, org.id), inArray(user.id, disabled)));
  return !roles.some((r) => r.role === 'org_admin');
}

/** `${API_ORIGIN}/api/v1/erasures/<id>/certificate`: known from the request on, `404` until completion. */
export function certificateUrl(ctx: Pick<AppContext, 'config'>, id: string): string {
  return `${ctx.config.apiOrigin}/api/v1/erasures/${id}/certificate`;
}

/** The console page every mail points at. */
export function erasurePageUrl(ctx: Pick<AppContext, 'config'>): string {
  return `${ctx.config.webOrigin}/app/settings/erasure`;
}

/** The `OrgErasure` wire shape (section 5.6); names are display names ("Erased user" after completion). */
export async function toOrgErasure(ctx: AppContext, exec: Executor, row: OrgErasureRow): Promise<OrgErasure> {
  const ids = [row.requestedBy, row.approvedBy, row.cancelledBy].filter((x): x is string => typeof x === 'string');
  const names = await userRefs(exec, ids);
  const person = (id: string | null) => (id ? refOf(names, id) : null);
  return {
    id: row.id,
    state: row.state,
    requestedBy: refOf(names, row.requestedBy),
    requestedAt: iso(row.requestedAt),
    approvedBy: person(row.approvedBy),
    approvedAt: isoOrNull(row.approvedAt),
    coolingOffUntil: isoOrNull(row.coolingOffUntil),
    cancelledBy: person(row.cancelledBy),
    cancelledAt: isoOrNull(row.cancelledAt),
    executedAt: isoOrNull(row.executedAt),
    completedAt: isoOrNull(row.completedAt),
    certificateUrl: certificateUrl(ctx, row.id),
  };
}

// ---------- mail (rule 5.2d) ----------

/** One line of mail text: control characters removed (no header injection through a name), length capped. */
export function mailText(s: string, max = 200): string {
  return sanitiseText(s, max).replace(/[\r\n]+/g, ' ');
}

/** "9 November 2026, 10:02 UTC". */
export function mailDate(d: Date): string {
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  return `${date}, ${time} UTC`;
}

/** The active org_admins and auditors of the org (the mail recipients of 5.2d). */
export async function adminsAndAuditors(exec: Executor, orgId: string): Promise<UserRow[]> {
  return exec
    .select()
    .from(user)
    .where(and(eq(user.orgId, orgId), inArray(user.role, ['org_admin', 'auditor']), eq(user.status, 'active')));
}

const KEEP_LINE =
  'Before it runs, download the audit export and the signed data residency report, and keep the certificate link: after the erasure nobody of the organisation can sign in.';

/** Sends one plain-text mail to each address when the `smtp` driver is configured; a failure is logged, never thrown. */
export async function mailEach(ctx: AppContext, to: readonly string[], subject: string, text: string, attachments: { name: string; json: unknown }[] = []): Promise<number> {
  if (ctx.mailer.driver !== 'smtp') return 0;
  let sent = 0;
  for (const addr of new Set(to)) {
    try {
      if (await ctx.mailer.send({ to: addr, subject: mailText(subject, 150), text, attachments })) sent++;
    } catch (err) {
      ctx.log.warn({ err: { name: (err as Error)?.name } }, 'erasure mail failed');
    }
  }
  return sent;
}

export function requestMail(ctx: AppContext, org: OrgRow, requester: UserRow, row: OrgErasureRow): { subject: string; text: string } {
  const who = mailText(requester.name);
  const name = mailText(org.name);
  const lines = row.solo
    ? [
        `${who} asked to permanently erase ${name}, as its only administrator.`,
        `It runs only after ${who} confirms it from the link mailed to them and a ${LIMITS.erasureSoloCoolingOffDays}-day cooling-off period. Any administrator can cancel it at ${erasurePageUrl(ctx)}.`,
      ]
    : [
        `${who} asked to permanently erase ${name}. It needs a second administrator's approval. Any administrator can cancel it at ${erasurePageUrl(ctx)}.`,
      ];
  lines.push('', KEEP_LINE, `After it runs, its signed certificate will be at ${certificateUrl(ctx, row.id)}.`);
  return { subject: `Permanent erasure of ${name} requested`, text: lines.join('\n') + '\n' };
}

export function soloConfirmMail(ctx: AppContext, org: OrgRow, link: string): { subject: string; text: string } {
  const name = mailText(org.name);
  return {
    subject: `Confirm the permanent erasure of ${name}`,
    text:
      [
        `You asked to permanently erase ${name}. To confirm it, open this link within ${LIMITS.erasureConfirmTtlHours} hours while signed in (you will be asked to sign in again if your session is older than ${LIMITS.erasureReauthMin} minutes):`,
        '',
        link,
        '',
        `After you confirm, the erasure runs when a ${LIMITS.erasureSoloCoolingOffDays}-day cooling-off period ends. You can cancel it at ${erasurePageUrl(ctx)} until then. If you did not ask for this, cancel it now.`,
      ].join('\n') + '\n',
  };
}

export function scheduledMail(ctx: AppContext, org: OrgRow, requester: UserRow, approver: UserRow | null, row: OrgErasureRow): { subject: string; text: string } {
  const name = mailText(org.name);
  const when = mailDate(row.coolingOffUntil ?? new Date());
  const who = approver ? `${mailText(requester.name)} and ${mailText(approver.name)}` : `${mailText(requester.name)} (the only administrator, confirmed by a mailed link)`;
  return {
    subject: `Permanent erasure of ${name} scheduled for ${when}`,
    text:
      [
        `${who} scheduled the permanent erasure of ${name} on ${when}. Any administrator can cancel it before then at ${erasurePageUrl(ctx)}. After it runs, its signed certificate will be at ${certificateUrl(ctx, row.id)}.`,
        '',
        KEEP_LINE,
      ].join('\n') + '\n',
  };
}

export function certificateMail(ctx: AppContext, row: OrgErasureRow): { subject: string; text: string } {
  return {
    subject: 'Organisation erased: the signed erasure certificate',
    text:
      [
        'The organisation you administered or audited was permanently erased. Its signed erasure certificate is attached and stays at:',
        certificateUrl(ctx, row.id),
        '',
        'Verify it offline with scripts/verify-erasure.mjs and the published keys of the region (/.well-known/indiansassist.json).',
      ].join('\n') + '\n',
  };
}
