#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT/.build/release"
DIST_DIR="$ROOT/dist"
APP_NAME="Word Fixer.app"
APP_DIR="$DIST_DIR/$APP_NAME"
EXECUTABLE_NAME="WordFixer"
BINARY="$BUILD_DIR/$EXECUTABLE_NAME"
PLIST_SOURCE="$ROOT/Resources/Info.plist"
PLIST_DEST="$APP_DIR/Contents/Info.plist"
MACOS_DIR="$APP_DIR/Contents/MacOS"
RESOURCES_DIR="$APP_DIR/Contents/Resources"

mkdir -p "$DIST_DIR"

swift build -c release --package-path "$ROOT"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cp "$BINARY" "$MACOS_DIR/$EXECUTABLE_NAME"
cp "$PLIST_SOURCE" "$PLIST_DEST"
chmod +x "$MACOS_DIR/$EXECUTABLE_NAME"

# Ad-hoc sign so the bundle behaves like a normal app locally.
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP_DIR" >/dev/null 2>&1 || true
fi

echo "$APP_DIR"
