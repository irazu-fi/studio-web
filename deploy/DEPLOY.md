# Deploying irazu.fi — Oracle Cloud (OCI), Frankfurt

One small VM runs everything: **Caddy** (HTTPS, static site, security headers, access
logs with masked IPs) and the **contact service** (`services/contact`, on 127.0.0.1:8787).
Email (Tuta) and its DNS records are untouched by any of this.

```
deploy/
  provision-vm.sh        on the VM, once (and again after changing the Caddyfile)
  publish-site.sh        on your PC: build → upload → switch release
  publish-contact.sh     on your PC: test → upload → restart service (auto-rollback)
  activate-site.sh       installed on the VM as irazu-activate-site
  activate-contact.sh    installed on the VM as irazu-activate-contact
  Caddyfile              copied to /etc/caddy/Caddyfile
  irazu-contact.service  systemd unit for the contact service
  CONTACT.md             contact form: Brevo key, service, checks
```

The PC scripts run in **Git Bash** (it has `ssh`, `scp` and `tar`) from the repo root,
with Node.js installed. `.gitattributes` keeps every file LF, so the scripts also run on
Linux after a Windows checkout.

---

## Day 1 — in this order

### 1. OCI account (console, region **Germany Central (Frankfurt)** `eu-frankfurt-1`)
1. **Billing → Budgets → Create budget**: 1 € per month, alert at 100 % of *actual*
   spend, to `ops@irazu.fi`. The account is Pay As You Go: Always Free resources cost
   nothing, anything else is billed — this alert is the safety net.
2. **Identity → Compartments**: create `irazu` and create everything below inside it.

### 2. Network
1. **Networking → Virtual cloud networks → Start VCN wizard → "Create VCN with
   Internet Connectivity"**. Name `irazu-vcn`, defaults otherwise.
2. Open the **public subnet's security list** and add ingress rules (source `0.0.0.0/0`):

   | Protocol | Port | Why |
   |---|---|---|
   | TCP | 80 | HTTP → HTTPS redirect and certificate challenge |
   | TCP | 443 | HTTPS |
   | UDP | 443 | HTTP/3 |

   SSH (TCP 22) is already there. If your connection has a fixed IP, change that rule's
   source to `<your-ip>/32`. SSH accepts keys only either way (provisioning sets that).

### 3. VM
**Compute → Instances → Create instance**
- Image: **Canonical Ubuntu 24.04** (not "Minimal").
- Shape: **VM.Standard.A1.Flex**, 1 OCPU / 6 GB (Always Free, ARM). If Frankfurt says
  *out of capacity*, try again later or use **VM.Standard.E2.1.Micro** (Always Free, x86,
  1 GB — enough for this site).
- Networking: `irazu-vcn`, public subnet, **assign a public IPv4 address: yes** (made
  permanent in step 4).
- SSH key: paste your **public** key (`~/.ssh/id_ed25519.pub`; create one in Git Bash
  with `ssh-keygen -t ed25519 -C "jose.chaves@irazu.fi"` if you do not have it).
  The private key never leaves your PC.
- Boot volume: default (47 GB is within Always Free).

### 4. Fixed IP
**Instance → Attached VNICs → primary VNIC → IPv4 addresses → Edit**: public IP type
**Reserved public IP**, create `irazu-ip`. Write the IP down; it is the one used for DNS
and for Brevo's *Authorized IPs* (outgoing mail leaves from it).

### 5. DNS in Webbikettu (Domainpark → zone editor)
Add, TTL 3600:

| Name | Type | Value |
|---|---|---|
| `irazu.fi.` | A | `<reserved IP>` |
| `www.irazu.fi.` | A | `<reserved IP>` |

**Do not touch** the MX, SPF (`v=spf1`), DKIM (`s1`, `s2`, `brevo1`, `brevo2`, `default` `._domainkey`),
`_dmarc`, `t-verify`, `brevo-code` or MTA-STS records. `mta-sts.irazu.fi` is a CNAME to Tuta:
do not create an A record with that name and do not serve it from Caddy.
Check with `nslookup irazu.fi 1.1.1.1` until it answers the new IP.

### 6. Provision the VM (PC, Git Bash, repo root)
```sh
scp -r deploy ubuntu@<IP>:~/deploy
ssh ubuntu@<IP> 'sudo bash ~/deploy/provision-vm.sh'
```
It updates the system, turns on automatic security updates (reboot at 02:30 UTC when a
kernel update needs it), opens 80/443 in the VM's own firewall (OCI's Ubuntu image blocks
them even when the security list allows them), sets SSH to keys only, installs Node.js 22
and Caddy from their signed repositories, the release helpers, the Caddyfile and the
contact service unit. A "coming soon" placeholder is served until step 7.

Caddy gets the certificate on its own once DNS points to the VM. If step 5 had not
propagated yet, it retries; nothing to do.

### 7. Publish the site
```sh
bash deploy/publish-site.sh ubuntu@<IP>
```
Packs only public files (no PDFs, no archives, no `services/`, no `deploy/`), uploads them
and switches the live site atomically.

### 8. Contact form
Follow **CONTACT.md → "Deploy (OCI, first time)"**: Brevo authorized IP + SMTP key →
`/etc/irazu/contact.env` → `publish-contact.sh` → `BACKEND_READY = true` → publish the site
again → one real test message.

### 9. Checks
- `https://irazu.fi`, `/fi/`, `/es/`, privacy and legal pages in the three languages.
- `http://irazu.fi` and `https://www.irazu.fi` both end at `https://irazu.fi/`.
- `curl -sI https://irazu.fi` shows CSP, HSTS (without `preload`), `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, and no `Server`.
- securityheaders.com: A or better. ssllabs.com/ssltest: A or better.
- Browser devtools → Network: no request leaves irazu.fi; Application → no cookies.
- Phone: the contact form sends; the email arrives with SPF/DKIM/DMARC pass.

---

## Every day after

| Task | Command (PC, Git Bash, repo root) |
|---|---|
| Publish site changes (commit first) | `bash deploy/publish-site.sh ubuntu@<IP>` |
| Undo the last site release | `ssh ubuntu@<IP> sudo irazu-activate-site --rollback` |
| List site releases (`*` = live; 5 kept) | `ssh ubuntu@<IP> sudo irazu-activate-site --list` |
| Publish contact service changes | `bash deploy/publish-contact.sh ubuntu@<IP>` (rolls back by itself if `/healthz` fails) |
| Change the Caddyfile | `scp -r deploy ubuntu@<IP>:~/deploy` then run step 6 again (validates before replacing) |
| Service log (outcomes only, no personal data) | `ssh ubuntu@<IP> journalctl -u irazu-contact -n 50` |

`export IRAZU_HOST=ubuntu@<IP>` in `~/.bashrc` lets you drop the argument.

## Visit statistics (no analytics script, no cookies)

The only source is Caddy's access log: IPs masked to /24 (IPv4) and /48 (IPv6), no
User-Agent, no cookies, kept 14 days. A report when you want one:
```sh
ssh ubuntu@<IP> 'sudo goaccess /var/log/caddy/access.log --log-format=CADDY -o /tmp/irazu-stats.html && sudo chown ubuntu /tmp/irazu-stats.html'
scp ubuntu@<IP>:/tmp/irazu-stats.html . && ssh ubuntu@<IP> rm /tmp/irazu-stats.html
```
It shows pages, languages, referrers and 404s. Browsers and operating systems show as
"unknown" — by design. The report is personal-data-light but stays on your PC; do not
publish it.

## Backups and recovery

Nothing on the VM is the only copy: the site and the scripts are in Git, the SMTP key can
be regenerated in Brevo. To rebuild from zero: new VM (step 3), move the reserved IP to it
(step 4, DNS unchanged), steps 6–8. Optional, before a big change: **Boot volume →
Create manual backup** (Always Free includes 5 volume backups; delete old ones).

## Security notes (OWASP ASVS L1, ISO 27001 Annex A as model — not certified)

- Releases are verified before switching (required files, no absolute or `..` paths,
  id format), switched atomically and kept for rollback.
- The contact service is only replaced after tests and `npm audit` (high/critical) pass
  on the PC; on the VM it rolls back automatically if it does not answer `/healthz`.
- Secrets: only in `/etc/irazu/contact.env` (root, 600). Never in the repo, the release
  archives or chat.
- Assets are not fingerprinted, so CSS, JS and HTML are revalidated on every visit (ETag);
  fonts are cached for a year, images for a week.
- HSTS has no `preload` on purpose (see the comment in the Caddyfile).
