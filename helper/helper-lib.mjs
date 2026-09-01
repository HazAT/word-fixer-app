import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REVIEW_MODEL = Object.freeze({
  provider: 'openai-codex',
  id: 'gpt-5.4-mini',
});
export const MAX_REVIEW_INPUT_BYTES = 64 * 1024;
export const MAX_TASK_OUTPUT_BYTES = 256 * 1024;
export const DEFAULT_REVIEW_TIMEOUT_MS = 30_000;

const lineBreakPattern = /\r\n|\r|\n/g;

export class ReviewInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReviewInputError';
    this.code = 'INVALID_REVIEW_INPUT';
  }
}

export class ReviewTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Pi review timed out after ${timeoutMs}ms.`);
    this.name = 'ReviewTimeoutError';
    this.code = 'REVIEW_TIMEOUT';
  }
}

export class ReviewCancelledError extends Error {
  constructor() {
    super('Pi review was cancelled.');
    this.name = 'ReviewCancelledError';
    this.code = 'REVIEW_CANCELLED';
  }
}

function textByteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

export function validateReviewInput(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new ReviewInputError('Review text must be a non-empty string.');
  }
  if (textByteLength(text) > MAX_REVIEW_INPUT_BYTES) {
    throw new ReviewInputError(`Review text exceeds the ${MAX_REVIEW_INPUT_BYTES}-byte limit.`);
  }
  return text;
}

function validateOutput(name, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Pi returned an empty or malformed ${name}.`);
  }
  if (textByteLength(value) > MAX_TASK_OUTPUT_BYTES) {
    throw new Error(`Pi returned ${name} larger than the ${MAX_TASK_OUTPUT_BYTES}-byte limit.`);
  }
  return value;
}

export function validateReviewResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Pi returned a malformed review response.');
  }

  const correction = validateOutput('correction', value.correction);
  const natural = validateOutput('natural rewrite', value.natural);
  const takeaway = validateOutput('takeaway', value.takeaway ?? value.feedback);
  if (value.feedback !== undefined && value.takeaway !== undefined && value.feedback !== value.takeaway) {
    throw new Error('Pi returned conflicting takeaway and feedback text.');
  }
  if (value.cost !== undefined && (typeof value.cost !== 'number' || !Number.isFinite(value.cost) || value.cost < 0)) {
    throw new Error('Pi returned a malformed aggregate cost.');
  }

  return {
    correction,
    natural,
    takeaway,
    feedback: takeaway,
    cost: value.cost,
  };
}

export function encodeLineBreaks(text) {
  let nonce = 0;
  while (text.includes(`⟦WF_BREAK_${nonce}_`)) {
    nonce += 1;
  }

  const markerPrefix = `⟦WF_BREAK_${nonce}_`;
  const lineBreaks = [];
  const encodedText = text.replace(lineBreakPattern, (lineBreak) => {
    const marker = `${markerPrefix}${lineBreaks.length}⟧`;
    lineBreaks.push({ marker, lineBreak });
    return marker;
  });

  return { encodedText, lineBreaks, markerPrefix };
}

export function restoreLineBreaks(text, transport) {
  if (/[\r\n]/.test(text)) {
    throw new Error('Pi changed the line-break structure by returning a literal line break.');
  }

  let searchOffset = 0;
  for (const { marker } of transport.lineBreaks) {
    const markerOffset = text.indexOf(marker, searchOffset);
    if (markerOffset === -1) {
      throw new Error('Pi changed the line-break structure by removing or reordering a line-break marker.');
    }
    if (text.indexOf(marker, markerOffset + marker.length) !== -1) {
      throw new Error('Pi changed the line-break structure by duplicating a line-break marker.');
    }
    searchOffset = markerOffset + marker.length;
  }

  let restoredText = text;
  for (const { marker, lineBreak } of transport.lineBreaks) {
    restoredText = restoredText.replace(marker, lineBreak);
  }

  if (restoredText.includes(transport.markerPrefix)) {
    throw new Error('Pi changed the line-break structure by adding an unknown line-break marker.');
  }

  return restoredText;
}

export function lineBreakProtocol(transport) {
  const markerDescription = transport.lineBreaks.length === 0
    ? 'This input contains no line-break markers.'
    : `This input contains ${transport.lineBreaks.length} immutable line-break marker(s) shaped like ${transport.markerPrefix}N⟧.`;

  return `
Word Fixer line-break transport protocol (mandatory):
- ${markerDescription}
- Each marker represents one exact original line break.
- Return every marker exactly once and in the same order.
- Do not add, remove, reorder, alter, or correct marker text.
- Do not emit literal carriage-return or line-feed characters.
- Correct only the text surrounding the markers.
`;
}

export function resolveConfigDir() {
  if (process.env.WORD_FIXER_CONFIG_DIR) {
    return process.env.WORD_FIXER_CONFIG_DIR;
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? os.homedir(), '.config'), 'word-fixer');
}

export function resolveDataDir() {
  if (process.env.WORD_FIXER_DATA_DIR) {
    return process.env.WORD_FIXER_DATA_DIR;
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? os.homedir(), '.local', 'share'), 'word-fixer');
}

export async function loadWordFixerConfig() {
  const configDir = resolveConfigDir();
  const configPath = path.join(configDir, 'config.json');
  const piDir = path.join(configDir, '.pi');
  const dataDir = resolveDataDir();
  const raw = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(raw);
  return { ...config, configDir, configPath, piDir, dataDir };
}

export async function resolvePiSdkModuleUrl(dataDir = resolveDataDir()) {
  const sdkDirectory = path.join(dataDir, 'sdk');
  try {
    return pathToFileURL(await fs.realpath(path.join(sdkDirectory, 'sdk-loader.mjs')));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Word Fixer SDK is not installed at ${sdkDirectory}. Run word-fixer-setup.`, { cause: error });
    }
    throw error;
  }
}

export function createLogger({ debugEnabled, logFile }) {
  async function append(line) {
    if (!debugEnabled) {
      return;
    }
    const message = `${line}\n`;
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    await fs.appendFile(logFile, message, 'utf8');
  }

  return {
    async log(message, extra = undefined) {
      if (!debugEnabled) {
        return;
      }
      const suffix = extra === undefined ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
      const line = `[${new Date().toISOString()}] [helper] ${message}${suffix}`;
      process.stderr.write(`${line}\n`);
      try {
        await append(line);
      } catch (error) {
        process.stderr.write(`[${new Date().toISOString()}] [helper] failed to append debug log ${String(error)}\n`);
      }
    },
  };
}

export async function loadPiServices({ piDir, dataDir, cwd, log }) {
  const sdkUrl = await resolvePiSdkModuleUrl(dataDir);
  const sdk = await import(sdkUrl.href);
  const {
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    createAgentSession,
  } = sdk;

  const authPath = path.join(process.env.HOME ?? os.homedir(), '.pi', 'agent', 'auth.json');
  const modelsPath = path.join(piDir, 'models.json');
  const modelsStorePath = path.join(dataDir, 'models-store.json');
  const promptPaths = {
    correction: path.join(piDir, 'SYSTEM.md'),
    natural: path.join(piDir, 'NATURAL.md'),
    feedback: path.join(piDir, 'FEEDBACK.md'),
  };
  const prompts = Object.fromEntries(await Promise.all(
    Object.entries(promptPaths).map(async ([name, promptPath]) => [name, await fs.readFile(promptPath, 'utf8')]),
  ));
  const modelRuntime = await ModelRuntime.create({ authPath, modelsPath, modelsStorePath });
  const model = modelRuntime.getModel(REVIEW_MODEL.provider, REVIEW_MODEL.id);
  if (!model) {
    throw new Error(`Required model ${REVIEW_MODEL.provider}/${REVIEW_MODEL.id} is unavailable.`);
  }
  const settingsManager = SettingsManager.create(cwd, piDir);

  await log.log('services ready', {
    sdkUrl: sdkUrl.href,
    piDir,
    authPath,
    modelsPath,
    modelsStorePath,
    promptPaths,
    model: `${REVIEW_MODEL.provider}/${REVIEW_MODEL.id}`,
  });

  return {
    piDir,
    prompts,
    SessionManager,
    createAgentSession,
    modelRuntime,
    model,
    settingsManager,
    async createResourceLoader(prompt) {
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: piDir,
        settingsManager,
        systemPromptOverride: () => prompt,
        appendSystemPromptOverride: () => [],
      });
      await resourceLoader.reload();
      return resourceLoader;
    },
  };
}

function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new ReviewCancelledError();
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function raceWithAbort(promise, signal) {
  if (!signal) {
    return promise;
  }
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function isReviewModel(model) {
  return model?.provider === REVIEW_MODEL.provider && model?.id === REVIEW_MODEL.id;
}

async function runTextTask({ services, text, cwd, log, systemPrompt, preserveLineBreaks, signal }) {
  throwIfAborted(signal);
  if (!isReviewModel(services.model)) {
    throw new Error(`Required model ${REVIEW_MODEL.provider}/${REVIEW_MODEL.id} is unavailable.`);
  }

  const transport = preserveLineBreaks ? encodeLineBreaks(text) : null;
  const resourceLoader = await raceWithAbort(services.createResourceLoader(
    transport ? `${systemPrompt}\n${lineBreakProtocol(transport)}` : systemPrompt,
  ), signal);
  const creationPromise = services.createAgentSession({
    cwd,
    agentDir: services.piDir,
    sessionManager: services.SessionManager.inMemory(cwd),
    modelRuntime: services.modelRuntime,
    model: services.model,
    settingsManager: services.settingsManager,
    resourceLoader,
    thinkingLevel: 'off',
    noTools: 'all',
  });

  let abandonedSession = false;
  void creationPromise.then(async ({ session }) => {
    if (abandonedSession) {
      try {
        await session.abort();
      } finally {
        session.dispose();
      }
    }
  }).catch(() => {});

  let created;
  try {
    created = await raceWithAbort(creationPromise, signal);
  } catch (error) {
    abandonedSession = true;
    throw error;
  }
  const { session, modelFallbackMessage } = created;
  let unsubscribe;
  let promptFinished = false;

  try {
    if (modelFallbackMessage) {
      await log.log('model fallback rejected', modelFallbackMessage);
      throw new Error(`Required model ${REVIEW_MODEL.provider}/${REVIEW_MODEL.id} was not used: ${modelFallbackMessage}`);
    }
    if (!isReviewModel(session.model)) {
      throw new Error(`Required model ${REVIEW_MODEL.provider}/${REVIEW_MODEL.id} was not selected.`);
    }

    let assistantText = '';
    let completedText = '';
    let completionError;
    let cost;
    unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        assistantText += event.assistantMessageEvent.delta;
      }
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        completedText = (event.message.content ?? [])
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('');
        if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') {
          completionError = event.message.errorMessage ?? `Pi stopped with reason: ${event.message.stopReason}`;
        } else {
          cost = event.message.usage?.cost?.total;
        }
      }
    });

    await raceWithAbort(session.prompt(transport?.encodedText ?? text), signal);
    promptFinished = true;
    if (completionError) {
      throw new Error(completionError);
    }
    const rawResult = completedText || assistantText;
    const resultText = transport ? restoreLineBreaks(rawResult, transport) : rawResult.trim();
    validateOutput('task output', resultText);
    if (cost !== undefined && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) {
      throw new Error('Pi returned malformed task cost data.');
    }
    return { text: resultText, cost };
  } finally {
    unsubscribe?.();
    try {
      if (!promptFinished || signal?.aborted) {
        await session.abort();
      }
    } finally {
      session.dispose();
    }
  }
}

export async function fixText({ services, text, cwd, log, signal }) {
  validateReviewInput(text);
  return runTextTask({
    services,
    text,
    cwd,
    log,
    systemPrompt: services.prompts.correction,
    preserveLineBreaks: true,
    signal,
  });
}

export async function reviewText({
  services,
  text,
  cwd,
  log,
  signal,
  timeoutMs = DEFAULT_REVIEW_TIMEOUT_MS,
}) {
  validateReviewInput(text);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ReviewInputError('Review timeout must be a positive integer number of milliseconds.');
  }

  const controller = new AbortController();
  const cancel = () => controller.abort(new ReviewCancelledError());
  if (signal?.aborted) {
    cancel();
  } else {
    signal?.addEventListener('abort', cancel, { once: true });
  }
  const timeout = setTimeout(() => {
    controller.abort(new ReviewTimeoutError(timeoutMs));
  }, timeoutMs);

  const taskOptions = [
    { name: 'correction', systemPrompt: services.prompts.correction, preserveLineBreaks: true },
    { name: 'natural', systemPrompt: services.prompts.natural, preserveLineBreaks: true },
    { name: 'feedback', systemPrompt: services.prompts.feedback, preserveLineBreaks: false },
  ];

  try {
    const settled = await Promise.allSettled(taskOptions.map(async (task) => {
      try {
        const result = await runTextTask({
          services,
          text,
          cwd,
          log,
          systemPrompt: task.systemPrompt,
          preserveLineBreaks: task.preserveLineBreaks,
          signal: controller.signal,
        });
        return [task.name, result];
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    }));

    const failure = settled.find((result) => result.status === 'rejected');
    if (failure) {
      throw failure.reason;
    }
    throwIfAborted(controller.signal);

    const results = Object.fromEntries(settled.map((result) => result.value));
    const costs = [results.correction.cost, results.natural.cost, results.feedback.cost]
      .filter((cost) => cost !== undefined);
    return validateReviewResponse({
      correction: results.correction.text,
      natural: results.natural.text,
      takeaway: results.feedback.text,
      feedback: results.feedback.text,
      cost: costs.length > 0 ? costs.reduce((total, cost) => total + cost, 0) : undefined,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function removeFileIfPresent(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}
