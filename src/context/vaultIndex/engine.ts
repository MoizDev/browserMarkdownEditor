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
    private sweeping = false;
    private rerun = false;
    private sweepWaiters: { resolve(): void; reject(error: unknown): void }[] = [];
    constructor(readonly session: IndexSession, private reader: IndexReader,
        private publish: (graph: IndexGraph) => void,
        private status: (phase: 'sweeping' | 'idle', done: number, total: number) => void) {}

    close(): void {
        this.stopped = true;
        this.ioWaiters.splice(0).forEach(wake => wake());
        this.sweepWaiters.splice(0).forEach(waiter => waiter.resolve());
    }
    foregroundIO(active: number): void {
        this.foreground = Math.max(0, active);
        if (!this.foreground) this.ioWaiters.splice(0).forEach(wake => wake());
    }
    publishGraph(stale = false): void {
        if (!this.stopped) this.publish(assembleGraph(this.session, ++this.graphGen,
            this.store.files, this.store.records, stale));
    }
    async prime(path: string, mtime: number, size: number, text: string, context: WorkerContext): Promise<void> {
        const rev = this.store.reservePrime(path);
        if (rev === undefined) return;
        try {
            const facts = await noteFactsSliced(text, () => context.slice());
            if (!this.stopped && this.store.prime(path, rev, mtime, size, facts)) this.publishGraph();
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
            const stat = await this.reader.stat(file);
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
        this.publishGraph();
    }
    private async runFiles(files: readonly IndexFile[], context: WorkerContext, interrupted = () => false,
        progress?: (done: number, total: number) => void): Promise<void> {
        for (let start = 0; start < files.length && !this.stopped && !context.cancelled && !interrupted(); start += 8) {
            const reads = await Promise.all(files.slice(start, start + 8).map(file => this.read(file, context)));
            for (const read of reads) {
                if (!read || this.stopped || context.cancelled) continue;
                let text: string | null;
                try { text = decodeDocumentText(read.bytes).replace(/\r\n?/g, '\n'); }
                catch { text = null; }
                const facts = text === null ? null : await noteFactsSliced(text, () => context.slice());
                if (!this.stopped && !context.cancelled) this.store.commitRead(read.file, read.rev, read.mtime, read.size, facts);
                await context.slice();
            }
            progress?.(Math.min(start + 8, files.length), files.length);
        }
    }
    async sweep(context: WorkerContext): Promise<void> {
        if (this.sweeping) {
            this.rerun = true;
            return new Promise<void>((resolve, reject) => this.sweepWaiters.push({ resolve, reject }));
        }
        this.sweeping = true;
        let completing: typeof this.sweepWaiters = [];
        try {
            do {
                this.rerun = false;
                completing = this.sweepWaiters.splice(0);
                const files = [...this.store.files];
                this.status('sweeping', 0, files.length);
                await this.runFiles(files, context, () => this.rerun,
                    (done, total) => this.status('sweeping', done, total));
                this.publishGraph();
                if (this.rerun) this.sweepWaiters.unshift(...completing);
                else completing.forEach(waiter => waiter.resolve());
                completing = [];
            } while (this.rerun && !this.stopped && !context.cancelled);
        } catch (error) {
            [...completing, ...this.sweepWaiters.splice(0)].forEach(waiter => waiter.reject(error));
            throw error;
        } finally {
            this.sweeping = false;
            if (!this.stopped) this.status('idle', this.store.files.length, this.store.files.length);
            this.sweepWaiters.splice(0).forEach(waiter => waiter.resolve());
        }
    }
}
