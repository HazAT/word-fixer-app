#!/usr/bin/env node
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { loadWordFixerConfig, log, parseArgs } from './pi-test-common.mjs';

const { positional, options } = parseArgs(process.argv.slice(2));
const prompt1 = positional[0] ?? 'helo wrld';
const prompt2 = positional[1] ?? 'ths is a tst';
const timeoutMs = Number(options.timeoutMs ?? 20000);

const { piDir } = await loadWordFixerConfig();
const piCommand = process.env.WORD_FIXER_PI_PATH ?? 'pi';
const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: piDir,
};

log('starting CLI RPC loop test');
log('prompt1', JSON.stringify(prompt1));
log('prompt2', JSON.stringify(prompt2));

const child = spawn(piCommand, ['--mode', 'rpc', '--no-tools', '--no-session', '--thinking', 'off'], {
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const stderr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
let phase = 'first-prompt';
let pendingPromptId = '1';
let pendingSessionId = null;
let timer = null;

function armTimeout(label) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    log('TIMEOUT', label, 'phase=', phase);
    child.kill('SIGKILL');
    process.exitCode = 1;
  }, timeoutMs);
}

function send(obj) {
  const line = JSON.stringify(obj);
  log('send', line);
  child.stdin.write(line + '\n');
}

stderr.on('line', (line) => log('stderr', line));
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  log('exit', { code, signal });
});

stdout.on('line', (line) => {
  log('stdout', line);
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }

  if (event.type === 'response' && event.id === pendingSessionId && event.success) {
    if (phase === 'reset-after-first') {
      phase = 'second-prompt';
      pendingSessionId = null;
      pendingPromptId = '2';
      send({ id: '2', type: 'prompt', message: prompt2 });
      armTimeout('waiting for second agent_end');
      return;
    }
  }

  if (event.type === 'agent_end' && phase === 'first-prompt') {
    phase = 'reset-after-first';
    pendingSessionId = 'new-1';
    send({ id: 'new-1', type: 'new_session' });
    armTimeout('waiting for new_session response');
    return;
  }

  if (event.type === 'agent_end' && phase === 'second-prompt') {
    phase = 'done';
    clearTimeout(timer);
    log('loop test completed');
    child.kill('SIGTERM');
  }
});

send({ id: '1', type: 'prompt', message: prompt1 });
armTimeout('waiting for first agent_end');
