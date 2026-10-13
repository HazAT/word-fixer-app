import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HelperClient } from '../lib/system.mjs';

// The helper runs its real HTTP and session paths against an isolated SDK double.
const fakeSdk = `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
export class ModelRuntime {
  static async create() { return new ModelRuntime(); }
  getModel(provider, id) { return { provider, id }; }
}
export const SettingsManager = { create() { return {}; } };
export const SessionManager = { inMemory() { return { fresh: true }; } };
export class DefaultResourceLoader {
  constructor(options) { this.prompt = options.systemPromptOverride(); }
  async reload() {}
}
export async function createAgentSession(options) {
  assert.equal(options.model.provider, 'openai');
  assert.equal(options.model.id, 'gpt-6-luna');
  assert.equal(options.thinkingLevel, 'off');
  assert.equal(options.noTools, 'all');
  assert.equal(options.sessionManager.fresh, true);
  let callback;
  let finish;
  let mode;
  return { session: {
    model: options.model,
    subscribe(fn) { callback = fn; return () => {}; },
    async prompt(text) {
      mode = text;
      if (text === 'hang') return new Promise(resolve => { finish = resolve; });
      if (text === 'fail') throw new Error('fake model failure');
      callback({ type: 'message_end', message: {
        role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop',
        usage: { cost: { total: 0.002 } },
      }});
    },
    async abort() { finish?.(); },
    dispose() { void fs.appendFile(process.env.WF_SESSION_LOG, mode + '\\n'); },
  }};
}
`;

test('HTTP prewarm and dictate use additive API v3 features, lazy prompts and dispose on all completion paths', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-helper-dictation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configDirectory = path.join(directory, 'config');
  const dataDirectory = path.join(directory, 'data');
  const piDirectory = path.join(configDirectory, '.pi');
  await fs.mkdir(piDirectory, { recursive: true });
  await fs.mkdir(path.join(dataDirectory, 'sdk'), { recursive: true });
  await fs.writeFile(path.join(dataDirectory, 'sdk', 'sdk-loader.mjs'), fakeSdk);
  await fs.writeFile(path.join(configDirectory, 'config.json'), JSON.stringify({
    nodeBinaryPath: process.execPath, dictation: { timeoutMs: 100 }, helperIdleTimeoutMs: 10000,
  }));
  for (const name of ['SYSTEM', 'NATURAL', 'FEEDBACK']) {
    await fs.writeFile(path.join(piDirectory, `${name}.md`), name);
  }
  const sessionLog = path.join(directory, 'sessions.log');
  const helper = new HelperClient({
    configDirectory, dataDirectory, environment: { ...process.env, WF_SESSION_LOG: sessionLog },
  });
  let launches = 0;
  const launch = helper.launch.bind(helper);
  helper.launch = async () => { launches += 1; await launch(); };
  await Promise.all([helper.prewarm(), helper.prewarm()]);
  assert.equal(launches, 1);
  const state = await helper.readState();
  assert.equal(state.apiVersion, 3);
  assert.deepEqual(state.features, ['dictate', 'prewarm']);
  t.after(async () => {
    await fetch(`http://127.0.0.1:${state.port}/shutdown`, { method: 'POST' }).catch(() => {});
  });
  await assert.rejects(helper.dictate('Transcript'), /Missing DICTATION.md/);
  await fs.writeFile(path.join(piDirectory, 'DICTATION.md'), 'Dictation prompt');
  const result = await helper.dictate('Transcript');
  assert.equal(result.text, 'Transcript');
  assert.equal(result.cost, 0.002);
  assert.ok(Number.isSafeInteger(result.durationMs) && result.durationMs >= 0);
  await assert.rejects(helper.dictate('fail'), /fake model failure/);
  await assert.rejects(helper.dictate('hang'), /timed out/);
  const controller = new AbortController();
  const cancelled = helper.dictate('hang', { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('cancel test')), 30);
  await assert.rejects(cancelled, /cancel test/);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const lines = (await fs.readFile(sessionLog, 'utf8')).trim().split('\n');
    if (lines.length === 4) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual((await fs.readFile(sessionLog, 'utf8')).trim().split('\n'), ['Transcript', 'fail', 'hang', 'hang']);
});
