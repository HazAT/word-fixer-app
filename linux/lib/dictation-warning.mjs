import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';

// Repeat the same warning at most this often while a failure persists.
export const WARNING_INTERVAL_MS = 15 * 60 * 1000;
const WARNING_BUDGET_MS = 250;

const kinds = [
  {
    kind: 'auth',
    test: /api key|auth|login|credential|invalid_grant|refresh|unauthori[sz]ed|\b40[13]\b/i,
    urgency: 'critical',
    body: 'Pi has no working OpenAI Codex login. Run pi, then /login → OpenAI Codex (legacy).',
  },
  {
    kind: 'timeout',
    test: /timed out/i,
    urgency: 'normal',
    body: 'Luna did not answer in time.',
  },
  {
    kind: 'setup',
    test: /installer|sdk|helper|ECONNREFUSED|config/i,
    urgency: 'critical',
    body: 'The Word Fixer helper is not working. Run word-fixer-setup or ./linux/install --check.',
  },
  { kind: 'failed', test: /./, urgency: 'critical', body: '' },
];

export function dictationWarning(details) {
  if (details?.outcome !== 'failed') return null;
  const error = String(details.error ?? 'Unknown error');
  const { kind, urgency, body } = kinds.find((entry) => entry.test.test(error));
  return {
    kind,
    urgency,
    title: 'Dictation not repaired',
    body: `The raw transcript was pasted. ${body || error.slice(0, 200)}`,
  };
}

// Best-effort and bounded: never throws, never waits for notify-send, and spends at most WARNING_BUDGET_MS.
export async function warnDictationFallback(details, {
  stateDirectory = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'word-fixer'),
  spawn = spawnProcess,
  now = Date.now(),
} = {}) {
  let timer;
  try {
    await Promise.race([
      updateWarning(details, { stateDirectory, spawn, now }),
      new Promise((resolve) => { timer = setTimeout(resolve, WARNING_BUDGET_MS); }),
    ]);
  } catch {
    // A warning must never change dictation output or exit status.
  } finally {
    clearTimeout(timer);
  }
}

async function updateWarning(details, { stateDirectory, spawn, now }) {
  const statePath = path.join(stateDirectory, 'dictation-warning.json');
  if (details?.outcome === 'fixed' || details?.outcome === 'unchanged') {
    await fs.rm(statePath, { force: true });
    return;
  }
  const warning = dictationWarning(details);
  if (!warning) return;
  // Last notification time per failure kind, so alternating failures cannot re-arm each other.
  const sent = await fs.readFile(statePath, 'utf8').then(JSON.parse).catch(() => ({}));
  if (now - (sent[warning.kind] ?? -Infinity) < WARNING_INTERVAL_MS) return;
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(statePath, `${JSON.stringify({ ...sent, [warning.kind]: now })}\n`, { mode: 0o600 });
  const child = spawn('notify-send', [
    `--urgency=${warning.urgency}`, '--app-name=Word Fixer', warning.title, warning.body,
  ], { detached: true, stdio: 'ignore', shell: false });
  child.on('error', () => {});
  child.unref();
}
