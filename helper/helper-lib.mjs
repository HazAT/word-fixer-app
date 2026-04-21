import fs from 'node:fs/promises';
import path from 'node:path';

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
    AuthStorage,
    ModelRegistry,
    SessionManager,
    SettingsManager,
    createAgentSession,
  } = sdk;

  const authPath = path.join(piDir, 'auth.json');
  const modelsPath = path.join(piDir, 'models.json');
  const systemPromptPath = path.join(piDir, 'SYSTEM.md');
  const systemPrompt = await fs.readFile(systemPromptPath, 'utf8');
  const authStorage = AuthStorage.create(authPath);
  const modelRegistry = ModelRegistry.create(authStorage, modelsPath);
  const settingsManager = SettingsManager.create(cwd, piDir);

  await log.log('services ready', { sdkUrl: sdkUrl.href, piDir, authPath, modelsPath, systemPromptPath });

  return {
    piDir,
    systemPrompt,
    SessionManager,
    createAgentSession,
    authStorage,
    modelRegistry,
    settingsManager,
  };
}

export async function fixText({ services, text, cwd, log }) {
  const { session, modelFallbackMessage } = await services.createAgentSession({
    cwd,
    agentDir: services.piDir,
    sessionManager: services.SessionManager.inMemory(),
    authStorage: services.authStorage,
    modelRegistry: services.modelRegistry,
    settingsManager: services.settingsManager,
    systemPrompt: services.systemPrompt,
    thinkingLevel: 'off',
    tools: [],
  });

  let assistantText = '';
  let completedText = '';
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
      if (event.message.stopReason !== 'aborted' && event.message.stopReason !== 'error') {
        cost = event.message.usage?.cost?.total;
      }
    }
  });

  try {
    if (modelFallbackMessage) {
      await log.log('model fallback', modelFallbackMessage);
    }
    await session.prompt(text);
    const result = (completedText || assistantText).trim();
    if (!result) {
      throw new Error('Pi returned no corrected text.');
    }
    return { text: result, cost };
  } finally {
    unsubscribe();
    session.dispose();
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
