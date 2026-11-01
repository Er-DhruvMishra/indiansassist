/**
 * Phase D consent-receipt mailer (docs/specs/phase-d-contracts.md rule 6.4d). Drivers: `log` (default; one redacted
 * line, for development and self-hosts without SMTP) and `smtp` (nodemailer, MIT-0). Env `MAIL_DRIVER`, `SMTP_URL`,
 * `MAIL_FROM`. The address itself is never logged (only its peppered hash reaches the chain).
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';

export type MailAttachment = { name: string; json: unknown };
export type MailMessage = { to: string; subject: string; text: string; attachments: MailAttachment[] };

export interface Mailer {
  readonly driver: 'log' | 'smtp';
  /** Resolves true when the message was handed to the transport. */
  send(m: MailMessage): Promise<boolean>;
}

export class LogMailer implements Mailer {
  readonly driver = 'log' as const;
  constructor(private readonly log: FastifyBaseLogger) {}
  async send(m: MailMessage): Promise<boolean> {
    this.log.info({ mail: { subject: m.subject, attachments: m.attachments.map((a) => a.name), toDomain: m.to.split('@')[1] ?? null } }, 'mail (log driver)');
    return true;
  }
}

type Transport = { sendMail(o: Record<string, unknown>): Promise<unknown> };

export class SmtpMailer implements Mailer {
  readonly driver = 'smtp' as const;
  private transport: Promise<Transport> | null = null;
  constructor(
    private readonly smtpUrl: string,
    private readonly from: string,
  ) {}

  private getTransport(): Promise<Transport> {
    this.transport ??= (import('nodemailer' as string) as Promise<{ default: { createTransport(url: string): Transport } }>).then((m) =>
      m.default.createTransport(this.smtpUrl),
    );
    return this.transport;
  }

  async send(m: MailMessage): Promise<boolean> {
    const t = await this.getTransport();
    await t.sendMail({
      from: this.from,
      to: m.to,
      subject: m.subject,
      text: m.text,
      attachments: m.attachments.map((a) => ({ filename: a.name, content: JSON.stringify(a.json, null, 2), contentType: 'application/json' })),
    });
    return true;
  }
}

export function buildMailer(config: Pick<Config, 'mail'>, log: FastifyBaseLogger): Mailer {
  return config.mail.driver === 'smtp' ? new SmtpMailer(config.mail.smtpUrl, config.mail.from) : new LogMailer(log);
}
