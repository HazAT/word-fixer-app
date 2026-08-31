import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createInlineDiff,
  escapeDiffForStyledText,
  escapeRichText,
} from '../lib/diff.mjs';

function originalText(segments) {
  return segments.filter(({ kind }) => kind !== 'added').map(({ text }) => text).join('');
}

function correctedText(segments) {
  return segments.filter(({ kind }) => kind !== 'deleted').map(({ text }) => text).join('');
}

test('represents unchanged, deleted, and added inline tokens', () => {
  const original = 'This si a plain sentence.';
  const corrected = 'This is a clear sentence.';
  const segments = createInlineDiff(original, corrected);

  assert.deepEqual(new Set(segments.map(({ kind }) => kind)), new Set([
    'unchanged',
    'deleted',
    'added',
  ]));
  assert.equal(originalText(segments), original);
  assert.equal(correctedText(segments), corrected);
});

test('returns unchanged text as one exact segment', () => {
  const text = 'First line\n\nSecond line\r\nThird\r';

  assert.deepEqual(createInlineDiff(text, text), [{ kind: 'unchanged', text }]);
});

test('preserves LF, CRLF, CR, boundary breaks, and intentional blank lines', () => {
  const original = '\nOne eror.\r\n\r\nSecond lnie.\rLast mistke.\n';
  const corrected = '\nOne error.\r\n\r\nSecond line.\rLast mistake.\n';
  const segments = createInlineDiff(original, corrected);

  assert.equal(originalText(segments), original);
  assert.equal(correctedText(segments), corrected);
  assert.equal(correctedText(segments).match(/\r\n|\r|\n/g)?.join('|'), '\n|\r\n|\r\n|\r|\n');
});

test('retains changed line-break structure as structured additions and deletions', () => {
  const original = 'alpha\nbeta\r';
  const corrected = 'alpha\r\nbeta\n';
  const segments = createInlineDiff(original, corrected);

  assert.equal(originalText(segments), original);
  assert.equal(correctedText(segments), corrected);
  assert.ok(segments.some(({ kind, text }) => kind === 'deleted' && text.includes('\n')));
  assert.ok(segments.some(({ kind, text }) => kind === 'added' && text.includes('\r\n')));
});

test('preserves Unicode, spaces, markdown, and markup-shaped text while escaping rich text', () => {
  const original = '  **naïve** 😀 <img src="https://bad.invalid/x"> & \'quoted\'  ';
  const corrected = '  **naïve** 🌍 <b>literal</b> & \'quoted\'  ';
  const segments = createInlineDiff(original, corrected);
  const escaped = escapeDiffForStyledText(segments);

  assert.equal(originalText(segments), original);
  assert.equal(correctedText(segments), corrected);
  assert.equal(escapeRichText('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(escaped.some(({ text }) => /<(?:img|b)\b/i.test(text)), false);
  assert.ok(escaped.some(({ text }) => text.includes('&lt;img')));
  assert.ok(escaped.some(({ text }) => text.includes('&lt;b&gt;literal&lt;/b&gt;')));
});

test('converts every supported line break to fixed styled-text markup only after escaping', () => {
  const escaped = escapeDiffForStyledText([
    { kind: 'added', text: '<x>\r\nnext\rthird\nfourth' },
  ]);

  assert.deepEqual(escaped, [{
    kind: 'added',
    text: '&lt;x&gt;<br/>next<br/>third<br/>fourth',
  }]);
});

test('rejects non-string diff input and malformed segments', () => {
  assert.throws(() => createInlineDiff(null, 'text'), /must be strings/);
  assert.throws(
    () => escapeDiffForStyledText([{ kind: 'added', text: 42 }]),
    /malformed/,
  );
});
