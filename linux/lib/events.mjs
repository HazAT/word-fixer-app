import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { REVIEW_MODEL } from '../../helper/helper-lib.mjs';

function base(type, details, target) {
  return {
    schema: 'word-fixer.event.v1', id: randomUUID(), type,
    at: new Date().toISOString(), host: os.hostname(), platform: 'omarchy',
    input: details.input ?? null, output: details.output ?? null,
    outcome: details.outcome, durationMs: details.durationMs,
    target: target ?? null,
    llm: details.llm ? { model: `${REVIEW_MODEL.provider}/${REVIEW_MODEL.id}`, durationMs: details.llm.durationMs ?? null, cost: details.llm.cost ?? null } : null,
    error: details.error ? String(details.error.message ?? details.error) : null,
  };
}

export function dictationEvent(details, { target = null, env = {} } = {}) {
  return {
    ...base('dictation', details, target),
    dictation: {
      source: details.source, hadContext: details.hadContext,
      asr: { engine: env.WORD_FIXER_ASR_ENGINE || null, model: env.WORD_FIXER_ASR_MODEL || null, backend: env.WORD_FIXER_ASR_BACKEND || null },
      guard: details.guard ? { editRatio: details.guard.editRatio, accepted: details.guard.accepted } : null,
    },
  };
}

export function reviewEvent(details) {
  const outcome = details.status === 'accepted' ? 'pasted'
    : ['source-lost', 'refocus-failed', 'target-mismatch'].includes(details.status) ? 'clipboard'
      : details.status === 'cancelled' ? 'cancelled' : 'failed';
  return {
    ...base('review', { ...details, outcome, output: ['pasted', 'clipboard'].includes(outcome) ? details.acceptedText : null }, details.target),
    review: {
      choice: details.choice === 0 ? 'light' : details.choice === 1 ? 'natural' : null,
      correction: details.review?.correction ?? null, natural: details.review?.natural ?? null,
      takeaway: details.review?.takeaway ?? null, terminal: details.terminal ?? false,
      status: details.status,
    },
  };
}

export function activeTarget() {
  return new Promise((resolve) => {
    execFile('hyprctl', ['activewindow', '-j'], { timeout: 500, maxBuffer: 64 * 1024 }, (error, stdout) => {
      try {
        if (error) return resolve(null);
        const window = JSON.parse(stdout);
        resolve(typeof window.class === 'string' && typeof window.title === 'string'
          ? { class: window.class, title: window.title } : null);
      } catch { resolve(null); }
    });
  });
}

export async function emitEvent(event, { config = {}, dataDir, log } = {}) {
  const debug = (message) => {
    if (config.debugLogging === true || process.env.WORD_FIXER_DEBUG === '1') Promise.resolve().then(() => log?.log(message)).catch(() => {});
  };
  let timer;
  let closeStdin = () => {};
  try {
    const line = `${JSON.stringify(event)}\n`;
    const append = async () => {
      if (config.eventLog !== true) return;
      try {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.appendFile(path.join(dataDir, 'events.jsonl'), line, {
          mode: 0o600,
          flag: constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK,
        });
      } catch (error) { debug(`event log failed: ${error.message}`); }
    };
    const command = async () => {
      const argv = config.eventCommand;
      if (argv === undefined) return;
      if (!Array.isArray(argv) || !argv.length || !argv.every((arg) => typeof arg === 'string' && arg.trim())) {
        debug('invalid eventCommand ignored');
        return;
      }
      await new Promise((resolve) => {
        const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
        const finish = () => { child.stdin.destroy(); resolve(); };
        closeStdin = finish;
        child.on('error', (error) => { debug(`event command failed: ${error.message}`); finish(); });
        child.stdin.on('error', (error) => { debug(`event stdin failed: ${error.message}`); finish(); });
        child.stdin.on('finish', finish);
        child.stdin.end(line);
        child.unref();
      });
    };
    await Promise.race([
      Promise.all([append(), command()]),
      new Promise((resolve) => {
        timer = setTimeout(() => { closeStdin(); resolve(); }, 1000);
      }),
    ]);
  } catch (error) { debug(`event emission failed: ${error.message}`); }
  finally { clearTimeout(timer); }
}
