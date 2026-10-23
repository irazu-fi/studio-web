/* Configuration from environment variables, validated at startup (fail fast).
   On the server they come from /etc/irazu/contact.env (root-only, never in git). */
import { z } from "zod";

const bool = z.enum(["true", "false"]).transform(v => v === "true");

const Env = z.object({
  HOST: z.string().default("127.0.0.1"),              // only reachable through Caddy
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  ALLOWED_ORIGINS: z.string().default("https://irazu.fi"),   // comma-separated, exact match
  SMTP_HOST: z.string().default("smtp-relay.brevo.com"),
  SMTP_PORT: z.coerce.number().int().default(587),     // 587 = STARTTLS (required, see mailer.ts)
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  MAIL_FROM: z.string().default("Irazu <hello@irazu.fi>"),
  MAIL_TO: z.email().default("hello@irazu.fi"),
  // DRY_RUN=true: validate everything but don't send (local development).
  DRY_RUN: bool.default(false),
  // Rate limits: per client IP, and a global cap that protects the Brevo daily quota.
  RATE_PER_IP: z.coerce.number().int().min(1).default(5),
  RATE_WINDOW_MIN: z.coerce.number().int().min(1).default(10),
  RATE_GLOBAL_PER_HOUR: z.coerce.number().int().min(1).default(40),
});

export type Config = {
  host: string; port: number; allowedOrigins: string[];
  smtp: { host: string; port: number; user: string; pass: string };
  mailFrom: string; mailTo: string; dryRun: boolean;
  ratePerIp: number; rateWindowMs: number; rateGlobalPerHour: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    // Print variable names only — never values (they may hold secrets).
    const names = parsed.error.issues.map(i => i.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${names}`);
  }
  const e = parsed.data;
  if (!e.DRY_RUN && (!e.SMTP_USER || !e.SMTP_PASS)) {
    throw new Error("Invalid configuration: SMTP_USER and SMTP_PASS are required unless DRY_RUN=true");
  }
  return {
    host: e.HOST, port: e.PORT,
    allowedOrigins: e.ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean),
    smtp: { host: e.SMTP_HOST, port: e.SMTP_PORT, user: e.SMTP_USER, pass: e.SMTP_PASS },
    mailFrom: e.MAIL_FROM, mailTo: e.MAIL_TO, dryRun: e.DRY_RUN,
    ratePerIp: e.RATE_PER_IP, rateWindowMs: e.RATE_WINDOW_MIN * 60_000, rateGlobalPerHour: e.RATE_GLOBAL_PER_HOUR,
  };
}
