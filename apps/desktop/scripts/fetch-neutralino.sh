#!/usr/bin/env bash
# Fetches the pinned Neutralinojs server binaries (official GitHub release
# asset) into apps/desktop/bin and verifies the SHA-256 digest that GitHub
# publishes for the asset. Equivalent to `neu update` for the binaries:
# neu CLI v11.0.1's downloader extracts the zip before the write stream has
# flushed ("end of central directory record signature not found"), so we do
# the same download with curl and an integrity check.
#
# The client library is NOT downloaded here: it is the npm package
# @neutralinojs/lib (pinned in package.json) and bundled by Vite.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./neutralino.config.json').cli.binaryVersion")"
# sha256 of neutralinojs-v<VERSION>.zip (GitHub release asset digest).
case "$VERSION" in
  6.10.0) EXPECTED="e633f480737f229f582d8ec6165a52d789340950aef062560702122389f08329" ;;
  *) EXPECTED="" ;;
esac
if [[ -z "$EXPECTED" ]]; then
  echo "No pinned checksum for Neutralinojs $VERSION. Add it to scripts/fetch-neutralino.sh" >&2
  echo "(see https://api.github.com/repos/neutralinojs/neutralinojs/releases/tags/v$VERSION → assets[].digest)." >&2
  exit 1
fi

if [[ -f bin/.version && "$(cat bin/.version)" == "$VERSION" && -x bin/neutralino-mac_universal ]]; then
  echo "Neutralinojs $VERSION binaries already present."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
URL="https://github.com/neutralinojs/neutralinojs/releases/download/v$VERSION/neutralinojs-v$VERSION.zip"
echo "Downloading $URL"
curl -fsSL --proto '=https' --tlsv1.2 -o "$TMP/nl.zip" "$URL"
ACTUAL="$(shasum -a 256 "$TMP/nl.zip" | awk '{print $1}')"
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
  echo "Checksum mismatch for $URL: expected $EXPECTED got $ACTUAL" >&2
  exit 1
fi
mkdir -p bin
unzip -q -o "$TMP/nl.zip" neutralino-mac_arm64 neutralino-mac_x64 neutralino-mac_universal -d bin
chmod 0755 bin/neutralino-mac_*
echo "$VERSION" > bin/.version
lipo -info bin/neutralino-mac_universal
