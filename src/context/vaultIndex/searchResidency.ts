import { decodeDocumentText } from '../../utils/diskVersion';
import { isTextFile } from '../../utils/vaultSearch';
import { isCanvasFile } from '../../utils/fileTypes';
import { mapPool } from '../../utils/pool';
import type { IndexFile } from '../../utils/vaultIndex/types';
import type { IndexStat } from './reader';
import type { WorkerContext } from '../../platform/workers/serve';

const FILE_LIMIT = 4 * 1024 * 1024;
const SOURCE_BYTES_LIMIT = 128 * 1024 * 1024;

type TextEntry = { mtime: number; size: number; text?: string };
type Source = { stat: IndexStat; revision: number; signal?: AbortSignal };

/** Search's optional text residency is separate from graph facts. Only the
 * committed full tree owns membership; a query's scope never prunes it. */
export class SearchResidency {
    private entries = new Map<string, TextEntry>();
    private sources = new Map<string, Source>();
    private revisions = new Map<string, number>();
    private treeGen = -1;
    private files: IndexFile[] = [];
    private runner: Promise<void> | undefined;
    private requested = new Set<string>();
    private interested = new Set<string>();
    private dirty = new Set<string>();
    private started = false;
    private fullStat = false;
    private disposed = false;

    constructor(private readonly stat: (file: IndexFile, context: WorkerContext) => Promise<IndexStat>, private readonly current: () => boolean,
        private readonly persisted: (path: string, mtime: number, size: number) => Promise<string | undefined>,
        private readonly persist: (path: string, mtime: number, size: number, text: string) => void) {}
    private rev(path: string) { return this.revisions.get(path) ?? 0; }
    private advance(path: string) { this.revisions.set(path, this.rev(path) + 1); }
    private valid(path: string, rev: number) { return !this.disposed && this.current() && this.rev(path) === rev; }
    setTree(treeGen: number, files: IndexFile[]) {
        if (treeGen <= this.treeGen) return;
        const next = new Set(files.map(file => file.path));
        for (const file of this.files) if (!next.has(file.path)) {
            this.advance(file.path); this.entries.delete(file.path); this.sources.delete(file.path); this.requested.delete(file.path);
        }
        this.treeGen = treeGen;
        this.files = files;
        this.fullStat = true;
    }
    invalidate(paths: readonly string[]) {
        for (const path of paths) {
            this.advance(path); this.sources.delete(path); this.entries.delete(path); this.dirty.add(path);
            if (this.interested.has(path)) this.requested.add(path);
        }
    }
    revalidate() {
        for (const file of this.files) this.advance(file.path);
        this.sources.clear();
        this.fullStat = true;
        for (const path of this.interested) this.requested.add(path);
    }
    prime(path: string, mtime: number, size: number, text: string) {
        if (!this.started) return;
        this.advance(path);
        this.dirty.delete(path);
        const bytes = size <= FILE_LIMIT ? async () => new TextEncoder().encode(text).buffer : async () => new ArrayBuffer(0);
        this.sources.set(path, { revision: this.rev(path), stat: { mtime, size, bytes, stream: () => new Blob([size <= FILE_LIMIT ? text : '']).stream() } });
        const normalized = size <= FILE_LIMIT ? text.replace(/\r\n?/g, '\n') : undefined;
        this.entries.set(path, { mtime, size, text: normalized });
        if (this.admit().has(path) && normalized !== undefined) this.persist(path, mtime, size, normalized);
    }
    dispose() { this.disposed = true; this.entries.clear(); this.sources.clear(); this.requested.clear(); }
    snapshot(): ReadonlyMap<string, TextEntry> { return this.entries; }
    // Stat completion order must not decide the global source-byte budget:
    // reserve synchronously in the provider's canonical tree order.
    private admit() {
        const accepted = new Set<string>();
        let bytes = 0;
        for (const file of this.files) {
            const source = this.sources.get(file.path);
            if (!source || source.stat.size > FILE_LIMIT || bytes + source.stat.size > SOURCE_BYTES_LIMIT) continue;
            bytes += source.stat.size; accepted.add(file.path);
        }
        for (const path of this.entries.keys()) if (!accepted.has(path)) this.entries.delete(path);
        return accepted;
    }
    async ensure(paths: readonly string[], context: WorkerContext): Promise<void> {
        if (!paths.length) return;
        this.started = true;
        for (const path of paths) { this.interested.add(path); this.requested.add(path); }
        if (this.runner) {
            try { await this.runner; } catch (error) { if (context.cancelled) throw error; }
            if (this.fullStat || paths.some(path => this.requested.has(path))) return this.ensure(paths, context);
            return;
        }
        const run = this.run(context).catch(error => { for (const path of this.interested) this.requested.add(path); throw error; });
        this.runner = run;
        try { await run; } finally { if (this.runner === run) this.runner = undefined; }
    }
    private async run(context: WorkerContext) {
        while (!this.disposed && this.current() && (this.fullStat || this.requested.size)) {
            const treeGen = this.treeGen;
            const wanted = new Set(this.requested);
            this.requested.clear();
            const full = this.fullStat;
            this.fullStat = false;
            const eligible = this.files.filter(file => isTextFile(file.path) && !isCanvasFile(file.path));
            const stats = full ? eligible : eligible.filter(file => this.dirty.has(file.path) || (wanted.has(file.path) && (!this.sources.has(file.path) || this.sources.get(file.path)?.signal?.aborted)));
            await mapPool(stats, async file => {
                const rev = this.rev(file.path);
                try {
                    const stat = await this.stat(file, context);
                    if (this.valid(file.path, rev) && treeGen === this.treeGen) {
                        this.sources.set(file.path, { stat, revision: rev, signal: context.signal });
                        this.dirty.delete(file.path);
                    }
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'NotAllowedError') throw error;
                    /* Transient IO failures are not cached. */
                }
            });
            context.signal.throwIfAborted();
            if (treeGen !== this.treeGen) { for (const path of wanted) this.requested.add(path); continue; }
            const admitted = this.admit();
            for (const file of eligible) {
                if (!wanted.has(file.path) || !admitted.has(file.path)) continue;
                const source = this.sources.get(file.path);
                if (!source || !this.valid(file.path, source.revision)) continue;
                const old = this.entries.get(file.path);
                if (old && old.mtime === source.stat.mtime && old.size === source.stat.size) continue;
                this.entries.delete(file.path);
                try {
                    let text = await this.persisted(file.path, source.stat.mtime, source.stat.size);
                    const fromDisk = text === undefined;
                    if (fromDisk) {
                        const bytes = await source.stat.bytes();
                        try { text = decodeDocumentText(bytes).replace(/\r\n?/g, '\n'); }
                        catch { /* Deterministic refusal is cached against this stat. */ }
                    }
                    if (this.valid(file.path, source.revision) && treeGen === this.treeGen && this.sources.get(file.path) === source) {
                        this.entries.set(file.path, { mtime: source.stat.mtime, size: source.stat.size, text });
                        const stillAdmitted = this.admit().has(file.path);
                        if (fromDisk && text !== undefined && stillAdmitted) this.persist(file.path, source.stat.mtime, source.stat.size, text);
                    }
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'NotAllowedError') throw error;
                    /* Retry on a later request. */
                }
                await context.slice();
            }
        }
        if (this.disposed || !this.current()) throw new DOMException('Index disposed', 'AbortError');
    }
}
