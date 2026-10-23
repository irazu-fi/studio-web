# Visit statistics — from server logs, no analytics script

The site loads no analytics script, sets no cookies and stores nothing in the
browser, so it needs no consent banner (Traficom guidance on Act 917/2014).
Statistics are counted on our own server from the Caddy access log, which is
already privacy-filtered by the Caddyfile:

- IP truncated (/24 for IPv4, /48 for IPv6), User-Agent and Cookie headers removed
- 14-day retention (`roll_keep_for 336h`)

Legal basis: legitimate interest (GDPR art. 6(1)(f)), stated in privacy.html §3.

## Tool

[GoAccess](https://goaccess.io/) on the VM, run on demand or weekly. Nothing
is published: the report is generated outside the web root and read over SSH.

```sh
# goaccess is installed by deploy/provision-vm.sh
mkdir -p ~/stats

# Weekly report (current + rotated logs, gz or plain)
zcat -f /var/log/caddy/access*.log* | goaccess - \
  --log-format=CADDY \
  --ignore-statics=req \
  --ignore-panel=HOSTS --ignore-panel=GEO_LOCATION \
  --ignore-panel=BROWSERS --ignore-panel=OS \
  --ignore-panel=REMOTE_USER \
  -o ~/stats/irazu-$(date +%G-W%V).html
```

Read it from your machine:

```sh
scp irazu-vm:stats/irazu-2026-W45.html .
```

## Rules

- **Never** serve the report from `/srv/site/dist` or any public path.
- **Never** use `--persist` / `--restore`: the GoAccess database would keep
  log lines (truncated IPs) beyond the 14 days promised in privacy.html.
- The `HOSTS` panel stays ignored so saved reports contain totals only, never IPs.
  That is why they can be kept longer than the logs.

## How to read the numbers

- Use **requests to pages** (`/`, `/fi/`, `/es/`, privacy, legal) as the main
  metric. "Unique visitors" is unreliable here: GoAccess groups by IP + date +
  User-Agent, and with truncated IPs and no User-Agent many people collapse into one.
- Bots cannot be filtered (no User-Agent), so totals are somewhat inflated.
  Read the trend, not the absolute number.
- Search Console (Google) and Bing Webmaster Tools add search queries and
  impressions without adding anything to the site.

## Verified

- 2026-10-19: GoAccess 1.8.1 (the Ubuntu 24.04 package) with `--log-format=CADDY`
  parsed every line of a log written by this Caddyfile on Caddy 2.10.2 (IPs masked,
  User-Agent and Cookie removed), plain and gzipped together, with the command above.
  The report contained no IP address. Check again once with the first real logs on
  the VM.
