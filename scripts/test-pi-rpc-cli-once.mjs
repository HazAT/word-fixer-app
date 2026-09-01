#!/usr/bin/env node
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { loadWordFixerConfig, log, parseArgs } from './pi-test-common.mjs';

const { positional, options } = parseArgs(process.argv.slice(2));
const prompt = positional[0] ?? 'helo wrld';
const timeoutMs = Number(options.timeoutMs ?? 15000);

const { piDir } = await loadWordFixerConfig();
const piCommand = process.env.WORD_FIXER_PI_PATH ?? 'pi';
const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: piDir,
};

log('starting CLI RPC once test');
log('piCommand', piCommand);
log('piDir', piDir);
log('prompt', JSON.stringify(prompt));

const child = spawn(piCommand, ['--mode', 'rpc', '--no-tools', '--no-session', '--thinking', 'off'], {
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const stderr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });

let settled = false;
let assistantText = '';
const timer = setTimeout(() => {
  if (settled) return;
  settled = true;
  log('TIMEOUT waiting for agent_end');
  child.kill('SIGKILL');
  process.exitCode = 1;
}, timeoutMs);

stderr.on('line', (line) => log('stderr', line));
child.on('exit', (code, signal) => log('exit', { code, signal }));
child.on('error', (error) => log('spawn error', error));

stdout.on('line', (line) => {
  log('stdout', line);
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }

  if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
    assistantText += event.assistantMessageEvent.delta;
  }

  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const text = (event.message.content ?? [])
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('');
    log('assistant message_end text', JSON.stringify(text));
  }

  if (event.type === 'agent_end' && !settled) {
    settled = true;
    clearTimeout(timer);
    log('assistantTextFromDeltas', JSON.stringify(assistantText));
    child.kill('SIGTERM');
  }
});

const payload = JSON.stringify({ id: '1', type: 'prompt', message: prompt }) + '\n';
log('sending prompt payload', payload.trim());
child.stdin.write(payload);
