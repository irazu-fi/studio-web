/* HTTP layer. Order of checks: origin → content type → size → rate limit → schema →
   bot heuristics → send. Every rejection is generic (no echo of the input) and nothing
   about the visitor is written to disk or to the logs. */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Config } from "./config.js";
import { buildMail, type Sender } from "./mailer.js";
import { RateLimiter } from "./ratelimit.js";
import { ContactSchema, looksLikeBot } from "./schema.js";

export type Deps = {
  config: Config;
  send: Sender;
  limiter: RateLimiter;
  /** Client IP. In production: the address Caddy reports (see server.ts). */
  clientIp: (c: Context) => string;
  now?: () => number;
  log?: (line: string) => void;
};

export const MAX_BODY_BYTES = 16 * 1024; // same as Caddy's request_body max_size

export function createApp(deps: Deps): Hono {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l: string) => console.log(l));
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
  });

  const reply = (c: Context, status: 200 | 400 | 403 | 405 | 413 | 415 | 429 | 502, outcome: string) => {
    log(`contact ${status} ${outcome}`); // outcome only — never the address or the text
    return c.json(status === 200 ? { ok: true } : { ok: false, error: outcome }, status);
  };

  // Local health check for systemd/monitoring. Caddy only proxies /api/contact.
  app.get("/healthz", c => c.text("ok"));

  app.post(
    "/api/contact",
    // 1. Same-origin only (CSRF defence; the site's own fetch always sends Origin).
    async (c, next) => {
      const origin = c.req.header("origin");
      if (!origin || !deps.config.allowedOrigins.includes(origin)) return reply(c, 403, "origin");
      // 2. JSON only (a plain HTML form post without JS gets a clear refusal).
      if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) return reply(c, 415, "content-type");
      await next();
    },
    // 3. Size guard (also enforced by Caddy).
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: c => reply(c, 413, "too-large") }),
    async c => {
      // 4. Rate limit per IP + global cap.
      const wait = deps.limiter.take(deps.clientIp(c), now());
      if (wait > 0) { c.header("Retry-After", String(wait)); return reply(c, 429, "rate-limited"); }

      // 5. Schema.
      let raw: unknown;
      try { raw = await c.req.json(); } catch { return reply(c, 400, "invalid"); }
      const parsed = ContactSchema.safeParse(raw);
      if (!parsed.success) return reply(c, 400, "invalid");

      // 6. Bots: same answer as a person, nothing sent.
      if (looksLikeBot(parsed.data, now())) return reply(c, 200, "dropped");

      // 7. Send.
      try {
        await deps.send(buildMail(parsed.data, deps.config, new Date(now())));
      } catch (err) {
        log(`contact smtp-error ${(err as { code?: string }).code ?? "unknown"}`);
        return reply(c, 502, "send-failed");
      }
      return reply(c, 200, "sent");
    },
  );

  app.all("/api/contact", c => { c.header("Allow", "POST"); return reply(c, 405, "method"); });
  app.notFound(c => c.json({ ok: false, error: "not-found" }, 404));
  app.onError((_err, c) => { log("contact 500 internal"); return c.json({ ok: false, error: "internal" }, 500); });
  return app;
}
