import { createWorkerClient } from '../../platform/workers';
import type { WorkerClient } from '../../platform/workers';
import type { IndexGraph, IndexSession } from '../../utils/vaultIndex/types';

export interface IndexTreeFile { path: string; kind: string; handle: FileSystemFileHandle }
export interface IndexTreeDelta {
    added: IndexTreeFile[];
    removed: string[];
    renamed: { from: string; to: string; kind: string; handle: FileSystemFileHandle }[];
    order?: string[];
}
const control = { priority: 1, cpu: 'light' } as const;
const background = { priority: 3 } as const;

/** One owner per vault activation; on worker recovery replay the latest tree. */
export class VaultIndexClient {
    private readonly worker: WorkerClient;
    private tree: IndexTreeFile[] = [];
    private treeGen = 0;
    private graphGen = 0;
    private disposed = false;
    private queue: Promise<void> = Promise.resolve();
    private sweeping?: Promise<void>;
    private sweepAgain = false;
    constructor(readonly session: IndexSession, onGraph: (graph: IndexGraph) => void,
        onProblem: (problem: unknown) => void, onStatus?: (status: unknown) => void) {
        this.worker = createWorkerClient({
            name: `vault-index-${session.sessionNo}`, protocol: 1,
            spawn: () => new Worker(new URL('./index.worker.ts', import.meta.url), { type: 'module' }),
            fileHandleOps: ['treeChunk', 'treeDelta'], events: ['graph', 'problem', 'status'], eventLimit: Infinity,
            onStart: async bootstrap => {
                this.graphGen = 0;
                await bootstrap.request('open', { session }, control);
                await this.sendTree(bootstrap, this.treeGen, this.tree);
                queueMicrotask(() => { if (!this.disposed) void this.sweep('open').catch(() => {}); });
            },
        });
        this.worker.on('graph', value => {
            const graph = value as IndexGraph;
            if (this.disposed || graph.session.sessionNo !== session.sessionNo || graph.session.vaultId !== session.vaultId
                || graph.graphGen <= this.graphGen || graph.treeGen !== this.treeGen) return;
            this.graphGen = graph.graphGen;
            onGraph(graph);
        });
        const currentEvent = (value: unknown) => {
            const event = value as { session?: IndexSession };
            return !this.disposed && event.session?.sessionNo === session.sessionNo && event.session.vaultId === session.vaultId;
        };
        this.worker.on('problem', value => { if (currentEvent(value)) onProblem(value); });
        this.worker.on('status', value => { if (currentEvent(value)) onStatus?.(value); });
    }
    private async sendTree(worker: WorkerClient, treeGen: number, files: readonly IndexTreeFile[]): Promise<void> {
        const session = this.session;
        await worker.request('treeBegin', { session, treeGen }, control);
        for (let i = 0; i < files.length; i += 2000) {
            await worker.request('treeChunk', { session, treeGen, files: files.slice(i, i + 2000) }, control);
            await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
        await worker.request('treeCommit', { session, treeGen }, control);
        void worker.request('graph', { session, stale: true }, background).catch(() => {});
    }
    private serial(work: () => Promise<void>): Promise<void> {
        const next = this.queue.catch(() => {}).then(() => this.disposed ? undefined : work());
        this.queue = next;
        return next;
    }
    setTree(files: IndexTreeFile[]): Promise<void> {
        this.tree = files;
        const treeGen = ++this.treeGen;
        return this.serial(() => this.sendTree(this.worker, treeGen, files));
    }
    treeDelta(delta: IndexTreeDelta): Promise<void> {
        const files = new Map(this.tree.map(file => [file.path, file]));
        for (const path of delta.removed) files.delete(path);
        for (const file of delta.renamed) { files.delete(file.from); files.set(file.to, { path: file.to, kind: file.kind, handle: file.handle }); }
        for (const file of delta.added) files.set(file.path, file);
        this.tree = delta.order ? delta.order.map(path => files.get(path)).filter((file): file is IndexTreeFile => !!file) : [...files.values()];
        const treeGen = ++this.treeGen;
        return this.serial(async () => {
            await this.worker.request('treeDelta', { session: this.session, treeGen, ...delta }, control);
            void this.worker.request('graph', { session: this.session, stale: true }, background).catch(() => {});
            const changed = [...delta.added.map(file => file.path), ...delta.renamed.map(file => file.to)];
            if (changed.length) void this.invalidate(changed).catch(() => {});
        });
    }
    prime(path: string, mtime: number, size: number, text: string): Promise<void> {
        return this.serial(async () => {
            const rev = await this.worker.request<number | null>('primeReserve', { session: this.session, path, mtime, size, text }, control);
            if (rev !== null) void this.worker.request('primeCommit', { session: this.session, path, rev }, background).catch(() => {});
        });
    }
    sweep(reason: 'open' | 'rescan' | 'poll' | 'user'): Promise<void> {
        if (this.sweeping) {
            this.sweepAgain = true;
            return this.sweeping.then(() => {});
        }
        const run = async () => {
            await this.queue;
            let start = 0, treeGen = this.treeGen;
            while (!this.disposed) {
                this.sweepAgain = false;
                const batch = await this.worker.request<{ next: number; treeGen: number; done: boolean } | null>(
                    'sweepBatch', { session: this.session, start, treeGen, reason }, background);
                if (!batch) return;
                if (this.sweepAgain) { start = 0; treeGen = this.treeGen; continue; }
                if (batch.done) return;
                start = batch.next;
                treeGen = batch.treeGen;
            }
        };
        const result = run().finally(() => { if (this.sweeping === result) this.sweeping = undefined; });
        this.sweeping = result;
        return result;
    }
    async invalidate(paths: string[]): Promise<void> {
        await this.queue;
        await this.worker.request('invalidate', { session: this.session, paths }, background);
    }
    async foregroundIO(active: number): Promise<void> {
        await this.worker.request('fgio', { session: this.session, active }, control);
    }
    retry(): void {
        this.worker.reset();
        void this.sweep('user').catch(() => {});
    }
    dispose(): void { this.disposed = true; this.worker.dispose(); }
}
