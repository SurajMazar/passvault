#!/usr/bin/env bash
# Encrypted PostgreSQL backup for the compose deployment.
#
#   AGE_RECIPIENT=age1... BACKUP_DIR=/var/backups/passvault ./deploy/backup.sh
#
# Writes passvault-<UTC timestamp>.dump.age (pg_dump custom format, encrypted
# with age to AGE_RECIPIENT), keeps the newest $KEEP (default 14), and never
# leaves an unencrypted dump on disk. Schedule daily (cron/systemd timer) and
# copy BACKUP_DIR off-host (object storage with versioning).
# Restore: see docs/DEPLOYMENT.md §12. Keep the server secrets (MFA_ENCRYPTION_KEY,
# RECOVERY_CODE_PEPPER) in your secrets store, separately from these backups.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-deploy/.env.production}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/passvault}"
KEEP="${KEEP:-14}"
: "${AGE_RECIPIENT:?set AGE_RECIPIENT to an age public key (age-keygen -o key.txt; keep key.txt OFF this server)}"
command -v age >/dev/null || { echo "install age (https://age-encryption.org)"; exit 1; }
if command -v podman >/dev/null; then COMPOSE=(podman compose); else COMPOSE=(docker compose); fi

umask 077
mkdir -p "$BACKUP_DIR"
out="$BACKUP_DIR/passvault-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
"${COMPOSE[@]}" -f deploy/compose.prod.yaml --env-file "$ENV_FILE" exec -T postgres \
  pg_dump -U passvault -d passvault -Fc | age -r "$AGE_RECIPIENT" -o "$out"
[[ -s "$out" ]] || { echo "backup is empty"; rm -f "$out"; exit 1; }
echo "wrote $out ($(wc -c < "$out") bytes)"
ls -1t "$BACKUP_DIR"/passvault-*.dump.age | tail -n +"$((KEEP + 1))" | xargs -r rm -f
