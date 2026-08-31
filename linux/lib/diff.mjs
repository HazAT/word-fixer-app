const LINE_BREAK_PATTERN = /\r\n|\r|\n/g;
const TOKEN_PATTERN = /\r\n|\r|\n|[^\S\r\n]+|[^\s\r\n]+/gu;
const MAX_MYERS_DISTANCE = 512;

function appendSegment(segments, kind, text) {
  if (text.length === 0) return;

  const previous = segments.at(-1);
  if (previous?.kind === kind) {
    previous.text += text;
  } else {
    segments.push({ kind, text });
  }
}

function tokenize(text) {
  return text.match(TOKEN_PATTERN) ?? [];
}

function splitLines(text) {
  const lines = [];
  let start = 0;

  for (const match of text.matchAll(LINE_BREAK_PATTERN)) {
    const index = match.index;
    lines.push({ content: text.slice(start, index), separator: match[0] });
    start = index + match[0].length;
  }

  lines.push({ content: text.slice(start), separator: '' });
  return lines;
}

function fallbackDiff(originalTokens, correctedTokens) {
  let prefixLength = 0;
  while (
    prefixLength < originalTokens.length
    && prefixLength < correctedTokens.length
    && originalTokens[prefixLength] === correctedTokens[prefixLength]
  ) {
    prefixLength += 1;
  }

  let oldSuffix = originalTokens.length;
  let newSuffix = correctedTokens.length;
  while (
    oldSuffix > prefixLength
    && newSuffix > prefixLength
    && originalTokens[oldSuffix - 1] === correctedTokens[newSuffix - 1]
  ) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  const changes = [];
  for (let index = 0; index < prefixLength; index += 1) {
    changes.push({ kind: 'unchanged', text: originalTokens[index] });
  }
  for (let index = prefixLength; index < oldSuffix; index += 1) {
    changes.push({ kind: 'deleted', text: originalTokens[index] });
  }
  for (let index = prefixLength; index < newSuffix; index += 1) {
    changes.push({ kind: 'added', text: correctedTokens[index] });
  }
  for (let index = oldSuffix; index < originalTokens.length; index += 1) {
    changes.push({ kind: 'unchanged', text: originalTokens[index] });
  }
  return changes;
}

function backtrack(trace, originalTokens, correctedTokens) {
  let oldIndex = originalTokens.length;
  let newIndex = correctedTokens.length;
  const reversed = [];

  for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
    const frontier = trace[distance];
    const diagonal = oldIndex - newIndex;
    const previousDiagonal = diagonal === -distance
      || (diagonal !== distance
        && (frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY)
          < (frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY))
      ? diagonal + 1
      : diagonal - 1;
    const previousOldIndex = frontier.get(previousDiagonal) ?? 0;
    const previousNewIndex = previousOldIndex - previousDiagonal;

    while (oldIndex > previousOldIndex && newIndex > previousNewIndex) {
      reversed.push({ kind: 'unchanged', text: originalTokens[oldIndex - 1] });
      oldIndex -= 1;
      newIndex -= 1;
    }

    if (distance === 0) break;

    if (oldIndex === previousOldIndex) {
      reversed.push({ kind: 'added', text: correctedTokens[previousNewIndex] });
    } else {
      reversed.push({ kind: 'deleted', text: originalTokens[previousOldIndex] });
    }
    oldIndex = previousOldIndex;
    newIndex = previousNewIndex;
  }

  return reversed.reverse();
}

function tokenDiff(originalTokens, correctedTokens) {
  if (
    originalTokens.length === correctedTokens.length
    && originalTokens.every((token, index) => token === correctedTokens[index])
  ) {
    return originalTokens.map((text) => ({ kind: 'unchanged', text }));
  }

  const maximumDistance = originalTokens.length + correctedTokens.length;
  const frontier = new Map([[1, 0]]);
  const trace = [];

  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    if (distance > MAX_MYERS_DISTANCE) {
      return fallbackDiff(originalTokens, correctedTokens);
    }

    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let oldIndex;
      if (
        diagonal === -distance
        || (diagonal !== distance
          && (frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY)
            < (frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY))
      ) {
        oldIndex = frontier.get(diagonal + 1) ?? 0;
      } else {
        oldIndex = (frontier.get(diagonal - 1) ?? 0) + 1;
      }

      let newIndex = oldIndex - diagonal;
      while (
        oldIndex < originalTokens.length
        && newIndex < correctedTokens.length
        && originalTokens[oldIndex] === correctedTokens[newIndex]
      ) {
        oldIndex += 1;
        newIndex += 1;
      }
      frontier.set(diagonal, oldIndex);

      if (oldIndex >= originalTokens.length && newIndex >= correctedTokens.length) {
        return backtrack(trace, originalTokens, correctedTokens);
      }
    }
  }

  return fallbackDiff(originalTokens, correctedTokens);
}

function appendTokenDiff(segments, original, corrected) {
  for (const change of tokenDiff(tokenize(original), tokenize(corrected))) {
    appendSegment(segments, change.kind, change.text);
  }
}

export function createInlineDiff(original, corrected) {
  if (typeof original !== 'string' || typeof corrected !== 'string') {
    throw new TypeError('Inline diff inputs must be strings.');
  }
  if (original === corrected) {
    return original.length === 0 ? [] : [{ kind: 'unchanged', text: original }];
  }

  const originalLines = splitLines(original);
  const correctedLines = splitLines(corrected);
  const matchingLineStructure = originalLines.length === correctedLines.length
    && originalLines.every((line, index) => line.separator === correctedLines[index].separator);
  const segments = [];

  if (!matchingLineStructure) {
    appendTokenDiff(segments, original, corrected);
    return segments;
  }

  for (let index = 0; index < originalLines.length; index += 1) {
    appendTokenDiff(segments, originalLines[index].content, correctedLines[index].content);
    appendSegment(segments, 'unchanged', correctedLines[index].separator);
  }
  return segments;
}

export function escapeRichText(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Rich-text input must be a string.');
  }

  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function escapeDiffForStyledText(segments) {
  if (!Array.isArray(segments)) {
    throw new TypeError('Diff segments must be an array.');
  }

  return segments.map((segment) => {
    if (
      !segment
      || !['unchanged', 'deleted', 'added'].includes(segment.kind)
      || typeof segment.text !== 'string'
    ) {
      throw new TypeError('Diff segment is malformed.');
    }
    return {
      kind: segment.kind,
      text: escapeRichText(segment.text).replace(/\r\n|\r|\n/g, '<br/>'),
    };
  });
}
