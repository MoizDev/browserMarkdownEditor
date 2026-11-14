import affUrl from '../../../../node_modules/dictionary-en/index.aff?url';
import dicUrl from '../../../../node_modules/dictionary-en/index.dic?url';
import type { Misspelling } from './menu';

type Payload = { kind: 'init'; aff: string; dic: string; custom: readonly string[] }
    | { kind: 'check'; text: string }
    | { kind: 'suggest'; word: string }
    | { kind: 'dictionary'; words: readonly string[] };
type Pending = { resolve(value: unknown): void; reject(error: unknown): void; timer?: ReturnType<typeof setTimeout> };

/** Loaded on first text edit; dictionaries survive worker failure without another fetch. */
export class BoardSpellClient {
    private worker: Worker | null = null;
    private ready: Promise<void> | null = null;
    private dictionary: Promise<{ aff: string; dic: string }> | null = null;
    private custom: readonly string[];
    private serial = 0;
    private readonly pending = new Map<number, Pending>();
    private disposed = false;
    private debounce: ReturnType<typeof setTimeout> | null = null;
    private generation = 0;

    constructor(custom: readonly string[]) { this.custom = [...custom]; }

    private request<T>(payload: Payload, deadline = 0): Promise<T> {
        const worker = this.worker;
        if (!worker || this.disposed) return Promise.reject(new Error('Spelling worker unavailable'));
        const id = ++this.serial;
        return new Promise<T>((resolve, reject) => {
            const pending: Pending = { resolve: value => resolve(value as T), reject };
            if (deadline) pending.timer = setTimeout(() => {
                if (this.pending.delete(id)) reject(new DOMException('Spelling deadline exceeded', 'TimeoutError'));
            }, deadline);
            this.pending.set(id, pending);
            worker.postMessage({ id, ...payload });
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
        this.dictionary ??= Promise.all([fetch(affUrl), fetch(dicUrl)]).then(async ([a, d]) => {
            if (!a.ok || !d.ok) throw new Error('Spelling dictionary could not be loaded');
            return { aff: await a.text(), dic: await d.text() };
        }).catch(error => { this.dictionary = null; throw error; });
        const ready = this.dictionary.then(async data => {
            if (this.worker !== worker || this.disposed) throw new DOMException('Spelling client closed', 'AbortError');
            await this.request({ kind: 'init', ...data, custom: this.custom });
        }).catch(error => { this.failed(worker, error); throw error; });
        this.ready = ready;
        return ready;
    }

    async suggest(word: string): Promise<readonly string[]> {
        await this.start();
        return this.request<readonly string[]>({ kind: 'suggest', word }, 250);
    }

    async setDictionary(words: readonly string[]): Promise<void> {
        this.custom = [...words];
        if (!this.ready) return;
        await this.ready;
        await this.request({ kind: 'dictionary', words: this.custom });
    }

    /** Only the latest edited-node text is reported, even if an older check returns late. */
    check(text: string, publish: (ranges: readonly Misspelling[]) => void, error: (reason: unknown) => void): void {
        const generation = ++this.generation;
        if (this.debounce !== null) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
            this.debounce = null;
            void this.start().then(() => this.request<readonly Misspelling[]>({ kind: 'check', text }))
                .then(ranges => { if (!this.disposed && generation === this.generation) publish(ranges); },
                    reason => { if (!this.disposed && generation === this.generation) error(reason); });
        }, 300);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true; this.generation++;
        if (this.debounce !== null) clearTimeout(this.debounce);
        if (this.worker) this.failed(this.worker, new DOMException('Spelling client disposed', 'AbortError'));
    }
}
