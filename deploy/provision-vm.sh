#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Irazu — prepare a fresh OCI VM (Ubuntu 24.04) for irazu.fi.
# Run ON THE VM, from a copy of the repo's deploy/ folder:
#     scp -r deploy ubuntu@<ip>:~/deploy && ssh ubuntu@<ip> 'sudo ~/deploy/provision-vm.sh'
# Idempotent: safe to run again (e.g. after editing the Caddyfile).
# See deploy/DEPLOY.md for the full first-day order.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
# shellcheck disable=SC1091
. /etc/os-release
[[ ${ID:-} == ubuntu ]] || { echo "Ubuntu expected, found ${ID:-unknown}." >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE_MAJOR=22
export DEBIAN_FRONTEND=noninteractive
step() { printf '\n── %s\n' "$*"; }

step "1/8 System updates + automatic security updates"
apt-get update -q
apt-get -yq upgrade
apt-get -yq install ca-certificates curl gnupg debian-keyring debian-archive-keyring \
  apt-transport-https unattended-upgrades iptables-persistent netfilter-persistent goaccess
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
# Kernel updates need a reboot: do it at a quiet hour (Caddy and the service start on boot).
cat > /etc/apt/apt.conf.d/52irazu-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "02:30";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF

step "2/8 Package repositories: Caddy (official) and Node.js ${NODE_MAJOR} (NodeSource), signed keyrings"
install -d -m 755 /etc/apt/keyrings
if [[ ! -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]]; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
fi
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
if [[ ! -f /etc/apt/keyrings/nodesource.gpg ]]; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
fi
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update -q
apt-get -yq install caddy nodejs
node --version; caddy version

step "3/8 Host firewall: open 80/tcp, 443/tcp and 443/udp (HTTP/3)"
# OCI Ubuntu images ship iptables rules that allow only SSH and REJECT the rest.
# New rules go just before that REJECT. The OCI security list must allow the same ports.
open_port() { # $1 = iptables|ip6tables, $2 = tcp|udp, $3 = port
  local ipt=$1 proto=$2 port=$3 pos
  "$ipt" -C INPUT -p "$proto" --dport "$port" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null && return 0
  pos=$("$ipt" -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')
  if [[ -n $pos ]]; then "$ipt" -I INPUT "$pos" -p "$proto" --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
  else "$ipt" -A INPUT -p "$proto" --dport "$port" -m conntrack --ctstate NEW -j ACCEPT; fi
}
for ipt in iptables ip6tables; do
  open_port "$ipt" tcp 80; open_port "$ipt" tcp 443; open_port "$ipt" udp 443
done
netfilter-persistent save

step "4/8 SSH: keys only, no root login"
cat > /etc/ssh/sshd_config.d/10-irazu.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
X11Forwarding no
MaxAuthTries 3
EOF
sshd -t && systemctl reload ssh

step "5/8 Directories"
install -d -m 755 /srv/site /srv/site/releases /srv/contact
install -d -m 700 /etc/irazu
install -d -m 750 -o caddy -g caddy /var/log/caddy
if [[ ! -e /srv/site/dist ]]; then
  # Placeholder until the first publish, so Caddy has something to serve. Its id sorts
  # before every real release, so rollback and pruning treat it as the oldest one.
  ph=/srv/site/releases/00000000T000000Z
  install -d -m 755 "$ph"
  printf '%s\n' '<!doctype html><html lang="en"><meta charset="utf-8"><title>Irazu</title><p>Irazu — coming soon.</p></html>' > "$ph/index.html"
  ln -s releases/00000000T000000Z /srv/site/dist
fi

step "6/8 Release helpers"
install -m 755 "$HERE/activate-site.sh"    /usr/local/sbin/irazu-activate-site
install -m 755 "$HERE/activate-contact.sh" /usr/local/sbin/irazu-activate-contact

step "7/8 Caddy configuration"
caddy validate --config "$HERE/Caddyfile" --adapter caddyfile   # check before replacing the live one
install -m 644 "$HERE/Caddyfile" /etc/caddy/Caddyfile
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

step "8/8 Contact service unit (enabled later, once /etc/irazu/contact.env exists)"
install -m 644 "$HERE/irazu-contact.service" /etc/systemd/system/irazu-contact.service
systemctl daemon-reload

cat <<'EOF'

Done. Next (deploy/DEPLOY.md):
  • From your PC:  deploy/publish-site.sh ubuntu@<ip>
  • Contact form:  deploy/CONTACT.md, "Deploy (OCI, first time)"
EOF
