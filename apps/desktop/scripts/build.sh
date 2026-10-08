#!/usr/bin/env bash
# Builds PassVault.app for macOS (arm64, x64 and universal) and ad-hoc signs it
# for local runs. Developer ID signing / notarization: scripts/sign-and-notarize.sh.
#
#   pnpm --filter @passvault/desktop package
#   (API/web URLs come from VITE_API_URL / VITE_WEB_URL or the gitignored .env.production)
#   VITE_API_URL=https://api.example.com VITE_WEB_URL=https://app.example.com bash scripts/build.sh
#   ARCHS="universal" bash scripts/build.sh          # only the universal bundle
#   HELPER_LAYOUT=bundle bash scripts/build.sh       # helper inside "PassVault Helper.app" (see docs/DESKTOP.md)
#
# Output:
#   dist/PassVault.app            universal (x86_64 + arm64)
#   dist/arm64/PassVault.app      Apple silicon only
#   dist/x64/PassVault.app        Intel only
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
HELPER_DIR="$REPO/native/desktop-helper"
cd "$HERE"

ARCHS="${ARCHS:-universal arm64 x64}"
HELPER_LAYOUT="${HELPER_LAYOUT:-flat}"   # flat | bundle
VERSION="$(node -p "require('./package.json').version")"
NL_VERSION="$(node -p "require('./neutralino.config.json').cli.binaryVersion")"
MIN_MACOS="14.0" # Neutralinojs $NL_VERSION binaries are built with minos 14.0
BUILD="$HERE/.build"
DIST="$HERE/dist"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

log "Neutralinojs $NL_VERSION binaries"
bash scripts/fetch-neutralino.sh

log "Icons"
[[ -f assets/icon-1024.png && -f resources/icons/appIcon.png && -f resources/icons/trayIcon.png ]] || node scripts/gen-icons.mjs

# Production defaults come from .env.production (public URLs only); environment
# variables VITE_API_URL / VITE_WEB_URL override them for other deployments.
API_URL="${VITE_API_URL:-$(sed -n 's/^VITE_API_URL=//p' .env.production)}"
log "Frontend (vite, production) — API $API_URL"
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec vite build --mode production
grep -q 'Content-Security-Policy' resources/app/index.html || { echo "CSP meta missing from index.html" >&2; exit 1; }
API_ORIGIN="$(node -p "new URL(process.argv[1]).origin" "$API_URL")"
CONNECT="$(sed -n 's/.*connect-src \([^;]*\);.*/\1/p' resources/app/index.html)"
# Any https server the user chooses; never plain http beyond localhost, never wildcards.
echo " $CONNECT " | grep -q ' https: ' || { echo "CSP connect-src must allow https: servers" >&2; exit 1; }
echo " $CONNECT " | grep -Eq ' (http:|\*|http://\*[^ ]*) ' && { echo "CSP connect-src too broad: $CONNECT" >&2; exit 1; }
grep -qF "$API_ORIGIN" resources/app/assets/index-*.js || { echo "API URL $API_ORIGIN not compiled into the bundle" >&2; exit 1; }

log "resources.neu (neu build)"
rm -rf "$BUILD"
mkdir -p "$BUILD/neu"
cp -R resources "$BUILD/neu/resources"
case "$HELPER_LAYOUT" in
  flat) HELPER_CMD='"${NL_PATH}/../MacOS/pv-helper"' ;;
  bundle) HELPER_CMD='"${NL_PATH}/../Helpers/PassVault Helper.app/Contents/MacOS/pv-helper"' ;;
  *) echo "HELPER_LAYOUT must be flat or bundle" >&2; exit 1 ;;
esac
HELPER_CMD="$HELPER_CMD" node -e '
  const fs = require("fs");
  const c = JSON.parse(fs.readFileSync("neutralino.config.json", "utf8"));
  if (c.modes.window.enableInspector !== false) throw new Error("production config must disable the inspector");
  if (c.exportAuthInfo !== false || c.tokenSecurity !== "one-time") throw new Error("token settings changed");
  c.extensions = c.extensions.map((e) => e.id === "io.passvault.helper" ? { ...e, commandDarwin: process.env.HELPER_CMD } : e);
  fs.writeFileSync(process.argv[1], JSON.stringify(c, null, 2));
' "$BUILD/neu/neutralino.config.json"
# neu CLI pinned as a devDependency (no global install needed, same version locally and in CI)
(cd "$BUILD/neu" && "$HERE/node_modules/.bin/neu" build >/dev/null)
RES_NEU="$BUILD/neu/dist/PassVault/resources.neu"
[[ -f "$RES_NEU" ]] || { echo "neu build did not produce resources.neu" >&2; exit 1; }
ls -la "$RES_NEU"

log "pv-helper (universal)"
make -C "$HELPER_DIR" universal VERSION="$VERSION" >/dev/null
lipo -info "$HELPER_DIR/bin/pv-helper-universal"

log "libpvwindow.dylib (buddy floats above every app; see scripts/pvwindow.m)"
clang -arch arm64 -arch x86_64 -mmacosx-version-min="$MIN_MACOS" -dynamiclib -fobjc-arc -O2 -Wall -Wextra -Werror \
  -framework AppKit -framework WebKit -install_name @executable_path/libpvwindow.dylib -o "$BUILD/libpvwindow.dylib" scripts/pvwindow.m
lipo -info "$BUILD/libpvwindow.dylib"

log "App icon (.icns)"
ICONSET="$BUILD/PassVault.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s assets/icon-1024.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d assets/icon-1024.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$BUILD/PassVault.icns"

slice() { # slice <universal-binary> <lipo-arch> <out>
  lipo -thin "$2" -output "$3" "$1"
}

assemble() { # assemble <arch: universal|arm64|x64> <app path>
  local arch="$1" app="$2"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  local c="$app/Contents"
  case "$arch" in
    universal)
      cp bin/neutralino-mac_universal "$c/MacOS/passvault-shell"
      cp "$BUILD/libpvwindow.dylib" "$c/MacOS/libpvwindow.dylib"
      cp "$HELPER_DIR/bin/pv-helper-universal" "$BUILD/pv-helper.$arch" ;;
    arm64)
      cp bin/neutralino-mac_arm64 "$c/MacOS/passvault-shell"
      slice "$BUILD/libpvwindow.dylib" arm64 "$c/MacOS/libpvwindow.dylib"
      cp "$HELPER_DIR/bin/pv-helper-arm64" "$BUILD/pv-helper.$arch" ;;
    x64)
      cp bin/neutralino-mac_x64 "$c/MacOS/passvault-shell"
      slice "$BUILD/libpvwindow.dylib" x86_64 "$c/MacOS/libpvwindow.dylib"
      cp "$HELPER_DIR/bin/pv-helper-amd64" "$BUILD/pv-helper.$arch" ;;
  esac
  # Link the buddy window library into the shell (LC_LOAD_DYLIB; no DYLD_* variables).
  codesign --remove-signature "$c/MacOS/passvault-shell" 2>/dev/null || true
  python3 scripts/add-load-command.py "$c/MacOS/passvault-shell" @executable_path/libpvwindow.dylib >/dev/null
  otool -L "$c/MacOS/passvault-shell" | grep -q '@executable_path/libpvwindow.dylib' || { echo "libpvwindow.dylib not linked" >&2; exit 1; }
  if [[ "$HELPER_LAYOUT" == "bundle" ]]; then
    local h="$c/Helpers/PassVault Helper.app/Contents"
    mkdir -p "$h/MacOS"
    cp "$BUILD/pv-helper.$arch" "$h/MacOS/pv-helper"
    write_plist "$h/Info.plist" "io.passvault.desktop.helper" "PassVault Helper" "pv-helper" "true"
  else
    cp "$BUILD/pv-helper.$arch" "$c/MacOS/pv-helper"
  fi
  chmod 0755 "$c/MacOS/"*
  cp "$RES_NEU" "$c/Resources/resources.neu"
  # The shell is the bundle's executable: macOS ties the menu-bar item (and Dock, login item) to the
  # process that LaunchServices started, so no launcher may exec into it. Neutralino looks for its
  # resources next to the binary; the symlink keeps the data itself in Resources (code signing).
  ln -s ../Resources/resources.neu "$c/MacOS/resources.neu"
  cp "$BUILD/PassVault.icns" "$c/Resources/PassVault.icns"
  write_plist "$c/Info.plist" "io.passvault.desktop" "PassVault" "passvault-shell" "false"
  printf 'APPL????' > "$c/PkgInfo"
  plutil -lint "$c/Info.plist" >/dev/null

  # Ad-hoc signature for local runs (inner code first, then the bundle).
  if [[ "$HELPER_LAYOUT" == "bundle" ]]; then
    codesign --force --sign - --identifier io.passvault.helper "$c/Helpers/PassVault Helper.app/Contents/MacOS/pv-helper"
    codesign --force --sign - "$c/Helpers/PassVault Helper.app"
  else
    codesign --force --sign - --identifier io.passvault.helper "$c/MacOS/pv-helper"
  fi
  codesign --force --sign - --identifier io.passvault.desktop.window "$c/MacOS/libpvwindow.dylib"
  # The shell is the app's executable, so it carries the app's identifier.
  codesign --force --sign - --identifier io.passvault.desktop "$c/MacOS/passvault-shell"
  # No --deep: it would re-sign the inner code above with generated identifiers.
  codesign --force --sign - "$app"
  codesign --verify --deep --strict "$app"
}

write_plist() { # write_plist <path> <bundle id> <name> <executable> <LSUIElement>
  cat > "$1" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key><string>$2</string>
	<key>CFBundleName</key><string>$3</string>
	<key>CFBundleDisplayName</key><string>$3</string>
	<key>CFBundleExecutable</key><string>$4</string>
	<key>CFBundleIconFile</key><string>PassVault</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleShortVersionString</key><string>$VERSION</string>
	<key>CFBundleVersion</key><string>$VERSION</string>
	<key>CFBundleDevelopmentRegion</key><string>en</string>
	<key>LSMinimumSystemVersion</key><string>$MIN_MACOS</string>
	<key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
	<key>LSUIElement</key><$5/>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSSupportsAutomaticGraphicsSwitching</key><true/>
	<key>NSHumanReadableCopyright</key><string>PassVault</string>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsLocalNetworking</key><true/>
	</dict>
</dict>
</plist>
PLIST
}

for arch in $ARCHS; do
  case "$arch" in
    universal) APP="$DIST/PassVault.app" ;;
    arm64|x64) APP="$DIST/$arch/PassVault.app" ;;
    *) echo "unknown arch $arch" >&2; exit 1 ;;
  esac
  log "Assemble $arch → ${APP#$HERE/}"
  mkdir -p "$(dirname "$APP")"
  assemble "$arch" "$APP"
  for b in "$APP/Contents/MacOS/"* ; do
    printf '  %-16s %s\n' "$(basename "$b")" "$(lipo -archs "$b")"
  done
  [[ "$HELPER_LAYOUT" == "bundle" ]] && printf '  %-16s %s\n' "pv-helper" "$(lipo -archs "$APP/Contents/Helpers/PassVault Helper.app/Contents/MacOS/pv-helper")"
  du -sh "$APP" | awk '{print "  size " $1}'
done

log "Done"
echo "Run: open \"$DIST/PassVault.app\"   (logs: ~/Library/Application Support/io.passvault.desktop/neutralinojs.log, ~/Library/Logs/PassVault/helper.log)"
