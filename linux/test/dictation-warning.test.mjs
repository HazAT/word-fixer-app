import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dictationWarning, warnDictationFallback, WARNING_INTERVAL_MS } from '../lib/dictation-warning.mjs';

const authError = { outcome: 'failed', error: 'No API key found for openai-codex.  Use /login to log into a provider via OAuth or API key.' };

test('auth failures warn critically with the login fix; guard rejections stay silent', () => {
  assert.deepEqual(dictationWarning(authError), {
    kind: 'auth',
    urgency: 'critical',
    title: 'Dictation not repaired',
    body: 'The raw transcript was pasted. Pi has no working OpenAI Codex login. Run pi, then /login → OpenAI Codex (legacy).',
  });
  assert.equal(dictationWarning({ outcome: 'failed', error: 'OAuth refresh failed for openai-codex: (401)' }).kind, 'auth');
  assert.equal(dictationWarning({ outcome: 'failed', error: 'Word Fixer helper failed to become ready.' }).kind, 'setup');
  assert.equal(dictationWarning({ outcome: 'failed', error: 'Helper request timed out after 8000ms.' }).urgency, 'normal');
  assert.match(dictationWarning({ outcome: 'failed', error: 'Pi changed the line-break structure.' }).body, /pasted\. Pi changed/);
  assert.equal(dictationWarning({ outcome: 'rejected', error: 'Dictation rejected by the transcript guard.' }), null);
  assert.equal(dictationWarning({ outcome: 'fixed' }), null);
});

test('a persisting failure notifies once per interval and success re-arms it', async (t) => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-warning-'));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { on() {}, unref() {} };
  };
  const warn = (details, now) => warnDictationFallback(details, { stateDirectory, spawn, now });

  await warn(authError, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'notify-send');
  assert.deepEqual(calls[0].args.slice(0, 3), ['--urgency=critical', '--app-name=Word Fixer', 'Dictation not repaired']);
  assert.deepEqual(calls[0].options, { detached: true, stdio: 'ignore', shell: false });

  await warn(authError, WARNING_INTERVAL_MS - 1);
  await warn({ outcome: 'rejected' }, WARNING_INTERVAL_MS - 1);
  assert.equal(calls.length, 1);
  await warn({ outcome: 'failed', error: 'Helper request timed out after 8000ms.' }, 2);
  assert.equal(calls.length, 2);
  await warn(authError, 3);
  assert.equal(calls.length, 2, 'an interleaved timeout must not re-arm the auth warning');
  await warn({ outcome: 'fixed' }, 4);
  await warn(authError, 5);
  assert.equal(calls.length, 3);
  await warn(authError, 5 + WARNING_INTERVAL_MS);
  assert.equal(calls.length, 4);
});

test('warning failures never throw', async (t) => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-warning-'));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const spawn = () => { throw new Error('no notify-send'); };
  await fs.writeFile(path.join(stateDirectory, 'file'), '');
  await warnDictationFallback(authError, { stateDirectory: path.join(stateDirectory, 'file'), spawn });
  await warnDictationFallback(authError, { stateDirectory, spawn });
});
