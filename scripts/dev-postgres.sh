#!/usr/bin/env bash
# Local PostgreSQL for development/tests without Docker.
# Creates a cluster under .dev/pgdata (gitignored) on port ${PV_PG_PORT:-54329}
# with a randomly generated password written to .dev/pg-password.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/.dev/pgdata"
PORT="${PV_PG_PORT:-54329}"
PWFILE="$ROOT/.dev/pg-password"
PGBIN="${PGBIN:-$(dirname "$(command -v pg_ctl || echo /opt/homebrew/opt/postgresql@14/bin/pg_ctl)")}"

cmd="${1:-start}"
mkdir -p "$ROOT/.dev"
chmod 700 "$ROOT/.dev"

init() {
  if [ ! -f "$DATA/PG_VERSION" ]; then
    umask 077
    openssl rand -base64 24 | tr -d '/+=' > "$PWFILE"
    "$PGBIN/initdb" -D "$DATA" -U passvault --auth=scram-sha-256 --pwfile="$PWFILE" >/dev/null
    echo "listen_addresses = '127.0.0.1'" >> "$DATA/postgresql.conf"
    echo "port = $PORT" >> "$DATA/postgresql.conf"
    echo "unix_socket_directories = '$ROOT/.dev'" >> "$DATA/postgresql.conf"
  fi
}

case "$cmd" in
  start)
    init
    if ! "$PGBIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      "$PGBIN/pg_ctl" -D "$DATA" -l "$ROOT/.dev/postgres.log" -w start >/dev/null
    fi
    PW="$(cat "$PWFILE")"
    for db in passvault passvault_test; do
      PGPASSWORD="$PW" "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U passvault -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 \
        || PGPASSWORD="$PW" "$PGBIN/createdb" -h 127.0.0.1 -p "$PORT" -U passvault "$db"
    done
    echo "postgresql://passvault:${PW}@127.0.0.1:${PORT}/passvault"
    ;;
  url)
    echo "postgresql://passvault:$(cat "$PWFILE")@127.0.0.1:${PORT}/${2:-passvault}"
    ;;
  stop)
    "$PGBIN/pg_ctl" -D "$DATA" -w stop >/dev/null && echo stopped
    ;;
  *) echo "usage: $0 start|stop|url [db]"; exit 1 ;;
esac
