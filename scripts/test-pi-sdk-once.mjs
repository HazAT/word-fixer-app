#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWordFixerConfig, log, parseArgs, resolvePiSdkModuleUrl } from './pi-test-common.mjs';

const { positional } = parseArgs(process.argv.slice(2));
const prompt = positional[0] ?? 'helo wrld';

const { piBinaryPath, piDir } = await loadWordFixerConfig();
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
const settingsManager = SettingsManager.create(process.cwd(), piDir);
const authStorage = AuthStorage.create(authPath);
const modelRegistry = ModelRegistry.create(authStorage, modelsPath);
const systemPrompt = await fs.readFile(path.join(piDir, 'SYSTEM.md'), 'utf8');

log('starting direct SDK test');
log('sdkUrl', sdkUrl.href);
log('piDir', piDir);
log('prompt', JSON.stringify(prompt));

const { session, modelFallbackMessage } = await createAgentSession({
  cwd: process.cwd(),
  agentDir: piDir,
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
  settingsManager,
  systemPrompt,
  thinkingLevel: 'off',
  tools: [],
});

if (modelFallbackMessage) {
  log('modelFallbackMessage', modelFallbackMessage);
}

let assistantText = '';
const unsubscribe = session.subscribe((event) => {
  if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
    assistantText += event.assistantMessageEvent.delta;
    log('delta', JSON.stringify(event.assistantMessageEvent.delta));
  }
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const text = (event.message.content ?? [])
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('');
    log('message_end text', JSON.stringify(text));
  }
  if (event.type === 'turn_end') {
    log('turn_end');
  }
});

await session.prompt(prompt);
log('assistantTextFromDeltas', JSON.stringify(assistantText));

unsubscribe();
session.dispose();
