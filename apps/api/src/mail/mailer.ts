/**
 * The one mail transport (Phase D rule 6.4d; Phase F section 4.1). Drivers: `log` (default; one redacted line, for
 * development and self-hosts without SMTP) and `smtp` (nodemailer, MIT-0). Env `MAIL_DRIVER`, `SMTP_URL`, `MAIL_FROM`,
 * `SMTP_REQUIRE_TLS`. The address itself is never logged (only its peppered hash reaches the chain), nor is a body or
 * the SMTP URL (it may carry credentials).
 *
 * Phase F: an invite or reset mail has no attachment (an empty list; no MIME part is added); every mail is plain text only; with
 * `requireTls` the transport refuses to send without STARTTLS or implicit TLS (`smtps:`), rule 4.1b. A send that hangs
 * is bounded by the socket timeouts and an overall deadline, so a caller that awaits it (the invite reply) never waits
 * on a stuck relay for long.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';

export type MailAttachment = { name: string; json: unknown };
export type MailMessage = { to: string; subject: string; text: string; attachments: MailAttachment[] };

export interface Mailer {
  readonly driver: 'log' | 'smtp';
  /** Resolves true when the message was handed to the transport; rejects when the transport refused it. */
  send(m: MailMessage): Promise<boolean>;
}

export class LogMailer implements Mailer {
  readonly driver = 'log' as const;
  constructor(private readonly log: FastifyBaseLogger) {}
  async send(m: MailMessage): Promise<boolean> {
    this.log.info(
      { mail: { subject: m.subject, attachments: m.attachments.map((a) => a.name), toDomain: m.to.split('@')[1] ?? null } },
      'mail (log driver)',
    );
    return true;
  }
}

type Transport = { sendMail(o: Record<string, unknown>): Promise<unknown>; close?(): void };

/** Timeouts of one SMTP send (ms). Tests shorten them to script a hanging server. */
export type SmtpTimeouts = { connectionMs: number; greetingMs: number; socketMs: number; overallMs: number };
export const DEFAULT_SMTP_TIMEOUTS: SmtpTimeouts = { connectionMs: 10_000, greetingMs: 10_000, socketMs: 15_000, overallMs: 20_000 };

export type SmtpOptions = { requireTls?: boolean; timeouts?: Partial<SmtpTimeouts> };

/** A URL query value as nodemailer's own URL parser reads it (numbers and booleans). */
function queryValue(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
}

/**
 * The nodemailer options for `SMTP_URL`, with the TLS rule applied last, so a query parameter in the URL
 * (`?ignoreTLS=true`, `?requireTLS=false`) can never weaken it.
 */
export function smtpTransportOptions(smtpUrl: string, opts: SmtpOptions = {}): Record<string, unknown> {
  const u = new URL(smtpUrl);
  const secure = u.protocol === 'smtps:';
  if (!secure && u.protocol !== 'smtp:') throw new Error('SMTP_URL must start with smtp: or smtps:');
  const o: Record<string, unknown> = {};
  for (const [k, v] of u.searchParams) o[k] = queryValue(v);
  o['host'] = u.hostname.replace(/^\[|\]$/g, '');
  if (u.port !== '') o['port'] = Number(u.port);
  o['secure'] = secure;
  if (u.username !== '') o['auth'] = { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) };
  const t = { ...DEFAULT_SMTP_TIMEOUTS, ...(opts.timeouts ?? {}) };
  o['connectionTimeout'] = t.connectionMs;
  o['greetingTimeout'] = t.greetingMs;
  o['socketTimeout'] = t.socketMs;
  // nodemailer would otherwise log through its own logger, which can carry addresses and server replies.
  o['logger'] = false;
  o['debug'] = false;
  if (opts.requireTls && !secure) {
    o['requireTLS'] = true;
    o['ignoreTLS'] = false;
    o['opportunisticTLS'] = false;
  }
  return o;
}

export class SmtpMailer implements Mailer {
  readonly driver = 'smtp' as const;
  private transport: Promise<Transport> | null = null;
  private readonly overallMs: number;
  constructor(
    private readonly smtpUrl: string,
    private readonly from: string,
    private readonly opts: SmtpOptions = {},
  ) {
    this.overallMs = opts.timeouts?.overallMs ?? DEFAULT_SMTP_TIMEOUTS.overallMs;
  }

  private getTransport(): Promise<Transport> {
    this.transport ??= (import('nodemailer' as string) as Promise<{ default: { createTransport(o: Record<string, unknown>): Transport } }>).then((m) =>
      m.default.createTransport(smtpTransportOptions(this.smtpUrl, this.opts)),
    );
    return this.transport;
  }

  async send(m: MailMessage): Promise<boolean> {
    const t = await this.getTransport();
    const sending = t.sendMail({
      from: this.from,
      to: m.to,
      subject: m.subject,
      // Rule 4.1a: plain text only, never an HTML part.
      text: m.text,
      ...(m.attachments.length > 0
        ? { attachments: m.attachments.map((a) => ({ filename: a.name, content: JSON.stringify(a.json, null, 2), contentType: 'application/json' })) }
        : {}),
    });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('smtp send timed out'), { code: 'ETIMEDOUT' })), this.overallMs);
      timer.unref?.();
    });
    try {
      await Promise.race([sending, deadline]);
    } finally {
      clearTimeout(timer);
    }
    return true;
  }
}

export function buildMailer(config: Pick<Config, 'mail'>, log: FastifyBaseLogger): Mailer {
  return config.mail.driver === 'smtp'
    ? new SmtpMailer(config.mail.smtpUrl, config.mail.from, { requireTls: config.mail.requireTls })
    : new LogMailer(log);
}
