#!/usr/bin/env bash
# Development run: Vite rebuilds the UI on change (`vite build --watch`) and
# the Neutralino binary serves resources/app from this directory with the
# web inspector enabled. Reload the window (⌘R in the inspector) after a rebuild.
#
#   pnpm --filter @passvault/desktop dev
#
# Uses a generated neutralino.dev.config.json (gitignored):
#   - applicationId io.passvault.desktop.dev (separate storage directory)
#   - enableInspector true
#   - helper from native/desktop-helper/bin/pv-helper (host arch build)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
cd "$HERE"

bash scripts/fetch-neutralino.sh
[[ -f resources/icons/appIcon.png && -f resources/icons/trayIcon.png ]] || node scripts/gen-icons.mjs
make -C "$REPO/native/desktop-helper" build >/dev/null

node -e '
  const fs = require("fs");
  const c = JSON.parse(fs.readFileSync("neutralino.config.json", "utf8"));
  c.applicationId = "io.passvault.desktop.dev";
  c.modes.window.enableInspector = true;
  c.modes.window.title = "PassVault (dev)";
  c.extensions = c.extensions.map((e) => e.id === "io.passvault.helper"
    ? { ...e, commandDarwin: "\"${NL_PATH}/../../native/desktop-helper/bin/pv-helper\"" } : e);
  fs.writeFileSync("neutralino.dev.config.json", JSON.stringify(c, null, 2));
'

pnpm exec vite build --mode development
pnpm exec vite build --watch --mode development >/dev/null 2>&1 &
VITE_PID=$!
trap 'kill $VITE_PID 2>/dev/null || true' EXIT

case "$(uname -m)" in
  arm64) NL_BIN=bin/neutralino-mac_arm64 ;;
  *) NL_BIN=bin/neutralino-mac_x64 ;;
esac
"$NL_BIN" --res-mode=directory --path="$HERE" --config-file=/neutralino.dev.config.json
