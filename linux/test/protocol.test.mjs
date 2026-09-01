import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createCancelCompletion,
  createChoiceCompletion,
  createReviewRequest,
  createReviewResult,
  parseCompletion,
  parseReviewRequest,
  parseReviewResult,
  readCompletion,
  readReviewRequest,
  readReviewResult,
  writeCompletionAtomic,
  writeReviewRequestAtomic,
  writeReviewResultAtomic,
} from '../lib/protocol.mjs';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const otherRequestId = '123e4567-e89b-42d3-a456-426614174001';

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'word-fixer-protocol-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('request and result schemas preserve untrusted multiline model text exactly', () => {
  const text = '\nUnicode 😀\r\nMarkdown **bold**\rMarkup <img src=x>\nShell $(touch nope); \' " & |';
  const request = createReviewRequest({ requestId, text });
  const result = createReviewResult({
    requestId,
    correction: text.replace('nope', 'never'),
    natural: `${text}\nNatural ending`,
    takeaway: 'Use <literal> & **markdown**, not shell `code`.',
    cost: 0.003,
  });

  assert.equal(request.text, text);
  assert.equal(result.correction, text.replace('nope', 'never'));
  assert.equal(result.natural, `${text}\nNatural ending`);
  assert.equal(result.takeaway, 'Use <literal> & **markdown**, not shell `code`.');
  assert.equal(result.cost, 0.003);
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(result));
});

test('rejects malformed schemas, unsafe request IDs, and request mismatches', () => {
  assert.throws(
    () => parseReviewRequest({ schemaVersion: 2, requestId, text: 'text' }),
    /schema version/,
  );
  assert.throws(
    () => parseReviewRequest({ schemaVersion: 1, requestId: '../../completion', text: 'text' }),
    /invalid request ID/,
  );
  assert.throws(
    () => parseReviewRequest(
      { schemaVersion: 1, requestId, text: 'text' },
      { expectedRequestId: otherRequestId },
    ),
    /active request ID/,
  );
  assert.throws(
    () => parseReviewRequest({ schemaVersion: 1, requestId, text: '   ' }),
    /invalid text/,
  );
  assert.throws(
    () => parseReviewRequest({ schemaVersion: 1, requestId, text: 'text', command: 'rm -rf /' }),
    /unsupported field command/,
  );
});

test('rejects missing and malformed review result fields', () => {
  const valid = {
    schemaVersion: 1,
    requestId,
    correction: 'Light edit',
    natural: 'Natural English',
    takeaway: 'Takeaway',
  };

  assert.throws(() => parseReviewResult({ ...valid, correction: null }), /invalid correction/);
  assert.throws(() => parseReviewResult({ ...valid, natural: '' }), /invalid natural/);
  assert.throws(() => parseReviewResult({ ...valid, takeaway: [] }), /invalid takeaway/);
  assert.throws(() => parseReviewResult({ ...valid, cost: Number.NaN }), /invalid cost/);
  assert.throws(() => parseReviewResult({ ...valid, feedback: 'not accepted' }), /unsupported field/);
  assert.throws(
    () => parseReviewResult(valid, { expectedRequestId: otherRequestId }),
    /active request ID/,
  );
});

test('accepts only choice zero, choice one, or cancellation without embedded model text', () => {
  assert.deepEqual(createChoiceCompletion(requestId, 0), {
    schemaVersion: 1,
    requestId,
    outcome: 'choice',
    choice: 0,
  });
  assert.deepEqual(createChoiceCompletion(requestId, 1), {
    schemaVersion: 1,
    requestId,
    outcome: 'choice',
    choice: 1,
  });
  assert.deepEqual(createCancelCompletion(requestId), {
    schemaVersion: 1,
    requestId,
    outcome: 'cancel',
  });

  for (const choice of [-1, 2, 0.5, '0', null]) {
    assert.throws(
      () => parseCompletion({ schemaVersion: 1, requestId, outcome: 'choice', choice }),
      /invalid choice/,
    );
  }
  assert.throws(
    () => parseCompletion({ schemaVersion: 1, requestId, outcome: 'cancel', choice: 0 }),
    /unsupported field choice/,
  );
  assert.throws(
    () => parseCompletion({
      schemaVersion: 1,
      requestId,
      outcome: 'choice',
      choice: 0,
      correction: 'must stay in the client request file',
    }),
    /unsupported field correction/,
  );
  assert.throws(
    () => parseCompletion(
      { schemaVersion: 1, requestId, outcome: 'cancel' },
      { expectedRequestId: otherRequestId },
    ),
    /active request ID/,
  );
});

test('publishes request and model result files atomically with restrictive modes', async (t) => {
  const directory = await temporaryDirectory(t);
  const requestPath = path.join(directory, 'request.json');
  const resultPath = path.join(directory, 'result.json');
  const text = 'Leading\n\nUnicode λ 😀\r\n<markup> $(shell) \'quotes\'';
  const request = createReviewRequest({ requestId, text });
  const result = createReviewResult({
    requestId,
    correction: `${text} correction`,
    natural: `${text} natural`,
    takeaway: '<takeaway> & literal',
  });

  await writeReviewRequestAtomic(requestPath, request);
  await writeReviewResultAtomic(resultPath, result);

  assert.deepEqual(await readReviewRequest(requestPath, { expectedRequestId: requestId }), request);
  assert.deepEqual(await readReviewResult(resultPath, { expectedRequestId: requestId }), result);
  assert.equal((await fs.stat(requestPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(resultPath)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['request.json', 'result.json']);
});

test('publishes exactly one complete choice atomically and never overwrites it', async (t) => {
  const directory = await temporaryDirectory(t);
  const completionPath = path.join(directory, 'completion.json');
  const completions = [
    createChoiceCompletion(requestId, 0),
    createChoiceCompletion(requestId, 1),
  ];

  const attempts = await Promise.allSettled(
    completions.map((completion) => writeCompletionAtomic(completionPath, completion)),
  );
  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(({ status }) => status === 'rejected').length, 1);

  const completion = await readCompletion(completionPath, { expectedRequestId: requestId });
  assert.ok(completion.choice === 0 || completion.choice === 1);
  assert.equal((await fs.stat(completionPath)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(directory), ['completion.json']);
});

test('writes and reads cancellation atomically and rejects malformed JSON files', async (t) => {
  const directory = await temporaryDirectory(t);
  const completionPath = path.join(directory, 'cancel.json');
  const malformedPath = path.join(directory, 'malformed.json');

  await writeCompletionAtomic(completionPath, createCancelCompletion(requestId));
  assert.deepEqual(await readCompletion(completionPath, { expectedRequestId: requestId }), {
    schemaVersion: 1,
    requestId,
    outcome: 'cancel',
  });

  await fs.writeFile(malformedPath, '{not json', { mode: 0o600 });
  await assert.rejects(() => readCompletion(malformedPath), /valid JSON/);
  await assert.rejects(
    () => writeCompletionAtomic('relative.json', createCancelCompletion(requestId)),
    /must be absolute/,
  );
});
