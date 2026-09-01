import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAX_REQUEST_TEXT_BYTES } from './protocol.mjs';
import { clipboardKeyEvents } from './input-command.mjs';
import { delay } from './runtime.mjs';
import { targetMatches } from './target.mjs';

const HELPER_API_VERSION = 3;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function commandError(command, args, stderr, code) {
  const detail = stderr.trim() || `exit status ${String(code)}`;
  return new Error(`${command} ${args.join(' ')} failed: ${detail}`);
}

export function runCommand(command, args, {
  input,
  signal,
  timeoutMs = 5_000,
  maximumOutputBytes = 1024 * 1024,
  env = process.env,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    const timer = setTimeout(() => finish(new Error(`${command} timed out after ${timeoutMs}ms.`)), timeoutMs);
    function abort() {
      finish(signal?.reason instanceof Error ? signal.reason : new Error('Word Fixer was cancelled.'));
    }
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error && child.exitCode === null) child.kill('SIGKILL');
      if (error) reject(error);
      else resolve(result);
    }
    function collect(target) {
      return (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > maximumOutputBytes) {
          finish(new Error(`${command} produced too much output.`));
          return;
        }
        target.push(chunk);
      };
    }

    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    child.once('error', finish);
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('close', (code, childSignal) => {
      const standardOutput = Buffer.concat(stdout);
      const standardError = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        finish(commandError(command, args, standardError, code ?? childSignal));
      } else {
        finish(null, { stdout: standardOutput, stderr: standardError });
      }
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

function parseJsonBuffer(buffer, label) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error(`${label} returned malformed JSON.`);
  }
}

function validatedHelperState(value) {
  if (
    !value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !Number.isSafeInteger(value.port) || value.port <= 0 || value.port > 65535
    || value.apiVersion !== HELPER_API_VERSION
  ) return null;
  return { pid: value.pid, port: value.port, apiVersion: value.apiVersion };
}

async function fetchJson(url, body, { signal, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Helper request timed out after ${timeoutMs}ms.`)),
    timeoutMs,
  );
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let value;
    try {
      value = await response.json();
    } catch {
      throw new Error('Helper returned malformed JSON.');
    }
    if (!response.ok || value?.ok !== true) {
      throw new Error(typeof value?.error === 'string' ? value.error : `Helper request failed with HTTP ${response.status}.`);
    }
    return value;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

export class HelperClient {
  constructor({
    configDirectory = process.env.WORD_FIXER_CONFIG_DIR
      || path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || os.homedir(), '.config'), 'word-fixer'),
    dataDirectory = process.env.WORD_FIXER_DATA_DIR
      || path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || os.homedir(), '.local', 'share'), 'word-fixer'),
    helperScript = path.join(repositoryRoot, 'helper', 'word-fixer-helper.mjs'),
    helperStartupTimeoutMs = 5_000,
    reviewTimeoutMs = 35_000,
    environment = process.env,
  } = {}) {
    this.configDirectory = configDirectory;
    this.dataDirectory = dataDirectory;
    this.helperStatePath = path.join(dataDirectory, 'helper.json');
    this.helperScript = helperScript;
    this.helperStartupTimeoutMs = helperStartupTimeoutMs;
    this.reviewTimeoutMs = reviewTimeoutMs;
    this.environment = environment;
  }

  async readState() {
    try {
      return validatedHelperState(JSON.parse(await fs.readFile(this.helperStatePath, 'utf8')));
    } catch {
      return null;
    }
  }

  async health(state, signal) {
    if (!state) return false;
    try {
      const value = await fetchJson(`http://127.0.0.1:${state.port}/health`, {}, {
        signal,
        timeoutMs: 2_000,
      });
      return value.ready === true
        && value.apiVersion === HELPER_API_VERSION
        && value.pid === state.pid;
    } catch (error) {
      if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : error);
      return false;
    }
  }

  async launch() {
    const config = JSON.parse(await fs.readFile(path.join(this.configDirectory, 'config.json'), 'utf8'));
    if (typeof config.nodeBinaryPath !== 'string' || !path.isAbsolute(config.nodeBinaryPath)) {
      throw new Error('Word Fixer config has no absolute nodeBinaryPath.');
    }
    const nodePath = config.nodeBinaryPath;
    await fs.access(nodePath, fs.constants.X_OK);
    await fs.access(this.helperScript, fs.constants.R_OK);
    await fs.rm(this.helperStatePath, { force: true });

    const child = spawn(nodePath, [this.helperScript], {
      cwd: repositoryRoot,
      detached: true,
      shell: false,
      stdio: 'ignore',
      env: {
        ...this.environment,
        WORD_FIXER_CONFIG_DIR: this.configDirectory,
        WORD_FIXER_DATA_DIR: this.dataDirectory,
        WORD_FIXER_HELPER_CWD: repositoryRoot,
        PATH: `${path.dirname(nodePath)}:${this.environment.PATH || '/usr/bin:/bin'}`,
      },
    });
    child.unref();
  }

  async ensureRunning(signal) {
    let state = await this.readState();
    if (await this.health(state, signal)) return state;

    await this.launch();
    const deadline = Date.now() + this.helperStartupTimeoutMs;
    while (Date.now() < deadline) {
      state = await this.readState();
      if (await this.health(state, signal)) return state;
      await delay(50, signal);
    }
    throw new Error('Word Fixer helper failed to become ready.');
  }

  async review(text, { signal } = {}) {
    const state = await this.ensureRunning(signal);
    const value = await fetchJson(`http://127.0.0.1:${state.port}/review`, { text }, {
      signal,
      timeoutMs: this.reviewTimeoutMs,
    });
    if (
      value.takeaway !== undefined
      && value.feedback !== undefined
      && value.takeaway !== value.feedback
    ) {
      throw new Error('Helper returned conflicting takeaway and feedback text.');
    }
    return {
      correction: value.correction,
      natural: value.natural,
      takeaway: value.takeaway ?? value.feedback,
      feedback: value.feedback,
      cost: value.cost,
    };
  }
}

export class LinuxSystem {
  constructor({ helper = new HelperClient(), command = runCommand } = {}) {
    this.helper = helper;
    this.command = command;
  }

  async getActiveWindow({ signal } = {}) {
    const result = await this.command('hyprctl', ['-j', 'activewindow'], { signal });
    return parseJsonBuffer(result.stdout, 'hyprctl activewindow');
  }

  async clearClipboard({ signal } = {}) {
    await this.command(
      'wl-copy',
      ['--clear'],
      { signal, timeoutMs: 2_000, maximumOutputBytes: 64 * 1024 },
    );
  }

  async copy(sourceWindow, target, { signal } = {}) {
    const [down, up] = clipboardKeyEvents('copy', sourceWindow);
    const current = await this.getActiveWindow({ signal });
    if (!targetMatches(target, current)) {
      throw new Error('Refusing to copy because the source window lost focus.');
    }
    await this.command('hyprctl', [
      'eval',
      `hl.dispatch(hl.dsp.send_key_state({ mods = '${down.mods}', key = '${down.key}', state = '${down.state}' }))`,
    ], { signal });
    try {
      await delay(50, signal);
    } finally {
      await this.command('hyprctl', [
        'eval',
        `hl.dispatch(hl.dsp.send_key_state({ mods = '${up.mods}', key = '${up.key}', state = '${up.state}' }))`,
      ]).catch(() => {});
    }
    await delay(150, signal);
  }

  async readClipboardText({ signal } = {}) {
    const result = await this.command(
      'wl-paste',
      ['--type', 'text', '--no-newline'],
      { signal, timeoutMs: 2_000, maximumOutputBytes: MAX_REQUEST_TEXT_BYTES + 1 },
    );
    return result.stdout.toString('utf8');
  }

  summonOverlay(locator) {
    return this.command(
      'omarchy-shell',
      ['shell', 'summon', 'hazat.word-fixer', JSON.stringify(locator)],
      { timeoutMs: 3_000, maximumOutputBytes: 64 * 1024 },
    );
  }

  hideOverlay() {
    return this.command(
      'omarchy-shell',
      ['shell', 'hide', 'hazat.word-fixer'],
      { timeoutMs: 3_000, maximumOutputBytes: 64 * 1024 },
    );
  }

  review(text, options) {
    return this.helper.review(text, options);
  }

  async writeClipboardText(text, { signal } = {}) {
    await this.command(
      'wl-copy',
      ['--type', 'text/plain;charset=utf-8'],
      { input: Buffer.from(text, 'utf8'), signal, timeoutMs: 2_000, maximumOutputBytes: 64 * 1024 },
    );
  }

  async sourceExists(target, { signal } = {}) {
    const result = await this.command('hyprctl', ['-j', 'clients'], { signal });
    const windows = parseJsonBuffer(result.stdout, 'hyprctl clients');
    return Array.isArray(windows) && windows.some((window) => targetMatches(target, window));
  }

  async focusAndVerify(target, { signal } = {}) {
    try {
      await this.command(
        'hyprctl',
        ['eval', `hl.dispatch(hl.dsp.focus({ window = 'address:${target.address}' }))`],
        { signal },
      );
      const deadline = Date.now() + 750;
      while (Date.now() < deadline) {
        const active = await this.getActiveWindow({ signal });
        if (targetMatches(target, active)) return true;
        await delay(25, signal);
      }
      return false;
    } catch (error) {
      if (signal?.aborted) throw error;
      return false;
    }
  }

  async paste(sourceWindow, target, { signal } = {}) {
    const [down, up] = clipboardKeyEvents('paste', sourceWindow);
    const current = await this.getActiveWindow({ signal });
    if (!targetMatches(target, current)) {
      throw new Error('Refusing to paste because the source window lost focus.');
    }
    await this.command('hyprctl', [
      'eval',
      `hl.dispatch(hl.dsp.send_key_state({ mods = '${down.mods}', key = '${down.key}', state = '${down.state}' }))`,
    ], { signal });
    try {
      await delay(50, signal);
    } finally {
      await this.command('hyprctl', [
        'eval',
        `hl.dispatch(hl.dsp.send_key_state({ mods = '${up.mods}', key = '${up.key}', state = '${up.state}' }))`,
      ]).catch(() => {});
    }
  }

  async notifyFailure(message) {
    await this.command(
      'notify-send',
      ['--urgency=critical', 'Word Fixer', message],
      { timeoutMs: 2_000, maximumOutputBytes: 64 * 1024 },
    ).catch(() => {});
  }
}
