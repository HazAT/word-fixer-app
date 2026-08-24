#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { loadWordFixerConfig, parseArgs } from './pi-test-common.mjs';

const { positional } = parseArgs(process.argv.slice(2));
const prompt = positional[0] ?? 'helo wrld';
const { configDir, piBinaryPath } = await loadWordFixerConfig();
const nodePath = path.join(path.dirname(piBinaryPath), 'node');
const helperScript = path.resolve('helper/word-fixer-helper.mjs');
const helperStatePath = path.join(configDir, 'helper.json');

await fs.rm(helperStatePath, { force: true });

const child = spawn(nodePath, [helperScript], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    WORD_FIXER_CONFIG_DIR: configDir,
    WORD_FIXER_DEBUG: '1',
    WORD_FIXER_HELPER_CWD: process.cwd(),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

let port = null;
for (let attempt = 0; attempt < 50; attempt += 1) {
  try {
    const state = JSON.parse(await fs.readFile(helperStatePath, 'utf8'));
    port = state.port;
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

if (!port) {
  child.kill('SIGTERM');
  throw new Error('Helper did not write helper.json');
}

const baseUrl = `http://127.0.0.1:${port}`;
console.log('health', await fetchJson(`${baseUrl}/health`, {}));
console.log('review', await fetchJson(`${baseUrl}/review`, { text: prompt }));
console.log('shutdown', await fetchJson(`${baseUrl}/shutdown`, {}));
await once(child, 'exit');

async function fetchJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}
