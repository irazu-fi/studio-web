/* Server-side validation of the contact form. The browser checks are a courtesy;
   this schema is the real gate (OWASP ASVS V2 / V5: validate on the server, allow-list
   the shape, bound every length). Same contract as assets/js/main.js. */
import { z } from "zod";

// Remove control characters except tab and newline; normalise line endings and Unicode.
export function cleanText(s: string): string {
  return s.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g, "").trim();
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/; // same rule as the browser

export const ContactSchema = z.strictObject({
  email: z.string().max(254).transform(s => s.trim())
    .refine(s => EMAIL_RE.test(s) && !/[\r\n]/.test(s), "email"),
  briefing: z.string().max(4000).transform(cleanText)
    .refine(s => s.length >= 20 && s.length <= 4000, "briefing"),
  privacy_consent: z.literal(true),                 // GDPR: explicit, never pre-ticked
  company_website: z.string().max(200).optional(),  // honeypot: must stay empty
  form_ts: z.string().regex(/^\d{10,14}$/),          // ms timestamp set when the page loaded
  lang: z.enum(["en", "fi", "es"]).default("en"),
});

export type ContactInput = z.output<typeof ContactSchema>;

/* Bot heuristics. A bot gets the same "ok" answer as a person but nothing is sent,
   so it learns nothing. */
export const MIN_FILL_MS = 3000;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function looksLikeBot(input: ContactInput, now = Date.now()): boolean {
  if (input.company_website && input.company_website.trim() !== "") return true;
  const started = Number(input.form_ts);
  const elapsed = now - started;
  return !(elapsed >= MIN_FILL_MS && elapsed <= MAX_AGE_MS);
}
