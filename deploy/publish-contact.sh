#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Irazu — build, test and publish the contact service to the VM.
# Run from your PC (Git Bash on Windows works), in the repo root:
#     deploy/publish-contact.sh ubuntu@<vm-ip>     (or set IRAZU_HOST)
# Nothing is uploaded unless the tests pass and production dependencies have
# no high/critical advisories. On the VM the previous version is restored
# automatically if the new one does not answer /healthz.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

HOST="${1:-${IRAZU_HOST:-}}"
[[ -n $HOST ]] || { echo "usage: deploy/publish-contact.sh user@host   (or IRAZU_HOST=user@host)" >&2; exit 1; }
cd "$(dirname "$0")/../services/contact"

npm ci --no-audit --no-fund
npm test                                   # builds dist/ and runs the suite
npm audit --omit=dev --audit-level=high

pkg=$(mktemp "${TMPDIR:-/tmp}/irazu-contact.XXXXXX")
trap 'rm -f "$pkg"' EXIT
tar -czf "$pkg" dist/src package.json package-lock.json   # no tests, no node_modules
stamp=$(date -u +%Y%m%dT%H%M%SZ)

scp -q "$pkg" "$HOST:/tmp/irazu-contact-$stamp.tgz"
# shellcheck disable=SC2029  # expanded locally on purpose (fixed-format id)
ssh "$HOST" "sudo irazu-activate-contact /tmp/irazu-contact-$stamp.tgz"
