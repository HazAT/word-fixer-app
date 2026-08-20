---
name: word-fixer-onboarding
description: Guides end-to-end onboarding for the Word Fixer app from a clean checkout to a working installed app. Use when asked to "onboard word fixer", "set up word fixer", "install word fixer", "get word fixer working", "configure word fixer", or "help me set up this app". Checks repo state, pi availability, config, auth, installation, and macOS Accessibility permission, then proposes and executes the next actions with user confirmation.
---

Guide the user through a managed Word Fixer setup until the installed app is ready to use.

## Step 1: Inspect the current state

Start by checking the environment before proposing changes.

Inspect:
- repository root and expected project files
- whether `pi` exists at all
- whether `~/.config/word-fixer/` exists
- whether `~/.config/word-fixer/config.json` exists
- whether `~/.config/word-fixer/.pi/SYSTEM.md` exists
- whether global Pi auth exists at `~/.pi/agent/auth.json`
- whether `~/Applications/Word Fixer.app` exists
- whether `/Applications/Word Fixer.app` exists

Use `bash` for existence checks and `read` for config contents.

## Step 2: Summarize onboarding status

Report the current status as a short checklist before taking action.

Use this structure:

```text
Word Fixer onboarding status
- Repo: present / missing
- pi: found at ... / missing
- Word Fixer config: present / missing
- Global Pi auth: present / missing
- Installed app: present at ... / not installed
- Accessibility permission: requires manual confirmation in System Settings
```

If something is missing, state the exact next action needed.

## Step 3: Propose the next actions

Propose the smallest set of actions needed to finish onboarding.

Typical actions:

| Condition | Action |
|---|---|
| `pi` missing | Tell the user Word Fixer depends on an installed Pi runtime and ask them to install/configure `pi` first |
| Word Fixer config missing | Offer to run `make install`, `make install-system`, or launch the app once so config can be bootstrapped with the detected `pi` path |
| App not installed | Offer to run `make install` or `make reinstall` |
| Installed app path exists but user is testing from mixed locations | Recommend using the installed app path consistently |
| Accessibility permission not confirmed | Explain the exact System Settings path and the app path that must be authorized |

Do not perform config edits or installation until the user agrees. Word Fixer reads Pi's canonical auth file directly; do not copy OAuth credentials into its app-specific config directory.

## Step 4: Execute approved actions

After the user approves, perform only the agreed actions.

Allowed actions include:
- run `swift build`, `make build`, `make install`, `make install-system`, or `make reinstall`
- create `~/.config/word-fixer/.pi/` if needed
- show the current config file and explain fields
- point the user to `~/.config/word-fixer/.pi/SYSTEM.md` for prompt customization

## Step 5: Guide macOS permission setup

Treat Accessibility permission as a manual checkpoint.

Tell the user:
- open `System Settings -> Privacy & Security -> Accessibility`
- enable the installed app path they are actually using
- prefer `~/Applications/Word Fixer.app` if installed there
- avoid switching between `swift run`, `dist/Word Fixer.app`, and the installed app during permission setup

If the user reports odd behavior, ask them to verify the authorized app path first.

## Step 6: Verify the app is ready

Before declaring success, verify what can be verified automatically.

Check:
- the app builds successfully if you ran a build
- the installed app exists if you ran install
- the config directory exists
- `config.json` exists and `piBinaryPath` points at the detected `pi` binary when install/bootstrap was part of the workflow
- `~/.config/word-fixer/.pi/SYSTEM.md` exists
- `~/.pi/agent/auth.json` exists when auth is required

Then give the user a final manual verification sequence:

```text
1. Open the installed Word Fixer app
2. Confirm Accessibility permission is enabled for that exact app path
3. Select text in another app
4. Press the configured shortcut
5. Review the diff overlay
6. Press Enter to apply or Escape to cancel
```

## Step 7: End with a clear outcome

End with one of these outcomes:

- `Onboarding complete` — all required setup is in place, with any remaining manual Accessibility check called out explicitly
- `Blocked on pi installation` — Pi runtime is missing
- `Blocked on user confirmation` — waiting to install, copy auth, or edit config
- `Blocked on macOS permission` — app is installed but Accessibility is not yet granted

Use concise bullets. Include exact file paths and commands actually used.
