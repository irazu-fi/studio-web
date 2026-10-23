#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Irazu — install a new build of the contact service on the VM
# (installed as /usr/local/sbin/irazu-activate-contact).
#   irazu-activate-contact <archive.tgz>
# Unpacks into /srv/contact.new, installs production dependencies, swaps it in,
# restarts the service and checks /healthz. If the check fails, the previous
# version is restored automatically.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

APP="${APP:-/srv/contact}"            # overridable for tests
ENV_FILE="${ENV_FILE:-/etc/irazu/contact.env}"
SERVICE=irazu-contact
archive=${1:?usage: irazu-activate-contact <archive.tgz>}
[[ -f $archive ]] || { echo "archive not found: $archive" >&2; exit 1; }

rm -rf "$APP.new"; mkdir -p "$APP.new"
if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then echo "unsafe paths in archive" >&2; exit 1; fi
tar -xzf "$archive" -C "$APP.new" --no-same-owner --no-same-permissions
[[ -f $APP.new/dist/src/server.js && -f $APP.new/package-lock.json ]] || { echo "incomplete build" >&2; exit 1; }
(cd "$APP.new" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
chmod -R u=rwX,go=rX "$APP.new"

healthy() { for _ in $(seq 1 20); do curl -fsS --max-time 2 http://127.0.0.1:8787/healthz >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }

rm -rf "$APP.prev"
[[ -d $APP ]] && mv "$APP" "$APP.prev"
mv "$APP.new" "$APP"

if [[ ! -f $ENV_FILE ]]; then
  echo "Installed. $ENV_FILE is missing, so the service was not started (see deploy/CONTACT.md)."
  rm -f "$archive"; exit 0
fi

systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"
if healthy; then
  echo "contact service: healthy"
  rm -f "$archive"
else
  echo "contact service did not become healthy — rolling back" >&2
  journalctl -u "$SERVICE" -n 20 --no-pager >&2 || true
  if [[ -d $APP.prev ]]; then rm -rf "$APP"; mv "$APP.prev" "$APP"; systemctl restart "$SERVICE"; fi
  exit 1
fi
