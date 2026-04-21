# Word Fixer

A tiny macOS menu bar app that fixes selected text with `pi`.

Select text in almost any app, press **⌘⇧C**, review the inline diff, then press **Enter** to apply the correction or **Escape** to cancel.

## Requirements

- macOS 14+
- Swift 5.10+
- `pi` installed
- Accessibility permission enabled for the app / terminal running it

## Build and run

```bash
swift build
swift run
```

Or:

```bash
make build
make run
```

## Package as a real app

Build a release `.app` bundle:

```bash
make package
```

That creates:

```text
dist/Word Fixer.app
```

Open it directly:

```bash
make open
```

## Install

Install for the current user:

```bash
make install
```

Install into `/Applications`:

```bash
make install-system
```

Or run the script directly:

```bash
./scripts/install.sh --open
./scripts/install.sh --system --open
```

## Usage

1. Select text in any supported app
2. Press **⌘⇧C**
3. Wait for the overlay to show the corrected diff
4. Press **Enter** to replace the selection
5. Press **Escape** to dismiss without changing anything

## How it works

Word Fixer now uses **Accessibility APIs first**:
- reads the focused text element and selected range
- sends the selected text to `pi`
- writes the corrected text back to the same element/range

If the focused app does not expose usable text attributes through Accessibility, Word Fixer falls back to clipboard-based copy/paste simulation. That fallback is less reliable than the Accessibility path.

## Configuration

Config directory:

```text
~/.config/word-fixer/
```

Main config file:

```text
~/.config/word-fixer/config.json
```

Default config:

```json
{
  "shortcutKey": "c",
  "shortcutModifiers": ["command", "shift"],
  "piBinaryPath": "/Users/haza/.vite-plus/js_runtime/node/24.15.0/bin/pi"
}
```

### `pi` environment

Word Fixer uses its own `pi` config directory:

```text
~/.config/word-fixer/.pi/
```

Important files:

- `~/.config/word-fixer/.pi/SYSTEM.md` — system prompt for correction behavior
- `~/.config/word-fixer/.pi/settings.json` — provider/model settings
- `~/.config/word-fixer/.pi/auth.json` — auth copied or created for this app

Example `settings.json` using Haiku:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-haiku-4-5"
}
```

## Customizing the prompt

Edit:

```text
~/.config/word-fixer/.pi/SYSTEM.md
```

Default prompt:

```md
You are a spelling and grammar corrector. You receive text and return ONLY the corrected version. Do not explain changes. Do not add commentary. Return the corrected text and nothing else. If the text is already correct, return it unchanged.
```

## Permissions

Word Fixer needs **Accessibility** permission.

On first launch it prompts for access. If it does not work, open:

**System Settings → Privacy & Security → Accessibility**

and enable the app or the terminal you are using to run `swift run`.

## Notes

- The overlay is non-editable by design.
- Terminal apps may behave differently from normal text apps.
- Apps with poor Accessibility support may fall back to simulated copy/paste, which can be less reliable.
