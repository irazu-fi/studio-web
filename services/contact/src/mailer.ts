/* Builds and sends the notification email: plain text only (no HTML, so nothing the
   visitor typed can be rendered as markup or carry a tracking pixel). The visitor's
   address goes in Reply-To; From is always our own authenticated domain (DKIM/DMARC). */
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "./config.js";
import type { ContactInput } from "./schema.js";

export type Mail = { from: string; to: string; replyTo: string; subject: string; text: string; headers: Record<string, string> };
export type Sender = (mail: Mail) => Promise<void>;

const LANG_NAME = { en: "English", fi: "Finnish", es: "Spanish" } as const;

export function buildMail(input: ContactInput, cfg: Pick<Config, "mailFrom" | "mailTo">, now = new Date()): Mail {
  const received = now.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  return {
    from: cfg.mailFrom,
    to: cfg.mailTo,
    replyTo: input.email,
    subject: `[irazu.fi] New briefing (${input.lang.toUpperCase()})`,
    text: [
      "New briefing from the irazu.fi contact form.",
      "",
      `From:     ${input.email}`,
      `Language: ${LANG_NAME[input.lang]}`,
      `Received: ${received}`,
      "Consent:  privacy policy accepted",
      "",
      "─".repeat(60),
      input.briefing,
      "─".repeat(60),
      "",
      "Reply to this email to answer the sender directly.",
      "Not stored anywhere else: delete this email when the enquiry is closed (see privacy policy, §4).",
    ].join("\n"),
    headers: { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" },
  };
}

// `tlsForTests` exists only so the test suite can talk to a local server with a
// self-signed certificate. Production code never passes it.
export function smtpSender(cfg: Config, tlsForTests?: { rejectUnauthorized: boolean }): Sender {
  const transport: Transporter = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.port === 465,     // 465 = implicit TLS
    requireTLS: cfg.smtp.port !== 465, // 587: refuse to send if STARTTLS is not offered
    auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
    tls: { minVersion: "TLSv1.2", ...tlsForTests },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  });
  return async (mail) => { await transport.sendMail(mail); };
}

/* DRY_RUN: nothing leaves the machine. Prints only that a message would be sent
   (not its content: logs must not hold personal data). */
export const dryRunSender: Sender = async (mail) => {
  console.log(`[dry-run] would send "${mail.subject}" (${mail.text.length} chars)`);
};
