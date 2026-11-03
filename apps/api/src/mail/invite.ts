/**
 * Phase F section 4.2: the invitation mail, sent after the invite (or resend) transaction committed. A send failure
 * never fails the invite: the reply says `mailed: false` and the copy-link flow still works. Each attempt chains
 * `user.invite_mailed { userId, delivered, cause }` (actor: the inviting admin) and a successful send sets
 * `user.invite_mailed_at`.
 */
import { updateUser, type OrgRow, type UserRow } from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { userActor, writeAudit } from '../lib/audit.js';
import { mailAvailable, orgDisplayName, sendMail, ssoBeginUrl } from './send.js';
import { inviteMail } from './templates.js';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** `${WEB_ORIGIN}/invite#i=<secret>` (fragment: the secret never reaches a server log or a Referer). */
export function inviteUrlOf(ctx: Pick<AppContext, 'config'>, secret: string): string {
  return `${ctx.config.webOrigin}/invite#i=${secret}`;
}

/** Rule 4.2a: `sendEmail` defaults to true when invite mail is available, and is ignored otherwise. */
export function shouldMailInvite(ctx: Pick<AppContext, 'config'>, sendEmail: boolean | undefined): boolean {
  return mailAvailable(ctx) && sendEmail !== false;
}

/**
 * Sends the invitation and chains the attempt. Returns whether it was delivered to the transport and the user row as
 * it now stands (with `inviteMailedAt` set on success). Never throws.
 */
export async function mailInvite(
  ctx: AppContext,
  org: OrgRow,
  inviter: Pick<UserRow, 'id' | 'name'>,
  invitee: UserRow,
  secret: string,
  expiresAt: Date,
): Promise<{ mailed: boolean; user: UserRow }> {
  const text = inviteMail({
    inviterName: inviter.name,
    orgName: orgDisplayName(org),
    role: invitee.role,
    inviteUrl: inviteUrlOf(ctx, secret),
    expiresAt,
    ssoBeginUrl: org.ssoRequired ? ssoBeginUrl(ctx, org, invitee.email) : null,
  });
  const result = await sendMail(ctx, 'invite', invitee.email, text, { carriesSecret: true });
  const delivered = result === 'sent';
  let user = invitee;
  try {
    user = await ctx.db.transaction(async (tx) => {
      const u = delivered ? await updateUser(tx, invitee.id, { inviteMailedAt: new Date() }) : invitee;
      await writeAudit(ctx, tx, org, {
        actor: userActor(inviter),
        action: 'user.invite_mailed',
        data: { userId: invitee.id, delivered, cause: delivered ? null : result === 'no_mailer' ? 'no_mailer' : 'send_failed' },
      });
      return u;
    });
  } catch (err) {
    ctx.log.error({ err: err instanceof Error ? { name: err.name, message: err.message } : 'error', userId: invitee.id }, 'invite mail not recorded');
  }
  return { mailed: delivered, user };
}
