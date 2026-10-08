#!/usr/bin/env bash
# One-time trust bootstrap for a new server — the ONLY manual PassVault step.
# Installs the fixed CI entry point and authorizes the CI deploy key for it.
# Everything else is applied by the Deploy workflow on every deploy.
#
#   scp deploy/server/bootstrap.sh deploy/server/ci-entry.sh root@SERVER:/tmp/
#   ssh root@SERVER 'bash /tmp/bootstrap.sh "ssh-ed25519 AAAA… passvault-ci-deploy" && rm /tmp/bootstrap.sh /tmp/ci-entry.sh'
#
# Prerequisites on the host: Docker (with compose), nginx, certbot (nginx plugin),
# PostgreSQL if DATABASE_URL points at this host, python3, curl, envsubst (gettext-base).
set -euo pipefail
PUBKEY="${1:?usage: bootstrap.sh \"ssh-ed25519 AAAA… comment\"}"
HERE="$(cd "$(dirname "$0")" && pwd)"
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ "$PUBKEY" =~ ^ssh-(ed25519|rsa)\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || { echo "not an SSH public key" >&2; exit 1; }
for c in docker nginx certbot python3 curl envsubst; do command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 1; }; done

install -d -m 0755 /opt/passvault /opt/passvault/bin /opt/passvault/releases /opt/passvault/web
install -m 0755 "$HERE/ci-entry.sh" /opt/passvault/bin/ci-deploy
install -d -m 0700 /root/.ssh
touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
KEYPART="$(awk '{print $1" "$2}' <<<"$PUBKEY")"
if ! grep -qF "$KEYPART" /root/.ssh/authorized_keys; then
  echo "restrict,command=\"/opt/passvault/bin/ci-deploy\" $PUBKEY" >> /root/.ssh/authorized_keys
fi
echo "CI entry point installed; the deploy key may only run /opt/passvault/bin/ci-deploy."
echo "Now configure the GitHub variables/secrets (docs/DEPLOYMENT.md §0b) and push to main."
