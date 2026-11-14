import affUrl from '../../../../node_modules/dictionary-en/index.aff?url';
import dicUrl from '../../../../node_modules/dictionary-en/index.dic?url';
import { createWorkerClient } from '../../../platform/workers';
import type { WorkerClient } from '../../../platform/workers';
import type { Misspelling } from './menu';
import { normalizeUserDictionary } from './dictionary';
import { packedMisspellings } from './packedRanges';

async function misspellings(value: unknown, text: string, signal: AbortSignal): Promise<readonly Misspelling[]> {
    if (!(value instanceof Uint32Array) || value.length % 2 || value.length > text.length * 2) throw new Error('Invalid spelling worker response');
    let previous = 0;
    for (let i = 0; i < value.length; i += 2) {
        signal.throwIfAborted();
        const from = value[i], to = value[i + 1];
        if (from < previous || to <= from || to > text.length) throw new Error('Invalid spelling worker range');
        previous = to;
        if ((i & 8191) === 8190) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    return packedMisspellings(text, value);
}

/** Loaded on first text edit; dictionaries survive worker failure without another fetch. */
export class BoardSpellClient {
    private host: WorkerClient | null = null;
    private ready: Promise<void> | null = null;
    private dictionary: Promise<{ aff: string; dic: string }> | null = null;
    private dictionaryFetch: AbortController | null = null;
    private custom: readonly string[];
    private disposed = false;
    private debounce: ReturnType<typeof setTimeout> | null = null;
    private checkAbort: AbortController | null = null;
    private generation = 0;
    private dictionaryVersion = 0;
    private dictionaryBarrier: Promise<void> = Promise.resolve();
    private readonly name = `whiteboard-spell-${crypto.randomUUID()}`;

    constructor(custom: readonly string[]) { this.custom = normalizeUserDictionary(custom); }

    private dictionaryData(): Promise<{ aff: string; dic: string }> {
        if (this.dictionary) return this.dictionary;
        const controller = new AbortController();
        this.dictionaryFetch = controller;
        const loading: Promise<{ aff: string; dic: string }> = Promise.all([
            fetch(affUrl, { signal: controller.signal }), fetch(dicUrl, { signal: controller.signal }),
        ]).then(async ([a, d]) => {
            if (!a.ok || !d.ok) throw new Error('Spelling dictionary could not be loaded');
            const [aff, dic] = await Promise.all([a.text(), d.text()]);
            if (aff.length > 1_000_000 || dic.length > 4_000_000) throw new RangeError('Spelling dictionary exceeds limits');
            return { aff, dic };
        }).catch(error => {
            controller.abort();
            if (this.dictionary === loading) this.dictionary = null;
            throw error;
        }).finally(() => { if (this.dictionaryFetch === controller) this.dictionaryFetch = null; });
        this.dictionary = loading;
        return loading;
    }

    private abortDictionaryFetch(): void {
        if (!this.dictionaryFetch) return;
        this.dictionaryFetch.abort();
        this.dictionaryFetch = null;
        this.dictionary = null;
    }

    start(): Promise<void> {
        if (this.disposed) return Promise.reject(new Error('Spelling client disposed'));
        if (this.host?.state === 'failed') {
            this.host.dispose(); this.host = null; this.ready = null;
            this.dictionaryBarrier = Promise.resolve();
        }
        if (this.ready) return this.ready;
        let host!: WorkerClient;
        host = createWorkerClient({
            name: this.name,
            protocol: 1,
            spawn: () => new Worker(new URL('./spell.worker.ts', import.meta.url), { type: 'module' }),
            onStart: async bootstrap => {
                const data = await this.dictionaryData();
                if (this.host !== host || this.disposed) throw new DOMException('Spelling client closed', 'AbortError');
                await bootstrap.request('init', { ...data, custom: this.custom },
                    { priority: 2, deadlineMs: 30_000, terminateOnDeadline: true });
            },
        });
        this.host = host;
        const ready = host.request('ready', null, { priority: 2, cpu: 'light', deadlineMs: 45_000 }).then(() => {
            if (this.host !== host || this.disposed) throw new DOMException('Spelling client closed', 'AbortError');
        }).catch(error => {
            if (this.host === host) {
                this.host = null; this.ready = null; this.dictionaryBarrier = Promise.resolve();
                host.dispose(); this.abortDictionaryFetch();
            }
            throw error;
        });
        this.ready = ready;
        return ready;
    }

    private async waitForDictionary(): Promise<void> {
        for (;;) {
            const pending = this.dictionaryBarrier;
            try { await pending; } catch (error) { if (pending === this.dictionaryBarrier) throw error; }
            if (pending === this.dictionaryBarrier) return;
        }
    }

    async suggest(word: string): Promise<readonly string[]> {
        if (!word || word.length > 64) return [];
        await this.start();
        await this.waitForDictionary();
        const host = this.host;
        if (!host || this.disposed) throw new DOMException('Spelling client closed', 'AbortError');
        // nspell is synchronous: recycle a worker that cannot finish a suggestion promptly.
        const value = await host.request<unknown>('suggest', { word }, { priority: 0, deadlineMs: 250, terminateOnDeadline: true });
        if (!Array.isArray(value) || value.length > 5 || value.some(item => typeof item !== 'string' || item.length > 256))
            throw new Error('Invalid spelling suggestion response');
        return value;
    }

    async setDictionary(words: readonly string[]): Promise<void> {
        this.cancelCheck();
        this.custom = normalizeUserDictionary(words);
        const version = ++this.dictionaryVersion, host = this.host, ready = this.ready;
        if (!ready || !host) { this.dictionaryBarrier = Promise.resolve(); return; }
        const previous = this.dictionaryBarrier;
        const update = previous.catch(() => {}).then(async () => {
            await ready;
            if (host === this.host && !this.disposed && version === this.dictionaryVersion)
                await host.request('dictionary', { words: this.custom }, { priority: 2, deadlineMs: 10_000, terminateOnDeadline: true });
        });
        this.dictionaryBarrier = update;
        void update.catch(error => {
            if (this.dictionaryBarrier === update && host === this.host && error instanceof Error
                && (error.name === 'Cancelled' || error.name === 'WorkerCrashed'))
                this.dictionaryBarrier = Promise.resolve();
        });
        await update;
    }

    private cancelCheck(): void {
        this.generation++;
        if (this.debounce !== null) clearTimeout(this.debounce);
        this.debounce = null;
        this.checkAbort?.abort();
        this.checkAbort = null;
    }

    /** Only the latest edited-node text is reported, even if an older check returns late. */
    check(text: string, publish: (ranges: readonly Misspelling[]) => void, error: (reason: unknown) => void, delay = 300): void {
        this.cancelCheck();
        const generation = this.generation;
        this.debounce = setTimeout(() => {
            this.debounce = null;
            const controller = new AbortController();
            this.checkAbort = controller;
            void Promise.resolve().then(() => this.start()).then(async () => {
                await this.waitForDictionary();
                if (this.disposed || generation !== this.generation || controller.signal.aborted) return null;
                const host = this.host;
                if (!host) throw new DOMException('Spelling client closed', 'AbortError');
                return host.request<unknown>('check', { text },
                    { priority: 2, signal: controller.signal, deadlineMs: 10_000, terminateOnDeadline: true });
            }).then(async value => {
                if (value === null || this.disposed || generation !== this.generation) return;
                const ranges = await misspellings(value, text, controller.signal);
                if (!this.disposed && generation === this.generation && !controller.signal.aborted) publish(ranges);
            }).catch(reason => {
                if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
                if (reason instanceof Error && (reason.name === 'Cancelled' || reason.name === 'WorkerCrashed'))
                    this.check(text, publish, error, 0);
                else error(reason);
            }).finally(() => { if (this.checkAbort === controller) this.checkAbort = null; });
        }, Number.isFinite(delay) ? Math.max(0, Math.min(delay, 10_000)) : 300);
    }

    /** Drop the worker when the editing pane is hidden; retain downloaded dictionary bytes. */
    suspend(): void {
        this.cancelCheck();
        const host = this.host;
        this.host = null; this.ready = null;
        this.dictionaryBarrier = Promise.resolve();
        host?.dispose();
        this.abortDictionaryFetch();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.suspend();
        this.dictionary = null;
    }
}
