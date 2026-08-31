import { createReviewRequest, createReviewResult } from './protocol.mjs';
import { captureTarget, isTerminalWindow, targetMatches } from './target.mjs';

export const DEFAULT_COMPLETION_TIMEOUT_MS = 5 * 60 * 1000;

function overlayPayload(runtime, state, fields = {}) {
  return {
    schemaVersion: 1,
    requestId: runtime.requestId,
    completionFile: runtime.completionFile,
    state,
    ...fields,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function publishAndSummon(runtime, system, payload) {
  await runtime.publishOverlay(payload);
  await system.summonOverlay(runtime.locator);
}

async function waitForReviewOrCancellation({ reviewPromise, completionPromise }) {
  return Promise.race([
    reviewPromise.then(
      (review) => ({ type: 'review', review }),
      (error) => ({ type: 'review-error', error }),
    ),
    completionPromise.then(
      (completion) => ({ type: 'completion', completion }),
      (error) => ({ type: 'completion-error', error }),
    ),
  ]);
}

export async function runReviewFlow({
  sourceAddress,
  sourcePid,
  sourceTerminal,
  runtime,
  system,
  signal,
  completionTimeoutMs = DEFAULT_COMPLETION_TIMEOUT_MS,
}) {
  let overlayShown = false;
  const reviewController = new AbortController();
  const cancelReview = () => reviewController.abort(signal?.reason);
  signal?.addEventListener('abort', cancelReview, { once: true });

  try {
    const sourceWindow = await system.getActiveWindow({ signal });
    const sourceTarget = captureTarget(sourceWindow);
    if (sourceTarget.address !== sourceAddress.toLowerCase() || sourceTarget.pid !== sourcePid) {
      throw new Error('The source window changed before Word Fixer captured the selection.');
    }
    if (isTerminalWindow(sourceWindow) !== sourceTerminal) {
      throw new Error('The source window type changed before Word Fixer captured the selection.');
    }

    const selectedText = await system.readClipboardText({ signal });
    const request = createReviewRequest({ requestId: runtime.requestId, text: selectedText });

    await publishAndSummon(runtime, system, overlayPayload(runtime, 'loading'));
    overlayShown = true;

    const completionPromise = runtime.waitForCompletion({
      timeoutMs: completionTimeoutMs,
      signal,
    });
    const reviewPromise = system.review(request.text, { signal: reviewController.signal }).then((value) => (
      createReviewResult({
        requestId: runtime.requestId,
        correction: value?.correction,
        natural: value?.natural,
        takeaway: value?.takeaway ?? value?.feedback,
        cost: value?.cost,
      })
    ));
    const first = await waitForReviewOrCancellation({ reviewPromise, completionPromise });

    if (first.type === 'completion-error') throw first.error;
    if (first.type === 'completion') {
      reviewController.abort(new Error('Review dismissed.'));
      if (first.completion.outcome !== 'cancel') {
        throw new Error('Word Fixer received a choice before review was ready.');
      }
      await system.hideOverlay();
      overlayShown = false;
      return { status: 'cancelled' };
    }

    if (first.type === 'review-error') {
      await publishAndSummon(runtime, system, overlayPayload(runtime, 'error', {
        message: errorMessage(first.error),
        action: 'Dismiss and try the shortcut again.',
      }));
      const completion = await completionPromise;
      if (completion.outcome !== 'cancel') {
        throw new Error('Word Fixer cannot accept a choice after a failed review.');
      }
      await system.hideOverlay();
      overlayShown = false;
      return { status: 'review-error', error: first.error };
    }

    const review = first.review;
    await publishAndSummon(runtime, system, overlayPayload(runtime, 'review', {
      original: request.text,
      correction: review.correction,
      natural: review.natural,
      takeaway: review.takeaway,
      ...(review.cost === undefined ? {} : { cost: review.cost }),
    }));

    const completion = await completionPromise;
    if (completion.outcome === 'cancel') {
      await system.hideOverlay();
      overlayShown = false;
      return { status: 'cancelled' };
    }

    const acceptedText = completion.choice === 0 ? review.correction : review.natural;
    await system.hideOverlay();
    overlayShown = false;
    await system.writeClipboardText(acceptedText, { signal });

    const sourceExists = await system.sourceExists(sourceTarget, { signal });
    if (!sourceExists) {
      await system.notifyFailure(
        'Source window is no longer available. The correction is on the clipboard.',
      );
      return { status: 'source-lost', acceptedText };
    }

    const refocused = await system.focusAndVerify(sourceTarget, { signal });
    if (!refocused) {
      await system.notifyFailure(
        'Could not safely restore the source window. The correction is on the clipboard.',
      );
      return { status: 'refocus-failed', acceptedText };
    }

    const activeWindow = await system.getActiveWindow({ signal });
    if (!targetMatches(sourceTarget, activeWindow)) {
      await system.notifyFailure(
        'The active window no longer matches the source. The correction is on the clipboard.',
      );
      return { status: 'target-mismatch', acceptedText };
    }

    await system.paste(sourceWindow, sourceTarget, { signal });
    return { status: 'accepted', acceptedText, choice: completion.choice };
  } finally {
    signal?.removeEventListener('abort', cancelReview);
    if (overlayShown) await system.hideOverlay().catch(() => {});
  }
}

export async function executeWordFixer(options) {
  const runtime = await options.acquireRuntime();
  try {
    return await runReviewFlow({ ...options, runtime });
  } finally {
    await runtime.cleanup();
  }
}
