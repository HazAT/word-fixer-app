#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVG="$ROOT/Resources/logo.svg"
ICONSET="$ROOT/Resources/AppIcon.iconset"
ICNS="$ROOT/Resources/AppIcon.icns"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [[ ! -f "$SVG" ]]; then
  echo "Missing SVG at $SVG" >&2
  exit 1
fi

rm -rf "$ICONSET"
mkdir -p "$ICONSET"
rm -f "$ICNS"

qlmanage -t -s 1024 -o "$TMP_DIR" "$SVG" >/dev/null 2>&1
BASE_SRC="$TMP_DIR/$(basename "$SVG").png"

make_icon() {
  local size="$1"
  local name="$2"
  sips -z "$size" "$size" "$BASE_SRC" --out "$ICONSET/$name" >/dev/null
}

make_icon 16 icon_16x16.png
make_icon 32 icon_16x16@2x.png
make_icon 32 icon_32x32.png
make_icon 64 icon_32x32@2x.png
make_icon 128 icon_128x128.png
make_icon 256 icon_128x128@2x.png
make_icon 256 icon_256x256.png
make_icon 512 icon_256x256@2x.png
make_icon 512 icon_512x512.png
cp "$BASE_SRC" "$ICONSET/icon_512x512@2x.png"

iconutil -c icns "$ICONSET" -o "$ICNS"
echo "$ICNS"
