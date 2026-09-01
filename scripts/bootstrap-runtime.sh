#!/usr/bin/env bash
set -euo pipefail

umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SDK_PACKAGE="@earendil-works/pi-coding-agent"
PROVIDER="openai-codex"
MODEL="gpt-5.4-mini"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_DIR="$CONFIG_HOME/word-fixer"
PI_DIR="$CONFIG_DIR/.pi"
DATA_DIR="$DATA_HOME/word-fixer"
SDK_DIR="$DATA_DIR/sdk"
NPM_CACHE_DIR="$DATA_DIR/npm-cache"
SUPPORT_BIN_DIR="$DATA_DIR/bin"
CONFIG_FILE="$CONFIG_DIR/config.json"
AUTH_FILE="$HOME/.pi/agent/auth.json"
NODE_COMMAND="${WORD_FIXER_NODE_PATH:-$(command -v node || true)}"
NPM_COMMAND="${WORD_FIXER_NPM_PATH:-$(command -v npm || true)}"
PI_COMMAND="${WORD_FIXER_PI_PATH:-}"
SDK_MANIFEST="$ROOT/helper/package.json"
SDK_LOCKFILE="$ROOT/helper/package-lock.json"
SDK_LOADER="$ROOT/helper/sdk-loader.mjs"

fail() {
  echo "word-fixer-runtime: $*" >&2
  exit 1
}

if [[ -z $PI_COMMAND && -n $NODE_COMMAND ]]; then
  PI_COMMAND="$("$NODE_COMMAND" - <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const packageName = '@earendil-works/pi-coding-agent';
for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
  const candidate = path.join(directory, 'pi');
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    const realPath = fs.realpathSync(candidate);
    let packageDirectory = path.dirname(realPath);
    while (true) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
        if (manifest.name === packageName) {
          process.stdout.write(candidate);
          process.exit(0);
        }
      } catch {}
      const parent = path.dirname(packageDirectory);
      if (parent === packageDirectory) break;
      packageDirectory = parent;
    }
  } catch {}
}
EOF
)"
fi

[[ -n $NODE_COMMAND && $NODE_COMMAND == /* && -x $NODE_COMMAND ]] || fail "Node.js was not found at an absolute executable path."
[[ -n $NPM_COMMAND && $NPM_COMMAND == /* && -x $NPM_COMMAND ]] || fail "npm was not found at an absolute executable path."
[[ -n $PI_COMMAND && $PI_COMMAND == /* && -x $PI_COMMAND ]] || fail "Pi was not found at an absolute executable path."
[[ -r $SDK_MANIFEST && -r $SDK_LOCKFILE && -r $SDK_LOADER ]] || fail "locked SDK runtime files are missing from $ROOT/helper."
[[ -r $AUTH_FILE ]] || fail "canonical Pi authentication is missing at $AUTH_FILE. Sign in with pi and retry."

node_version="$($NODE_COMMAND -p 'process.versions.node')"
"$NODE_COMMAND" -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1);
' || fail "Node.js 22.19 or newer is required (found v$node_version)."

sdk_version="$($NODE_COMMAND -e '
  const manifest = require(process.argv[1]);
  const version = manifest.dependencies?.[process.argv[2]];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) process.exit(1);
  process.stdout.write(version);
' "$SDK_MANIFEST" "$SDK_PACKAGE")" || fail "$SDK_MANIFEST must pin $SDK_PACKAGE to an exact version."

"$NODE_COMMAND" -e '
  const lock = require(process.argv[1]);
  const actual = lock.packages?.['node_modules/' + process.argv[2]]?.version;
  if (actual !== process.argv[3]) process.exit(1);
' "$SDK_LOCKFILE" "$SDK_PACKAGE" "$sdk_version" || fail "$SDK_LOCKFILE does not lock $SDK_PACKAGE at $sdk_version."

model_output="$($PI_COMMAND --list-models "$PROVIDER/$MODEL")" || fail "could not query the required Pi model $PROVIDER/$MODEL."
awk -v provider="$PROVIDER" -v model="$MODEL" 'NR > 1 && $1 == provider && $2 == model { found = 1 } END { exit !found }' <<<"$model_output" \
  || fail "required model $PROVIDER/$MODEL is unavailable; no fallback model will be used."

auth_output="$($PI_COMMAND auth check --provider "$PROVIDER" --model "$MODEL" --json --no-refresh)" \
  || fail "canonical authentication for $PROVIDER/$MODEL is not ready."
AUTH_OUTPUT="$auth_output" "$NODE_COMMAND" -e '
  const value = JSON.parse(process.env.AUTH_OUTPUT);
  if (value.status !== "ready" || value.provider !== process.argv[1] || typeof value.authType !== "string") process.exit(1);
' "$PROVIDER" || fail "canonical authentication for $PROVIDER/$MODEL is not ready."

mkdir -p "$CONFIG_DIR" "$PI_DIR" "$DATA_DIR" "$SUPPORT_BIN_DIR" "$NPM_CACHE_DIR"
chmod 700 "$CONFIG_DIR" "$PI_DIR" "$DATA_DIR" "$SUPPORT_BIN_DIR" "$NPM_CACHE_DIR"

sdk_is_current() {
  local installed_package="$SDK_DIR/node_modules/@earendil-works/pi-coding-agent/package.json"
  [[ -r $SDK_DIR/package.json && -r $SDK_DIR/package-lock.json && -r $SDK_DIR/sdk-loader.mjs && -r $installed_package ]] || return 1
  cmp -s "$SDK_MANIFEST" "$SDK_DIR/package.json" || return 1
  cmp -s "$SDK_LOCKFILE" "$SDK_DIR/package-lock.json" || return 1
  cmp -s "$SDK_LOADER" "$SDK_DIR/sdk-loader.mjs" || return 1
  "$NODE_COMMAND" -e '
    const installed = require(process.argv[1]);
    if (installed.version !== process.argv[2]) process.exit(1);
  ' "$installed_package" "$sdk_version" || return 1
  SDK_CHECK_DIR="$SDK_DIR" "$NODE_COMMAND" --input-type=module -e '
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    await import(pathToFileURL(path.join(process.env.SDK_CHECK_DIR, "sdk-loader.mjs")));
  ' >/dev/null 2>&1
}

if ! sdk_is_current; then
  temporary_directory="$(mktemp -d "$DATA_DIR/.sdk-install.XXXXXX")"
  trap 'rm -rf "${temporary_directory:-}"' EXIT
  cp "$SDK_MANIFEST" "$temporary_directory/package.json"
  cp "$SDK_LOCKFILE" "$temporary_directory/package-lock.json"
  cp "$SDK_LOADER" "$temporary_directory/sdk-loader.mjs"
  if ! (
    cd "$temporary_directory"
    NPM_CONFIG_CACHE="$NPM_CACHE_DIR" "$NPM_COMMAND" ci --omit=dev --ignore-scripts --no-audit --no-fund
  ); then
    fail "could not install the locked $SDK_PACKAGE dependency. Restore network access and retry."
  fi
  SDK_CHECK_DIR="$temporary_directory" "$NODE_COMMAND" --input-type=module -e '
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    await import(pathToFileURL(path.join(process.env.SDK_CHECK_DIR, "sdk-loader.mjs")));
  ' || fail "the installed $SDK_PACKAGE package could not be loaded by Node."
  rm -rf "$SDK_DIR"
  mv "$temporary_directory" "$SDK_DIR"
  temporary_directory=""
  trap - EXIT
fi

if [[ -e $SUPPORT_BIN_DIR/node && ! -L $SUPPORT_BIN_DIR/node ]]; then
  fail "Node runtime path already exists and is not a symbolic link: $SUPPORT_BIN_DIR/node"
fi
ln -sfn "$NODE_COMMAND" "$SUPPORT_BIN_DIR/node"

for prompt_name in SYSTEM NATURAL FEEDBACK; do
  if [[ ! -e $PI_DIR/$prompt_name.md ]]; then
    cp "$ROOT/shared/prompts/$prompt_name.md" "$PI_DIR/$prompt_name.md"
    chmod 600 "$PI_DIR/$prompt_name.md"
  fi
done
if [[ ! -e $PI_DIR/settings.json ]]; then
  cp "$ROOT/shared/settings.json" "$PI_DIR/settings.json"
  chmod 600 "$PI_DIR/settings.json"
fi

CONFIG_FILE="$CONFIG_FILE" NODE_PATH="$SUPPORT_BIN_DIR/node" "$NODE_COMMAND" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const configFile = process.env.CONFIG_FILE;
let config = {};
if (fs.existsSync(configFile)) {
  config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${configFile} must contain a JSON object.`);
  }
}
delete config.piBinaryPath;
config.nodeBinaryPath = process.env.NODE_PATH;
config.shortcutKey ??= 'c';
config.shortcutModifiers ??= ['command', 'shift'];
config.debugLogging ??= true;
const temporaryFile = path.join(path.dirname(configFile), `.config.json.${process.pid}`);
fs.writeFileSync(temporaryFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporaryFile, configFile);
EOF

rm -f "$CONFIG_DIR/helper.json" "$CONFIG_DIR/debug.log" "$PI_DIR/models-store.json"
printf 'Word Fixer runtime ready: %s@%s using Node v%s\n' "$SDK_PACKAGE" "$sdk_version" "$node_version"
