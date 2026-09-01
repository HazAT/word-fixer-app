import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  encodeLineBreaks,
  fixText,
  lineBreakProtocol,
  MAX_REVIEW_INPUT_BYTES,
  MAX_TASK_OUTPUT_BYTES,
  restoreLineBreaks,
  REVIEW_MODEL,
  reviewText,
  resolvePiSdkModuleUrl,
  validateReviewResponse,
} from './helper-lib.mjs';

const testModel = { provider: REVIEW_MODEL.provider, id: REVIEW_MODEL.id };

function reviewServices({ outputs = {}, hang = false, modelFallbackMessage } = {}) {
  const sessions = [];
  const sessionManagers = [];
  const prompts = {
    correction: 'LIGHT PROMPT',
    natural: 'NATURAL PROMPT',
    feedback: 'FEEDBACK PROMPT',
  };

  const services = {
    piDir: '/tmp/word-fixer-test',
    prompts,
    SessionManager: {
      inMemory(cwd) {
        const manager = { cwd, nonce: Symbol('session') };
        sessionManagers.push(manager);
        return manager;
      },
    },
    modelRuntime: {},
    model: testModel,
    settingsManager: {},
    async createResourceLoader(systemPrompt) {
      return { systemPrompt };
    },
    async createAgentSession(options) {
      assert.equal(options.model, testModel);
      assert.equal(options.thinkingLevel, 'off');
      assert.equal(options.noTools, 'all');
      assert.equal(options.sessionManager, sessionManagers.at(-1));

      const task = Object.entries(prompts)
        .find(([, prompt]) => options.resourceLoader.systemPrompt.startsWith(prompt))?.[0];
      let subscribed;
      let finishPrompt;
      const state = {
        task,
        aborts: 0,
        disposed: 0,
        unsubscribed: 0,
      };
      sessions.push(state);

      return {
        modelFallbackMessage,
        session: {
          model: testModel,
          subscribe(callback) {
            subscribed = callback;
            return () => {
              state.unsubscribed += 1;
              subscribed = undefined;
            };
          },
          prompt(prompt) {
            if (hang) {
              return new Promise((resolve) => {
                finishPrompt = resolve;
              });
            }
            const output = outputs[task] ?? (task === 'feedback' ? 'Useful takeaway.' : prompt);
            subscribed({
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: output }],
                stopReason: 'stop',
                usage: { cost: { total: 0.001 } },
              },
            });
            return Promise.resolve();
          },
          async abort() {
            state.aborts += 1;
            finishPrompt?.();
          },
          dispose() {
            state.disposed += 1;
          },
        },
      };
    },
  };

  return { services, sessions, sessionManagers };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for test condition.');
}

test('resolves the locked app-owned SDK without inspecting the Pi CLI package', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'word-fixer-pi-sdk-'));
  t.after(() => fs.rm(dataDirectory, { recursive: true, force: true }));

  const sdkDirectory = path.join(dataDirectory, 'sdk');
  const packageRoot = path.join(sdkDirectory, 'node_modules', '@earendil-works', 'pi-coding-agent');
  const sdkPath = path.join(packageRoot, 'sdk.js');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(sdkDirectory, 'package.json'), '{"private":true,"type":"module"}\n');
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-coding-agent',
    type: 'module',
    exports: './sdk.js',
  }));
  await fs.writeFile(sdkPath, 'export const testSdk = true;\n');
  const loaderPath = path.join(sdkDirectory, 'sdk-loader.mjs');
  await fs.writeFile(loaderPath, "export * from '@earendil-works/pi-coding-agent';\n");

  const sdkUrl = await resolvePiSdkModuleUrl(dataDirectory);

  assert.equal(fileURLToPath(sdkUrl), await fs.realpath(loaderPath));
  assert.equal((await import(sdkUrl.href)).testSdk, true);
});

test('reports a clear setup error when the app-owned SDK is missing', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'word-fixer-pi-sdk-missing-'));
  t.after(() => fs.rm(dataDirectory, { recursive: true, force: true }));

  await assert.rejects(resolvePiSdkModuleUrl(dataDirectory), /Run the Word Fixer installer again/);
});

test('round-trips mixed line breaks and intentional blank lines exactly', () => {
  const original = '\r\nFirst line\n\nSecond line\rThird line\r\n';
  const transport = encodeLineBreaks(original);

  assert.equal(transport.encodedText.includes('\r'), false);
  assert.equal(transport.encodedText.includes('\n'), false);
  assert.equal(transport.lineBreaks.length, 5);
  assert.equal(restoreLineBreaks(transport.encodedText, transport), original);
});

test('uses a marker namespace that does not collide with selected text', () => {
  const original = 'Keep ⟦WF_BREAK_0_0⟧ literal.\nFix teh typo.';
  const transport = encodeLineBreaks(original);

  assert.equal(transport.markerPrefix, '⟦WF_BREAK_1_');
  assert.equal(restoreLineBreaks(transport.encodedText, transport), original);
});

test('rejects missing, reordered, duplicated, unknown, or literal line breaks', () => {
  const transport = encodeLineBreaks('one\ntwo\r\nthree');
  const [first, second] = transport.lineBreaks.map(({ marker }) => marker);

  assert.throws(
    () => restoreLineBreaks(`one${second}two${first}three`, transport),
    /removing or reordering/,
  );
  assert.throws(
    () => restoreLineBreaks(`one${first}${first}two${second}three`, transport),
    /duplicating/,
  );
  assert.throws(
    () => restoreLineBreaks(`one${first}two${second}${transport.markerPrefix}99⟧three`, transport),
    /unknown/,
  );
  assert.throws(
    () => restoreLineBreaks(`one${first}two\n${second}three`, transport),
    /literal line break/,
  );
});

test('fixText preserves boundary, blank, LF, CRLF, and CR breaks', async () => {
  const original = '\nThs first line.\r\n\r\nSecnd line.\rLast eror.\n';
  let subscribed;
  let receivedPrompt;
  let receivedSystemPrompt;
  let disposed = false;

  const services = {
    piDir: '/tmp/word-fixer-test',
    prompts: { correction: 'Correct text only.' },
    SessionManager: { inMemory: () => ({}) },
    modelRuntime: {},
    model: testModel,
    settingsManager: {},
    async createResourceLoader(systemPrompt) {
      receivedSystemPrompt = systemPrompt;
      return {};
    },
    async createAgentSession(options) {
      assert.equal(options.model, testModel);
      assert.equal(options.thinkingLevel, 'off');
      assert.equal(options.noTools, 'all');
      return {
        modelFallbackMessage: undefined,
        session: {
          model: testModel,
          subscribe(callback) {
            subscribed = callback;
            return () => {};
          },
          async prompt(prompt) {
            receivedPrompt = prompt;
            subscribed({
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{
                  type: 'text',
                  text: prompt
                    .replace('Ths', 'This')
                    .replace('Secnd', 'Second')
                    .replace('eror', 'error'),
                }],
                stopReason: 'stop',
                usage: { cost: { total: 0.001 } },
              },
            });
          },
          async abort() {},
          dispose() {
            disposed = true;
          },
        },
      };
    },
  };
  const log = { async log() {} };

  const result = await fixText({ services, text: original, cwd: '/tmp', log });

  assert.equal(receivedPrompt.includes('\r'), false);
  assert.equal(receivedPrompt.includes('\n'), false);
  assert.match(receivedSystemPrompt, /line-break transport protocol/);
  assert.equal(result.text, '\nThis first line.\r\n\r\nSecond line.\rLast error.\n');
  assert.equal(result.cost, 0.001);
  assert.equal(disposed, true);
});

test('reviewText runs correction, natural rewrite, and feedback concurrently', async () => {
  const prompts = {
    correction: 'LIGHT PROMPT',
    natural: 'NATURAL PROMPT',
    feedback: 'FEEDBACK PROMPT',
  };
  let activeSessions = 0;
  let maximumActiveSessions = 0;
  let disposedSessions = 0;
  let unsubscribedSessions = 0;
  const receivedTasks = [];
  const sessionManagers = [];

  const services = {
    piDir: '/tmp/word-fixer-test',
    prompts,
    SessionManager: {
      inMemory() {
        const manager = { nonce: Symbol('session') };
        sessionManagers.push(manager);
        return manager;
      },
    },
    modelRuntime: {},
    model: testModel,
    settingsManager: {},
    async createResourceLoader(systemPrompt) {
      return { systemPrompt };
    },
    async createAgentSession(options) {
      assert.equal(options.model, testModel);
      assert.equal(options.thinkingLevel, 'off');
      assert.equal(options.noTools, 'all');
      assert.ok(sessionManagers.includes(options.sessionManager));
      let subscribed;
      return {
        modelFallbackMessage: undefined,
        session: {
          model: testModel,
          subscribe(callback) {
            subscribed = callback;
            return () => {
              unsubscribedSessions += 1;
            };
          },
          async prompt(prompt) {
            activeSessions += 1;
            maximumActiveSessions = Math.max(maximumActiveSessions, activeSessions);
            await new Promise((resolve) => setTimeout(resolve, 10));

            let output;
            if (options.resourceLoader.systemPrompt.startsWith(prompts.correction)) {
              receivedTasks.push('correction');
              output = prompt.replace('can tip the scale', 'can tip the scales');
            } else if (options.resourceLoader.systemPrompt.startsWith(prompts.natural)) {
              receivedTasks.push('natural');
              output = prompt.replace('Your vote can tip the scale', 'Your vote could tip the scales');
            } else {
              receivedTasks.push('feedback');
              output = 'It makes sense, but “tip the scales” is the usual English idiom. “Tip the scale” sounds slightly off here.';
            }

            subscribed({
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: output }],
                stopReason: 'stop',
                usage: { cost: { total: 0.001 } },
              },
            });
            activeSessions -= 1;
          },
          async abort() {},
          dispose() {
            disposedSessions += 1;
          },
        },
      };
    },
  };

  const result = await reviewText({
    services,
    text: 'Your vote can tip the scale',
    cwd: '/tmp',
    log: { async log() {} },
  });

  assert.equal(maximumActiveSessions, 3);
  assert.deepEqual(receivedTasks.sort(), ['correction', 'feedback', 'natural']);
  assert.equal(sessionManagers.length, 3);
  assert.equal(new Set(sessionManagers).size, 3);
  assert.equal(result.correction, 'Your vote can tip the scales');
  assert.equal(result.natural, 'Your vote could tip the scales');
  assert.match(result.takeaway, /usual English idiom/);
  assert.equal(result.feedback, result.takeaway);
  assert.equal(result.cost, 0.003);
  assert.equal(unsubscribedSessions, 3);
  assert.equal(disposedSessions, 3);
});

test('review transport preserves mixed breaks, Unicode, markdown, and shell metacharacters', async () => {
  const original = '\r\n  café 😀 $HOME `echo nope` **bold** <tag> "quotes" \\ path\n\nline two\rlast  \r\n';
  const { services } = reviewServices();

  const result = await reviewText({
    services,
    text: original,
    cwd: '/tmp',
    log: { async log() {} },
  });

  assert.equal(result.correction, original);
  assert.equal(result.natural, original);
  assert.equal(result.takeaway, 'Useful takeaway.');
});

test('rejects empty and oversized review input before creating sessions', async () => {
  const { services, sessions } = reviewServices();
  const options = { services, cwd: '/tmp', log: { async log() {} } };

  await assert.rejects(
    reviewText({ ...options, text: ' \r\n\t' }),
    /non-empty string/,
  );
  await assert.rejects(
    reviewText({ ...options, text: 'é'.repeat((MAX_REVIEW_INPUT_BYTES / 2) + 1) }),
    /byte limit/,
  );
  assert.equal(sessions.length, 0);
});

test('malformed and oversized model output disposes every session subscription', async () => {
  for (const correction of ['   ', 'x'.repeat(MAX_TASK_OUTPUT_BYTES + 1)]) {
    const { services, sessions } = reviewServices({
      outputs: {
        correction,
        natural: 'Natural rewrite.',
        feedback: 'Useful takeaway.',
      },
    });

    await assert.rejects(
      reviewText({
        services,
        text: 'Text to review',
        cwd: '/tmp',
        log: { async log() {} },
      }),
      /empty or malformed|larger than/,
    );
    assert.equal(sessions.length, 3);
    assert.equal(sessions.reduce((total, session) => total + session.unsubscribed, 0), 3);
    assert.equal(sessions.reduce((total, session) => total + session.disposed, 0), 3);
  }
});

test('timeout aborts and disposes all three active sessions', async () => {
  const { services, sessions } = reviewServices({ hang: true });

  await assert.rejects(
    reviewText({
      services,
      text: 'Text to review',
      cwd: '/tmp',
      log: { async log() {} },
      timeoutMs: 5,
    }),
    (error) => error?.code === 'REVIEW_TIMEOUT',
  );

  assert.equal(sessions.length, 3);
  assert.equal(sessions.reduce((total, session) => total + session.aborts, 0), 3);
  assert.equal(sessions.reduce((total, session) => total + session.unsubscribed, 0), 3);
  assert.equal(sessions.reduce((total, session) => total + session.disposed, 0), 3);
});

test('caller cancellation aborts and disposes all three active sessions', async () => {
  const { services, sessions } = reviewServices({ hang: true });
  const controller = new AbortController();
  const review = reviewText({
    services,
    text: 'Text to review',
    cwd: '/tmp',
    log: { async log() {} },
    signal: controller.signal,
  });

  await waitFor(() => sessions.length === 3);
  controller.abort();
  await assert.rejects(review, (error) => error?.code === 'REVIEW_CANCELLED');

  assert.equal(sessions.reduce((total, session) => total + session.aborts, 0), 3);
  assert.equal(sessions.reduce((total, session) => total + session.unsubscribed, 0), 3);
  assert.equal(sessions.reduce((total, session) => total + session.disposed, 0), 3);
});

test('rejects model fallback and disposes every fresh session', async () => {
  const { services, sessions } = reviewServices({ modelFallbackMessage: 'using another model' });

  await assert.rejects(
    reviewText({
      services,
      text: 'Text to review',
      cwd: '/tmp',
      log: { async log() {} },
    }),
    /was not used/,
  );

  assert.equal(sessions.length, 3);
  assert.equal(sessions.reduce((total, session) => total + session.aborts, 0), 3);
  assert.equal(sessions.reduce((total, session) => total + session.disposed, 0), 3);
});

test('validates the stable review response shape', () => {
  const response = validateReviewResponse({
    correction: 'Light edit',
    natural: 'Natural rewrite',
    takeaway: 'Takeaway',
    feedback: 'Takeaway',
    cost: 0,
  });

  assert.deepEqual(response, {
    correction: 'Light edit',
    natural: 'Natural rewrite',
    takeaway: 'Takeaway',
    feedback: 'Takeaway',
    cost: 0,
  });
  assert.throws(
    () => validateReviewResponse({ correction: 'x', natural: 'y', feedback: '' }),
    /takeaway/,
  );
  assert.throws(
    () => validateReviewResponse({ correction: 'x', natural: 'y', takeaway: 'a', feedback: 'b' }),
    /conflicting/,
  );
  assert.throws(
    () => validateReviewResponse({ correction: 'x', natural: 'y', feedback: 'z', cost: Number.NaN }),
    /aggregate cost/,
  );
});

test('protocol explicitly forbids structural line-break changes', () => {
  const protocol = lineBreakProtocol(encodeLineBreaks('one\ntwo'));

  assert.match(protocol, /Return every marker exactly once and in the same order/);
  assert.match(protocol, /Do not emit literal carriage-return or line-feed characters/);
});
