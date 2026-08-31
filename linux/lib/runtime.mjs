import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { readCompletion } from './protocol.mjs';

export class DuplicateInvocationError extends Error {
  constructor() {
    super('Word Fixer is already reviewing text.');
    this.name = 'DuplicateInvocationError';
    this.code = 'WORD_FIXER_ALREADY_RUNNING';
  }
}

export class CompletionTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Word Fixer review timed out after ${timeoutMs}ms.`);
    this.name = 'CompletionTimeoutError';
    this.code = 'WORD_FIXER_COMPLETION_TIMEOUT';
  }
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('Word Fixer was cancelled.');
}

export function delay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel() {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(abortError(signal));
    }
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

async function writeJsonReplace(filePath, value) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function acquireLock(lockDirectory, owner) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.mkdir(lockDirectory, { mode: 0o700 });
      await fs.writeFile(
        path.join(lockDirectory, 'owner.json'),
        `${JSON.stringify(owner)}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      );
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        await fs.rm(lockDirectory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    }

    let currentOwner;
    try {
      currentOwner = JSON.parse(await fs.readFile(path.join(lockDirectory, 'owner.json'), 'utf8'));
    } catch {
      currentOwner = null;
    }
    if (await processIsAlive(currentOwner?.pid)) throw new DuplicateInvocationError();
    if (!currentOwner) {
      const lockStat = await fs.stat(lockDirectory).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs < 1_000) {
        throw new DuplicateInvocationError();
      }
    }

    const stalePath = `${lockDirectory}.stale.${process.pid}.${randomUUID()}`;
    try {
      await fs.rename(lockDirectory, stalePath);
      await fs.rm(stalePath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw new DuplicateInvocationError();
}

export async function acquireRequestRuntime({
  runtimeDirectory = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'word-fixer'),
  requestId = randomUUID(),
} = {}) {
  await fs.mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const runtimeStat = await fs.stat(runtimeDirectory);
  if (!runtimeStat.isDirectory() || runtimeStat.uid !== process.getuid()) {
    throw new Error('Word Fixer runtime path is not a user-owned directory.');
  }
  await fs.chmod(runtimeDirectory, 0o700);

  const lockDirectory = path.join(runtimeDirectory, 'active.lock');
  const owner = { pid: process.pid, requestId };
  await acquireLock(lockDirectory, owner);

  let requestDirectory;
  try {
    requestDirectory = await fs.mkdtemp(path.join(runtimeDirectory, `request-${requestId}-`));
    await fs.chmod(requestDirectory, 0o700);
  } catch (error) {
    await fs.rm(lockDirectory, { recursive: true, force: true });
    throw error;
  }

  const overlayFile = path.join(requestDirectory, 'overlay.json');
  const completionFile = path.join(requestDirectory, 'completion.json');
  let cleaned = false;

  async function ownsLock() {
    try {
      const current = JSON.parse(await fs.readFile(path.join(lockDirectory, 'owner.json'), 'utf8'));
      return current.pid === owner.pid && current.requestId === owner.requestId;
    } catch {
      return false;
    }
  }

  return Object.freeze({
    requestId,
    requestDirectory,
    overlayFile,
    completionFile,
    locator: Object.freeze({ schemaVersion: 1, requestId, payloadFile: overlayFile }),
    publishOverlay(payload) {
      return writeJsonReplace(overlayFile, payload);
    },
    async waitForCompletion({ timeoutMs, signal, pollIntervalMs = 20 }) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw abortError(signal);
        try {
          return await readCompletion(completionFile, { expectedRequestId: requestId });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
      }
      throw new CompletionTimeoutError(timeoutMs);
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await fs.rm(requestDirectory, { recursive: true, force: true });
      if (await ownsLock()) await fs.rm(lockDirectory, { recursive: true, force: true });
    },
  });
}
