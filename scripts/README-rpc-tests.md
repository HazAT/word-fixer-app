# RPC / SDK test scripts

These scripts are for isolating Pi transport behavior outside the macOS app.

## Requirements

- Node available on PATH
- `~/.config/word-fixer/config.json` configured
- `~/.config/word-fixer/.pi/` contains `settings.json` and `SYSTEM.md`
- Pi is authenticated through `~/.pi/agent/auth.json`

## Scripts

### 1. CLI RPC once

```bash
node scripts/test-pi-rpc-cli-once.mjs "helo wrld"
```

Tests a single RPC prompt over stdio and logs all stdout/stderr lines with timestamps.

### 2. CLI RPC loop + `new_session`

```bash
node scripts/test-pi-rpc-cli-loop.mjs "helo wrld" "ths is a tst"
```

Tests:
- first prompt
- `new_session`
- second prompt

This is the closest reproduction of the app's intended persistent RPC model.

### 3. Direct SDK bindings

```bash
node scripts/test-pi-sdk-once.mjs "helo wrld"
```

Uses direct Node bindings from the Pi SDK instead of the CLI RPC mode.
This answers the question: **yes, we can use direct Node bindings**.

The script resolves the SDK path from the configured `piBinaryPath`, so you do not need to install the Pi SDK package in this project.

### 4. Helper HTTP transport

```bash
node scripts/test-word-fixer-helper.mjs "helo wrld"
```

Starts the local helper, waits for `~/.config/word-fixer/helper.json`, then exercises:
- `POST /health`
- `POST /fix`
- `POST /shutdown`
