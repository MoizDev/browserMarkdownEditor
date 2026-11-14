import type { FileRecord } from '../../utils/vaultIndex/types';
import { INDEX_EXTRACTOR, INDEX_SCHEMA, openIndexDatabase, requestResult, transactionDone } from './persistence';

type StoredNote = Omit<FileRecord, 'path' | 'rev' | 'text'>;
type TextSnapshot = { mtime: number; size: number; text: string };
type Change = { record?: FileRecord | null; text?: string; textVersion?: { mtime: number; size: number } };
const range = (vault: string) => IDBKeyRange.bound([vault, ''], [vault, '\uffff']);

function validNote(value: unknown): value is StoredNote {
    if (!value || typeof value !== 'object') return false;
    const note = value as StoredNote;
    return typeof note.kind === 'string' && Number.isFinite(note.mtime) && Number.isFinite(note.size) && note.size >= 0
        && (note.status === 'ready' || note.status === 'refused') && !!note.facts
        && [note.facts.wikilinks, note.facts.mdLinks, note.facts.embeds].every(a => Array.isArray(a) && a.every(s => typeof s === 'string'));
}

/** A session keeps its own dirty set even while another window owns the writer lock. */
export class PersistSession {
    private readonly dirty = new Map<string, Change>();
    private readonly abort = new AbortController();
    private release?: () => void;
    private held = false;
    private closed = false;
    private timer?: ReturnType<typeof setTimeout>;
    private flushing: Promise<void> = Promise.resolve();
    private channel?: BroadcastChannel;
    constructor(readonly vaultId: string, private problem: (kind: 'quota' | 'corrupt', detail: string) => void) {}

    async open(): Promise<FileRecord[]> {
        try {
            const db = await openIndexDatabase();
            const transaction = db.transaction(['vaults', 'notes'], 'readonly');
            const metadata = await requestResult(transaction.objectStore('vaults').get(this.vaultId)) as { schema?: number; extractorVersion?: number } | undefined;
            if (metadata && (metadata.schema !== INDEX_SCHEMA || metadata.extractorVersion !== INDEX_EXTRACTOR)) {
                this.problem('corrupt', 'Index version changed; rebuilding');
                this.reset = true;
            } else if (metadata) {
                const notes = transaction.objectStore('notes');
                const keysRequest = notes.getAllKeys(range(this.vaultId));
                const valuesRequest = notes.getAll(range(this.vaultId));
                const [keys, values] = await Promise.all([requestResult(keysRequest), requestResult(valuesRequest)]);
                if (!values.every(validNote)) { this.problem('corrupt', 'Invalid index record; rebuilding'); this.reset = true; }
                else {
                    this.startWriter();
                    return values.map((value, i) => ({ ...value, path: (keys[i] as string[])[1], rev: 0 }));
                }
            }
        } catch (error) { this.problem('corrupt', String(error)); }
        this.startWriter();
        return [];
    }
    private reset = false;
    private startWriter(): void {
        this.channel = new BroadcastChannel('bme-index-layout');
        this.channel.onmessage = event => {
            const message = event.data as { vaultId?: string; layout?: unknown; forget?: boolean };
            if (message.vaultId !== this.vaultId) return;
            if (message.forget) {
                this.closed = true; this.dirty.clear(); this.layout = undefined; this.reset = false;
                if (this.timer) clearTimeout(this.timer);
                if (this.held) this.release?.(); else this.abort.abort();
                this.channel?.close();
            } else if (message.layout) { this.layout = message.layout; this.schedule(); }
        };
        void navigator.locks.request(`bme-index:${this.vaultId}`, { signal: this.abort.signal }, async () => {
            if (this.closed) return;
            this.held = true;
            const released = new Promise<void>(resolve => { this.release = resolve; });
            await this.flush();
            await released;
            await this.flush();
            this.held = false;
        }).catch(() => {});
    }
    private layout: unknown;
    mark(path: string, record: FileRecord | null, text?: string): void {
        if (this.closed) return;
        const previous = this.dirty.get(path);
        const version = previous?.textVersion ?? previous?.record;
        const kept = record && version?.mtime === record.mtime && version.size === record.size ? previous?.text : undefined;
        this.dirty.set(path, { record, text: record && record.size <= 4 * 1024 * 1024 ? text ?? kept : undefined });
        this.schedule();
    }
    markText(path: string, mtime: number, size: number, text: string): void {
        if (this.closed) return;
        const existing = this.dirty.get(path);
        this.dirty.set(path, { ...existing, text, textVersion: { mtime, size } });
        this.schedule();
    }
    private schedule(): void {
        if (!this.held || this.closed || this.timer) return;
        this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 2000);
    }
    flush(): Promise<void> {
        const run = async () => {
            if (!this.held || (!this.dirty.size && !this.reset && !this.layout)) return;
            const entries = [...this.dirty];
            const layout = this.layout;
            const reset = this.reset;
            this.dirty.clear(); this.layout = undefined; this.reset = false;
            try {
                const db = await openIndexDatabase();
                const tx = db.transaction(['vaults', 'notes', 'texts', 'layouts'], 'readwrite');
                const notes = tx.objectStore('notes'), texts = tx.objectStore('texts');
                if (reset) { notes.delete(range(this.vaultId)); texts.delete(range(this.vaultId)); tx.objectStore('layouts').delete(this.vaultId); }
                for (const [path, change] of entries) {
                    const key = [this.vaultId, path];
                    if (change.record === null) { notes.delete(key); texts.delete(key); continue; }
                    if (change.record) {
                        const { path: _path, rev: _rev, text: _text, ...record } = change.record;
                        notes.put(record, key);
                        if (change.text !== undefined) texts.put({ ...(change.textVersion ?? { mtime: record.mtime, size: record.size }), text: change.text }, key);
                        else texts.delete(key);
                    } else if (change.textVersion && change.text !== undefined) {
                        texts.put({ ...change.textVersion, text: change.text }, key);
                    }
                }
                if (layout) tx.objectStore('layouts').put({ schema: INDEX_SCHEMA, extractorVersion: INDEX_EXTRACTOR, layout }, this.vaultId);
                const count = notes.count(range(this.vaultId));
                count.onsuccess = () => tx.objectStore('vaults').put({ schema: INDEX_SCHEMA, extractorVersion: INDEX_EXTRACTOR,
                    lastSweepAt: Date.now(), recordCount: count.result }, this.vaultId);
                await transactionDone(tx);
            } catch (error) {
                this.problem(error instanceof DOMException && error.name === 'QuotaExceededError' ? 'quota' : 'corrupt', String(error));
                for (const [path, change] of entries) if (!this.dirty.has(path)) this.dirty.set(path, change);
                this.reset ||= reset;
            }
        };
        this.flushing = this.flushing.then(run, run);
        return this.flushing;
    }
    async readText(path: string, mtime: number, size: number): Promise<string | undefined> {
        if (this.closed) return undefined;
        const pending = this.dirty.get(path);
        if (pending) {
            const version = pending.textVersion ?? pending.record;
            return version?.mtime === mtime && version.size === size ? pending.text : undefined;
        }
        if (this.reset) return undefined;
        try {
            const db = await openIndexDatabase();
            const value = await requestResult(db.transaction('texts').objectStore('texts').get([this.vaultId, path])) as TextSnapshot | undefined;
            return value?.mtime === mtime && value.size === size && typeof value.text === 'string' ? value.text : undefined;
        } catch { return undefined; }
    }
    async close(): Promise<void> {
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        if (this.held) { await this.flush(); this.release?.(); }
        else this.abort.abort();
        this.channel?.close();
    }
}
