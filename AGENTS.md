# AGENTS.md

## Project

Word Fixer has two platform frontends around one review contract:

- **macOS 14+** — existing Swift/AppKit menu bar app.
- **Omarchy** — Hyprland capture/client plus a keep-loaded Quickshell overlay in `omarchy-shell`.

Every successful review produces `Light edit`, `Natural English`, and `Takeaway` through three fresh concurrent in-memory Pi SDK sessions.

## Platform invariants

### macOS remains AX-first

Use Accessibility APIs as the primary macOS capture/apply path. Clipboard copy/paste is fallback only. Do not redesign macOS toward clipboard-first behavior because Linux uses the Wayland clipboard.

Both frontends use the shared prompts, app-owned SDK layout, XDG-aware config/data paths, and versioned helper API. macOS packaging must seed the same locked runtime without changing its AX-first capture and apply behavior.

### Omarchy paste must be exact-target safe

Capture the Hyprland source address, PID, initial class, and terminal classification before opening the overlay. On acceptance:

1. hide the overlay;
2. place the chosen correction on the plain-text clipboard;
3. require the captured source to still exist;
4. refocus and verify the same address, PID, and initial class;
5. verify again immediately before input;
6. only then dispatch paste.

Never paste into a changed or unverified window. On refusal, keep the correction on the clipboard and notify the user. Cancellation and failures must not modify source text and must release request state and the single-instance lock.

Normal windows use Ctrl+C/Ctrl+V. Windows tagged `terminal` use Ctrl+Insert/Shift+Insert. Omarchy capture clears the previous clipboard; rich MIME restoration is intentionally unsupported.

Never clear the clipboard or inject copy from inside the triggering Hyprland Lua key callback. The callback captures source metadata and returns; the external single-instance client then verifies the target, clears the clipboard, and dispatches copy. Bind on key release so trigger state is settled before client launch.

### Pi runtime is fixed and isolated

Every task session must use:

- provider/model: `openai/gpt-6-luna`;
- thinking: `off`;
- tools: `noTools: "all"`;
- fresh in-memory session, disposed on every completion path.

Run correction, natural rewrite, and takeaway concurrently. Do not add model fallback, persistent sessions, conversation history, a model picker, or copied credentials.

The locked `@earendil-works/pi-coding-agent` SDK belongs under `~/.local/share/word-fixer/sdk/` (or `$XDG_DATA_HOME/word-fixer/sdk/`), never in checkout `node_modules` or a global package. Prompts and app Pi settings belong under `~/.config/word-fixer/.pi/`. Authentication remains canonical at `~/.pi/agent/auth.json`.

### Linux dictation

`word-fixer-dictate` transforms stdin to one repaired transcript on stdout; Voxtype owns paste. This is the explicitly supported exception to no auto-paste without review, not a clipboard or capture path. Use one fresh in-memory `openai/gpt-6-luna` session, thinking off, no tools, disposed on every path. Every failure or guard rejection has empty stdout and non-zero exit so Voxtype uses raw text. No review lock, notifications, model fallback or macOS dictation.

Helper API remains v3 with additive `features: ["dictate", "prewarm"]` in health and helper state. Reviews require only a healthy v3 helper; dictation/prewarm also require the corresponding feature, retiring verified featureless v3 helpers under the startup lock. Do not change Swift or weaken macOS capture/apply behavior.

Load `DICTATION.md` and optional user `VOCABULARY.md` lazily on every call, never in `loadPiServices`. The macOS installer does not seed the dictation prompt. Linux installers seed only missing `DICTATION.md` and never create or modify vocabulary.

### Linux event hooks

Follow `docs/events.md` for the `word-fixer.event.v1` contract. Emit one completion event per dictation/review, never prewarm or duplicate invocation. `eventCommand` (argv, no shell) and `eventLog` are opt-in and off by default: events contain raw user text. Detached hook stdout/stderr must be ignored, stdin delivery capped at 1000 ms, and failures must never alter output, exit code, or paste-safety ordering. No network integration or retries belong here. ASR labels come from `WORD_FIXER_ASR_ENGINE`, `WORD_FIXER_ASR_MODEL`, and `WORD_FIXER_ASR_BACKEND`.

## Configuration and generated state

```text
~/.config/word-fixer/config.json
~/.config/word-fixer/.pi/{SYSTEM,NATURAL,FEEDBACK,DICTATION}.md
~/.config/word-fixer/.pi/VOCABULARY.md (optional, user-owned)
~/.config/word-fixer/.pi/settings.json
~/.pi/agent/auth.json

~/.local/share/word-fixer/sdk/
~/.local/share/word-fixer/helper.json
~/.local/share/word-fixer/models-store.json
~/.local/share/word-fixer/debug.log
~/.local/share/word-fixer/events.jsonl (opt-in, raw text, mode 0600)
${XDG_RUNTIME_DIR:-/tmp}/word-fixer/
```

Optional config keys: `helperIdleTimeoutMs` (positive integer, default 120000), `dictation.timeoutMs` (positive integer, default 8000), `dictation.maxEditRatio` (non-negative finite number, default 0.5). `WORD_FIXER_HELPER_IDLE_MS` overrides configured idle timeout. `WORD_FIXER_CONFIG_DIR` and `WORD_FIXER_DATA_DIR` override XDG paths; `VOXTYPE_CONTEXT` provides previous dictation context, clamped to 4 KiB.

Platform installers seed only missing prompts and settings. Never overwrite user prompt customization. Runtime helper state, logs, sockets, locks, requests, installed dependencies, and credentials must remain untracked.

## Key files

### Shared review engine

- `helper/helper-lib.mjs` — config paths, SDK services, model/session invariants, validation, cancellation, and timeout.
- `helper/word-fixer-helper.mjs` — versioned loopback health/review service.
- `helper/sdk-loader.mjs`, `helper/package.json`, `helper/package-lock.json` — locked app-owned SDK.
- `shared/prompts/`, `shared/settings.json` — versioned cross-platform bootstrap defaults.

### macOS

- `Sources/WordFixer/WordFixerApp.swift` — app entry and hotkey.
- `Sources/WordFixer/AppState.swift` — session orchestration.
- `Sources/WordFixer/TextCapture.swift` — AX-first capture/apply and clipboard fallback.
- `Sources/WordFixer/PiInvoker.swift`, `PiHelperClient.swift` — helper transport/supervision.
- `Sources/WordFixer/DiffEngine.swift` — inline diff.
- `Sources/WordFixer/OverlayPanel.swift`, `OverlayView.swift` — AppKit/SwiftUI overlay.
- `Sources/WordFixer/ConfigManager.swift` — shared config/data paths and non-destructive default bootstrap.
- `scripts/bootstrap-runtime.sh` — locked macOS SDK, Node link, prompt/settings, model, and auth bootstrap.

### Omarchy/Linux

- `manifest.json` — schema-v1 `hazat.word-fixer` overlay and bar-widget plugin.
- `linux/install` — idempotent install and non-destructive `--check`.
- `linux/bin/word-fixer` — single-instance client entry point.
- `linux/bin/word-fixer-dictate`, `linux/lib/dictate.mjs` — bounded stdin/stdout dictation, guard and detached prewarm.
- `shared/prompts/DICTATION.md` — transcript-only repair contract.
- `linux/hypr/word-fixer.lua` — source capture and deferred external-client launch only; no clipboard or input injection.
- `linux/lib/events.mjs` — v1 event builders, bounded target capture, opt-in detached hook and local NDJSON log.
- `linux/lib/orchestrator.mjs` — loading/review/error flow and safe paste-back.
- `linux/lib/system.mjs` — process, helper, clipboard, shell, focus, and notification integration.
- `linux/lib/runtime.mjs` — restrictive request IPC, lock, timeout, and cleanup.
- `linux/lib/protocol.mjs`, `diff.mjs`, `target.mjs`, `input-command.mjs` — validated platform primitives.
- `linux/omarchy/WordFixer.qml`, `WordFixerModel.js` — themed overlay, controls, escaped diff rendering.
- `Status.qml` — persistent ready indicator and active-review status in the Omarchy bar.
- `linux/test/` — Linux unit, overlay, orchestration, and installer tests.

## Verification

### Required for shared helper or Omarchy changes

```bash
node --test helper/helper-lib.test.mjs linux/test/*.test.mjs
for file in helper/helper-lib.mjs helper/sdk-loader.mjs helper/word-fixer-helper.mjs linux/bin/word-fixer linux/bin/word-fixer-dictate linux/lib/*.mjs; do node --check "$file"; done
bash -n linux/install
luac -p linux/hypr/word-fixer.lua
omarchy plugin validate "$PWD"
```

Use `./linux/install --check` for live installation status. Installer tests already exercise a temporary XDG home, double installation, prompt/settings preservation, and prerequisite failures.

### Required for live binding or managed machine-config changes

The product installer does not edit personal bindings. Managed config must explicitly replace HEY Calendar:

```lua
hl.unbind("SUPER + SHIFT + C")
o.bind("SUPER + SHIFT + C", "Word Fixer", function()
  dofile((os.getenv("HOME") or "") .. "/.config/omarchy/plugins/hazat.word-fixer/linux/hypr/word-fixer.lua").capture()
end, { release = true })
```

Verify with:

```bash
omarchy menu keybindings --print | rg 'SUPER SHIFT \+ C|Word Fixer|Calendar'
hyprctl reload
test -z "$(hyprctl configerrors)"
~/omarchy-config/bin/doctor.sh
```

Keep product implementation in this repository. Machine config may track only the declarative binding, plugin enablement, and installer wrapper; never copy QML/helper/prompt source into `~/omarchy-config`.

### macOS verification

For changes that touch Swift, the shared helper, or macOS packaging:

```bash
swift build
swift test
make package
```

Install and launch `~/Applications/Word Fixer.app`, verify helper prewarm from `~/.local/share/word-fixer/debug.log`, and run one real review when authentication is available. `make test` includes Swift and helper tests and is therefore macOS-only. When testing Accessibility permissions, use one stable installed app path rather than switching among `swift run`, `dist/...`, and installed copies.

## Supported scope

Do not claim or add non-Omarchy compositor support, a standalone Linux GUI, auto-paste without review (except Voxtype-owned dictation paste above), rich clipboard restoration, settings UI, model selection, history, or persistent sessions unless explicitly requested.
