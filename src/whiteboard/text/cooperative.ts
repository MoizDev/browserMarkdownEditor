import type { PlainTextOptions } from './plainText';

/** Drive the same pure traversal synchronously when the caller already holds an atomic transaction. */
export function finishTextSteps<T>(steps: Generator<void, T>): T {
    let completed = false;
    try {
        for (;;) {
            const step = steps.next();
            if (step.done) { completed = true; return step.value; }
        }
    } finally {
        if (!completed) try { steps.return(undefined as T); } catch { /* Preserve the original error. */ }
    }
}

/** Cancellation closes the traversal before its unpublished fragments can outlive the caller. */
export async function finishTextStepsCooperative<T>(steps: Generator<void, T>, options: PlainTextOptions): Promise<T> {
    const budget = options.sliceMilliseconds ?? 3;
    if (!Number.isFinite(budget) || budget <= 0) throw new RangeError('Invalid text operation time slice');
    let started = performance.now(), completed = false;
    try {
        for (;;) {
            options.signal?.throwIfAborted();
            const step = steps.next();
            if (step.done) { completed = true; return step.value; }
            if (performance.now() - started >= budget) {
                await options.cooperate();
                options.signal?.throwIfAborted();
                started = performance.now();
            }
        }
    } finally {
        if (!completed) try { steps.return(undefined as T); } catch { /* Preserve the original error. */ }
    }
}
