#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_SCRIPT="$ROOT/scripts/package-app.sh"
RUNTIME_SCRIPT="$ROOT/scripts/bootstrap-runtime.sh"
APP_PATH="$($PACKAGE_SCRIPT | tail -n 1)"
TARGET_DIR="$HOME/Applications"
OPEN_AFTER_INSTALL=0

bootstrap_runtime() {
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    local user_home
    user_home="$(dscl . -read "/Users/$SUDO_USER" NFSHomeDirectory | awk '{print $2}')"
    sudo -u "$SUDO_USER" env -u XDG_CONFIG_HOME -u XDG_DATA_HOME HOME="$user_home" PATH="$PATH" "$RUNTIME_SCRIPT"
    return
  fi
  "$RUNTIME_SCRIPT"
}

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
TARGET_EXECUTABLE="$TARGET_APP/Contents/MacOS/WordFixer"

running_pid="$(pgrep -f -x "$TARGET_EXECUTABLE" || true)"
if [[ -n "$running_pid" ]]; then
  kill "$running_pid"
  for _ in {1..30}; do
    if ! kill -0 "$running_pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  if kill -0 "$running_pid" 2>/dev/null; then
    echo "Word Fixer is still running; quit it before installing." >&2
    exit 1
  fi
fi

rm -rf "$TARGET_APP"
ditto "$APP_PATH" "$TARGET_APP"
bootstrap_runtime

echo "Installed to $TARGET_APP"

if [[ "$OPEN_AFTER_INSTALL" -eq 1 ]]; then
  open "$TARGET_APP"
fi
