#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import {
  createLogger,
  fixText,
  loadPiServices,
  loadWordFixerConfig,
  removeFileIfPresent,
  writeJsonFile,
} from './helper-lib.mjs';

const idleTimeoutMs = Number(process.env.WORD_FIXER_HELPER_IDLE_MS ?? 120000);
const cwd = process.env.WORD_FIXER_HELPER_CWD || process.cwd();

const config = await loadWordFixerConfig();
const debugEnabled = process.env.WORD_FIXER_DEBUG === '1' || config.debugLogging === true;
const logger = createLogger({
  debugEnabled,
  logFile: path.join(config.configDir, 'debug.log'),
});
const helperStatePath = path.join(config.configDir, 'helper.json');

let services = null;
let server = null;
let isShuttingDown = false;
let idleTimer = null;

function resetIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    void shutdown('idle_timeout');
  }, idleTimeoutMs);
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8').trim();
  return body ? JSON.parse(body) : {};
}

async function ensureServices() {
  if (services) {
    return services;
  }
  services = await loadPiServices({
    piDir: config.piDir,
    piBinaryPath: config.piBinaryPath,
    cwd,
    log: logger,
  });
  return services;
}

async function shutdown(reason) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  await logger.log('shutdown', { reason });
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await removeFileIfPresent(helperStatePath);
  process.exit(0);
}

async function handleRequest(request, response) {
  resetIdleTimer();

  if (request.method !== 'POST') {
    sendJson(response, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    if (request.url === '/health') {
      sendJson(response, 200, { ok: true, ready: true, pid: process.pid });
      return;
    }

    if (request.url === '/shutdown') {
      sendJson(response, 200, { ok: true });
      queueMicrotask(() => {
        void shutdown('http_shutdown');
      });
      return;
    }

    if (request.url !== '/fix') {
      sendJson(response, 404, { ok: false, error: 'Not found' });
      return;
    }

    const startedAt = Date.now();
    const body = await readJsonBody(request);
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text) {
      sendJson(response, 400, { ok: false, error: 'Missing text' });
      return;
    }

    const currentServices = await ensureServices();
    const fixed = await fixText({
      services: currentServices,
      text,
      cwd,
      log: logger,
    });
    await logger.log('fix complete', { durationMs: Date.now() - startedAt, inputLength: text.length, outputLength: fixed.length });
    sendJson(response, 200, { ok: true, text: fixed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logger.log('request failed', { url: request.url, error: message });
    sendJson(response, 500, { ok: false, error: message });
  }
}

server = http.createServer((request, response) => {
  void handleRequest(request, response);
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Failed to determine helper port');
}

await writeJsonFile(helperStatePath, {
  pid: process.pid,
  port: address.port,
});
await logger.log('listening', { pid: process.pid, port: address.port, helperStatePath, idleTimeoutMs, cwd, piDir: config.piDir });
resetIdleTimer();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
