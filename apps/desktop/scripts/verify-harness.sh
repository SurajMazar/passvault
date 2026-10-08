#!/usr/bin/env bash
# Verification harness (development only — never shipped).
#
# Runs the production UI bundle (resources/app) + the bundled pv-helper with a
# *verification* Neutralino config so the app can be inspected from outside:
#
#   bash scripts/verify-harness.sh cloud    # no window; open http://localhost:47391/ in a browser
#   bash scripts/verify-harness.sh window   # real window
#
# Differences from neutralino.config.json (all verification-only):
#   applicationId io.passvault.desktop.verify (separate storage), exportAuthInfo
#   true (writes the tokens to ~/Library/Application Support/io.passvault.desktop.verify/.tmp/auth_info.json
#   so scripts/nl-client.mjs can call allow-listed native methods such as
#   extensions.getStats from outside), defaultMode window|cloud.
# Note: Neutralino 6.10's window.snapshot crashes on macOS 26
# (+[SCWindow windowWithWindowID:] unrecognized selector), so it is not used.
# Production builds never contain these settings (scripts/build.sh checks them).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-window}"
V="$HERE/.build/verify"
APP="${PV_APP:-$HERE/dist/PassVault.app}"
mkdir -p "$V"
ln -sfn "$HERE/resources" "$V/resources"
HELPER="$APP/Contents/MacOS/pv-helper" MODE="$MODE" node -e '
  const fs = require("fs");
  const c = JSON.parse(fs.readFileSync(process.argv[1] + "/neutralino.config.json", "utf8"));
  c.applicationId = "io.passvault.desktop.verify";
  c.defaultMode = process.env.MODE;
  c.exportAuthInfo = true;
  c.extensions = c.extensions.map((e) => e.id === "io.passvault.helper" ? { ...e, commandDarwin: JSON.stringify(process.env.HELPER) } : e);
  fs.writeFileSync(process.argv[2] + "/neutralino.config.json", JSON.stringify(c, null, 2));
' "$HERE" "$V"
# The bundle's own shell: Neutralino with libpvwindow.dylib linked in, exactly as shipped.
NL_BIN="$APP/Contents/MacOS/passvault-shell"
exec "$NL_BIN" --res-mode=directory --path="$V"
