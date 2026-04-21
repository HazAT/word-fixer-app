#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_SCRIPT="$ROOT/scripts/package-app.sh"
APP_PATH="$($PACKAGE_SCRIPT | tail -n 1)"
TARGET_DIR="$HOME/Applications"
OPEN_AFTER_INSTALL=0

resolve_user_home() {
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    dscl . -read "/Users/${SUDO_USER}" NFSHomeDirectory | awk '{print $2}'
    return
  fi

  printf '%s\n' "$HOME"
}

bootstrap_config() {
  local user_home pi_path node_path config_dir config_file
  user_home="$(resolve_user_home)"
  config_dir="$user_home/.config/word-fixer"
  config_file="$config_dir/config.json"

  pi_path="$(command -v pi || true)"
  if [[ -z "$pi_path" ]]; then
    echo "Warning: pi not found on PATH; leaving $config_file unchanged" >&2
    return
  fi

  case "$pi_path" in
    /*) ;;
    *) pi_path="$(cd "$(dirname "$pi_path")" && pwd)/$(basename "$pi_path")" ;;
  esac

  node_path="$(dirname "$pi_path")/node"
  if [[ ! -x "$node_path" ]]; then
    node_path="$(command -v node || true)"
  fi

  if [[ -z "$node_path" ]]; then
    echo "Warning: node not found; leaving $config_file unchanged" >&2
    return
  fi

  mkdir -p "$config_dir"

  if [[ ! -f "$config_file" ]]; then
    cat > "$config_file" <<EOF
{
  "shortcutKey": "c",
  "shortcutModifiers": ["command", "shift"],
  "piBinaryPath": "$pi_path",
  "debugLogging": true
}
EOF
    echo "Bootstrapped $config_file"
    return
  fi

  "$node_path" - <<'EOF' "$config_file" "$pi_path"
const fs = require('fs');
const [configFile, piPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const current = config.piBinaryPath ?? '';
if (current && fs.existsSync(current)) {
  process.exit(0);
}
config.piBinaryPath = piPath;
fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
EOF

  echo "Ensured piBinaryPath in $config_file -> $pi_path"
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
rm -rf "$TARGET_APP"
ditto "$APP_PATH" "$TARGET_APP"

echo "Installed to $TARGET_APP"
bootstrap_config

if [[ "$OPEN_AFTER_INSTALL" -eq 1 ]]; then
  open "$TARGET_APP"
fi
