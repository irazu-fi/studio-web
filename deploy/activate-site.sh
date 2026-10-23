#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Irazu — activate a site release on the VM (installed as /usr/local/sbin/irazu-activate-site).
#   irazu-activate-site <archive.tgz> <release-id>   unpack and switch to a new release
#   irazu-activate-site --rollback                    switch back to the previous release
#   irazu-activate-site --list                        show releases (* = live)
# The live site is the symlink /srv/site/dist → releases/<id>; the switch is atomic
# (rename of a symlink), so visitors never see a half-copied site.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

SITE_ROOT="${SITE_ROOT:-/srv/site}"   # overridable for tests
KEEP="${KEEP:-5}"                     # releases kept on disk (for rollback)
REL_DIR="$SITE_ROOT/releases"

die() { echo "error: $*" >&2; exit 1; }
current() { [[ -L $SITE_ROOT/dist ]] && basename "$(readlink "$SITE_ROOT/dist")" || true; }
switch_to() { # atomic: create a new symlink, then rename it over the old one
  ln -sfn "releases/$1" "$SITE_ROOT/dist.next"
  mv -Tf "$SITE_ROOT/dist.next" "$SITE_ROOT/dist"
  echo "live: $1"
}
releases() { find "$REL_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort; }

case "${1:-}" in
  --list)
    cur=$(current)
    releases | while read -r r; do [[ $r == "$cur" ]] && echo "* $r" || echo "  $r"; done
    ;;
  --rollback)
    cur=$(current)
    prev=$(releases | awk -v c="$cur" '$0 == c {print p; exit} {p = $0}')
    [[ -n $prev ]] || die "no release before '$cur'"
    switch_to "$prev"
    ;;
  ""|-h|--help)
    sed -n '3,8p' "$0"; exit 0
    ;;
  *)
    archive=$1; id=${2:-}
    [[ $id =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "release id must look like 20270115T093000Z"
    [[ -f $archive ]] || die "archive not found: $archive"
    dest="$REL_DIR/$id"
    [[ ! -e $dest ]] || die "release $id already exists"
    mkdir -p "$dest"
    # Refuse archives with absolute paths or '..' (defence in depth; we build them ourselves).
    if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then rm -rf "$dest"; die "unsafe paths in archive"; fi
    tar -xzf "$archive" -C "$dest" --no-same-owner --no-same-permissions
    for f in index.html fi/index.html es/index.html privacy.html assets/css/styles.css; do
      [[ -f $dest/$f ]] || { rm -rf "$dest"; die "release incomplete: missing $f"; }
    done
    chmod -R u=rwX,go=rX "$dest"
    switch_to "$id"
    rm -f "$archive"
    # Prune: keep the newest $KEEP releases, never the live one.
    cur=$(current)
    releases | head -n "-$KEEP" | while read -r r; do [[ $r == "$cur" ]] || rm -rf "${REL_DIR:?}/$r"; done
    ;;
esac
