import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Model = require('../omarchy/WordFixerModel.js');
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const completionFile = '/tmp/word-fixer-test/completion.json';

function payload(state, fields = {}) {
  return {
    schemaVersion: 1,
    requestId,
    completionFile,
    state,
    ...fields,
  };
}

function originalText(segments) {
  return segments.filter(({ kind }) => kind !== 'added').map(({ text }) => text).join('');
}

function correctedText(segments) {
  return segments.filter(({ kind }) => kind !== 'deleted').map(({ text }) => text).join('');
}

test('accepts strict loading, review, and actionable error payloads', () => {
  assert.deepEqual(Model.parsePayload(JSON.stringify(payload('loading'))), {
    valid: true,
    schemaVersion: 1,
    requestId,
    completionFile,
    state: 'loading',
  });

  const review = Model.parsePayload(payload('review', {
    original: 'This are wrong.',
    correction: 'This is wrong.',
    natural: 'This is incorrect.',
    takeaway: 'Use “is” with singular “this”.',
    cost: 0.00025,
  }));
  assert.equal(review.valid, true);
  assert.equal(review.original, 'This are wrong.');
  assert.equal(review.cost, 0.00025);

  assert.deepEqual(Model.parsePayload(payload('error', {
    message: 'The model timed out.',
    action: 'Dismiss and try again.',
  })), {
    valid: true,
    schemaVersion: 1,
    requestId,
    completionFile,
    state: 'error',
    message: 'The model timed out.',
    action: 'Dismiss and try again.',
  });
});

test('rejects malformed overlay payloads instead of guessing', () => {
  assert.equal(Model.parsePayload('{bad json').valid, false);
  assert.equal(Model.parsePayload({ ...payload('loading'), schemaVersion: 2 }).valid, false);
  assert.equal(Model.parsePayload({ ...payload('loading'), requestId: '../../bad' }).valid, false);
  assert.equal(Model.parsePayload({ ...payload('loading'), completionFile: 'relative.json' }).valid, false);
  assert.equal(Model.parsePayload({ ...payload('loading'), correction: 'unexpected' }).valid, false);
  assert.equal(Model.parsePayload(payload('review', {
    original: 'text',
    correction: '',
    natural: 'text',
    takeaway: 'tip',
  })).valid, false);
  assert.equal(Model.parsePayload(payload('error', { message: 'failed', action: '  ' })).valid, false);
});

test('structured diffs preserve line boundaries, Unicode, and intentional whitespace', () => {
  const original = '\n  **naïve** 😀 eror\r\n\rLast  line.\n';
  const corrected = '\n  **naïve** 🌍 error\r\n\rLast  line!\n';
  const segments = Model.createInlineDiff(original, corrected);

  assert.equal(originalText(segments), original);
  assert.equal(correctedText(segments), corrected);
  assert.ok(segments.some(({ kind }) => kind === 'deleted'));
  assert.ok(segments.some(({ kind }) => kind === 'added'));
});

test('rich diff renders markup-shaped text literally with distinct additions and deletions', () => {
  const rendered = Model.renderDiff(
    '<script>alert("old")</script> &  text',
    '<b onclick="bad">literal</b> &  text',
    { foreground: '#eeeeee', added: '#00ff00', deleted: '#ff0000' },
  );

  assert.doesNotMatch(rendered, /<(?:script|b)\b/i);
  assert.match(rendered, /&lt;script&gt;/);
  assert.match(rendered, /&lt;b/);
  assert.match(rendered, /onclick=&quot;bad&quot;&gt;/);
  assert.match(rendered, /color:#ff0000;text-decoration:line-through/);
  assert.match(rendered, /color:#00ff00;font-weight:600;text-decoration:underline/);
  assert.match(rendered, /&nbsp;&nbsp;/);
});

test('keyboard actions cycle only two visible choices and map accept/cancel controls', () => {
  assert.deepEqual(Model.keyAction('Tab', false, 'review'), { action: 'select', direction: 1 });
  assert.deepEqual(Model.keyAction('Tab', true, 'review'), { action: 'select', direction: -1 });
  assert.deepEqual(Model.keyAction('Backtab', false, 'review'), { action: 'select', direction: -1 });
  assert.deepEqual(Model.keyAction('Enter', false, 'review'), { action: 'accept' });
  assert.deepEqual(Model.keyAction('Escape', false, 'loading'), { action: 'cancel' });
  assert.deepEqual(Model.keyAction('Enter', false, 'error'), { action: 'none' });
  assert.equal(Model.nextChoice(0, 1), 1);
  assert.equal(Model.nextChoice(1, 1), 0);
  assert.equal(Model.nextChoice(0, -1), 1);
});

test('completion contains only choice index or cancellation', () => {
  assert.deepEqual(Model.completion(requestId, 'choice', 1), {
    schemaVersion: 1,
    requestId,
    outcome: 'choice',
    choice: 1,
  });
  assert.deepEqual(Model.completion(requestId, 'cancel'), {
    schemaVersion: 1,
    requestId,
    outcome: 'cancel',
  });
  assert.deepEqual(Object.keys(Model.completion(requestId, 'choice', 0)).sort(), [
    'choice',
    'outcome',
    'requestId',
    'schemaVersion',
  ]);
  assert.throws(() => Model.completion(requestId, 'choice', 2), /invalid/);
});

test('optional aggregate cost uses the established compact display', () => {
  assert.equal(Model.formatCost(0.00025), 'Total cost $0.000250');
  assert.equal(Model.formatCost(0.01234), 'Total cost $0.0123');
  assert.equal(Model.formatCost(undefined), '');
});

test('manifest and QML declare one keep-loaded bounded native overlay', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'manifest.json'), 'utf8'));
  const qml = await fs.readFile(path.join(repositoryRoot, manifest.entryPoints.overlay), 'utf8');

  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.kinds, ['overlay']);
  assert.equal(manifest.keepLoaded, true);
  assert.match(qml, /function open\(payloadJson\)/);
  assert.match(qml, /function close\(\)/);
  assert.match(qml, /PanelWindow\s*\{/);
  assert.match(qml, /WlrKeyboardFocus\.Exclusive/);
  assert.match(qml, /ScrollView\s*\{/);
  assert.match(qml, /Math\.min\(maximumCardHeight/);
  assert.match(qml, /textFormat: Text\.RichText/);
  assert.match(qml, /onClicked: root\.dismiss\(\)/);
  assert.ok(qml.indexOf('Light edit') < qml.indexOf('Natural English'));
  assert.ok(qml.indexOf('Natural English') < qml.indexOf('Takeaway'));
});
