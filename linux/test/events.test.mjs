import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { dictationEvent, reviewEvent, emitEvent } from '../lib/events.mjs';

for (const outcome of ['fixed', 'unchanged', 'rejected', 'failed']) {
  test(`dictation event shape: ${outcome}`, () => {
    const event = dictationEvent({ input: 'text', output: ['fixed', 'unchanged'].includes(outcome) ? 'text' : null, outcome, durationMs: 10, source: 'voxtype', hadContext: true, guard: { accepted: outcome !== 'rejected', editRatio: 0, unchanged: true }, llm: { cost: 0.01, durationMs: 5 }, error: outcome === 'failed' ? 'offline' : null });
    assert.equal(event.schema, 'word-fixer.event.v1');
    assert.match(event.id, /^[0-9a-f-]{36}$/);
    assert.equal(new Date(event.at).toISOString(), event.at);
    assert.equal(event.host, os.hostname());
    assert.equal(event.platform, 'omarchy');
    assert.equal(event.outcome, outcome);
    assert.equal(event.llm.model, 'openai/gpt-6-luna');
    assert.deepEqual(event.dictation, { source: 'voxtype', hadContext: true, asr: { engine: null, model: null, backend: null }, guard: { accepted: outcome !== 'rejected', editRatio: 0 } });
    assert.equal('review' in event, false);
  });
}
for (const [status, outcome] of Object.entries({ accepted: 'pasted', cancelled: 'cancelled', 'source-lost': 'clipboard', 'refocus-failed': 'clipboard', 'target-mismatch': 'clipboard', failed: 'failed', 'review-error': 'failed' })) {
  test(`review event shape: ${status}`, () => {
    for (const choice of [0, 1, null]) {
      const event = reviewEvent({ input: 'text', status, choice, acceptedText: 'chosen', durationMs: 5, terminal: true, target: { class: 'editor', title: 'document' }, review: { correction: 'light', natural: 'natural', takeaway: 'tip' }, error: outcome === 'failed' ? new Error('offline') : null });
      assert.equal(event.outcome, outcome);
      assert.equal(event.review.choice, choice === 0 ? 'light' : choice === 1 ? 'natural' : null);
      assert.equal(event.output, ['pasted', 'clipboard'].includes(outcome) ? 'chosen' : null);
      assert.equal(event.review.correction, 'light');
      assert.equal(event.review.terminal, true);
      assert.equal(event.target.class, 'editor');
      assert.equal('dictation' in event, false);
      if (outcome === 'failed') assert.equal(event.error, 'offline');
    }
    assert.equal(reviewEvent({ status: 'failed', durationMs: 0 }).input, null);
  });
}

test('opt-in log uses 0600; defaults write nothing; invalid command logs once', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-events-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await emitEvent({ test: true }, { dataDir: dir });
  assert.deepEqual(await fs.readdir(dir), []);
  await emitEvent({ test: true }, { dataDir: dir, config: { eventLog: true } });
  assert.equal((await fs.stat(path.join(dir, 'events.jsonl'))).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8'), '{"test":true}\n');
  const messages = [];
  await emitEvent({}, { config: { eventCommand: [], debugLogging: true }, log: { log: message => messages.push(message) } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(messages, ['invalid eventCommand ignored']);
  await emitEvent({}, { config: { eventCommand: [] }, log: { log: () => assert.fail('debug disabled') } });
});

test('hook stdin is capped at 1000 ms and emission never rejects', async () => {
  const started = Date.now();
  await emitEvent({ input: 'x'.repeat(2 * 1024 * 1024) }, { config: { eventCommand: [process.execPath, '-e', 'setTimeout(() => {}, 1200)'] } });
  assert.ok(Date.now() - started < 1500);
  const circular = {}; circular.self = circular;
  await emitEvent(circular, { config: { eventLog: true } });
});

test('real CLI hook receives one event; slow and failing hooks preserve stdout and exit', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-events-cli-'));
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/health'
      ? { ok: true, ready: true, apiVersion: 3, pid: process.pid, features: ['dictate', 'prewarm'] }
      : { ok: true, text: 'Transcript', durationMs: 1, cost: 0.001 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await fs.writeFile(path.join(dir, 'helper.json'), JSON.stringify({ pid: process.pid, port: server.address().port, apiVersion: 3, features: ['dictate', 'prewarm'] }));
  const file = path.join(dir, 'received');
  const hook = path.join(dir, 'hook.mjs');
  await fs.writeFile(hook, `import fs from 'node:fs'; let text = ''; for await (const chunk of process.stdin) text += chunk; fs.appendFileSync(process.argv[2], text); setTimeout(() => {}, 3000);`);
  for (const eventCommand of [[process.execPath, hook, file], [process.execPath, '-e', 'process.exit(1)'], [path.join(dir, 'missing')], undefined]) {
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ eventCommand, nodeBinaryPath: process.execPath }));
    const started = Date.now();
    const result = await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, ['linux/bin/word-fixer-dictate', '--source', 'voxtype'], { env: { ...process.env, WORD_FIXER_CONFIG_DIR: dir, WORD_FIXER_DATA_DIR: dir }, timeout: 1500 }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
      child.stdin.end('Transcript');
    });
    assert.equal(result.stdout, 'Transcript');
    assert.equal(result.stderr, '');
    assert.ok(Date.now() - started < 1500);
  }
  for (let i = 0; i < 100; i++) {
    if (await fs.stat(file).catch(() => null)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.schema, 'word-fixer.event.v1');
  assert.equal(event.input, 'Transcript');
  assert.equal(event.output, 'Transcript');
  assert.equal(event.dictation.source, 'voxtype');
  assert.equal(event.outcome, 'unchanged');
  assert.equal(await fs.stat(path.join(dir, 'events.jsonl')).catch(() => null), null);
});
