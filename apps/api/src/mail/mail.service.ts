import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { describeError } from '../common/exception.filter';
import { maskEmail } from '../common/util';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Outbound email. Emails contain only links with single-use tokens, never
 * secrets or vault data.
 *  - smtp:    nodemailer (production)
 *  - console: prints the message to stdout (local development only; refused in production)
 *  - memory:  keeps messages in `outbox` (tests only)
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private readonly transporter: Transporter | null;
  readonly outbox: MailMessage[] = [];

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    if (cfg.MAIL_TRANSPORT === 'smtp') {
      this.transporter = nodemailer.createTransport({
        host: cfg.SMTP_HOST,
        port: cfg.SMTP_PORT,
        secure: cfg.SMTP_SECURE,
        requireTLS: cfg.SMTP_REQUIRE_TLS,
        auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASSWORD ?? '' } : undefined,
      });
    } else {
      this.transporter = null;
    }
  }

  async send(msg: MailMessage): Promise<void> {
    switch (this.cfg.MAIL_TRANSPORT) {
      case 'memory':
        this.outbox.push(msg);
        return;
      case 'console':
        // Development only (config refuses it in production). Written straight to
        // stdout, NOT through the structured logger, so links never reach log storage.
        process.stdout.write(`\n----- [dev mail] to: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.text}\n-----\n`);
        return;
      case 'smtp':
        await this.transporter!.sendMail({ from: this.cfg.MAIL_FROM, to: msg.to, subject: msg.subject, text: msg.text });
        return;
    }
  }

  /** Fire-and-forget (keeps response timing independent of mail delivery). */
  sendInBackground(msg: MailMessage): void {
    this.send(msg).catch((e: unknown) => {
      this.logger.error({ to: maskEmail(msg.to), err: describeError(e) }, 'mail delivery failed');
    });
  }

  link(path: string, token: string): string {
    // token in the URL fragment: never sent to web servers / proxies / referrers
    return `${this.cfg.WEB_APP_URL}${path}#token=${encodeURIComponent(token)}`;
  }

  registrationCodeEmail(to: string, code: string): MailMessage {
    // No link: a URL carrying the email + code would end up in web server / proxy logs.
    return {
      to,
      subject: 'Your PassVault verification code',
      text:
        `Your PassVault verification code is:\n\n    ${code}\n\nEnter it in the PassVault sign-up screen within 15 minutes.\n\n` +
        `If you did not try to create a PassVault account, ignore this email; no account is created without this code.\n`,
    };
  }

  alreadyRegisteredEmail(to: string): MailMessage {
    return {
      to,
      subject: 'PassVault registration attempt',
      text:
        `Someone tried to create a PassVault account with this email address, but an account already exists.\n\n` +
        `If this was you, sign in at ${this.cfg.WEB_APP_URL} or use account recovery there if you forgot your master password.\n` +
        `If it was not you, you can ignore this email; nothing was changed.\n`,
    };
  }

  recoveryEmail(to: string, token: string): MailMessage {
    return {
      to,
      subject: 'PassVault account recovery',
      text:
        `An account recovery was requested for this email address.\n\nContinue here (valid for 30 minutes, single use):\n\n` +
        `${this.link('/recover', token)}\n\nYou will need your two-factor code or an MFA recovery code. ` +
        `If you did not request this, ignore this email; your account is unchanged.\n`,
    };
  }
}
