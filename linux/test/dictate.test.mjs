import assert from 'node:assert/strict';
import test from 'node:test';
import { executeDictation } from '../lib/dictate.mjs';

const input = 'pie durabur';
const system = { async dictate() { return { text: 'Pi durable', cost: 0.001, durationMs: 20 }; } };

test('accepted and unchanged dictation preserve output and event details', async () => {
  const result = await executeDictation({ input, system, env: { VOXTYPE_CONTEXT: 'previous' }, argv: ['--source', 'voxtype'] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'Pi durable');
  assert.equal(result.details.source, 'voxtype');
  assert.equal(result.details.hadContext, true);
  assert.equal(result.details.outcome, 'fixed');
  assert.deepEqual(result.details.llm, { cost: 0.001, durationMs: 20 });
  const unchanged = await executeDictation({ input, system: { async dictate(text) { return { text }; } } });
  assert.equal(unchanged.exitCode, 0);
  assert.equal(unchanged.stdout, input);
  assert.equal(unchanged.details.outcome, 'unchanged');
});

test('answer-style output is rejected with empty stdout', async () => {
  const result = await executeDictation({ input, system: { async dictate() { return { text: 'Yes, I can help you check that extension.' }; } } });
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, '');
  assert.equal(result.details.output, null);
  assert.equal(result.details.outcome, 'rejected');
  assert.equal(result.details.guard.accepted, false);
});

test('helper failure, malformed output and invalid input fail without stdout', async () => {
  for (const options of [
    { system: { async dictate() { throw new Error('offline\nerror'); } } },
    { system: { async dictate() { return {}; } } },
    { input: ' ' }, { input: 'x'.repeat(8193) }, { argv: ['--source', 'INVALID'] },
  ]) {
    const result = await executeDictation({ input, system, ...options });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.details.outcome, 'failed');
    assert.equal(result.stderr.trim().includes('\n'), false);
  }
});

test('late oversized helper output rejects within the whole dictation deadline', async () => {
  const started = Date.now();
  const timeoutMs = 200;
  const result = await executeDictation({
    input: 'x'.repeat(8192),
    config: { dictation: { timeoutMs } },
    system: { async dictate() {
      await new Promise(resolve => setTimeout(resolve, 150));
      return { text: 'y'.repeat(256 * 1024) };
    } },
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, '');
  assert.equal(result.details.outcome, 'rejected');
  assert.deepEqual(result.details.guard, { editRatio: null, accepted: false, unchanged: false });
  assert.ok(Date.now() - started < timeoutMs + 1000);
});

test('guard assessment remains inside the deadline', async () => {
  let calls = 0;
  const result = await executeDictation({
    input, system, config: { dictation: { timeoutMs: 200 } },
    clock: () => ++calls < 3 ? 0 : 201,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /timed out/);
});

test('deadline covers helper startup/request and even a stalled stdin', async () => {
  let aborted = false;
  for (const options of [
    { system: { dictate(_text, { signal }) { signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); } } },
    { input: new Promise(() => {}) },
  ]) {
    aborted = false;
    const startedAt = Date.now();
    const result = await executeDictation({ input, system, ...options, config: { dictation: { timeoutMs: 30 } } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /timed out/);
    assert.ok(Date.now() - startedAt < 1030);
    if (options.system) assert.equal(aborted, true);
  }
});
