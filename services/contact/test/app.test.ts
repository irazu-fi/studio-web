import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { SMTPServer } from "smtp-server";
import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { buildMail, smtpSender, type Mail } from "../src/mailer.js";
import { RateLimiter } from "../src/ratelimit.js";
import { ContactSchema } from "../src/schema.js";

const ORIGIN = "https://irazu.fi";
const NOW = 1_800_000_000_000;
const config: Config = loadConfig({ DRY_RUN: "true", MAIL_TO: "hello@irazu.fi" } as NodeJS.ProcessEnv);

function setup(opts: { send?: (m: Mail) => Promise<void>; perIp?: number; global?: number } = {}) {
  const sent: Mail[] = [];
  const logs: string[] = [];
  const app = createApp({
    config,
    send: opts.send ?? (async m => { sent.push(m); }),
    limiter: new RateLimiter(opts.perIp ?? 5, 600_000, opts.global ?? 40),
    clientIp: c => c.req.header("x-test-ip") ?? "203.0.113.7",
    now: () => NOW,
    log: l => logs.push(l),
  });
  return { app, sent, logs };
}

const valid = (over: Record<string, unknown> = {}) => ({
  email: "visitor@example.fi",
  briefing: "Our gate queue is slow in the mornings; we need faster container checks.",
  privacy_consent: true,
  company_website: "",
  form_ts: String(NOW - 60_000),
  lang: "fi",
  ...over,
});

const post = (app: ReturnType<typeof setup>["app"], body: unknown, headers: Record<string, string> = {}) =>
  app.request("/api/contact", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("contact endpoint", () => {
  test("valid briefing → 200 and exactly one plain-text email", async () => {
    const { app, sent, logs } = setup();
    const res = await post(app, valid());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(sent.length, 1);
    const m = sent[0]!;
    assert.equal(m.to, "hello@irazu.fi");
    assert.equal(m.from, "Irazu <hello@irazu.fi>");
    assert.equal(m.replyTo, "visitor@example.fi");
    assert.match(m.subject, /\(FI\)$/);
    assert.match(m.text, /Our gate queue is slow/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    // Logs never contain the address or the text.
    assert.ok(logs.every(l => !l.includes("visitor@") && !l.includes("gate queue")));
  });

  test("honeypot filled → same 200 answer, nothing sent", async () => {
    const { app, sent } = setup();
    const res = await post(app, valid({ company_website: "http://spam.example" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(sent.length, 0);
  });

  test("submitted faster than 3 s, or with a stale/future timestamp → dropped silently", async () => {
    const { app, sent } = setup();
    for (const ts of [NOW - 1000, NOW + 60_000, NOW - 2 * 86_400_000]) {
      const res = await post(app, valid({ form_ts: String(ts) }));
      assert.equal(res.status, 200);
    }
    assert.equal(sent.length, 0);
  });

  test("schema rejections → 400 without echoing input", async () => {
    const { app, sent } = setup({ perIp: 100 });
    const cases: Record<string, unknown>[] = [
      valid({ privacy_consent: false }),
      valid({ privacy_consent: "true" }),
      valid({ email: "not-an-email" }),
      valid({ email: "a@b.fi\r\nBcc: victim@example.com" }),
      valid({ briefing: "too short" }),
      valid({ briefing: "x".repeat(4001) }),
      valid({ lang: "de" }),
      valid({ form_ts: "yesterday" }),
      { ...valid(), extra: "field" },
    ];
    for (const body of cases) {
      const res = await post(app, body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.deepEqual(await res.json(), { ok: false, error: "invalid" });
    }
    const bad = await post(app, "{not json");
    assert.equal(bad.status, 400);
    assert.equal(sent.length, 0);
  });

  test("foreign or missing Origin → 403 (CSRF)", async () => {
    const { app, sent } = setup();
    assert.equal((await post(app, valid(), { origin: "https://evil.example" })).status, 403);
    const noOrigin = await app.request("/api/contact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(valid()) });
    assert.equal(noOrigin.status, 403);
    assert.equal(sent.length, 0);
  });

  test("non-JSON body → 415; oversized body → 413; GET → 405", async () => {
    const { app } = setup();
    assert.equal((await post(app, "email=a", { "content-type": "application/x-www-form-urlencoded" })).status, 415);
    assert.equal((await post(app, valid({ briefing: "x".repeat(20_000) }))).status, 413);
    const get = await app.request("/api/contact");
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("allow"), "POST");
  });

  test("rate limit: 6th request from the same IP within 10 min → 429 with Retry-After", async () => {
    const { app, sent } = setup();
    for (let i = 0; i < 5; i++) assert.equal((await post(app, valid())).status, 200);
    const res = await post(app, valid());
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("retry-after")) > 0);
    assert.equal((await post(app, valid(), { "x-test-ip": "198.51.100.9" })).status, 200); // other IP unaffected
    assert.equal(sent.length, 6);
  });

  test("global hourly cap protects the Brevo quota", async () => {
    const { app } = setup({ perIp: 100, global: 3 });
    for (let i = 0; i < 3; i++) assert.equal((await post(app, valid(), { "x-test-ip": `192.0.2.${i}` })).status, 200);
    assert.equal((await post(app, valid(), { "x-test-ip": "192.0.2.99" })).status, 429);
  });

  test("SMTP failure → 502 so the page shows 'write to hello@irazu.fi'", async () => {
    const { app, logs } = setup({ send: async () => { throw Object.assign(new Error("boom"), { code: "ECONNECTION" }); } });
    const res = await post(app, valid());
    assert.equal(res.status, 502);
    assert.ok(logs.includes("contact smtp-error ECONNECTION"));
  });

  test("control characters are removed, line breaks kept", () => {
    const input = ContactSchema.parse(valid({ briefing: "Line one\r\nLine\u0007 two\u2028 end padding text" }));
    const m = buildMail(input, config);
    assert.match(m.text, /Line one\nLine two end padding text/);
  });

  test("config: refuses to start without SMTP credentials unless DRY_RUN", () => {
    assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), /SMTP_USER and SMTP_PASS/);
    assert.throws(() => loadConfig({ DRY_RUN: "true", PORT: "abc" } as NodeJS.ProcessEnv), /PORT/);
  });
});

/* Real SMTP round trip against a local server that only accepts mail over STARTTLS. */
describe("SMTP delivery", () => {
  const dir = mkdtempSync(join(tmpdir(), "smtp-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "1",
    "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")], { stdio: "ignore" });
  const received: { raw: string; secure: boolean; user: string | undefined; rcpt: string[] }[] = [];

  // startTls=false: STARTTLS is really unavailable (not just hidden), like a misconfigured
  // or downgraded relay. The client must then refuse to send.
  const makeServer = (startTls: boolean) => new SMTPServer({
    ...(startTls ? { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }
                 : { disabledCommands: ["STARTTLS"], allowInsecureAuth: true }),
    authMethods: ["PLAIN", "LOGIN"],
    onAuth(auth, _s, cb) { auth.username === "u" && auth.password === "p" ? cb(null, { user: auth.username }) : cb(new Error("bad auth")); },
    onData(stream, session, cb) {
      let raw = ""; stream.on("data", d => { raw += d; });
      stream.on("end", () => { received.push({ raw, secure: session.secure, user: session.user as string | undefined, rcpt: session.envelope.rcptTo.map(r => r.address) }); cb(); });
    },
  });
  const tlsServer = makeServer(true), plainServer = makeServer(false);
  let tlsPort = 0, plainPort = 0;

  before(async () => {
    await new Promise<void>(r => tlsServer.listen(0, "127.0.0.1", () => r()));
    await new Promise<void>(r => plainServer.listen(0, "127.0.0.1", () => r()));
    tlsPort = (tlsServer.server.address() as { port: number }).port;
    plainPort = (plainServer.server.address() as { port: number }).port;
  });
  after(() => { tlsServer.close(); plainServer.close(); });

  const cfgFor = (port: number): Config => ({ ...config, dryRun: false, smtp: { host: "127.0.0.1", port, user: "u", pass: "p" } });

  test("sends over STARTTLS with auth; message is text/plain with Reply-To", async () => {
    const send = smtpSender(cfgFor(tlsPort), { rejectUnauthorized: false });
    const { app } = setup({ send });
    const res = await post(app, valid({ briefing: "Ääkköset toimivat: konttiterminaali ja <b>ei HTML:ää</b>." }));
    assert.equal(res.status, 200);
    const msg = received.at(-1)!;
    assert.equal(msg.secure, true);
    assert.equal(msg.user, "u");
    assert.deepEqual(msg.rcpt, ["hello@irazu.fi"]);
    assert.match(msg.raw, /^Reply-To: visitor@example\.fi/m);
    assert.match(msg.raw, /^Content-Type: text\/plain; charset=utf-8/m);
    assert.doesNotMatch(msg.raw, /text\/html/);
  });

  test("refuses to send when the server offers no STARTTLS → 502", async () => {
    const before = received.length;
    const send = smtpSender(cfgFor(plainPort), { rejectUnauthorized: false });
    const { app } = setup({ send });
    const res = await post(app, valid());
    assert.equal(res.status, 502);
    assert.equal(received.length, before);
  });
});
