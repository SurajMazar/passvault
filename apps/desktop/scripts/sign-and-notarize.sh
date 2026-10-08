#!/usr/bin/env bash
# Developer ID signing (hardened runtime), notarization, stapling and DMG for
# PassVault.app. Requires an Apple Developer account — NOT available in the
# environment this script was written in, so the signed path has not been
# executed end to end (see docs/DESKTOP.md → "Verification").
#
# Prerequisites
#   - "Developer ID Application: <Name> (<TEAMID>)" certificate + private key in the login keychain
#       security find-identity -v -p codesigning
#   - A notarytool keychain profile:
#       xcrun notarytool store-credentials passvault-notary \
#         --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
#   - Optional, for Touch ID unlock (data-protection keychain): a Developer ID
#     provisioning profile for App ID TEAMID.io.passvault.desktop that allows
#     keychain-access-groups, and an app built with HELPER_LAYOUT=bundle
#     (the helper must be a bundle to embed the profile):
#       HELPER_LAYOUT=bundle ARCHS=universal bash scripts/build.sh
#
# Usage
#   IDENTITY="Developer ID Application: Example Inc (ABCDE12345)" TEAM_ID=ABCDE12345 \
#   NOTARY_PROFILE=passvault-notary [PROVISIONING_PROFILE=path/to/profile.provisionprofile] \
#   bash scripts/sign-and-notarize.sh [dist/PassVault.app]
#
#   DRY_RUN=1 … prints every command instead of running it.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
APP="${1:-$HERE/dist/PassVault.app}"
VERSION="$(node -p "require('$HERE/package.json').version")"
OUT="$(dirname "$APP")"
DMG="$OUT/PassVault-$VERSION.dmg"
WORK="$HERE/.build/sign"
DRY_RUN="${DRY_RUN:-}"

run() {
  if [[ -n "$DRY_RUN" ]]; then printf '+ %q' "$1"; shift; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}
die() { echo "error: $*" >&2; exit 1; }

[[ -d "$APP" ]] || die "$APP not found — run scripts/build.sh first"
if [[ -z "$DRY_RUN" ]]; then
  [[ -n "${IDENTITY:-}" ]] || die "IDENTITY is required"
  [[ -n "${TEAM_ID:-}" ]] || die "TEAM_ID is required"
  [[ -n "${NOTARY_PROFILE:-}" ]] || die "NOTARY_PROFILE is required"
  security find-identity -v -p codesigning | grep -qF "$IDENTITY" || die "signing identity not found in the keychain: $IDENTITY"
  xcrun --find notarytool >/dev/null || die "xcrun notarytool not available (install Xcode Command Line Tools)"
else
  IDENTITY="${IDENTITY:-Developer ID Application: Example (TEAMID1234)}"
  TEAM_ID="${TEAM_ID:-TEAMID1234}"
  NOTARY_PROFILE="${NOTARY_PROFILE:-passvault-notary}"
fi

C="$APP/Contents"
HELPER_BUNDLE="$C/Helpers/PassVault Helper.app"
SIGN=(codesign --force --timestamp --options runtime --sign "$IDENTITY")
mkdir -p "$WORK"

echo "==> Helper"
if [[ -n "${PROVISIONING_PROFILE:-}" ]]; then
  [[ -d "$HELPER_BUNDLE" ]] || die "PROVISIONING_PROFILE requires HELPER_LAYOUT=bundle (no '$HELPER_BUNDLE')"
  sed "s/\$(TEAM_ID)/$TEAM_ID/g" "$REPO/native/desktop-helper/entitlements.plist" > "$WORK/helper.entitlements.plist"
  run cp "$PROVISIONING_PROFILE" "$HELPER_BUNDLE/Contents/embedded.provisionprofile"
  run "${SIGN[@]}" --identifier io.passvault.helper --entitlements "$WORK/helper.entitlements.plist" "$HELPER_BUNDLE/Contents/MacOS/pv-helper"
  run "${SIGN[@]}" --entitlements "$WORK/helper.entitlements.plist" "$HELPER_BUNDLE"
elif [[ -d "$HELPER_BUNDLE" ]]; then
  run "${SIGN[@]}" --identifier io.passvault.helper "$HELPER_BUNDLE/Contents/MacOS/pv-helper"
  run "${SIGN[@]}" "$HELPER_BUNDLE"
  echo "   (no provisioning profile: Touch ID unlock stays unavailable)"
else
  run "${SIGN[@]}" --identifier io.passvault.helper "$C/MacOS/pv-helper"
  echo "   (flat helper: Touch ID unlock stays unavailable; see docs/DESKTOP.md)"
fi

echo "==> Neutralino shell + app bundle"
# No hardened-runtime exceptions: WKWebView runs JavaScript in system XPC
# processes, so neither allow-jit nor unsigned-executable-memory is needed.
run "${SIGN[@]}" --identifier io.passvault.desktop.shell "$C/MacOS/passvault-shell"
run "${SIGN[@]}" --entitlements "$HERE/scripts/entitlements.app.plist" "$APP"
run codesign --verify --deep --strict --verbose=2 "$APP"
run codesign -dvv "$APP"

echo "==> Notarize app"
ZIP="$WORK/PassVault-$VERSION.zip"
run rm -f "$ZIP"
run ditto -c -k --keepParent "$APP" "$ZIP"
run xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
run xcrun stapler staple "$APP"
run xcrun stapler validate "$APP"
run spctl --assess --type execute --verbose=4 "$APP"

echo "==> DMG"
STAGE="$WORK/dmg"
run rm -rf "$STAGE" "$DMG"
run mkdir -p "$STAGE"
run ditto "$APP" "$STAGE/PassVault.app"
run ln -s /Applications "$STAGE/Applications"
run hdiutil create -volname "PassVault" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG"
run codesign --force --timestamp --sign "$IDENTITY" "$DMG"
run xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
run xcrun stapler staple "$DMG"
run spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"
run shasum -a 256 "$DMG"
echo "Done: $DMG"
