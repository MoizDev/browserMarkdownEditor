import { mapPool } from './pool';
import type { FileTreeFileNode } from '../types';

export interface IndexVersion { lastModified: number; size: number }
export interface IndexSource {
    version: IndexVersion;
    /** Undefined is a deterministic text refusal; transient failures throw. */
    read(): Promise<string | undefined>;
}
export interface IndexEntry {
    version: IndexVersion;
    text?: string;
    revision: number;
}

const FILE_LIMIT = 4 * 1024 * 1024;
const SOURCE_BYTES_LIMIT = 128 * 1024 * 1024;

/** One activation, not one stored vault id. All filesystem access is injected. */
export class VaultIndexSession {
    readonly sessionId = Symbol('vault-index-session');
    generation = 0;
    treeRevision = 0;
    requestedGeneration = 0;
    completedGeneration = 0;
    readonly dirtyPaths = new Set<string>();
    readonly entries = new Map<string, IndexEntry>();
    private revisions = new Map<string, number>();
    private nodes: FileTreeFileNode[] | null = null;
    private metadata = new Map<string, IndexSource>();
    private fullPass = false;
    private runner: Promise<void> | null = null;
    private listeners = new Set<() => void>();
    private storeRevision = 0;
    private disposed = false;

    constructor(private readonly stat: (node: FileTreeFileNode) => Promise<IndexSource>) {}

    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    getRevision = () => this.storeRevision;
    private publish() { this.storeRevision++; for (const listener of this.listeners) listener(); }
    private bump(path: string) { const rev = (this.revisions.get(path) ?? 0) + 1; this.revisions.set(path, rev); return rev; }
    private current(path: string, generation: number, revision: number) {
        return !this.disposed && this.generation === generation && (this.revisions.get(path) ?? 0) === revision;
    }
    snapshot(): Map<string, string> {
        const result = new Map<string, string>();
        for (const [path, entry] of this.entries) if (entry.text !== undefined) result.set(path, entry.text);
        return result;
    }
    requestSync(nodes: FileTreeFileNode[]): Promise<void> {
        if (this.disposed) return Promise.reject(new DOMException('Index disposed', 'AbortError'));
        if (this.nodes !== nodes) {
            this.nodes = nodes;
            this.treeRevision++;
            this.fullPass = true;
            this.requestedGeneration++;
            const paths = new Set(nodes.map(node => node.path));
            for (const path of this.revisions.keys()) if (!paths.has(path)) this.bump(path);
        }
        return this.start();
    }
    invalidate(path: string) {
        if (this.disposed) return;
        this.bump(path);
        this.dirtyPaths.add(path);
        this.requestedGeneration++;
        if (this.nodes) void this.start().catch(() => {});
    }
    revalidate() {
        if (this.disposed) return;
        this.fullPass = true;
        this.requestedGeneration++;
        if (this.nodes) void this.start().catch(() => {});
    }
    remove(path: string) {
        this.bump(path);
        this.entries.delete(path);
        this.metadata.delete(path);
        this.dirtyPaths.delete(path);
        this.publish();
    }
    retarget(from: string, to: string) { this.remove(from); this.invalidate(to); }
    primeWritten(path: string, version: IndexVersion, text: string, _documentRevision: number) {
        if (this.disposed) return;
        const revision = this.bump(path);
        // A primed source has the same immutable bytes as the completed write.
        this.metadata.set(path, { version, read: async () => text });
        this.entries.set(path, { version, text: version.size <= FILE_LIMIT ? text.replace(/\r\n?/g, '\n') : undefined, revision });
        if (this.nodes) this.admit();
        this.publish();
    }
    dispose() {
        this.disposed = true;
        this.generation++;
        this.entries.clear(); this.metadata.clear(); this.dirtyPaths.clear();
        this.publish();
    }
    private admit(): Set<string> {
        const admitted = new Set<string>();
        let sourceBytes = 0;
        for (const node of this.nodes ?? []) {
            const source = this.metadata.get(node.path);
            if (!source || source.version.size > FILE_LIMIT || sourceBytes + source.version.size > SOURCE_BYTES_LIMIT) continue;
            sourceBytes += source.version.size;
            admitted.add(node.path);
        }
        for (const path of this.entries.keys()) if (!admitted.has(path)) this.entries.delete(path);
        return admitted;
    }
    private start(): Promise<void> {
        if (this.runner) return this.runner;
        const run = this.run();
        this.runner = run;
        void run.finally(() => { if (this.runner === run) this.runner = null; }).catch(() => {});
        return run;
    }
    private async run() {
        while (!this.disposed && this.completedGeneration < this.requestedGeneration) {
            const target = this.requestedGeneration;
            const generation = this.generation;
            const treeRevision = this.treeRevision;
            const nodes = this.nodes ?? [];
            const full = this.fullPass;
            const dirty = new Set(this.dirtyPaths);
            this.fullPass = false;
            this.dirtyPaths.clear();
            const selected = full ? nodes : nodes.filter(node => dirty.has(node.path));
            await mapPool(selected, async node => {
                const revision = this.revisions.get(node.path) ?? 0;
                try {
                    const source = await this.stat(node);
                    if (this.current(node.path, generation, revision)) this.metadata.set(node.path, source);
                } catch {
                    if (this.current(node.path, generation, revision)) { this.metadata.delete(node.path); this.entries.delete(node.path); }
                }
            });
            if (this.disposed || this.generation !== generation) throw new DOMException('Index disposed', 'AbortError');
            if (treeRevision !== this.treeRevision) continue;
            if (full) {
                const paths = new Set(nodes.map(node => node.path));
                for (const path of this.metadata.keys()) if (!paths.has(path)) this.metadata.delete(path);
                for (const path of this.entries.keys()) if (!paths.has(path)) this.entries.delete(path);
            }
            const admitted = this.admit();
            await mapPool(nodes.filter(node => admitted.has(node.path)), async node => {
                const source = this.metadata.get(node.path);
                if (!source) return;
                const prev = this.entries.get(node.path);
                if (prev && prev.version.lastModified === source.version.lastModified && prev.version.size === source.version.size) return;
                const revision = this.revisions.get(node.path) ?? 0;
                try {
                    const text = await source.read();
                    if (this.current(node.path, generation, revision) && this.metadata.get(node.path) === source && this.treeRevision === treeRevision) {
                        this.entries.set(node.path, { version: source.version, text, revision });
                    }
                } catch { /* A transient error is retried on the next request. */ }
            });
            if (this.disposed || this.generation !== generation) throw new DOMException('Index disposed', 'AbortError');
            this.completedGeneration = target;
            this.publish();
        }
    }
}
