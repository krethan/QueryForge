import { readFileSync } from 'node:fs';
import nodemailer, { type Transporter } from 'nodemailer';
import type { AppConfig } from '../config/config.js';

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  attachments: { filename: string; path: string }[];
}

export interface Mailer {
  send(msg: MailMessage): Promise<{ messageId?: string }>;
}

/** SMTP via nodemailer. TLS is mandatory: implicit TLS (SMTP_SECURE=true) or required STARTTLS. */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;
  constructor(private readonly cfg: NonNullable<AppConfig['smtp']>) {
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      requireTLS: !cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.password ?? '' } : undefined,
      tls: {
        rejectUnauthorized: cfg.rejectUnauthorized,
        minVersion: 'TLSv1.2',
        ca: cfg.caFile ? readFileSync(cfg.caFile) : undefined,
      },
      connectionTimeout: 15_000,
      socketTimeout: 60_000,
    });
  }
  async send(msg: MailMessage) {
    const info = await this.transport.sendMail({
      from: this.cfg.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      attachments: msg.attachments,
    });
    return { messageId: info.messageId };
  }
}

/** In-memory mailer for tests and demo mode. Never opens a network connection. */
export class MemoryMailer implements Mailer {
  sent: (MailMessage & { attachmentData: Buffer[] })[] = [];
  failNext?: Error;
  async send(msg: MailMessage) {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      throw e;
    }
    // copy the bytes now: the caller deletes the temp file after send() resolves
    const data = msg.attachments.map((a) => readFileSync(a.path));
    this.sent.push({ ...msg, attachmentData: data });
    return { messageId: `<memory-${this.sent.length}@queryforge.invalid>` };
  }
}

/** Parse and check recipients against the configured domain allowlist. */
export function checkRecipients(
  raw: string[] | string,
  cfg: Pick<AppConfig['scheduler'], 'recipientDomains' | 'maxRecipients'>,
): { ok: true; recipients: string[] } | { ok: false; message: string } {
  const list = (Array.isArray(raw) ? raw : raw.split(/[,;\s]+/))
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  const uniq = [...new Set(list)];
  if (!uniq.length) return { ok: false, message: 'Add at least one recipient.' };
  if (uniq.length > cfg.maxRecipients)
    return { ok: false, message: `At most ${cfg.maxRecipients} recipients are allowed.` };
  if (!cfg.recipientDomains.length)
    return {
      ok: false,
      message: 'Email delivery is disabled: SCHEDULE_RECIPIENT_DOMAINS is not configured.',
    };
  for (const r of uniq) {
    const m = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/.exec(r);
    if (!m) return { ok: false, message: `"${r}" is not a valid email address.` };
    if (!cfg.recipientDomains.includes(m[1]))
      return {
        ok: false,
        message: `${r}: only addresses at ${cfg.recipientDomains.join(', ')} are allowed.`,
      };
  }
  return { ok: true, recipients: uniq };
}
