# Contact form service — `services/contact`

Small Node service behind Caddy that receives the contact form, filters bots and sends
**one plain-text email** to `hello@irazu.fi` through Brevo SMTP. It stores nothing:
no database, no files, no personal data in the logs.

```
browser ── POST /api/contact (JSON) ──▶ Caddy (TLS, 16 KB limit) ──▶ 127.0.0.1:8787 ──▶ Brevo SMTP (587, STARTTLS) ──▶ hello@irazu.fi
```

## What it checks (in order)

| Step | Rule | Answer |
|---|---|---|
| Origin | `Origin` header must be exactly `https://irazu.fi` (CSRF) | 403 |
| Type | `Content-Type: application/json` only | 415 |
| Size | body ≤ 16 KB (Caddy enforces it too) | 413 |
| Rate | 5 per IP per 10 min; 40 per hour in total (Brevo free plan: 300/day) | 429 + `Retry-After` |
| Schema (Zod, strict) | email ≤ 254 and no line breaks; briefing 20–4000 chars after cleaning; `privacy_consent === true`; `lang` en/fi/es; no unknown fields | 400 (no echo of the input) |
| Bots | honeypot `company_website` filled, or form sent < 3 s after load / timestamp older than 24 h or in the future | 200 `{ok:true}`, **nothing sent** |
| Send | SMTP with `requireTLS` (refuses to send unencrypted), 10–20 s timeouts | 200, or 502 → page says "write to hello@irazu.fi" |

The email: `From: Irazu <hello@irazu.fi>` (DKIM by Brevo on irazu.fi), `Reply-To:` the
visitor, `text/plain` only (no HTML, no tracking pixel, nothing the visitor typed is
rendered as markup). Control characters are stripped; line breaks are kept.

IPs for rate limiting are kept only in memory, hashed with a random key that changes on
every restart. Logs contain one line per request with the outcome only, e.g.
`contact 200 sent`, `contact 429 rate-limited`.

## Develop and test

```sh
cd services/contact
npm ci
npm test                         # builds + 13 tests (incl. a real SMTP round trip over STARTTLS)
DRY_RUN=true ALLOWED_ORIGINS=http://localhost:8080 npm start   # validates, sends nothing
```

`npm test` needs `openssl` on the PATH (it creates a throw-away certificate for the
local SMTP test server).

## Configuration

Environment variables, validated at start-up (the service refuses to start with a bad
value or without SMTP credentials unless `DRY_RUN=true`). Template:
`services/contact/.env.example`. In production they live in `/etc/irazu/contact.env`,
`root:root`, mode `600` — never in the repo, never in chat.

## Deploy (OCI, first time)

Prerequisites: the VM is provisioned (`deploy/DEPLOY.md`, steps 1–7). That installed
Node.js 22, Caddy with `deploy/Caddyfile`, the systemd unit and the release helper.

1. **Brevo, in this order** (also in stack-decisions "Pendiente"):
   1. Settings → Security → Authorized IPs: add the VM's **reserved public IP**
      (outgoing mail leaves from it).
   2. Settings → SMTP & API → Generate SMTP key (name it `irazu-web-oci`). Copy it
      straight into the next step — not into a file on your PC, not into chat.
   3. On the VM, create the config (it opens an editor; paste the template from
      `services/contact/.env.example`, fill `SMTP_USER` and `SMTP_PASS`, save):
      ```sh
      ssh ubuntu@<IP>
      sudo install -m 600 -o root -g root /dev/null /etc/irazu/contact.env
      sudo nano /etc/irazu/contact.env
      ```
   4. Settings → SMTP & API → **Activate for SMTP keys** (block unauthorised IPs).
2. **Build, test and install** (PC, Git Bash, repo root):
   ```sh
   bash deploy/publish-contact.sh ubuntu@<IP>
   ```
   It runs the 13 tests and `npm audit` first; on the VM it installs production
   dependencies only, starts the service and checks `/healthz` (→ `contact service:
   healthy`). If the check fails it restores the previous version and prints the log.
3. **Check on the VM**: `journalctl -u irazu-contact -n 20` shows
   `irazu-contact listening on 127.0.0.1:8787` and **no** `DRY_RUN` note.
4. **Turn the form on**: in `assets/js/main.js` set `BACKEND_READY = true`, commit, then
   `bash deploy/publish-site.sh ubuntu@<IP>`.
5. **Check one real message** (from a phone, not the server):
   - the page shows the "Thank you" message in its language;
   - in Zoho, "Show original": SPF/DKIM/DMARC **pass**, DKIM `d=irazu.fi`;
   - the message is `text/plain` and links are **not** rewritten by Brevo (no click/open
     tracking). If they are, disable tracking in Brevo before going live;
   - Zoho did not quarantine it (sender name "Irazu" is on the protected list for hello@).
6. Rotating the key: generate a new one in Brevo, update `/etc/irazu/contact.env`,
   `sudo systemctl restart irazu-contact`, then delete the old key in Brevo.

## Security notes (OWASP ASVS L1/L2, not certified)

- Same-origin only, JSON only, strict schema, bounded sizes, generic errors.
- No secrets in the repo; config validated at start; SMTP over TLS ≥ 1.2 required.
- Least-privilege systemd unit (`DynamicUser`, read-only system, no capabilities);
  `systemd-analyze security` exposure 1.3/10.
- Listens on 127.0.0.1 only; Caddy is the only way in. `X-Forwarded-For` is trusted only
  from loopback and only its last entry (added by Caddy).
- Production dependencies: hono, @hono/node-server, zod, nodemailer — pinned in
  `package-lock.json`; `npm audit --omit=dev` before each deploy.
