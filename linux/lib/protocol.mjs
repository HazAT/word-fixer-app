import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const PROTOCOL_SCHEMA_VERSION = 1;
export const MAX_REQUEST_TEXT_BYTES = 64 * 1024;
export const MAX_RESULT_TEXT_BYTES = 256 * 1024;
const MAX_PROTOCOL_FILE_BYTES = (MAX_RESULT_TEXT_BYTES * 3 * 6) + 4096;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = 'INVALID_WORD_FIXER_PROTOCOL';
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, name) {
  if (!isRecord(value)) {
    throw new ProtocolError(`${name} must be a JSON object.`);
  }
}

function requireExactKeys(value, requiredKeys, optionalKeys, name) {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new ProtocolError(`${name} is missing ${key}.`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ProtocolError(`${name} contains unsupported field ${key}.`);
    }
  }
}

function requireSchema(value, name) {
  if (value.schemaVersion !== PROTOCOL_SCHEMA_VERSION) {
    throw new ProtocolError(`${name} has an unsupported schema version.`);
  }
}

function requireRequestId(requestId, expectedRequestId, name) {
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new ProtocolError(`${name} has an invalid request ID.`);
  }
  if (expectedRequestId !== undefined && requestId !== expectedRequestId) {
    throw new ProtocolError(`${name} does not match the active request ID.`);
  }
  return requestId;
}

function requireText(value, field, maximumBytes, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProtocolError(`${name} has an invalid ${field}.`);
  }
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new ProtocolError(`${name} ${field} exceeds the ${maximumBytes}-byte limit.`);
  }
  return value;
}

function freeze(value) {
  return Object.freeze(value);
}

export function parseReviewRequest(value, { expectedRequestId } = {}) {
  const name = 'Review request';
  requireRecord(value, name);
  requireExactKeys(value, ['schemaVersion', 'requestId', 'text'], [], name);
  requireSchema(value, name);

  return freeze({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    requestId: requireRequestId(value.requestId, expectedRequestId, name),
    text: requireText(value.text, 'text', MAX_REQUEST_TEXT_BYTES, name),
  });
}

export function createReviewRequest({ requestId, text }) {
  return parseReviewRequest({ schemaVersion: PROTOCOL_SCHEMA_VERSION, requestId, text });
}

export function parseReviewResult(value, { expectedRequestId } = {}) {
  const name = 'Review result';
  requireRecord(value, name);
  requireExactKeys(
    value,
    ['schemaVersion', 'requestId', 'correction', 'natural', 'takeaway'],
    ['cost'],
    name,
  );
  requireSchema(value, name);

  if (
    value.cost !== undefined
    && (typeof value.cost !== 'number' || !Number.isFinite(value.cost) || value.cost < 0)
  ) {
    throw new ProtocolError(`${name} has an invalid cost.`);
  }

  const result = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    requestId: requireRequestId(value.requestId, expectedRequestId, name),
    correction: requireText(value.correction, 'correction', MAX_RESULT_TEXT_BYTES, name),
    natural: requireText(value.natural, 'natural', MAX_RESULT_TEXT_BYTES, name),
    takeaway: requireText(value.takeaway, 'takeaway', MAX_RESULT_TEXT_BYTES, name),
  };
  if (value.cost !== undefined) result.cost = value.cost;
  return freeze(result);
}

export function createReviewResult({ requestId, correction, natural, takeaway, cost }) {
  const result = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    requestId,
    correction,
    natural,
    takeaway,
  };
  if (cost !== undefined) result.cost = cost;
  return parseReviewResult(result);
}

export function parseCompletion(value, { expectedRequestId } = {}) {
  const name = 'Completion';
  requireRecord(value, name);
  requireSchema(value, name);

  if (value.outcome === 'choice') {
    requireExactKeys(value, ['schemaVersion', 'requestId', 'outcome', 'choice'], [], name);
    if (!Number.isInteger(value.choice) || value.choice < 0 || value.choice > 1) {
      throw new ProtocolError(`${name} has an invalid choice.`);
    }
    return freeze({
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      requestId: requireRequestId(value.requestId, expectedRequestId, name),
      outcome: 'choice',
      choice: value.choice,
    });
  }

  if (value.outcome === 'cancel') {
    requireExactKeys(value, ['schemaVersion', 'requestId', 'outcome'], [], name);
    return freeze({
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      requestId: requireRequestId(value.requestId, expectedRequestId, name),
      outcome: 'cancel',
    });
  }

  throw new ProtocolError(`${name} has an invalid outcome.`);
}

export function createChoiceCompletion(requestId, choice) {
  return parseCompletion({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    requestId,
    outcome: 'choice',
    choice,
  });
}

export function createCancelCompletion(requestId) {
  return parseCompletion({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    requestId,
    outcome: 'cancel',
  });
}

async function publishJsonAtomic(filePath, value) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new TypeError('Protocol file path must be absolute.');
  }

  const contents = `${JSON.stringify(value)}\n`;
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;

  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;

    // Publishing with a hard link is atomic and, unlike rename(), never
    // overwrites a completion already produced for this request.
    await fs.link(temporaryPath, filePath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function readJson(filePath, parser, options) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new TypeError('Protocol file path must be absolute.');
  }

  const file = await fs.lstat(filePath);
  if (!file.isFile() || file.size > MAX_PROTOCOL_FILE_BYTES) {
    throw new ProtocolError('Protocol file is not a bounded regular file.');
  }

  const contents = await fs.readFile(filePath, 'utf8');
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new ProtocolError('Protocol file does not contain valid JSON.');
  }
  return parser(value, options);
}

export async function writeReviewRequestAtomic(filePath, request) {
  await publishJsonAtomic(filePath, parseReviewRequest(request));
}

export function readReviewRequest(filePath, options) {
  return readJson(filePath, parseReviewRequest, options);
}

export async function writeReviewResultAtomic(filePath, result) {
  await publishJsonAtomic(filePath, parseReviewResult(result));
}

export function readReviewResult(filePath, options) {
  return readJson(filePath, parseReviewResult, options);
}

export async function writeCompletionAtomic(filePath, completion) {
  await publishJsonAtomic(filePath, parseCompletion(completion));
}

export function readCompletion(filePath, options) {
  return readJson(filePath, parseCompletion, options);
}
