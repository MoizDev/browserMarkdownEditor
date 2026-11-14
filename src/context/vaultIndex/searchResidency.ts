import { decodeDocumentText } from '../../utils/diskVersion';
import { isTextFile } from '../../utils/vaultSearch';
import { isCanvasFile } from '../../utils/fileTypes';
import { mapPool } from '../../utils/pool';
import type { IndexFile } from '../../utils/vaultIndex/types';
import type { IndexReader, IndexStat } from './reader';

const FILE_LIMIT = 4 * 1024 * 1024;
const SOURCE_BYTES_LIMIT = 128 * 1024 * 1024;

type TextEntry = { mtime: number; size: number; text?: string };
type Source = { stat: IndexStat; revision: number };

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
    private fullStat = false;
    private disposed = false;

    constructor(private readonly reader: IndexReader, private readonly current: () => boolean,
        private readonly persisted: (path: string, mtime: number, size: number) => Promise<string | undefined>) {}
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
        for (const path of paths) { this.advance(path); this.sources.delete(path); this.entries.delete(path); }
    }
    prime(path: string, mtime: number, size: number, text: string) {
        this.advance(path);
        this.sources.set(path, { revision: this.rev(path), stat: { mtime, size, bytes: async () => new TextEncoder().encode(text).buffer } });
        this.entries.set(path, { mtime, size, text: size <= FILE_LIMIT ? text.replace(/\r\n?/g, '\n') : undefined });
        this.admit();
    }
    dispose() { this.disposed = true; this.entries.clear(); this.sources.clear(); this.requested.clear(); }
    snapshot(): ReadonlyMap<string, TextEntry> { return this.entries; }
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
    async ensure(paths: readonly string[], onProgress?: () => Promise<void>): Promise<void> {
        for (const path of paths) this.requested.add(path);
        if (this.runner) { await this.runner; if (this.fullStat || paths.some(path => this.requested.has(path))) return this.ensure(paths, onProgress); return; }
        const run = this.run(onProgress);
        this.runner = run;
        try { await run; } finally { if (this.runner === run) this.runner = undefined; }
    }
    private async run(onProgress?: () => Promise<void>) {
        while (!this.disposed && this.current() && (this.fullStat || this.requested.size)) {
            const treeGen = this.treeGen;
            const wanted = new Set(this.requested);
            this.requested.clear();
            const full = this.fullStat;
            this.fullStat = false;
            const eligible = this.files.filter(file => isTextFile(file.path) && !isCanvasFile(file.path));
            const stats = full ? eligible : eligible.filter(file => wanted.has(file.path) && !this.sources.has(file.path));
            await mapPool(stats, async file => {
                const rev = this.rev(file.path);
                try {
                    const stat = await this.reader.stat(file);
                    if (this.valid(file.path, rev) && treeGen === this.treeGen) this.sources.set(file.path, { stat, revision: rev });
                } catch { /* Transient IO failures are not cached. */ }
            });
            if (treeGen !== this.treeGen) continue;
            const admitted = this.admit();
            for (const file of eligible) {
                if (!wanted.has(file.path) || !admitted.has(file.path)) continue;
                const source = this.sources.get(file.path);
                if (!source || !this.valid(file.path, source.revision)) continue;
                const old = this.entries.get(file.path);
                if (old && old.mtime === source.stat.mtime && old.size === source.stat.size) continue;
                try {
                    let text = await this.persisted(file.path, source.stat.mtime, source.stat.size);
                    if (text === undefined) {
                        const bytes = await source.stat.bytes();
                        try { text = decodeDocumentText(bytes).replace(/\r\n?/g, '\n'); }
                        catch { /* Deterministic refusal is cached against this stat. */ }
                    }
                    if (this.valid(file.path, source.revision) && treeGen === this.treeGen && this.sources.get(file.path) === source)
                        this.entries.set(file.path, { mtime: source.stat.mtime, size: source.stat.size, text });
                } catch { /* Retry on a later request. */ }
                await onProgress?.();
            }
        }
        if (this.disposed || !this.current()) throw new DOMException('Index disposed', 'AbortError');
    }
}
