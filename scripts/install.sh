#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_SCRIPT="$ROOT/scripts/package-app.sh"
APP_PATH="$($PACKAGE_SCRIPT | tail -n 1)"
TARGET_DIR="$HOME/Applications"
OPEN_AFTER_INSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --system)
      TARGET_DIR="/Applications"
      shift
      ;;
    --open)
      OPEN_AFTER_INSTALL=1
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--system] [--open]" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$TARGET_DIR"
TARGET_APP="$TARGET_DIR/$(basename "$APP_PATH")"
rm -rf "$TARGET_APP"
ditto "$APP_PATH" "$TARGET_APP"

echo "Installed to $TARGET_APP"

if [[ "$OPEN_AFTER_INSTALL" -eq 1 ]]; then
  open "$TARGET_APP"
fi
