#!/usr/bin/env bash
# PassVault release deployment on a shared host. Installed as /opt/passvault/bin/ci-deploy.
#
# The CI deploy key is restricted to this command in /root/.ssh/authorized_keys:
#   restrict,command="/opt/passvault/bin/ci-deploy" ssh-ed25519 AAAA… passvault-ci
# and the requested action arrives in SSH_ORIGINAL_COMMAND:
#   deploy <release-id>   release tarball (tar.gz) on stdin:
#                           api-image.tar.gz  (docker save of passvault-api:<release-id>)
#                           web/              (built web app)
#                           compose.yaml
#                           runtime.env       (optional: SMTP_* / MAIL_FROM from GitHub secrets,
#                                              merged into .env, then deleted)
#   status                show the running container and the current release
#   restart               restart the API with the current release (after editing .env)
#   rollback              switch back to the previous release
# Run it locally as root the same way: SSH_ORIGINAL_COMMAND="status" /opt/passvault/bin/ci-deploy
set -euo pipefail
BASE=/opt/passvault
# shellcheck disable=SC1091
. "$BASE/deploy.conf"
PORT="${PV_API_PORT:-3100}"
REQ="${SSH_ORIGINAL_COMMAND:-${1:-}}"

compose() { PV_IMAGE_TAG="$1" PV_API_PORT="$PORT" docker compose -p passvault -f "$BASE/compose.yaml" "${@:2}"; }

healthy() {
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

activate() { # <release-id>: point web + current at a release and start its image
  local id="$1" dir="$BASE/releases/$1"
  compose "$id" up -d --remove-orphans
  if ! healthy; then
    echo "release $id is not healthy" >&2
    compose "$id" logs --tail 60 api >&2 || true
    return 1
  fi
  ln -sfn "$dir/web" "$BASE/web/current.new" && mv -Tf "$BASE/web/current.new" "$BASE/web/current"
  ln -sfn "$dir" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
  echo "$id is live"
}

# Merge CI-provided mail settings into .env. Only these keys are accepted, empty values are ignored
# (removing a GitHub secret keeps the server's current value), and the file is deleted afterwards.
merge_runtime_env() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  python3 - "$f" "$BASE/.env" <<'PY'
import os, re, sys, tempfile
src, dst = sys.argv[1], sys.argv[2]
allowed = {"SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_REQUIRE_TLS", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM"}
new = {}
for line in open(src, encoding="utf-8").read().splitlines():
    m = re.match(r"^([A-Z_]+)=(.*)$", line)
    if m and m.group(1) in allowed and m.group(2) != "" and "\n" not in m.group(2):
        new[m.group(1)] = m.group(2)
def quote(v):
    # docker compose env_file syntax: plain when safe, '…' (literal) otherwise, "…" with escapes as a last resort
    if re.fullmatch(r"[A-Za-z0-9_@.:+/=,%-]*", v):
        return v
    if "'" not in v:
        return "'" + v + "'"
    return '"' + v.replace("\\", "\\\\").replace('"', '\\"').replace("$", "$$") + '"'
new = {k: quote(v) for k, v in new.items()}
lines = open(dst, encoding="utf-8").read().splitlines()
seen = set()
out = []
for line in lines:
    k = line.split("=", 1)[0]
    if k in new:
        out.append(f"{k}={new[k]}")
        seen.add(k)
    else:
        out.append(line)
out += [f"{k}={v}" for k, v in new.items() if k not in seen]
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dst), prefix=".env.")
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    fh.write("\n".join(out) + "\n")
os.chmod(tmp, 0o600)
os.replace(tmp, dst)
print("mail settings updated from CI: " + (", ".join(sorted(new)) or "none"))
PY
  rm -f "$f"
}

current_id() { basename "$(readlink "$BASE/current" 2>/dev/null || echo none)"; }

case "$REQ" in
  "deploy "*)
    ID="${REQ#deploy }"
    [[ "$ID" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo "invalid release id" >&2; exit 2; }
    PREV="$(current_id)"
    DIR="$BASE/releases/$ID"
    rm -rf "$DIR"
    install -d -m 0700 "$DIR"
    # Private while extracting (runtime.env may carry SMTP credentials).
    # GNU tar refuses absolute paths and '..' members by default.
    ( umask 077 && tar -xz -C "$DIR" --no-same-owner --no-same-permissions )
    merge_runtime_env "$DIR/runtime.env"
    [[ -f "$DIR/api-image.tar.gz" && -f "$DIR/web/index.html" && -f "$DIR/compose.yaml" ]] || { echo "incomplete release" >&2; exit 1; }
    docker load -i "$DIR/api-image.tar.gz" >/dev/null
    rm -f "$DIR/api-image.tar.gz"
    docker image inspect "passvault-api:$ID" >/dev/null || { echo "image passvault-api:$ID missing in the archive" >&2; exit 1; }
    chmod 0755 "$DIR"
    chmod -R a+rX "$DIR/web"
    chmod 0644 "$DIR/compose.yaml"
    install -m 0644 "$DIR/compose.yaml" "$BASE/compose.yaml"
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
    PREV="$(ls -1t "$BASE/releases" | grep -vx "$(current_id)" | head -1)"
    [[ -n "$PREV" ]] || { echo "no previous release" >&2; exit 1; }
    activate "$PREV"
    ;;
  *)
    echo "usage: deploy <release-id> (tar.gz on stdin) | status | restart | rollback" >&2
    exit 2
    ;;
esac
