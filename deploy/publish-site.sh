#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Irazu — publish the static site to the VM as a new release.
# Run from your PC (Git Bash on Windows works), in the repo root:
#     deploy/publish-site.sh ubuntu@<vm-ip>        (or set IRAZU_HOST)
# Builds the language pages, packs only the public files, uploads them and
# switches the live site atomically. Undo with:
#     ssh ubuntu@<vm-ip> sudo irazu-activate-site --rollback
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

HOST="${1:-${IRAZU_HOST:-}}"
[[ -n $HOST ]] || { echo "usage: deploy/publish-site.sh user@host   (or IRAZU_HOST=user@host)" >&2; exit 1; }
cd "$(dirname "$0")/.."

node tools/build-i18n.mjs

# Deploy what is committed: warn about local changes (they would be published too).
if command -v git >/dev/null && [[ -n $(git status --porcelain -- index.html "fi" "es" privacy.html legal.html assets robots.txt sitemap.xml 2>/dev/null) ]]; then
  echo "warning: uncommitted changes in site files — they will be published as they are on disk." >&2
fi
if grep -q 'const BACKEND_READY = false' assets/js/main.js; then
  echo "note: contact form is in prototype mode (BACKEND_READY = false in assets/js/main.js)."
fi

id=$(date -u +%Y%m%dT%H%M%SZ)
pkg=$(mktemp "${TMPDIR:-/tmp}/irazu-site.XXXXXX")
trap 'rm -f "$pkg"' EXIT
# Public files only. Brand PDFs and any stray archives stay out of the web root.
tar -czf "$pkg" --exclude='*.zip' --exclude='*.pdf' \
  index.html privacy.html legal.html robots.txt sitemap.xml "fi" "es" assets
echo "release $id: $(du -h "$pkg" | cut -f1)"

scp -q "$pkg" "$HOST:/tmp/irazu-site-$id.tgz"
# shellcheck disable=SC2029  # expanded locally on purpose (fixed-format id)
ssh "$HOST" "sudo irazu-activate-site /tmp/irazu-site-$id.tgz $id"
