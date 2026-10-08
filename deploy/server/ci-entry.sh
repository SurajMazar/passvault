#!/usr/bin/env bash
# PassVault CI entry point: the ONLY PassVault file installed on the server by
# hand, once (deploy/server/bootstrap.sh). The CI deploy key is restricted to it:
#   restrict,command="/opt/passvault/bin/ci-deploy" ssh-ed25519 AAAA… passvault-ci-deploy
#
# Everything else (configuration and secrets, database, nginx, certificate,
# containers) comes from the release that CI streams in on stdin and is applied
# by that release's own server/apply.sh, so the server's state always comes
# from git + GitHub secrets.
set -euo pipefail
BASE=/opt/passvault
REQ="${SSH_ORIGINAL_COMMAND:-${1:-}}"
case "$REQ" in
  "deploy "*)
    ID="${REQ#deploy }"
    [[ "$ID" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo "invalid release id" >&2; exit 2; }
    install -d -m 0755 "$BASE" "$BASE/releases"
    DIR="$BASE/releases/$ID"
    rm -rf "$DIR"
    install -d -m 0700 "$DIR"
    # Private while extracting (runtime.env carries secrets). GNU tar refuses absolute and '..' paths.
    ( umask 077 && tar -xz -C "$DIR" --no-same-owner --no-same-permissions )
    [[ -f "$DIR/server/apply.sh" ]] || { echo "release has no server/apply.sh" >&2; exit 1; }
    exec bash "$DIR/server/apply.sh" deploy "$ID"
    ;;
  status | restart | rollback)
    CUR="$(readlink -f "$BASE/current" 2>/dev/null || true)"
    [[ -n "$CUR" && -f "$CUR/server/apply.sh" ]] || { echo "no current release" >&2; exit 1; }
    exec bash "$CUR/server/apply.sh" "$REQ"
    ;;
  *)
    echo "usage: deploy <release-id> (release tar.gz on stdin) | status | restart | rollback" >&2
    exit 2
    ;;
esac
