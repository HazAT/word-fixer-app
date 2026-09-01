# RPC / SDK test scripts

These scripts are for isolating Pi transport behavior outside the macOS app.

## Requirements

- Node and `pi` available on PATH
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

This isolates Pi's RPC reset behavior; the app itself uses fresh in-memory SDK sessions.

### 3. Direct SDK bindings

```bash
node scripts/test-pi-sdk-once.mjs "helo wrld"
```

Uses the locked app-owned Pi SDK instead of the CLI RPC mode. Run the platform installer first so the SDK exists under app data.

### 4. Helper HTTP transport

```bash
node scripts/test-word-fixer-helper.mjs "helo wrld"
```

Starts the local helper, waits for `~/.local/share/word-fixer/helper.json`, then exercises:
- `POST /health`
- `POST /review`
- `POST /shutdown`
