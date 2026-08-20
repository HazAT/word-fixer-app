# AGENTS.md

## Project
Word Fixer is a macOS menu bar app that fixes selected text with `pi`.

Flow:
1. Global hotkey triggers capture
2. Read selected text from the focused app
3. Send text to `pi --no-tools`
4. Show inline diff in overlay
5. Enter applies, Escape cancels

## Most important rule
This project is **AX-first**.

Use Accessibility APIs as the primary capture/apply path.
Clipboard copy/paste is fallback only.
Do not redesign the app back toward clipboard-first behavior unless explicitly asked.

## Build / run
```bash
swift build
swift run
```

Or:
```bash
make build
make run
```

## Package / install
```bash
make package
make install
make reinstall
```

Installed app:
```text
~/Applications/Word Fixer.app
```

Use the installed app consistently when testing permissions. Avoid switching between `swift run`, `dist/...`, and installed copies unless needed.

## Config
Main config dir:
```text
~/.config/word-fixer/
```

Important files:
- `~/.config/word-fixer/config.json`
- `~/.config/word-fixer/.pi/SYSTEM.md`
- `~/.config/word-fixer/.pi/settings.json`
- `~/.pi/agent/auth.json` — shared Pi authentication

## Key files
- `Sources/WordFixer/WordFixerApp.swift` — app entry + hotkey
- `Sources/WordFixer/AppState.swift` — session orchestration
- `Sources/WordFixer/TextCapture.swift` — AX capture/apply + fallback
- `Sources/WordFixer/PiInvoker.swift` — `pi` execution
- `Sources/WordFixer/DiffEngine.swift` — diff rendering
- `Sources/WordFixer/OverlayPanel.swift` / `OverlayView.swift` — overlay UI
- `Sources/WordFixer/ConfigManager.swift` — config bootstrap

## Permissions
Accessibility permission is required.
If behavior is weird, first check macOS Accessibility settings and make sure the correct app path is authorized.
