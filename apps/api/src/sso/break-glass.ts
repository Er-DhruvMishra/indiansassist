/**
 * Phase E rule 3.7d: a break-glass password login while SSO is required mails every other active org_admin of the org
 * through the D `Mailer` ("<name> signed in with the break-glass password at <time> from <ip>"). An admin with no
 * address, or a failing transport, is skipped without an error; the `log` driver writes one redacted line instead.
 * Each notice goes through the Phase F send path (`mail/send.ts`), so it counts in `ia_mail_sent_total` as
 * `kind="break_glass_login"` with the `sent`, `failed` or `no_mailer` result of every other mail kind (F section 4.1e),
 * and takes the fixed subject and one-line names of the other kinds (F rule 4.1a; `mail/templates.ts`).
 */
import { LIMITS } from '@indiansassist/shared';
import type { OrgRow, UserRow } from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { sendMail } from '../mail/send.js';
import { breakGlassLoginMail } from '../mail/templates.js';
import { listOtherActiveAdmins } from './repo.js';

export async function notifyBreakGlassLogin(ctx: AppContext, org: OrgRow, user: UserRow, ip: string | undefined): Promise<number> {
  let sent = 0;
  try {
    const admins = await listOtherActiveAdmins(ctx.db, org.id, user.id);
    const at = new Date().toISOString();
    for (const a of admins) {
      if (!a.email || !a.email.includes('@')) continue;
      const mail = breakGlassLoginMail({ name: user.name, orgName: org.name, at, ip, sessionHours: LIMITS.breakGlassSessionHours });
      // The notice carries no token or link, so the `log` driver still writes its one redacted line (`no_mailer`).
      if ((await sendMail(ctx, 'break_glass_login', a.email, mail, { carriesSecret: false })) === 'sent') sent++;
    }
  } catch (err) {
    ctx.log.warn({ err: err instanceof Error ? err.name : 'error' }, 'break-glass notice failed');
  }
  return sent;
}
