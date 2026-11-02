/**
 * Phase E rule 3.7d: a break-glass password login while SSO is required mails every other active org_admin of the org
 * through the D `Mailer` ("<name> signed in with the break-glass password at <time> from <ip>"). An admin with no
 * address, or a failing transport, is skipped without an error; the `log` driver writes one redacted line instead.
 */
import { LIMITS } from '@indiansassist/shared';
import type { OrgRow, UserRow } from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { listOtherActiveAdmins } from './repo.js';

export async function notifyBreakGlassLogin(ctx: AppContext, org: OrgRow, user: UserRow, ip: string | undefined): Promise<number> {
  let sent = 0;
  try {
    const admins = await listOtherActiveAdmins(ctx.db, org.id, user.id);
    const at = new Date().toISOString();
    for (const a of admins) {
      if (!a.email || !a.email.includes('@')) continue;
      try {
        const ok = await ctx.mailer.send({
          to: a.email,
          subject: `${org.name}: break-glass sign-in`,
          text: `${user.name} signed in with the break-glass password at ${at} from ${ip ?? 'an unknown address'}.\n\nSingle sign-on is required for ${org.name}; break-glass sessions last ${LIMITS.breakGlassSessionHours} hour(s). If this was not expected, review the audit log and the break-glass list in the SSO settings.`,
          attachments: [],
        });
        if (ok) sent++;
      } catch (err) {
        ctx.log.warn({ err: err instanceof Error ? err.name : 'error' }, 'break-glass notice not sent');
      }
    }
  } catch (err) {
    ctx.log.warn({ err }, 'break-glass notice failed');
  }
  return sent;
}
