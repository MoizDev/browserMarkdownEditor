import type { PlainTextOptions } from './plainText';

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

export { yieldToHost } from '../../platform/yieldToHost';

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
