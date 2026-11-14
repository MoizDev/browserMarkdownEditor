import { decodeDocumentText } from '../../utils/diskVersion';
import { assembleGraph } from '../../utils/vaultIndex/graph';
import { noteFactsSliced } from '../../utils/vaultIndex/facts';
import type { IndexFile, IndexGraph, IndexSession } from '../../utils/vaultIndex/types';
import type { WorkerContext } from '../../platform/workers/serve';
import type { IndexReader } from './reader';
import { IndexStore } from './store';

/** One session's mutable index. IO is injected so handle cloning and path
 * resolution do not leak into graph assembly or its revision rules. */
export class IndexEngine {
    readonly store = new IndexStore();
    private graphGen = 0;
    private stopped = false;
    private foreground = 0;
    private ioActive = 0;
    private ioWaiters: (() => void)[] = [];
    private reportedTimes = new Map<string, number>();
    private changedTimes = new Map<string, [number, number]>();
    constructor(readonly session: IndexSession, private reader: IndexReader,
        private publish: (graph: IndexGraph) => void,
        private status: (phase: 'sweeping' | 'idle', done: number, total: number) => void,
        private onTimes?: (changes: [string, number, number][], sweepComplete: boolean) => void) {}

    close(): void {
        this.stopped = true;
        this.ioWaiters.splice(0).forEach(wake => wake());
    }
    foregroundIO(active: number): void {
        this.foreground = Math.max(0, active);
        if (!this.foreground) this.ioWaiters.splice(0).forEach(wake => wake());
    }
    async publishGraph(context: WorkerContext, stale = false): Promise<void> {
        if (this.stopped) return;
        const generation = ++this.graphGen;
        const graph = await assembleGraph(this.session, generation, this.store.treeGen,
            this.store.files, new Map(this.store.records), stale, () => context.slice());
        if (!this.stopped && !context.cancelled && generation === this.graphGen) this.publish(graph);
    }
    async prime(path: string, rev: number, mtime: number, size: number, text: string, context: WorkerContext): Promise<void> {
        if (this.stopped || this.store.revision(path) !== rev) return;
        try {
            const facts = await noteFactsSliced(text, () => context.slice());
            const result = !this.stopped && this.store.prime(path, rev, mtime, size, facts);
            if (result) this.store.releasePrime(path, rev);
            if (result === 'changed') await this.publishGraph(context);
        } finally { this.store.releasePrime(path, rev); }
    }
    private async acquireIO(context: WorkerContext): Promise<boolean> {
        while (!this.stopped && !context.cancelled) {
            if (!this.foreground && this.ioActive < 8) { this.ioActive++; return true; }
            await new Promise<void>(resolve => {
                const wake = () => {
                    clearInterval(timer);
                    context.signal.removeEventListener('abort', wake);
                    const index = this.ioWaiters.indexOf(wake);
                    if (index >= 0) this.ioWaiters.splice(index, 1);
                    resolve();
                };
                this.ioWaiters.push(wake);
                context.signal.addEventListener('abort', wake, { once: true });
                const timer = setInterval(() => context.heartbeat(), 1000);
                if (context.signal.aborted) wake();
            });
        }
        return false;
    }
    private releaseIO(): void {
        this.ioActive--;
        this.ioWaiters.splice(0).forEach(wake => wake());
    }
    private async read(file: IndexFile, context: WorkerContext): Promise<{ file: IndexFile; rev: number; mtime: number; size: number; bytes: ArrayBuffer } | undefined> {
        let held = await this.acquireIO(context);
        if (!held) return;
        const rev = this.store.revision(file.path);
        try {
            const startedAt = performance.timeOrigin + performance.now();
            const stat = await this.reader.stat(file);
            if (this.store.revision(file.path) === rev && this.reportedTimes.get(file.path) !== stat.mtime) {
                this.reportedTimes.set(file.path, stat.mtime);
                this.changedTimes.set(file.path, [stat.mtime, startedAt]);
            }
            const previous = this.store.records.get(file.path);
            if (previous && previous.mtime === stat.mtime && previous.size === stat.size) return;
            if (!/\.md$/i.test(file.path)) return;
            this.releaseIO();
            held = false;
            held = await this.acquireIO(context);
            if (!held) return;
            const bytes = await stat.bytes();
            return { file, rev, mtime: stat.mtime, size: stat.size, bytes };
        } catch (error) {
            // IO errors are transient, unlike a deterministic decode refusal.
            if (error instanceof DOMException && error.name === 'NotAllowedError') throw error;
        } finally { if (held) this.releaseIO(); }
    }
    async invalidate(paths: readonly string[], context: WorkerContext): Promise<void> {
        const wanted = new Set(paths);
        await this.runFiles(this.store.files.filter(file => wanted.has(file.path)), context);
        await this.publishGraph(context);
    }
    private async runFiles(files: readonly IndexFile[], context: WorkerContext): Promise<void> {
        for (let start = 0; start < files.length && !this.stopped && !context.cancelled; start += 8) {
            const reads = await Promise.all(files.slice(start, start + 8).map(file => this.read(file, context)));
            if (this.changedTimes.size) {
                this.onTimes?.([...this.changedTimes].map(([path, [mtime, startedAt]]) => [path, mtime, startedAt]), false);
                this.changedTimes.clear();
            }
            for (const read of reads) {
                if (!read || this.stopped || context.cancelled) continue;
                let text: string | null;
                try { text = decodeDocumentText(read.bytes).replace(/\r\n?/g, '\n'); }
                catch { text = null; }
                const facts = text === null ? null : await noteFactsSliced(text, () => context.slice());
                if (!this.stopped && !context.cancelled) this.store.commitRead(read.file, read.rev, read.mtime, read.size, facts);
                await context.slice();
            }
        }
    }
    async sweepBatch(start: number, treeGen: number, context: WorkerContext): Promise<{ next: number; treeGen: number; done: boolean }> {
        const currentGen = this.store.treeGen;
        if (treeGen !== currentGen) start = 0;
        const files = this.store.files;
        if (start === 0) {
            const live = new Set(files.map(file => file.path));
            for (const path of this.reportedTimes.keys()) if (!live.has(path)) this.reportedTimes.delete(path);
            this.status('sweeping', 0, files.length);
        }
        await this.runFiles(files.slice(start, start + 8), context);
        if (this.store.treeGen !== currentGen) return { next: 0, treeGen: this.store.treeGen, done: false };
        const next = Math.min(start + 8, files.length);
        if (next === files.length) {
            await this.publishGraph(context);
            if (this.store.treeGen !== currentGen) return { next: 0, treeGen: this.store.treeGen, done: false };
            if (!this.stopped) {
                this.onTimes?.([], true);
                this.status('idle', next, files.length);
            }
            return { next, treeGen: currentGen, done: true };
        }
        this.status('sweeping', next, files.length);
        return { next, treeGen: currentGen, done: false };
    }
}
