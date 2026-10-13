# Linux event hooks

Omarchy reviews and Linux dictations can emit one `word-fixer.event.v1` JSON object at completion. Both outputs are **opt-in and off by default**. Events include raw user text, window titles, and the machine hostname; only enable them for a trusted destination. macOS does not emit events.

## Configuration

Add optional keys to Word Fixer's `config.json` (other keys stay unchanged):

```json
{
  "eventCommand": ["/absolute/path/to/event-hook"],
  "eventLog": true
}
```

`eventCommand` is a non-empty array of non-empty strings: executable followed by arguments, **without a shell**. Invalid commands are ignored. The detached child receives exactly one JSON object plus a newline on stdin, with stdout and stderr ignored. Delivery is fire-and-forget: Word Fixer never waits for the child to exit. The **whole emission operation**, including local log append and stdin delivery, has a shared **1000 ms cap**; a stalled log cannot keep dictation running. Hook errors cannot change dictation output, exit status, or paste safety; they are recorded only when debug logging is enabled. No retries or network transport are built in.

`eventLog: true` appends NDJSON to `$XDG_DATA_HOME/word-fixer/events.jsonl` (normally `~/.local/share/word-fixer/events.jsonl`), creating it with mode **0600**. Config/data directory overrides follow the usual `WORD_FIXER_CONFIG_DIR` / `WORD_FIXER_DATA_DIR` rules. The log contains raw text; protect it and manage its retention yourself.

A generic executable hook that appends stdin to a user-selected file:

```sh
#!/bin/sh
umask 077
cat >> "$1"
```

Configure it with `["/absolute/path/to/event-hook", "/absolute/path/to/private-events.jsonl"]`.

## v1 contract

Common fields:

- `schema`: `word-fixer.event.v1`.
- `id`: UUID v4 from `crypto.randomUUID()`.
- `type`: `dictation` or `review`.
- `at`: ISO-8601 UTC completion time; `host`: `os.hostname()`; `platform`: `omarchy`.
- `input`: raw input string (null only for failure before capture/read).
- `output`: emitted/chosen text or null.
- `outcome`: dictation `fixed`, `unchanged`, `rejected`, `failed`; review `pasted`, `clipboard`, `cancelled`, `failed`.
- `durationMs`: total run duration.
- `target`: `{ "class": "...", "title": "..." }` or null.
- `llm`: `{ "model": "openai/gpt-6-luna", "durationMs": 0, "cost": 0.0 }` or null; numeric fields may be null.
- `error`: error message or null.

Only dictation events include `dictation`:

```json
{
  "source": "voxtype",
  "hadContext": false,
  "asr": { "engine": null, "model": null, "backend": null },
  "guard": { "editRatio": 0.0, "accepted": true }
}
```

`source` comes from `--source` (otherwise null). ASR labels come from `WORD_FIXER_ASR_ENGINE`, `WORD_FIXER_ASR_MODEL`, and `WORD_FIXER_ASR_BACKEND` (unset means null). `hadContext` reports non-empty `VOXTYPE_CONTEXT`. `guard` is null if assessment never ran; `guard.editRatio` is null when the growth limit rejects output before edit-distance computation. `output` is the printed text for fixed/unchanged (equal to input for unchanged), null for rejection/failure so Voxtype uses its own raw text. Target capture runs concurrently with the model call and is bounded to 500 ms; failure yields null. Prewarm emits nothing.

Only review events include `review`:

```json
{
  "choice": "light",
  "correction": "light edit",
  "natural": "natural rewrite",
  "takeaway": "usage tip",
  "terminal": false,
  "status": "accepted"
}
```

Choice 0 maps to `light`, choice 1 to `natural`, otherwise null. Alternatives are null until the review finishes. `terminal` and target class come from the captured source. Raw status `accepted` maps to `pasted`; `source-lost`, `refocus-failed`, and `target-mismatch` map to `clipboard`; cancellation maps to `cancelled`; thrown errors and dismissed review errors map to `failed`. Output is null for cancellation/failure. Duplicate invocations emit nothing. Emission occurs after the existing safe-paste/cleanup flow; none of its ordering or checks change.

Consumers must tolerate and preserve unknown extra fields. Batches use NDJSON. Very large reviews can produce individual events over 256 KiB; consumers such as a CLI transport with a 256 KiB transfer cap may reject them. Opt-in `eventLog` keeps these events locally without that size cap (when the append completes within the emission deadline).
