import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executeWordFixer } from '../lib/orchestrator.mjs';
import { selectClipboardCommand } from '../lib/input-command.mjs';
import {
  acquireRequestRuntime,
  CompletionTimeoutError,
  DuplicateInvocationError,
} from '../lib/runtime.mjs';
import { HelperClient, LinuxSystem } from '../lib/system.mjs';
import {
  createCancelCompletion,
  createChoiceCompletion,
  writeCompletionAtomic,
} from '../lib/protocol.mjs';

const normalWindow = {
  address: '0xA1B2',
  pid: 4242,
  initialClass: 'org.gnome.TextEditor',
  tags: ['editor'],
};
const terminalWindow = {
  address: '0xC3D4',
  pid: 5252,
  initialClass: 'com.mitchellh.ghostty',
  tags: ['terminal*'],
};
const execFileAsync = promisify(execFile);

async function temporaryRuntime(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'word-fixer-client-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

class StubSystem {
  constructor({
    source = normalWindow,
    text = 'This are wrong.',
    review = {
      correction: 'This is wrong.',
      natural: 'This wording is incorrect.',
      takeaway: 'Use “is” with singular “this”.',
      cost: 0.001,
    },
    completion = { state: 'review', outcome: 'choice', choice: 0 },
    sourceExists = true,
    refocused = true,
    activeAfterFocus = source,
  } = {}) {
    this.source = source;
    this.activeWindow = source;
    this.activeAfterFocus = activeAfterFocus;
    this.text = text;
    this.reviewValue = review;
    this.completion = completion;
    this.sourceExistsValue = sourceExists;
    this.refocused = refocused;
    this.overlayPayloads = [];
    this.locators = [];
    this.clipboardWrites = [];
    this.pastes = [];
    this.notifications = [];
    this.hideCount = 0;
    this.reviewInputs = [];
    this.clipboardClearCount = 0;
    this.copies = [];
    this.captureEvents = [];
  }

  async getActiveWindow() { return this.activeWindow; }
  async clearClipboard() {
    this.clipboardClearCount += 1;
    this.captureEvents.push('clear');
  }
  async copy(window) {
    this.copies.push(selectClipboardCommand('copy', window));
    this.captureEvents.push('copy');
  }
  async readClipboardText() {
    this.captureEvents.push('read');
    return this.text;
  }
  async review(text) {
    this.reviewInputs.push(text);
    if (this.reviewValue instanceof Error) throw this.reviewValue;
    return this.reviewValue;
  }
  async summonOverlay(locator) {
    this.locators.push(structuredClone(locator));
    const payload = JSON.parse(await fs.readFile(locator.payloadFile, 'utf8'));
    this.overlayPayloads.push(payload);
    if (this.completion?.state === payload.state) {
      if (this.completion.malformed) {
        await fs.writeFile(payload.completionFile, '{bad json', { mode: 0o600 });
      } else {
        const value = this.completion.outcome === 'cancel'
          ? createCancelCompletion(payload.requestId)
          : createChoiceCompletion(payload.requestId, this.completion.choice);
        await writeCompletionAtomic(payload.completionFile, value);
      }
    }
  }
  async hideOverlay() { this.hideCount += 1; }
  async writeClipboardText(text) { this.clipboardWrites.push(text); }
  async sourceExists() { return this.sourceExistsValue; }
  async focusAndVerify() {
    this.activeWindow = this.activeAfterFocus;
    return this.refocused;
  }
  async paste(window) { this.pastes.push(selectClipboardCommand('paste', window)); }
  async notifyFailure(message) { this.notifications.push(message); }
}

async function execute(t, system, options = {}) {
  const runtimeDirectory = await temporaryRuntime(t);
  let requestDirectory;
  let result;
  let failure;
  try {
    result = await executeWordFixer({
      sourceAddress: system.source.address.toLowerCase(),
      sourcePid: options.sourcePid ?? system.source.pid,
      sourceTerminal: system.source.tags.some((tag) => tag.replace(/\*$/, '') === 'terminal'),
      system,
      completionTimeoutMs: options.completionTimeoutMs ?? 1_000,
      signal: options.signal,
      acquireRuntime: async () => {
        const runtime = await acquireRequestRuntime({ runtimeDirectory });
        requestDirectory = runtime.requestDirectory;
        return runtime;
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(await fs.stat(runtimeDirectory).then((stat) => stat.mode & 0o777), 0o700);
  assert.equal(await fs.access(requestDirectory).then(() => true, () => false), false);
  assert.deepEqual(await fs.readdir(runtimeDirectory), []);
  if (failure) throw failure;
  return result;
}

test('client removes signal watchers and exits after a handled error', async (t) => {
  const directory = await temporaryRuntime(t);
  const notifySend = path.join(directory, 'notify-send');
  await fs.writeFile(notifySend, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  let failure;
  try {
    await execFileAsync(process.execPath, [path.resolve('linux/bin/word-fixer')], {
      env: { ...process.env, PATH: directory },
      timeout: 2_000,
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(failure?.code, 1);
  assert.equal(failure?.signal, null);
  assert.match(failure?.stderr ?? '', /Usage: word-fixer/);
});

test('stub helper runs loading and review through light-edit acceptance', async (t) => {
  const system = new StubSystem({ completion: { state: 'review', outcome: 'choice', choice: 0 } });
  const result = await execute(t, system);

  assert.equal(result.status, 'accepted');
  assert.equal(result.acceptedText, 'This is wrong.');
  assert.deepEqual(system.overlayPayloads.map(({ state }) => state), ['loading', 'review']);
  assert.equal(system.clipboardClearCount, 1);
  assert.deepEqual(system.copies, [{ mods: 'CTRL', key: 'C' }]);
  assert.deepEqual(system.captureEvents, ['clear', 'copy', 'read']);
  assert.deepEqual(system.clipboardWrites, ['This is wrong.']);
  assert.deepEqual(system.pastes, [{ mods: 'CTRL', key: 'V' }]);
  assert.equal(system.locators.every((value) => !JSON.stringify(value).includes(system.text)), true);
});

test('stub helper selects Natural English and terminal paste chord', async (t) => {
  const system = new StubSystem({
    source: terminalWindow,
    completion: { state: 'review', outcome: 'choice', choice: 1 },
  });
  const result = await execute(t, system);

  assert.equal(result.status, 'accepted');
  assert.deepEqual(system.copies, [{ mods: 'CTRL', key: 'Insert' }]);
  assert.deepEqual(system.clipboardWrites, ['This wording is incorrect.']);
  assert.deepEqual(system.pastes, [{ mods: 'SHIFT', key: 'Insert' }]);
});

test('stub helper cancellation closes review without clipboard output or paste', async (t) => {
  const system = new StubSystem({ completion: { state: 'review', outcome: 'cancel' } });
  const result = await execute(t, system);

  assert.equal(result.status, 'cancelled');
  assert.deepEqual(system.overlayPayloads.map(({ state }) => state), ['loading', 'review']);
  assert.deepEqual(system.clipboardWrites, []);
  assert.deepEqual(system.pastes, []);
});

test('loading cancellation aborts the pending review and cleans runtime state', async (t) => {
  const system = new StubSystem({ completion: { state: 'loading', outcome: 'cancel' } });
  system.review = (_text, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const result = await execute(t, system);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(system.pastes, []);
});

test('empty capture or changed source identity never opens an overlay or pastes', async (t) => {
  const emptySystem = new StubSystem({ text: ' \n\t ' });
  await assert.rejects(() => execute(t, emptySystem), /invalid text/);
  assert.deepEqual(emptySystem.overlayPayloads, []);
  assert.deepEqual(emptySystem.pastes, []);

  const changedSystem = new StubSystem();
  await assert.rejects(() => execute(t, changedSystem, { sourcePid: 9999 }), /source window changed/);
  assert.deepEqual(changedSystem.overlayPayloads, []);
  assert.equal(changedSystem.clipboardClearCount, 0);
  assert.deepEqual(changedSystem.copies, []);
  assert.deepEqual(changedSystem.pastes, []);
});

test('malformed helper output becomes an actionable error and never pastes', async (t) => {
  const system = new StubSystem({
    review: { correction: '', natural: 'Natural', takeaway: 'Tip' },
    completion: { state: 'error', outcome: 'cancel' },
  });
  const result = await execute(t, system);

  assert.equal(result.status, 'review-error');
  assert.deepEqual(system.overlayPayloads.map(({ state }) => state), ['loading', 'error']);
  assert.match(system.overlayPayloads[1].message, /invalid correction/);
  assert.deepEqual(system.pastes, []);
});

test('helper failure uses the bounded error overlay completion path', async (t) => {
  const system = new StubSystem({
    review: new Error('Stub helper timed out.'),
    completion: { state: 'error', outcome: 'cancel' },
  });
  const result = await execute(t, system);
  assert.equal(result.status, 'review-error');
  assert.equal(system.overlayPayloads[1].message, 'Stub helper timed out.');
  assert.deepEqual(system.pastes, []);
});

test('completion timeout and malformed completion clean up without paste', async (t) => {
  const timeoutSystem = new StubSystem({ completion: null });
  await assert.rejects(
    () => execute(t, timeoutSystem, { completionTimeoutMs: 30 }),
    CompletionTimeoutError,
  );
  assert.deepEqual(timeoutSystem.pastes, []);

  const malformedSystem = new StubSystem({
    completion: { state: 'review', malformed: true },
  });
  await assert.rejects(() => execute(t, malformedSystem), /valid JSON/);
  assert.deepEqual(malformedSystem.pastes, []);
});

test('source loss, refocus failure, and exact-target mismatch retain output but never paste', async (t) => {
  const cases = [
    { sourceExists: false, expected: 'source-lost' },
    { refocused: false, expected: 'refocus-failed' },
    {
      activeAfterFocus: { ...normalWindow, address: '0xFFFF' },
      expected: 'target-mismatch',
    },
  ];

  for (const values of cases) {
    const system = new StubSystem(values);
    const result = await execute(t, system);
    assert.equal(result.status, values.expected);
    assert.deepEqual(system.clipboardWrites, ['This is wrong.']);
    assert.deepEqual(system.pastes, []);
    assert.equal(system.notifications.length, 1);
  }
});

test('long multiline Unicode and metacharacter text travels through files and request bodies, not overlay argv', async (t) => {
  const text = `${'line $(touch /tmp/nope); <tag> & "quotes" 😀\n'.repeat(900)}終わり`;
  assert.ok(Buffer.byteLength(text) < 64 * 1024);
  const system = new StubSystem({ text });
  const result = await execute(t, system);

  assert.equal(result.status, 'accepted');
  assert.equal(system.reviewInputs[0], text);
  assert.equal(system.overlayPayloads[1].original, text);
  for (const locator of system.locators) {
    const serialized = JSON.stringify(locator);
    assert.ok(serialized.length < 512);
    assert.doesNotMatch(serialized, /touch|終わり|<tag>/);
  }
});

test('request runtime rejects duplicates, uses restrictive modes, and releases the lock', async (t) => {
  const runtimeDirectory = await temporaryRuntime(t);
  const first = await acquireRequestRuntime({ runtimeDirectory });
  assert.equal((await fs.stat(first.requestDirectory)).mode & 0o777, 0o700);
  await first.publishOverlay({ state: 'test' });
  assert.equal((await fs.stat(first.overlayFile)).mode & 0o777, 0o600);

  await assert.rejects(
    () => acquireRequestRuntime({ runtimeDirectory }),
    DuplicateInvocationError,
  );
  const duplicateSystem = new StubSystem();
  await assert.rejects(() => executeWordFixer({
    sourceAddress: normalWindow.address.toLowerCase(),
    sourcePid: normalWindow.pid,
    sourceTerminal: false,
    system: duplicateSystem,
    acquireRuntime: () => acquireRequestRuntime({ runtimeDirectory }),
  }), DuplicateInvocationError);
  assert.equal(duplicateSystem.clipboardClearCount, 0);
  assert.deepEqual(duplicateSystem.copies, []);
  assert.deepEqual(duplicateSystem.clipboardWrites, []);
  assert.deepEqual(duplicateSystem.pastes, []);
  await first.cleanup();
  const next = await acquireRequestRuntime({ runtimeDirectory });
  await next.cleanup();
  assert.deepEqual(await fs.readdir(runtimeDirectory), []);
});

test('abort during completion wait hides the overlay and cleans request state', async (t) => {
  const controller = new AbortController();
  const system = new StubSystem({ completion: null });
  system.summonOverlay = async function summon(locator) {
    const payload = JSON.parse(await fs.readFile(locator.payloadFile, 'utf8'));
    this.overlayPayloads.push(payload);
    if (payload.state === 'review') {
      setTimeout(() => controller.abort(new Error('test signal')), 5);
    }
  };
  await assert.rejects(
    () => execute(t, system, { signal: controller.signal }),
    /test signal/,
  );
  assert.ok(system.hideCount >= 1);
  assert.deepEqual(system.pastes, []);
});

test('helper client reuses a healthy API-v3 helper and preserves request text in HTTP body', async (t) => {
  const configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'word-fixer-helper-client-'));
  t.after(() => fs.rm(configDirectory, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health') {
      response.end(JSON.stringify({ ok: true, ready: true, pid: process.pid, apiVersion: 3 }));
    } else {
      response.end(JSON.stringify({
        ok: true,
        correction: 'Light',
        natural: 'Natural',
        takeaway: 'Tip',
        feedback: 'Tip',
      }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  await fs.writeFile(
    path.join(configDirectory, 'helper.json'),
    JSON.stringify({ pid: process.pid, port, apiVersion: 3 }),
  );
  const helper = new HelperClient({ configDirectory, dataDirectory: configDirectory });
  const text = 'Unicode 😀\n$(not argv)\n'.repeat(100);
  const review = await helper.review(text);

  assert.equal(review.natural, 'Natural');
  assert.deepEqual(requests.map(({ url }) => url), ['/health', '/review']);
  assert.equal(requests[1].body.text, text);
});

test('Linux clipboard transport clears capture state, reads plain text, and writes through stdin', async () => {
  const calls = [];
  const text = 'line 1\nUnicode 😀 $(shell) <markup>';
  const command = async (executable, args, options = {}) => {
    calls.push({ executable, args, options });
    return {
      stdout: executable === 'wl-paste' ? Buffer.from(text) : Buffer.alloc(0),
      stderr: '',
    };
  };
  const system = new LinuxSystem({ command });
  await system.clearClipboard();
  assert.equal(await system.readClipboardText(), text);
  await system.writeClipboardText(text);

  assert.deepEqual(calls[0].args, ['--clear']);
  assert.deepEqual(calls[1].args, ['--type', 'text', '--no-newline']);
  assert.deepEqual(calls[2].args, ['--type', 'text/plain;charset=utf-8']);
  assert.equal(calls[2].options.input.toString('utf8'), text);
  assert.equal(calls.some(({ args }) => args.includes(text)), false);
});

test('Linux copy and paste dispatch verify the exact target and emit installed chords', async () => {
  const mismatchedCalls = [];
  const mismatchedSystem = new LinuxSystem({
    command: async (executable, args) => {
      mismatchedCalls.push({ executable, args });
      return {
        stdout: Buffer.from(JSON.stringify({ ...normalWindow, pid: 9999 })),
        stderr: '',
      };
    },
  });
  const mismatchedTarget = {
    address: normalWindow.address.toLowerCase(),
    pid: normalWindow.pid,
    initialClass: normalWindow.initialClass,
  };
  await assert.rejects(
    () => mismatchedSystem.copy(normalWindow, mismatchedTarget),
    /Refusing to copy/,
  );
  await assert.rejects(
    () => mismatchedSystem.paste(normalWindow, mismatchedTarget),
    /Refusing to paste/,
  );
  assert.equal(mismatchedCalls.some(({ args }) => args[0] === 'dispatch'), false);

  for (const source of [normalWindow, terminalWindow]) {
    const calls = [];
    const command = async (executable, args) => {
      calls.push({ executable, args });
      if (args[0] === '-j') return { stdout: Buffer.from(JSON.stringify(source)), stderr: '' };
      return { stdout: Buffer.alloc(0), stderr: '' };
    };
    const system = new LinuxSystem({ command });
    const target = {
      address: source.address.toLowerCase(),
      pid: source.pid,
      initialClass: source.initialClass,
    };
    await system.copy(source, target);
    await system.paste(source, target);
    const dispatches = calls.filter(({ args }) => args[0] === 'dispatch');
    const expectedCopy = source === terminalWindow ? ['CTRL', 'Insert'] : ['CTRL', 'C'];
    const expectedPaste = source === terminalWindow ? ['SHIFT', 'Insert'] : ['CTRL', 'V'];
    assert.match(dispatches[0].args[1], new RegExp(`mods = '${expectedCopy[0]}'.*key = '${expectedCopy[1]}'.*state = 'down'`));
    assert.match(dispatches[1].args[1], new RegExp(`mods = '${expectedCopy[0]}'.*key = '${expectedCopy[1]}'.*state = 'up'`));
    assert.match(dispatches[2].args[1], new RegExp(`mods = '${expectedPaste[0]}'.*key = '${expectedPaste[1]}'.*state = 'down'`));
    assert.match(dispatches[3].args[1], new RegExp(`mods = '${expectedPaste[0]}'.*key = '${expectedPaste[1]}'.*state = 'up'`));
  }
});

test('product Hyprland callback captures target/type without injecting input in the key handler', async () => {
  const lua = await fs.readFile(path.resolve('linux/hypr/word-fixer.lua'), 'utf8');
  assert.ok(lua.indexOf('local source_address') < lua.indexOf('hl.timer(function()'));
  assert.ok(lua.indexOf('local source_pid') < lua.indexOf('hl.timer(function()'));
  assert.ok(lua.indexOf('local source_terminal') < lua.indexOf('hl.timer(function()'));
  assert.match(lua, /timeout = 150/);
  assert.match(lua, /word-fixer --source-address/);
  assert.match(lua, /--source-pid/);
  assert.doesNotMatch(lua, /wl-copy --clear|io\.popen|hl\.dsp\.send_key_state|hl\.dispatch/);
});
