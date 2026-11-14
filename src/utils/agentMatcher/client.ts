import type { WorkerClient } from '../../platform/workers';
import type { MatchAnswer, MatchBatch, MatchConfig, MatchFile, MatchProgress } from './types';

const CHUNK_CHARS = 64 * 1024;
const QUERY_MS = 5000;
let active: AbortController | undefined;
let owner: WorkerClient | undefined;
let ownerEpoch = 0;
let lastRunSignal: AbortSignal | undefined;
const poisoned = new Set<string>();
const vaultIds = new WeakMap<object, number>();
let nextVaultId = 0;

/** The owner is the vault, not the chat panel or any document pane. */
export function releaseAgentMatcher(): void {
    ++ownerEpoch;
    const controller = active;
    active = undefined;
    controller?.abort();
    owner?.dispose();
    owner = undefined;
    poisoned.clear();
    lastRunSignal = undefined;
}

export async function matchAgentSearch(
    config: MatchConfig,
    readFiles: () => Promise<Iterable<MatchFile>>,
    options: { signal?: AbortSignal; vaultToken: object | null; isCurrent(): boolean },
): Promise<MatchAnswer> {
    const epoch = ownerEpoch;
    const { createWorkerClient, WorkerHostError } = await import('../../platform/workers');
    // A vault can close while the lazy chunk loads. Never resurrect its owner afterwards.
    if (epoch !== ownerEpoch || options.signal?.aborted || !options.isCurrent()) {
        return { out: [], count: 0, fileCount: 0, stopped: false, incomplete: true, reason: 'the search was cancelled' };
    }
    active?.abort();
    const lifetime = active = new AbortController();
    const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
    const client = owner = createWorkerClient({
        name: 'agent-matcher',
        protocol: 1,
        spawn: () => new Worker(new URL('./matcher.worker.ts', import.meta.url), { type: 'module' }),
    });
    // A new message, not the agent's next tool call, is an explicit user retry. The persistent
    // owner retains crash/poison accounting across disposable workers and searches in one run.
    if (options.signal !== lastRunSignal) {
        if (client.state === 'failed') { client.reset(); poisoned.clear(); }
        lastRunSignal = options.signal;
    }
    let vaultId = options.vaultToken ? vaultIds.get(options.vaultToken) : 0;
    if (options.vaultToken && vaultId === undefined) {
        vaultId = ++nextVaultId;
        vaultIds.set(options.vaultToken, vaultId);
    }
    const answer: MatchAnswer = { out: [], count: 0, fileCount: 0, stopped: false, incomplete: false };
    const stop = () => {
        if (active !== lifetime) return;
        client.cancelAll(() => true);
        void client.recycle('Agent search cancelled', { lazy: true }).catch(() => {});
    };
    signal.addEventListener('abort', stop, { once: true });
    // TODO(C-03): replace root-handle identity with the vault activation id when it lands.
    // Follow the query, not the panel mount: hiding chat must not orphan its work. An idle owner
    // has neither this poll nor a worker clock.
    const identity = setInterval(() => { if (!options.isCurrent()) lifetime.abort(); }, 100);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let matching = false;
    let timedOut = false;
    let completed = false;
    let workerCrashed = false;
    let requestKey: string | undefined;
    try {
        // Syntax validation runs in the worker too. A startup/hello stall has its own 2 s cap;
        // the 5 s matching budget starts only once the bounded input feed can dispatch work.
        const queryKey = await client.request<string>('configure', config, { priority: 0, deadlineMs: 2000, signal });
        if (typeof queryKey !== 'string' || queryKey.length !== 64) throw new WorkerHostError('Protocol', 'Invalid matcher identity');
        const files = await readFiles();
        if (signal.aborted || !options.isCurrent()) throw new WorkerHostError('Cancelled', 'Search cancelled');
        matching = true;
        const deadline = performance.now() + QUERY_MS;
        deadlineTimer = setTimeout(() => { timedOut = true; lifetime.abort(); }, QUERY_MS);
        for (const file of files) {
            requestKey = JSON.stringify([vaultId, queryKey, file.path]);
            if (poisoned.has(requestKey)) {
                answer.incomplete = true;
                answer.reason = 'the pattern repeatedly crashed the search worker on a file';
                continue;
            }
            let offset = 0;
            const length = file.text?.length ?? 0;
            do {
                if (signal.aborted || !options.isCurrent()) throw new WorkerHostError('Cancelled', 'Search cancelled');
                const last = offset + CHUNK_CHARS >= length;
                const batch: MatchBatch = {
                    path: file.path, name: file.name, first: offset === 0, last,
                    textFile: file.text !== undefined, text: file.text?.slice(offset, offset + CHUNK_CHARS) ?? '',
                };
                const progress = await client.request<MatchProgress>('batch', batch, {
                    priority: 0, signal, deadlineMs: Math.max(0, deadline - performance.now()),
                    key: requestKey,
                });
                answer.out.push(...progress.out);
                answer.count = progress.count;
                answer.fileCount = progress.fileCount;
                answer.stopped = progress.stopped;
                if (last || progress.doneFile || progress.stopped) break;
                offset += CHUNK_CHARS;
            } while (offset < length);
            if (answer.stopped) break;
        }
        completed = true;
        return answer;
    } catch (error) {
        if (error instanceof WorkerHostError) {
            if (error.name === 'SyntaxError') throw error;
            workerCrashed = error.name === 'WorkerCrashed';
            answer.incomplete = true;
            if (error.poisoned && requestKey) poisoned.add(requestKey);
            answer.reason = timedOut || (matching && error.name === 'Deadline') ? 'the pattern took too long'
                : signal.aborted || error.name === 'Cancelled' ? 'the search was cancelled'
                : error.name === 'WorkerFailed' ? 'regex search unavailable'
                : error.poisoned ? 'the pattern repeatedly crashed the search worker on a file'
                : 'the search worker became unavailable';
            return answer;
        }
        throw error;
    } finally {
        clearTimeout(deadlineTimer);
        clearInterval(identity);
        signal.removeEventListener('abort', stop);
        if (active === lifetime) {
            // A transport crash belongs to the host's recovery window. Recycling it here cancelled
            // back-off (measured: the always-dying worker stopped at two starts, owner idle not failed).
            if (!completed && !workerCrashed) stop();
            active = undefined;
        }
    }
}
