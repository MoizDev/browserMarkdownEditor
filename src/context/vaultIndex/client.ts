import { createWorkerClient } from '../../platform/workers';
import type { WorkerClient } from '../../platform/workers';
import type { IndexGraph, IndexSession } from '../../utils/vaultIndex/types';
import { observeForegroundReads } from './foreground';
import { newIndexSession } from './session';
import type { SearchBatch } from '../../utils/searchController';
import type { MatchAnswer } from '../../utils/agentMatcher/types';

export interface SearchBuffer { path: string; revision: number; text: string }
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
    private readonly stopForeground: () => void;
    private tree: IndexTreeFile[] = [];
    private treeGen = 0;
    private graphGen = 0;
    private graphEpoch = 0;
    get publicationEpoch(): number { return this.graphEpoch; }
    private disposed = false;
    private queue: Promise<void> = Promise.resolve();
    private sweeping?: Promise<void>;
    private sweepAgain = false;
    private started = false;
    private nextQuery = 0;
    private nextOverlay = 0;
    private overlays = new Map<string, { revision: number; rev: number; text: string }>();
    private resultListeners = new Map<number, (batch: SearchBatch) => void>();
    constructor(public session: IndexSession, onGraph: (graph: IndexGraph) => void,
        private readonly onProblem: (problem: unknown) => void, onStatus?: (status: unknown) => void,
        onTimes?: (changes: [string, number, number][], sweepComplete: boolean) => void) {
        this.worker = createWorkerClient({
            name: `vault-index-${session.sessionNo}`, protocol: 1,
            spawn: () => new Worker(new URL('./index.worker.ts', import.meta.url), { type: 'module' }),
            fileHandleOps: ['treeChunk', 'treeDelta'], events: ['graph', 'problem', 'status', 'results', 'fileTimes'], eventLimit: Infinity,
            onStart: async bootstrap => {
                if (this.started) this.session = newIndexSession(this.session.vaultId);
                this.started = true;
                const session = this.session;
                this.graphGen = 0;
                this.graphEpoch++;
                await bootstrap.request('open', { session }, control);
                await this.sendTree(bootstrap, this.treeGen, this.tree);
                for (const [path, value] of this.overlays) await bootstrap.request('overlay', { session, path, rev: value.rev, text: value.text }, control);
                queueMicrotask(() => { if (!this.disposed) void this.sweep('open').catch(() => {}); });
            },
        });
        this.worker.on('graph', value => {
            const graph = value as IndexGraph;
            if (this.disposed || graph.session.sessionNo !== this.session.sessionNo || graph.session.vaultId !== this.session.vaultId
                || graph.graphGen <= this.graphGen || graph.treeGen !== this.treeGen) return;
            this.graphGen = graph.graphGen;
            onGraph(graph);
        });
        const currentEvent = (value: unknown) => {
            const event = value as { session?: IndexSession };
            return !this.disposed && event.session?.sessionNo === this.session.sessionNo && event.session.vaultId === this.session.vaultId;
        };
        this.worker.on('results', value => {
            const batch = value as SearchBatch;
            if (currentEvent(value)) this.resultListeners.get(batch.queryId)?.(batch);
        });
        this.worker.on('fileTimes', value => {
            if (!currentEvent(value)) return;
            const event = value as { changes: [string, number, number][]; sweepComplete: boolean };
            onTimes?.(event.changes, event.sweepComplete);
        });
        this.worker.on('problem', value => { if (currentEvent(value)) this.onProblem(value); });
        this.worker.on('status', value => { if (currentEvent(value)) onStatus?.(value); });
        this.stopForeground = observeForegroundReads(active => { void this.foregroundIO(active).catch(() => {}); });
    }
    acceptsGraph(graphGen: number, treeGen: number, epoch: number): boolean {
        return !this.disposed && epoch === this.publicationEpoch && graphGen === this.graphGen && treeGen === this.treeGen;
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
    primeText(path: string, mtime: number, size: number, text: string): Promise<void> {
        return this.serial(async () => { await this.worker.request('primeText', { session: this.session, path, mtime, size, text }, control); });
    }
    sweep(reason: 'open' | 'rescan' | 'poll' | 'user'): Promise<void> {
        if (this.sweeping) {
            this.sweepAgain = true;
            return this.sweeping.then(() => {});
        }
        const run = async () => {
            await this.queue.catch(() => {});
            let start = 0, treeGen = this.treeGen;
            while (!this.disposed) {
                this.sweepAgain = false;
                let batch: { next: number; treeGen: number; done: boolean } | null;
                try {
                    batch = await this.worker.request<typeof batch>(
                        'sweepBatch', { session: this.session, start, treeGen, reason }, background);
                } catch (error) {
                    // A newer request must not inherit the failure of the one it superseded.
                    if (this.sweepAgain && !this.disposed) { start = 0; treeGen = this.treeGen; continue; }
                    throw error;
                }
                if (!batch) {
                    if (this.sweepAgain && !this.disposed) { start = 0; treeGen = this.treeGen; continue; }
                    return;
                }
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
        await this.queue.catch(() => {});
        await this.worker.request('invalidate', { session: this.session, paths }, background);
    }
    async foregroundIO(active: number): Promise<void> {
        await this.worker.request('fgio', { session: this.session, active }, control);
    }
    private async syncOverlays(buffers: readonly SearchBuffer[]): Promise<void> {
        await this.serial(async () => {
            const incoming = new Map(buffers.map(buffer => [buffer.path, buffer]));
            for (const path of this.overlays.keys()) if (!incoming.has(path)) {
                this.overlays.delete(path);
                await this.worker.request('overlay', { session: this.session, path, rev: ++this.nextOverlay, text: null }, control);
            }
            for (const buffer of buffers) {
                const previous = this.overlays.get(buffer.path);
                if (previous && previous.revision === buffer.revision && previous.text === buffer.text) continue;
                const value = { revision: buffer.revision, rev: ++this.nextOverlay, text: buffer.text };
                this.overlays.set(buffer.path, value);
                await this.worker.request('overlay', { session: this.session, path: buffer.path, rev: value.rev, text: value.text }, control);
            }
        });
    }
    dropOverlay(path: string): Promise<void> {
        return this.serial(async () => {
            if (!this.overlays.has(path)) return;
            this.overlays.delete(path);
            await this.worker.request('overlay', { session: this.session, path, rev: ++this.nextOverlay, text: null }, control);
        });
    }
    async searchSidebar(query: string, buffers: readonly SearchBuffer[], onBatch: (batch: SearchBatch) => void, signal: AbortSignal): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            if (signal.aborted || this.disposed) throw new DOMException('Search cancelled', 'AbortError');
            const queryId = ++this.nextQuery;
            try {
                await this.syncOverlays(buffers);
                await this.worker.request('ready', {}, { priority: 1, signal });
                this.resultListeners.set(queryId, onBatch);
                await this.worker.request('search', { session: this.session, queryId, kind: 'sidebar', query }, { priority: 1, signal });
                return;
            } catch (error) {
                if (error instanceof Error && error.name === 'NotAllowedError') this.onProblem({ session: this.session, kind: 'permission', detail: error.message });
                if (attempt || signal.aborted || !(error instanceof Error) || error.name !== 'WorkerCrashed') throw error;
                onBatch({ session: this.session, queryId, overlayRevs: {}, batch: [], done: false, clipped: false, matchCount: 0, reset: true });
            } finally { this.resultListeners.delete(queryId); }
        }
    }
    async searchAgent(config: { query: string; regex: boolean; caseSensitive: boolean; scope: string; maxResults: number },
        buffers: readonly SearchBuffer[], signal?: AbortSignal): Promise<MatchAnswer> {
        await this.syncOverlays(buffers);
        await this.worker.request('ready', {}, { priority: 1, signal });
        try {
            return await this.worker.request<MatchAnswer>('search', { session: this.session, queryId: ++this.nextQuery, kind: 'agent', ...config }, { priority: 1, signal });
        } catch (error) {
            if (error instanceof Error && error.name === 'NotAllowedError') this.onProblem({ session: this.session, kind: 'permission', detail: error.message });
            throw error;
        }
    }
    retry(): void {
        this.worker.reset();
        void this.sweep('user').catch(() => {});
    }
    dispose(): void { this.disposed = true; this.stopForeground(); this.worker.dispose(); }
}
