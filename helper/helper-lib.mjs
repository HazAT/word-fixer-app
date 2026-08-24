import fs from 'node:fs/promises';
import path from 'node:path';

const lineBreakPattern = /\r\n|\r|\n/g;

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
  return path.join(process.env.HOME ?? '', '.config', 'word-fixer');
}

export async function loadWordFixerConfig() {
  const configDir = resolveConfigDir();
  const configPath = path.join(configDir, 'config.json');
  const piDir = path.join(configDir, '.pi');
  const raw = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(raw);
  return { configDir, configPath, piDir, ...config };
}

export async function resolvePiSdkModuleUrl(piBinaryPath) {
  const realPiPath = await fs.realpath(piBinaryPath);
  const packageRoot = path.dirname(path.dirname(realPiPath));
  return new URL(`file://${path.join(packageRoot, 'dist', 'index.js')}`);
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

export async function loadPiServices({ piDir, piBinaryPath, cwd, log }) {
  const sdkUrl = await resolvePiSdkModuleUrl(piBinaryPath);
  const sdk = await import(sdkUrl.href);
  const {
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    createAgentSession,
    getAgentDir,
  } = sdk;

  const authPath = path.join(getAgentDir(), 'auth.json');
  const modelsPath = path.join(piDir, 'models.json');
  const promptPaths = {
    correction: path.join(piDir, 'SYSTEM.md'),
    natural: path.join(piDir, 'NATURAL.md'),
    feedback: path.join(piDir, 'FEEDBACK.md'),
  };
  const prompts = Object.fromEntries(await Promise.all(
    Object.entries(promptPaths).map(async ([name, promptPath]) => [name, await fs.readFile(promptPath, 'utf8')]),
  ));
  const modelRuntime = await ModelRuntime.create({ authPath, modelsPath });
  const settingsManager = SettingsManager.create(cwd, piDir);

  await log.log('services ready', { sdkUrl: sdkUrl.href, piDir, authPath, modelsPath, promptPaths });

  return {
    piDir,
    prompts,
    SessionManager,
    createAgentSession,
    modelRuntime,
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

async function runTextTask({ services, text, cwd, log, systemPrompt, preserveLineBreaks }) {
  const transport = preserveLineBreaks ? encodeLineBreaks(text) : null;
  const resourceLoader = await services.createResourceLoader(
    transport ? `${systemPrompt}\n${lineBreakProtocol(transport)}` : systemPrompt,
  );
  const { session, modelFallbackMessage } = await services.createAgentSession({
    cwd,
    agentDir: services.piDir,
    sessionManager: services.SessionManager.inMemory(cwd),
    modelRuntime: services.modelRuntime,
    settingsManager: services.settingsManager,
    resourceLoader,
    thinkingLevel: 'off',
    noTools: 'all',
  });

  let assistantText = '';
  let completedText = '';
  let completionError;
  let cost;
  const unsubscribe = session.subscribe((event) => {
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

  try {
    if (modelFallbackMessage) {
      await log.log('model fallback', modelFallbackMessage);
    }
    await session.prompt(transport?.encodedText ?? text);
    if (completionError) {
      throw new Error(completionError);
    }
    const rawResult = completedText || assistantText;
    if (!rawResult.trim()) {
      throw new Error('Pi returned no text.');
    }
    return {
      text: transport ? restoreLineBreaks(rawResult, transport) : rawResult.trim(),
      cost,
    };
  } finally {
    unsubscribe();
    session.dispose();
  }
}

export async function fixText({ services, text, cwd, log }) {
  return runTextTask({
    services,
    text,
    cwd,
    log,
    systemPrompt: services.prompts.correction,
    preserveLineBreaks: true,
  });
}

export async function reviewText({ services, text, cwd, log }) {
  const [correction, natural, feedback] = await Promise.all([
    runTextTask({
      services,
      text,
      cwd,
      log,
      systemPrompt: services.prompts.correction,
      preserveLineBreaks: true,
    }),
    runTextTask({
      services,
      text,
      cwd,
      log,
      systemPrompt: services.prompts.natural,
      preserveLineBreaks: true,
    }),
    runTextTask({
      services,
      text,
      cwd,
      log,
      systemPrompt: services.prompts.feedback,
      preserveLineBreaks: false,
    }),
  ]);

  const costs = [correction.cost, natural.cost, feedback.cost].filter((cost) => cost !== undefined);
  return {
    correction: correction.text,
    natural: natural.text,
    feedback: feedback.text,
    cost: costs.length > 0 ? costs.reduce((total, cost) => total + cost, 0) : undefined,
  };
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
