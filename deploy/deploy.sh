#!/usr/bin/env bash
# PassVault production deploy for a single host (Podman or Docker compose).
#
#   ./deploy/deploy.sh                 # pre-flight checks, build, start, verify
#   ./deploy/deploy.sh --check         # pre-flight checks only
#   ENV_FILE=deploy/.env.other ./deploy/deploy.sh
#
# Run from the repository root on the server. See docs/DEPLOYMENT.md.
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-deploy/.env.production}"
COMPOSE_FILE="deploy/compose.prod.yaml"
CHECK_ONLY=false
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=true

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
fail=0
problem() { red "  ✗ $*"; fail=1; }
ok() { green "  ✓ $*"; }
warn() { yellow "  ! $*"; }

echo "PassVault deploy — pre-flight checks ($ENV_FILE)"

# --- tooling -------------------------------------------------------------------
if command -v podman >/dev/null 2>&1; then
  COMPOSE=(podman compose)
  ok "podman $(podman --version | awk '{print $3}')"
elif command -v docker >/dev/null 2>&1; then
  COMPOSE=(docker compose)
  ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"
else
  problem "podman (or docker) is not installed"
fi
command -v curl >/dev/null 2>&1 || problem "curl is required"

# --- env file --------------------------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  problem "$ENV_FILE not found (cp deploy/.env.production.example $ENV_FILE)"
  exit 1
fi
perm=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")
if [[ "$perm" != "600" && "$perm" != "400" ]]; then
  problem "$ENV_FILE has mode $perm — run: chmod 600 $ENV_FILE"
else
  ok "$ENV_FILE is owner-only ($perm)"
fi

get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
for v in PV_DOMAIN PV_ACME_EMAIL POSTGRES_PASSWORD MFA_ENCRYPTION_KEY RECOVERY_CODE_PEPPER PRELOGIN_SECRET CORS_ORIGINS MAIL_FROM SMTP_HOST; do
  [[ -n "$(get "$v")" ]] || problem "$v is empty in $ENV_FILE"
done
for v in MFA_ENCRYPTION_KEY RECOVERY_CODE_PEPPER PRELOGIN_SECRET; do
  val="$(get "$v")"
  [[ -z "$val" || ${#val} -ge 43 ]] || problem "$v looks too short (generate with: openssl rand -base64 32)"
done
domain="$(get PV_DOMAIN)"
cors="$(get CORS_ORIGINS)"
[[ -z "$domain" || ",$cors," == *",https://$domain,"* ]] || problem "CORS_ORIGINS must contain https://$domain"
[[ ",$cors," == *",http://127.0.0.1:47391,"* ]] || warn "CORS_ORIGINS lacks http://127.0.0.1:47391 (the macOS desktop app)"
[[ "$cors" == *"chrome-extension://"* ]] || warn "CORS_ORIGINS has no chrome-extension:// origin yet (fine until the extension is published)"
[[ -z "$(get SMTP_USER)" ]] && warn "SMTP_USER is empty (only fine if your SMTP relay needs no auth)"

# --- DNS and ports -----------------------------------------------------------------
if [[ -n "$domain" ]]; then
  resolved="$( (getent ahostsv4 "$domain" 2>/dev/null || dig +short A "$domain" 2>/dev/null || true) | awk '/^[0-9.]+/{print $1}' | sort -u | head -1)"
  public_ip="$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [[ -z "$resolved" ]]; then
    problem "$domain does not resolve — add an A record pointing at this server${public_ip:+ ($public_ip)}"
  elif [[ -n "$public_ip" && "$resolved" != "$public_ip" ]]; then
    warn "$domain resolves to $resolved but this host's public IP is $public_ip (OK only if a proxy/load balancer forwards 80/443 here; with Cloudflare proxying set SSL/TLS mode to Full (strict))"
  else
    ok "$domain → $resolved"
  fi
fi
for port in 80 443; do
  if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$port" | grep -q LISTEN; then
    warn "port $port is already in use on this host (stop the other web server, or the caddy container cannot bind)"
  fi
done

if [[ $fail -ne 0 ]]; then
  red "Pre-flight failed. Fix the items above and re-run."
  exit 1
fi
green "Pre-flight passed."
$CHECK_ONLY && exit 0

# --- deploy --------------------------------------------------------------------------
echo "Building and starting containers…"
"${COMPOSE[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build

echo "Waiting for https://$domain/api/v1/health (certificate issuance can take a minute)…"
for _ in $(seq 1 60); do
  if body="$(curl -fsS --max-time 5 "https://$domain/api/v1/health" 2>/dev/null)"; then
    ok "health: $body"
    break
  fi
  sleep 5
done
[[ -n "${body:-}" ]] || { problem "health check did not succeed — inspect: ${COMPOSE[*]} -f $COMPOSE_FILE --env-file $ENV_FILE logs caddy api"; exit 1; }

headers="$(curl -fsSI --max-time 5 "https://$domain/")"
for h in strict-transport-security content-security-policy x-frame-options x-content-type-options; do
  grep -qi "^$h:" <<<"$headers" && ok "header $h" || problem "missing header $h"
done
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$domain/")"
[[ "$code" == "308" || "$code" == "301" ]] && ok "HTTP redirects to HTTPS ($code)" || warn "HTTP returned $code (expected 308)"

[[ $fail -eq 0 ]] && green "PassVault is live at https://$domain" || exit 1
echo "Next: create your account, then set up daily backups (deploy/backup.sh) and monitoring — docs/DEPLOYMENT.md §12–13."
