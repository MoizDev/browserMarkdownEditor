import { boardMediaRefs } from '../../utils/boardMediaRefs';
import { isCanvasFile } from '../../utils/fileTypes';
import { Limiter } from '../../utils/pool';
import type { IndexBoardMedia, IndexFile, IndexMediaFacts, IndexMediaSnapshot } from '../../utils/vaultIndex/types';
import type { IndexReader } from './reader';

interface MediaFact extends IndexBoardMedia { signature: string }

function folderOf(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash < 0 ? '' : path.slice(0, slash);
}

/** Closed-board facts are advisory; a failed or superseded scan never authorizes retirement. */
export class BoardMediaIndex {
    private readonly limiter = new Limiter(2);
    private readonly facts = new Map<string, MediaFact>();
    private readonly listeners = new Set<() => void>();
    private files: IndexFile[] = [];
    private listedFolders = new Set<string>();
    private complete = false;
    private epoch = 0;
    private disposed = false;

    constructor(private readonly reader: IndexReader) {}

    private notify() {
        for (const listener of [...this.listeners]) {
            try { listener(); } catch (error) { console.error('Board media subscriber failed:', error); }
        }
    }

    async reconcile(files: readonly IndexFile[], assetNames: ReadonlyMap<string, readonly string[]>): Promise<void> {
        if (this.disposed) return;
        const epoch = ++this.epoch;
        this.complete = false;
        this.listedFolders = new Set(assetNames.keys());
        this.files = files.filter(file => isCanvasFile(file.path)).map(file => ({ ...file }));
        const boards = this.files;
        const paths = new Set(boards.map(file => file.path));
        for (const path of this.facts.keys()) if (!paths.has(path)) this.facts.delete(path);
        const listings = new Map<string, { names: Set<string>; signature: string }>();
        for (const file of boards) {
            const folder = folderOf(file.path);
            if (!listings.has(folder) && assetNames.has(folder)) {
                const names = new Set(assetNames.get(folder)!);
                listings.set(folder, { names, signature: JSON.stringify([...names].sort()) });
            }
        }
        this.notify();
        let next = 0;
        const worker = async () => {
            while (epoch === this.epoch && !this.disposed && next < boards.length) {
                const file = boards[next++];
                const listing = listings.get(folderOf(file.path));
                if (!listing) { this.facts.delete(file.path); continue; }
                await this.limiter.run(async () => {
                    if (epoch !== this.epoch || this.disposed) return;
                    try {
                        const stat = await this.reader.stat(file);
                        if (epoch !== this.epoch || this.disposed) return;
                        const previous = this.facts.get(file.path);
                        if (previous && previous.mtime === stat.mtime && previous.size === stat.size
                            && previous.signature === listing.signature) return;
                        const result = await boardMediaRefs(stat.stream(), listing.names);
                        if (epoch !== this.epoch || this.disposed) return;
                        if (result.ok) this.facts.set(file.path, { path: file.path, mtime: stat.mtime, size: stat.size,
                            names: result.names, signature: listing.signature });
                        else this.facts.delete(file.path);
                    } catch {
                        if (epoch === this.epoch && !this.disposed) this.facts.delete(file.path);
                    }
                });
            }
        };
        await Promise.all(Array.from({ length: Math.min(2, boards.length) }, worker));
        if (epoch !== this.epoch || this.disposed) return;
        this.complete = true;
        this.notify();
    }

    dump(): Record<string, IndexMediaFacts> {
        return Object.fromEntries([...this.facts].map(([path, fact]) => [path, {
            mtime: fact.mtime, size: fact.size, signature: fact.signature,
            listingKey: fact.signature, names: [...fact.names],
        }]));
    }

    restore(facts: Record<string, IndexMediaFacts>): void {
        if (this.disposed) return;
        this.epoch++;
        this.complete = false;
        this.facts.clear();
        for (const [path, fact] of Object.entries(facts)) {
            if (!isCanvasFile(path) || !fact || !Number.isFinite(fact.mtime) || !Number.isFinite(fact.size)
                || fact.size < 0 || typeof fact.listingKey !== 'string' || !Array.isArray(fact.names)
                || !fact.names.every(name => typeof name === 'string')) continue;
            this.facts.set(path, { path, mtime: fact.mtime, size: fact.size,
                signature: fact.listingKey, names: [...fact.names] });
        }
        this.notify();
    }

    invalidate(paths?: readonly string[]): void {
        if (this.disposed) return;
        this.epoch++;
        this.complete = false;
        if (paths) for (const path of paths) this.facts.delete(path);
        else this.facts.clear();
        this.notify();
    }

    snapshot(folder: string): IndexMediaSnapshot {
        const files = this.files.filter(file => folderOf(file.path) === folder);
        const boards: IndexBoardMedia[] = [];
        for (const file of files) {
            const fact = this.facts.get(file.path);
            if (fact) boards.push({ path: fact.path, mtime: fact.mtime, size: fact.size, names: [...fact.names] });
        }
        return { folder, fresh: !this.disposed && this.complete && this.listedFolders.has(folder) && boards.length === files.length, boards };
    }

    subscribe(listener: () => void): () => void {
        if (this.disposed) return () => {};
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    dispose(): void {
        this.disposed = true;
        this.epoch++;
        this.complete = false;
        this.files = [];
        this.listedFolders.clear();
        this.facts.clear();
        this.listeners.clear();
    }
}
