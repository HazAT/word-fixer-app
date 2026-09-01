#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT/.build/release"
DIST_DIR="$ROOT/dist"
APP_NAME="Word Fixer.app"
APP_DIR="$DIST_DIR/$APP_NAME"
EXECUTABLE_NAME="WordFixer"
BUNDLE_IDENTIFIER="com.wordfixer.app"
BINARY="$BUILD_DIR/$EXECUTABLE_NAME"
PLIST_SOURCE="$ROOT/Resources/Info.plist"
PLIST_DEST="$APP_DIR/Contents/Info.plist"
MACOS_DIR="$APP_DIR/Contents/MacOS"
RESOURCES_DIR="$APP_DIR/Contents/Resources"
ICON_SOURCE="$ROOT/Resources/AppIcon.icns"
ICON_SCRIPT="$ROOT/scripts/build-icon.sh"
HELPER_SOURCE_DIR="$ROOT/helper"
HELPER_DEST_DIR="$RESOURCES_DIR/helper"
DEFAULTS_SOURCE_DIR="$ROOT/shared"
DEFAULTS_DEST_DIR="$RESOURCES_DIR/defaults"

mkdir -p "$DIST_DIR"

if [[ -f "$ROOT/Resources/logo.svg" ]]; then
  "$ICON_SCRIPT" >/dev/null
fi

swift package clean --package-path "$ROOT" >/dev/null 2>&1 || true
swift build -c release --package-path "$ROOT"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cp "$BINARY" "$MACOS_DIR/$EXECUTABLE_NAME"
cp "$PLIST_SOURCE" "$PLIST_DEST"
if [[ -f "$ICON_SOURCE" ]]; then
  cp "$ICON_SOURCE" "$RESOURCES_DIR/AppIcon.icns"
fi
if [[ -d "$HELPER_SOURCE_DIR" ]]; then
  rm -rf "$HELPER_DEST_DIR"
  mkdir -p "$HELPER_DEST_DIR"
  cp "$HELPER_SOURCE_DIR"/*.mjs "$HELPER_DEST_DIR/"
  chmod +x "$HELPER_DEST_DIR/word-fixer-helper.mjs"
fi
rm -rf "$DEFAULTS_DEST_DIR"
ditto "$DEFAULTS_SOURCE_DIR" "$DEFAULTS_DEST_DIR"
chmod +x "$MACOS_DIR/$EXECUTABLE_NAME"

# Give local builds a stable designated requirement so macOS Accessibility
# permission survives when the executable changes between installations.
codesign \
  --force \
  --deep \
  --sign - \
  --identifier "$BUNDLE_IDENTIFIER" \
  --requirements "=designated => identifier \"$BUNDLE_IDENTIFIER\"" \
  "$APP_DIR"

echo "$APP_DIR"
