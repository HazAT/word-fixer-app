import {
  assessDictation, DEFAULT_DICTATION_TIMEOUT_MS, validateDictationInput,
} from '../../helper/helper-lib.mjs';

export async function executeDictation({ input, env = {}, argv = [], config = {}, system, clock = Date.now }) {
  const startedAt = clock();
  const details = {
    input: null, output: null, outcome: 'failed', guard: null,
    llm: null, hadContext: typeof env.VOXTYPE_CONTEXT === 'string' && !!env.VOXTYPE_CONTEXT.trim(),
    source: null, error: null, durationMs: 0,
  };
  const controller = new AbortController();
  let timer;
  try {
    if (argv.length) {
      if (argv.length !== 2 || argv[0] !== '--source' || !/^[a-z0-9-]{1,32}$/.test(argv[1])) {
        throw new Error('Usage: word-fixer-dictate [--source <name>] | --prewarm');
      }
      details.source = argv[1];
    }
    const timeoutMs = config.dictation?.timeoutMs ?? DEFAULT_DICTATION_TIMEOUT_MS;
    const maxEditRatio = config.dictation?.maxEditRatio ?? 0.5;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid dictation timeoutMs.');
    if (typeof maxEditRatio !== 'number' || !Number.isFinite(maxEditRatio) || maxEditRatio < 0) {
      throw new Error('Invalid dictation maxEditRatio.');
    }
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Dictation timed out after ${timeoutMs}ms.`);
        controller.abort(error);
        reject(error);
      }, Math.max(0, timeoutMs - (clock() - startedAt)));
    });
    const work = async () => {
      details.input = await input;
      validateDictationInput(details.input);
      const result = await system.dictate(details.input, { context: env.VOXTYPE_CONTEXT, signal: controller.signal });
      if (controller.signal.aborted) throw controller.signal.reason;
      if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('Helper returned empty dictation text.');
      details.llm = { durationMs: result.durationMs ?? null, cost: result.cost ?? null };
      details.guard = assessDictation(details.input, result.text, { maxEditRatio });
      if (clock() - startedAt >= timeoutMs) {
        const error = new Error(`Dictation timed out after ${timeoutMs}ms.`);
        controller.abort(error);
        throw error;
      }
      return result;
    };
    const result = await Promise.race([work(), deadline]);
    if (!details.guard.accepted) {
      details.outcome = 'rejected';
      details.error = 'Dictation rejected by the transcript guard.';
      return { exitCode: 3, stdout: '', stderr: `${details.error}\n`, details };
    }
    details.output = result.text;
    details.outcome = details.guard.unchanged ? 'unchanged' : 'fixed';
    return { exitCode: 0, stdout: result.text, stderr: '', details };
  } catch (error) {
    details.error = String(error?.message ?? error).replace(/[\r\n]+/g, ' ');
    return { exitCode: 1, stdout: '', stderr: `${details.error}\n`, details };
  } finally {
    clearTimeout(timer);
    details.durationMs = clock() - startedAt;
  }
}
