#!/usr/bin/env bash
# Applies a PassVault release on the server. Shipped inside every release by
# the Deploy workflow and run (as root) by /opt/passvault/bin/ci-deploy, so the
# server's whole PassVault state is derived from git + GitHub secrets/variables
# on every deploy — nothing is configured by hand.
#
#   apply.sh deploy <release-id>   full apply (release extracted to /opt/passvault/releases/<id>)
#   apply.sh status | restart | rollback
#
# A release contains:
#   server/          this script, compose.yaml, nginx.conf.template, nginx-headers.conf
#   api-image.tar.gz docker save of passvault-api:<id>
#   web/             built web dashboard
#   runtime.env      configuration + secrets from GitHub (deleted after use)
#
# Steps of a deploy (each idempotent):
#   1. validate runtime.env, write /opt/passvault/.env (0600) and deploy.conf from it
#   2. database: when DATABASE_URL points at this host's PostgreSQL, ensure the role
#      (with that password), the database and the pg_hba rule for Docker networks
#   3. TLS certificate for PV_DOMAIN (certbot, renewed by certbot.timer)
#   4. nginx site from the template (nginx -t before reload; previous config restored on error)
#   5. load the image, start it, wait for health (prisma migrate deploy runs at container start),
#      switch web + current; on failure roll back to the previous release
set -euo pipefail
BASE=/opt/passvault
HERE="$(cd "$(dirname "$0")" && pwd)"
log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- helpers
conf() { # value of KEY in deploy.conf
  sed -n "s/^$1=//p" "$BASE/deploy.conf" 2>/dev/null | head -1
}
compose() { # <image-tag> <args…>
  PV_IMAGE_TAG="$1" PV_API_PORT="$(conf PV_API_PORT)" docker compose -p passvault -f "$BASE/compose.yaml" "${@:2}"
}
healthy() {
  local port; port="$(conf PV_API_PORT)"
  for _ in $(seq 1 90); do
    curl -fsS "http://127.0.0.1:${port}/api/v1/health" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}
current_id() { basename "$(readlink "$BASE/current" 2>/dev/null || echo none)"; }
activate() { # <release-id>: start its image, then point web + current at it
  local id="$1" dir="$BASE/releases/$1"
  [[ -d "$dir" ]] || die "release $id not found"
  install -m 0644 "$dir/server/compose.yaml" "$BASE/compose.yaml"
  compose "$id" up -d --remove-orphans
  if ! healthy; then
    echo "release $id is not healthy" >&2
    compose "$id" logs --tail 80 api >&2 || true
    return 1
  fi
  ln -sfn "$dir/web" "$BASE/web/current.new" && mv -Tf "$BASE/web/current.new" "$BASE/web/current"
  ln -sfn "$dir" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
  echo "$id is live"
}

# ---------------------------------------------------------------- 1. configuration
write_config() { # <runtime.env>
  python3 - "$1" "$BASE" <<'PY'
import os, re, sys, tempfile, urllib.parse
src, base = sys.argv[1], sys.argv[2]
env = {}
for line in open(src, encoding="utf-8").read().splitlines():
    m = re.match(r"^([A-Z][A-Z0-9_]*)=(.*)$", line)
    if m:
        env[m.group(1)] = m.group(2)

def need(k):
    v = env.get(k, "")
    if not v:
        sys.exit(f"missing required setting {k} (GitHub secret/variable)")
    return v

domain = need("PV_DOMAIN")
if not re.fullmatch(r"[a-z0-9.-]+", domain): sys.exit("PV_DOMAIN is not a host name")
port = need("PV_API_PORT")
if not re.fullmatch(r"[0-9]{2,5}", port): sys.exit("PV_API_PORT must be a port number")
db = need("DATABASE_URL")
u = urllib.parse.urlsplit(db)
if u.scheme not in ("postgresql", "postgres") or not u.hostname or not u.username or not u.path.strip("/"):
    sys.exit("DATABASE_URL must look like postgresql://USER:PASSWORD@HOST:5432/DATABASE")
for k in ("MFA_ENCRYPTION_KEY", "RECOVERY_CODE_PEPPER", "PRELOGIN_SECRET"):
    if len(need(k)) < 32: sys.exit(f"{k} is too short (use: openssl rand -base64 32)")
for k in ("SMTP_HOST", "SMTP_PORT"):
    need(k)
registration = (env.get("REGISTRATION_OPEN") or "true").strip().lower()
if registration not in ("true", "false"): sys.exit("REGISTRATION_OPEN must be true or false")

cors = [f"https://{domain}", "http://localhost:47391"]
cors += [o.strip() for o in env.get("PV_EXTRA_CORS_ORIGINS", "").split(",") if o.strip()]
api = {
    "DATABASE_URL": db,
    "MFA_ENCRYPTION_KEY": env["MFA_ENCRYPTION_KEY"],
    "RECOVERY_CODE_PEPPER": env["RECOVERY_CODE_PEPPER"],
    "PRELOGIN_SECRET": env["PRELOGIN_SECRET"],
    "WEB_APP_URL": f"https://{domain}",
    "CORS_ORIGINS": ",".join(dict.fromkeys(cors)),
    "MAIL_FROM": env.get("MAIL_FROM") or f"PassVault <no-reply@{domain}>",
    "SMTP_HOST": env["SMTP_HOST"],
    "SMTP_PORT": env["SMTP_PORT"],
    "SMTP_SECURE": env.get("SMTP_SECURE") or "false",
    "SMTP_REQUIRE_TLS": env.get("SMTP_REQUIRE_TLS") or "true",
    "SMTP_USER": env.get("SMTP_USER", ""),
    "SMTP_PASSWORD": env.get("SMTP_PASSWORD", ""),
    "LOG_LEVEL": env.get("LOG_LEVEL") or "info",
    "REGISTRATION_OPEN": registration,
}

def quote(v):  # docker compose env_file syntax
    if re.fullmatch(r"[A-Za-z0-9_@.:+/=,%-]*", v): return v
    if "'" not in v: return "'" + v + "'"
    return '"' + v.replace("\\", "\\\\").replace('"', '\\"').replace("$", "$$") + '"'

def write(path, text, mode):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp.")
    with os.fdopen(fd, "w", encoding="utf-8") as fh: fh.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)

write(os.path.join(base, ".env"), "# Generated by the Deploy workflow from GitHub secrets/variables. Do not edit: changes are overwritten.\n" + "".join(f"{k}={quote(v)}\n" for k, v in api.items()), 0o600)
write(os.path.join(base, "deploy.conf"), f"PV_DOMAIN={domain}\nPV_API_PORT={port}\nACME_EMAIL={env.get('ACME_EMAIL', '')}\n", 0o644)
# database coordinates for the provisioning step (root-only file, removed right after)
write(os.path.join(base, ".db.tmp"), "\n".join([u.hostname, u.username, urllib.parse.unquote(u.password or ""), u.path.strip("/")]) + "\n", 0o600)
print(f"configuration written for {domain} (API port {port}, database host {u.hostname})")
PY
}

# ---------------------------------------------------------------- 2. database
provision_database() {
  local host user pass db pg hba line
  { read -r host; read -r user; read -r pass; read -r db; } < "$BASE/.db.tmp"
  rm -f "$BASE/.db.tmp"
  case "$host" in
    host.docker.internal | localhost | 127.0.0.1 | 172.17.0.1) ;;
    *) log "database: external host $host — not provisioned here"; return 0 ;;
  esac
  command -v pg_lsclusters >/dev/null || die "DATABASE_URL points at this host but PostgreSQL is not installed"
  [[ "$user" =~ ^[a-z_][a-z0-9_]{0,62}$ && "$db" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "database user/name must be lowercase identifiers"
  [[ -n "$pass" && "$pass" != *"'"* ]] || die "database password must be non-empty and contain no single quote"
  log "database: role $user, database $db on the local PostgreSQL"
  # Password via stdin, never on a command line.
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
SELECT format('CREATE ROLE %I LOGIN', '${user}') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${user}')\gexec
ALTER ROLE "${user}" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${pass}';
SELECT format('CREATE DATABASE %I OWNER %I', '${db}', '${user}') WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${db}')\gexec
REVOKE ALL ON DATABASE "${db}" FROM PUBLIC;
SQL
  pg="$(pg_lsclusters --no-header | awk '{print $1; exit}')"
  hba="/etc/postgresql/${pg}/main/pg_hba.conf"
  line="host    ${db}       ${user}       172.16.0.0/12           scram-sha-256"
  if ! grep -qF "$line" "$hba"; then
    echo "$line" >> "$hba"
    systemctl reload "postgresql@${pg}-main"
    echo "pg_hba: allowed $user@$db from Docker networks"
  fi
}

# ---------------------------------------------------------------- 3 + 4. TLS and nginx
configure_edge() {
  local domain port email live rendered target=/etc/nginx/sites-available/passvault.conf
  domain="$(conf PV_DOMAIN)"; port="$(conf PV_API_PORT)"; email="$(conf ACME_EMAIL)"
  install -d -m 0755 /var/www/letsencrypt "$BASE/web"
  live=/etc/letsencrypt/live/passvault/fullchain.pem
  if [[ ! -f "$live" ]] || ! openssl x509 -in "$live" -noout -ext subjectAltName 2>/dev/null | grep -q "DNS:${domain}\b"; then
    log "TLS: requesting a certificate for $domain"
    certbot certonly --nginx --non-interactive --agree-tos --cert-name passvault -d "$domain" \
      ${email:+-m "$email"} --deploy-hook 'systemctl reload nginx'
  fi
  [[ -e "$BASE/web/current" ]] || ln -sfn "$BASE/releases/$1/web" "$BASE/web/current"
  rendered="$(PV_DOMAIN="$domain" PV_API_PORT="$port" PV_WEB_ROOT="$BASE/web/current" \
    envsubst '${PV_DOMAIN} ${PV_API_PORT} ${PV_WEB_ROOT}' < "$HERE/nginx.conf.template")"
  if [[ "$rendered" != "$(cat "$target" 2>/dev/null)" ]] || ! cmp -s "$HERE/nginx-headers.conf" /etc/nginx/snippets/passvault-headers.conf; then
    log "nginx: updating the passvault site"
    cp -a "$target" "$target.prev" 2>/dev/null || true
    cp -a /etc/nginx/snippets/passvault-headers.conf /etc/nginx/snippets/passvault-headers.conf.prev 2>/dev/null || true
    install -m 0644 "$HERE/nginx-headers.conf" /etc/nginx/snippets/passvault-headers.conf
    printf '%s\n' "$rendered" > "$target"
    ln -sfn "$target" /etc/nginx/sites-enabled/passvault.conf
    if ! nginx -t; then
      echo "nginx -t failed — restoring the previous passvault config" >&2
      [[ -f "$target.prev" ]] && mv -f "$target.prev" "$target" || rm -f "$target" /etc/nginx/sites-enabled/passvault.conf
      [[ -f /etc/nginx/snippets/passvault-headers.conf.prev ]] && mv -f /etc/nginx/snippets/passvault-headers.conf.prev /etc/nginx/snippets/passvault-headers.conf
      exit 1
    fi
    systemctl reload nginx
  fi
}

# ---------------------------------------------------------------- commands
CMD="${1:-}"
case "$CMD" in
  deploy)
    ID="${2:?release id}"
    DIR="$BASE/releases/$ID"
    [[ -f "$DIR/runtime.env" && -f "$DIR/api-image.tar.gz" && -f "$DIR/web/index.html" ]] || die "incomplete release"
    PREV="$(current_id)"
    log "configuration"
    write_config "$DIR/runtime.env"
    rm -f "$DIR/runtime.env"
    port="$(conf PV_API_PORT)"
    if ss -tln | awk '{print $4}' | grep -q ":${port}\$" && ! docker ps --format '{{.Names}} {{.Ports}}' | grep -q "^passvault-api-1 .*:${port}->"; then
      die "port ${port} is used by another service; set the PV_API_PORT variable to a free port"
    fi
    provision_database
    log "TLS + nginx"
    configure_edge "$ID"
    log "container image"
    docker load -i "$DIR/api-image.tar.gz" >/dev/null
    rm -f "$DIR/api-image.tar.gz"
    docker image inspect "passvault-api:$ID" >/dev/null || die "image passvault-api:$ID missing in the release"
    chmod 0755 "$DIR"
    chmod -R a+rX "$DIR/web" "$DIR/server"
    log "activate $ID (pending database migrations run at container start)"
    if ! activate "$ID"; then
      if [[ "$PREV" != none && -d "$BASE/releases/$PREV" ]]; then
        echo "rolling back to $PREV" >&2
        activate "$PREV" || true
      fi
      exit 1
    fi
    # keep the five newest releases (and their images); never touch other projects' images
    for old in $(ls -1t "$BASE/releases" | tail -n +6); do
      rm -rf "${BASE:?}/releases/$old"
      docker image rm "passvault-api:$old" >/dev/null 2>&1 || true
    done
    ;;
  status)
    echo "current release: $(current_id)"
    compose "$(current_id)" ps
    ;;
  restart)
    activate "$(current_id)"
    ;;
  rollback)
    PREV="$(ls -1t "$BASE/releases" | grep -vx "$(current_id)" | head -1 || true)"
    [[ -n "$PREV" ]] || die "no previous release"
    activate "$PREV"
    ;;
  *)
    die "usage: apply.sh deploy <id> | status | restart | rollback"
    ;;
esac
