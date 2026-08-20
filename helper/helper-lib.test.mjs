import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeLineBreaks,
  fixText,
  lineBreakProtocol,
  restoreLineBreaks,
} from './helper-lib.mjs';

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
    systemPrompt: 'Correct text only.',
    SessionManager: { inMemory: () => ({}) },
    modelRuntime: {},
    settingsManager: {},
    async createResourceLoader(systemPrompt) {
      receivedSystemPrompt = systemPrompt;
      return {};
    },
    async createAgentSession(options) {
      assert.equal(options.noTools, 'all');
      return {
        modelFallbackMessage: undefined,
        session: {
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

test('protocol explicitly forbids structural line-break changes', () => {
  const protocol = lineBreakProtocol(encodeLineBreaks('one\ntwo'));

  assert.match(protocol, /Return every marker exactly once and in the same order/);
  assert.match(protocol, /Do not emit literal carriage-return or line-feed characters/);
});
