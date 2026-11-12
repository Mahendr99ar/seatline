import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** Resolves with the provider's message id once the mail is accepted. */
  send(mail: Mail): Promise<string>;
}

export function smtpMailer(url: string, from: string): Mailer {
  const transport = nodemailer.createTransport(url);
  return {
    async send(mail) {
      const info = await transport.sendMail({ from, ...mail });
      return info.messageId;
    },
  };
}

/** For local runs and demos without a mail server: the mail stays in the database and the log. */
export function logMailer(): Mailer {
  return {
    async send(mail) {
      console.log(`mail to ${mail.to}: ${mail.subject}`);
      return `log-${randomUUID()}`;
    },
  };
}
