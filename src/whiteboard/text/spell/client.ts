import affUrl from '../../../../node_modules/dictionary-en/index.aff?url';
import dicUrl from '../../../../node_modules/dictionary-en/index.dic?url';
import type { Misspelling } from './menu';
import { normalizeUserDictionary } from './dictionary';

type Payload = { kind: 'init'; aff: string; dic: string; custom: readonly string[] }
    | { kind: 'check'; text: string }
    | { kind: 'suggest'; word: string }
    | { kind: 'dictionary'; words: readonly string[] };
type Pending = { resolve(value: unknown): void; reject(error: unknown): void; timer?: ReturnType<typeof setTimeout> };

function misspellings(value: unknown, text: string): readonly Misspelling[] {
    if (!(value instanceof Uint32Array) || value.length % 2 || value.length > text.length * 2) throw new Error('Invalid spelling worker response');
    const result: Misspelling[] = [];
    let previous = 0;
    for (let i = 0; i < value.length; i += 2) {
        const from = value[i], to = value[i + 1];
        if (from < previous || to <= from || to > text.length) throw new Error('Invalid spelling worker range');
        result.push({ from, to, word: text.slice(from, to) }); previous = to;
    }
    return result;
}

/** Loaded on first text edit; dictionaries survive worker failure without another fetch. */
export class BoardSpellClient {
    private worker: Worker | null = null;
    private ready: Promise<void> | null = null;
    private dictionary: Promise<{ aff: string; dic: string }> | null = null;
    private dictionaryFetch: AbortController | null = null;
    private custom: readonly string[];
    private serial = 0;
    private readonly pending = new Map<number, Pending>();
    private disposed = false;
    private debounce: ReturnType<typeof setTimeout> | null = null;
    private generation = 0;

    constructor(custom: readonly string[]) { this.custom = normalizeUserDictionary(custom); }

    private request<T>(payload: Payload, deadline = 0, terminateOnDeadline = false): Promise<T> {
        const worker = this.worker;
        if (!worker || this.disposed) return Promise.reject(new Error('Spelling worker unavailable'));
        const id = ++this.serial;
        return new Promise<T>((resolve, reject) => {
            const pending: Pending = { resolve: value => resolve(value as T), reject };
            if (deadline) pending.timer = setTimeout(() => {
                if (this.pending.delete(id)) {
                    const error = new DOMException('Spelling deadline exceeded', 'TimeoutError');
                    reject(error);
                    if (terminateOnDeadline) this.failed(worker, payload.kind === 'suggest'
                        ? new DOMException('Spelling worker restarted after a slow suggestion', 'AbortError') : error);
                }
            }, deadline);
            this.pending.set(id, pending);
            try { worker.postMessage({ id, ...payload }); }
            catch (error) {
                this.pending.delete(id);
                if (pending.timer) clearTimeout(pending.timer);
                reject(error);
            }
        });
    }

    private failed(worker: Worker, error: unknown): void {
        if (this.worker !== worker) return;
        this.worker = null; this.ready = null;
        worker.terminate();
        for (const pending of this.pending.values()) {
            if (pending.timer) clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    start(): Promise<void> {
        if (this.disposed) return Promise.reject(new Error('Spelling client disposed'));
        if (this.ready) return this.ready;
        const worker = new Worker(new URL('./spell.worker.ts', import.meta.url), { type: 'module' });
        this.worker = worker;
        worker.addEventListener('message', event => {
            const data = event.data as { id: number; value?: unknown; error?: string };
            const pending = this.pending.get(data.id);
            if (!pending) return;
            this.pending.delete(data.id);
            if (pending.timer) clearTimeout(pending.timer);
            if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data.value);
        });
        worker.addEventListener('error', event => this.failed(worker, new Error(event.message)));
        worker.addEventListener('messageerror', () => this.failed(worker, new Error('Spelling worker message failed')));
        if (!this.dictionary) {
            const controller = new AbortController(); this.dictionaryFetch = controller;
            const loading: Promise<{ aff: string; dic: string }> = Promise.all([fetch(affUrl, { signal: controller.signal }), fetch(dicUrl, { signal: controller.signal })]).then(async ([a, d]) => {
                if (!a.ok || !d.ok) throw new Error('Spelling dictionary could not be loaded');
                const aff = await a.text(), dic = await d.text();
                if (aff.length > 1_000_000 || dic.length > 4_000_000) throw new RangeError('Spelling dictionary exceeds limits');
                return { aff, dic };
            }).catch(error => { controller.abort(); if (this.dictionary === loading) this.dictionary = null; throw error; })
                .finally(() => { if (this.dictionaryFetch === controller) this.dictionaryFetch = null; });
            this.dictionary = loading;
        }
        const ready = this.dictionary.then(async data => {
            if (this.worker !== worker || this.disposed) throw new DOMException('Spelling client closed', 'AbortError');
            await this.request({ kind: 'init', ...data, custom: this.custom }, 30_000, true);
        }).catch(error => { this.failed(worker, error); throw error; });
        this.ready = ready;
        return ready;
    }

    async suggest(word: string): Promise<readonly string[]> {
        if (!word || word.length > 64) return [];
        await this.start();
        // nspell suggestions are synchronous in the worker; a timed-out call otherwise blocks every later check.
        const value = await this.request<unknown>({ kind: 'suggest', word }, 250, true);
        if (!Array.isArray(value) || value.length > 5 || value.some(item => typeof item !== 'string' || item.length > 256))
            throw new Error('Invalid spelling suggestion response');
        return value;
    }

    async setDictionary(words: readonly string[]): Promise<void> {
        this.cancelCheck();
        this.custom = normalizeUserDictionary(words);
        const worker = this.worker;
        if (!this.ready || !worker) return;
        await this.ready;
        if (worker === this.worker && !this.disposed) await this.request({ kind: 'dictionary', words: this.custom }, 10_000, true);
    }

    private cancelCheck(): void {
        this.generation++;
        if (this.debounce !== null) clearTimeout(this.debounce);
        this.debounce = null;
        const worker = this.worker;
        if (worker) try { worker.postMessage({ id: 0, kind: 'cancel' }); }
        catch (error) { this.failed(worker, error); }
    }

    /** Only the latest edited-node text is reported, even if an older check returns late. */
    check(text: string, publish: (ranges: readonly Misspelling[]) => void, error: (reason: unknown) => void, delay = 300): void {
        this.cancelCheck();
        const generation = this.generation;
        this.debounce = setTimeout(() => {
            this.debounce = null;
            void Promise.resolve().then(() => this.start()).then(() => {
                if (this.disposed || generation !== this.generation) return null;
                return this.request<unknown>({ kind: 'check', text }, 10_000, true);
            }).then(value => {
                if (value !== null && !this.disposed && generation === this.generation) publish(misspellings(value, text));
            }).catch(reason => {
                if (this.disposed || generation !== this.generation) return;
                if (reason instanceof DOMException && reason.name === 'AbortError' && !this.worker) this.check(text, publish, error, 0);
                else error(reason);
            });
        }, Number.isFinite(delay) ? Math.max(0, Math.min(delay, 10_000)) : 300);
    }

    /** Drop the worker when the editing pane is hidden; retain downloaded dictionary bytes. */
    suspend(): void {
        this.generation++;
        if (this.debounce !== null) clearTimeout(this.debounce);
        this.debounce = null;
        if (this.worker) this.failed(this.worker, new DOMException('Spelling client suspended', 'AbortError'));
        if (this.dictionaryFetch) { this.dictionaryFetch.abort(); this.dictionaryFetch = null; this.dictionary = null; }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.suspend();
        this.dictionary = null;
    }
}
