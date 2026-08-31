#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import {
  createLogger,
  DEFAULT_REVIEW_TIMEOUT_MS,
  loadPiServices,
  loadWordFixerConfig,
  MAX_REVIEW_INPUT_BYTES,
  removeFileIfPresent,
  reviewText,
  validateReviewInput,
  writeJsonFile,
} from './helper-lib.mjs';

const apiVersion = 3;
const idleTimeoutMs = Number(process.env.WORD_FIXER_HELPER_IDLE_MS ?? 120000);
const reviewTimeoutMs = Number(process.env.WORD_FIXER_HELPER_REVIEW_MS ?? DEFAULT_REVIEW_TIMEOUT_MS);
const maximumBodyBytes = (MAX_REVIEW_INPUT_BYTES * 6) + 1024;
const cwd = process.env.WORD_FIXER_HELPER_CWD || process.cwd();

const config = await loadWordFixerConfig();
const debugEnabled = process.env.WORD_FIXER_DEBUG === '1' || config.debugLogging === true;
const logger = createLogger({
  debugEnabled,
  logFile: path.join(config.configDir, 'debug.log'),
});
const helperStatePath = path.join(config.configDir, 'helper.json');

let servicesPromise = null;
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
  let byteLength = 0;
  for await (const chunk of request) {
    byteLength += chunk.length;
    if (byteLength > maximumBodyBytes) {
      const error = new Error(`Request body exceeds the ${maximumBodyBytes}-byte limit.`);
      error.code = 'REQUEST_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8').trim();
  return body ? JSON.parse(body) : {};
}

function errorStatus(error) {
  if (error?.code === 'REQUEST_TOO_LARGE') {
    return 413;
  }
  if (error?.code === 'INVALID_REVIEW_INPUT' || error instanceof SyntaxError) {
    return 400;
  }
  if (error?.code === 'REVIEW_TIMEOUT') {
    return 504;
  }
  return 500;
}

async function ensureServices() {
  if (!servicesPromise) {
    servicesPromise = loadPiServices({
      piDir: config.piDir,
      piBinaryPath: config.piBinaryPath,
      cwd,
      log: logger,
    });
  }
  return servicesPromise;
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

  const controller = new AbortController();
  const cancelReview = () => controller.abort();
  const cancelClosedResponse = () => {
    if (!response.writableEnded) {
      cancelReview();
    }
  };
  request.once('aborted', cancelReview);
  response.once('close', cancelClosedResponse);

  try {
    if (request.url === '/health') {
      sendJson(response, 200, { ok: true, ready: true, pid: process.pid, apiVersion });
      return;
    }

    if (request.url === '/shutdown') {
      sendJson(response, 200, { ok: true });
      queueMicrotask(() => {
        void shutdown('http_shutdown');
      });
      return;
    }

    if (request.url !== '/review') {
      sendJson(response, 404, { ok: false, error: 'Not found' });
      return;
    }

    const startedAt = Date.now();
    const body = await readJsonBody(request);
    const text = validateReviewInput(body?.text);

    const currentServices = await ensureServices();
    const review = await reviewText({
      services: currentServices,
      text,
      cwd,
      log: logger,
      signal: controller.signal,
      timeoutMs: reviewTimeoutMs,
    });
    await logger.log('review complete', {
      durationMs: Date.now() - startedAt,
      inputLength: text.length,
      correctionLength: review.correction.length,
      naturalLength: review.natural.length,
      feedbackLength: review.feedback.length,
      cost: review.cost,
    });
    sendJson(response, 200, { ok: true, ...review });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logger.log('request failed', { url: request.url, error: message });
    if (!response.writableEnded && !response.destroyed) {
      sendJson(response, errorStatus(error), { ok: false, error: message });
    }
  } finally {
    request.removeListener('aborted', cancelReview);
    response.removeListener('close', cancelClosedResponse);
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
  apiVersion,
});
await logger.log('listening', {
  pid: process.pid,
  port: address.port,
  helperStatePath,
  idleTimeoutMs,
  reviewTimeoutMs,
  maximumInputBytes: MAX_REVIEW_INPUT_BYTES,
  cwd,
  piDir: config.piDir,
});
resetIdleTimer();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
