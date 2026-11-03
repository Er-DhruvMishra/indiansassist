/**
 * Phase F section 4.1: one send path for every Phase F mail kind, with the `ia_mail_sent_total{kind,result}` metric,
 * and the tracker of the work a public route does after its reply (rule 4.3a), so a test and `app.close()` can wait
 * for it.
 */
import type { MailKind } from '@indiansassist/shared';
import { parseSsoConfig } from '@indiansassist/shared';
import type { OrgRow } from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { beginPath } from '../sso/urls.js';
import type { MailText } from './templates.js';

export type SendResult = 'sent' | 'failed' | 'no_mailer';

/** Rule 4.1c: invite and reset mail exist only with the `smtp` driver (from config only, never per account). */
export function mailAvailable(ctx: Pick<AppContext, 'config'>): boolean {
  return ctx.config.mail.driver === 'smtp';
}

/** The org name a mail shows: the branded display name when the org set one. */
export function orgDisplayName(org: Pick<OrgRow, 'name' | 'branding'>): string {
  const d = org.branding?.displayName;
  return typeof d === 'string' && d.trim() !== '' ? d.trim() : org.name;
}

/** The absolute SSO begin URL for a mail (the api origin; `WEB_ORIGIN === API_ORIGIN` in production). */
export function ssoBeginUrl(ctx: Pick<AppContext, 'config'>, org: Pick<OrgRow, 'slug'>, email: string | null): string {
  return `${ctx.config.apiOrigin}${beginPath(org.slug, { loginHint: email })}`;
}

/** True when the org has an enabled SSO connection (rule 4.3b: a password-less account gets the notice then). */
export function orgHasSso(org: Pick<OrgRow, 'ssoConfig' | 'ssoRequired'>): boolean {
  return org.ssoRequired || (parseSsoConfig(org.ssoConfig)?.enabled ?? false);
}

/**
 * Sends one mail. With the `log` driver a mail that carries a token or link is never handed to the transport
 * (`carriesSecret`, rule 4.1c); other kinds write the log driver's one redacted line. Never throws.
 */
export async function sendMail(
  ctx: Pick<AppContext, 'mailer' | 'metrics' | 'log'>,
  kind: MailKind,
  to: string,
  mail: MailText,
  opts: { carriesSecret: boolean },
): Promise<SendResult> {
  if (ctx.mailer.driver !== 'smtp') {
    if (!opts.carriesSecret) {
      try {
        await ctx.mailer.send({ to, subject: mail.subject, text: mail.text, attachments: [] });
      } catch {
        /* the log driver does not fail */
      }
    }
    ctx.metrics.mailSent.inc({ kind, result: 'no_mailer' });
    return 'no_mailer';
  }
  try {
    await ctx.mailer.send({ to, subject: mail.subject, text: mail.text, attachments: [] });
    ctx.metrics.mailSent.inc({ kind, result: 'sent' });
    return 'sent';
  } catch (err) {
    // Only the error's name and code: a transport message can echo the address or the server's reply.
    const e = err as { name?: string; code?: unknown; responseCode?: unknown };
    ctx.log.warn({ mailKind: kind, err: { name: e?.name ?? 'Error', code: e?.code ?? null, responseCode: e?.responseCode ?? null } }, 'mail not sent');
    ctx.metrics.mailSent.inc({ kind, result: 'failed' });
    return 'failed';
  }
}

// ---------- work after the reply (rule 4.3a) ----------

const pending = new WeakMap<object, Set<Promise<void>>>();

/** Runs `work` on the next turn of the event loop (after the reply is written) and tracks it. */
export function afterReply(ctx: Pick<AppContext, 'log'>, work: () => Promise<void>): void {
  let set = pending.get(ctx);
  if (!set) {
    set = new Set();
    pending.set(ctx, set);
  }
  const s = set;
  const p = new Promise<void>((resolve) => {
    setImmediate(() => {
      work()
        .catch((err: unknown) => ctx.log.error({ err: err instanceof Error ? { name: err.name, message: err.message } : 'error' }, 'mail work failed'))
        .finally(resolve);
    });
  });
  s.add(p);
  void p.then(() => s.delete(p));
}

/** Resolves when every tracked piece of after-reply work has finished (tests; `app.close()`). */
export async function settleMailWork(ctx: object): Promise<void> {
  for (;;) {
    const set = pending.get(ctx);
    if (!set || set.size === 0) return;
    await Promise.all([...set]);
  }
}
