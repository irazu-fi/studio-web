/* Entry point: node dist/src/server.js (run by systemd, see deploy/irazu-contact.service). */
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { dryRunSender, smtpSender } from "./mailer.js";
import { RateLimiter } from "./ratelimit.js";

const config = loadConfig();
const limiter = new RateLimiter(config.ratePerIp, config.rateWindowMs, config.rateGlobalPerHour);
setInterval(() => limiter.sweep(), 60_000).unref();

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/* The service listens on localhost behind Caddy, so the TCP peer is Caddy itself.
   X-Forwarded-For is trusted only in that case, and only its LAST entry (the one Caddy
   adds); anything a client puts earlier in the header is ignored. */
function clientIp(c: Context): string {
  const peer = getConnInfo(c).remote.address ?? "unknown";
  if (!LOOPBACK.has(peer)) return peer;
  const xff = c.req.header("x-forwarded-for");
  const last = xff?.split(",").map(s => s.trim()).filter(Boolean).pop();
  return last ?? peer;
}

const app = createApp({ config, send: config.dryRun ? dryRunSender : smtpSender(config), limiter, clientIp });

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, info => {
  console.log(`irazu-contact listening on ${info.address}:${info.port}${config.dryRun ? " (DRY_RUN: nothing is sent)" : ""}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
}
