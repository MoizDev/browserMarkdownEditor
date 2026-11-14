import { createWorkerClient, type WorkerClient } from '../../platform/workers';
import { validBox } from '../geom/bounds';
import { boardEnvelope, matchingIdentity, validBoardIdentity, type BoardJobIdentity } from '../workers/protocol';
import { SceneColumns } from './columns';
import { HybridIndex, PackedTree, type PackedSnapshot, type PackedTreeData } from './index';

let nextRebuild = 0;
type Phase = 'idle' | 'count' | 'copy' | 'waiting' | 'ready' | 'cleanup';

/** Builds from per-entry versioned snapshots; newer edits remain in HybridIndex's overlay. */
export class ScenePackedRebuild {
    private readonly client: WorkerClient;
    private phase: Phase = 'idle';
    private cursor = 0;
    private highWater = 0;
    private count = 0;
    private slots: Uint32Array | undefined;
    private generations: Uint32Array | undefined;
    private versions: Uint32Array | undefined;
    private bounds: Float64Array | undefined;
    private ready: PackedTree | undefined;
    private controller: AbortController | undefined;
    private external: AbortSignal | undefined;
    private externalAbort: (() => void) | undefined;
    private disposed = false;
    private sequence = 0;

    constructor(private readonly index: HybridIndex, private readonly columns: SceneColumns,
        private readonly unbounded: ReadonlySet<number>, private readonly identity: { session: string; epoch: number },
        private readonly onError: (error: unknown) => void, private readonly onReady?: () => void) {
        if (!validBoardIdentity({ ...identity, revision: 0 })) throw new TypeError('Invalid scene worker identity');
        this.client = createWorkerClient({ name: `scene-packed-${++nextRebuild}`, protocol: 1,
            spawn: () => new Worker(new URL('../workers/geometry.worker.ts', import.meta.url), { type: 'module' }) });
    }
    private clear(): void {
        if (this.external && this.externalAbort) this.external.removeEventListener('abort', this.externalAbort);
        this.external = undefined; this.externalAbort = undefined; this.controller = undefined;
        this.slots = undefined; this.generations = undefined; this.versions = undefined; this.bounds = undefined; this.ready = undefined;
        this.phase = 'idle';
    }
    private report(error: unknown): void {
        try { this.onError(error); } catch { /* a reporting callback cannot reject a worker promise */ }
    }
    private wake(): void {
        try { this.onReady?.(); } catch (error) { this.report(error); }
    }
    private fail(error: unknown): void {
        this.sequence++;
        this.controller?.abort();
        this.clear();
        this.report(error); this.wake();
    }
    start(signal?: AbortSignal): void {
        if (this.disposed) throw new Error('Scene rebuild is disposed');
        if (this.phase !== 'idle') throw new Error('Scene rebuild is already active');
        if (signal?.aborted) { this.fail(signal.reason ?? new DOMException('Scene rebuild cancelled', 'AbortError')); return; }
        this.sequence++;
        this.controller = new AbortController();
        this.external = signal;
        this.externalAbort = () => this.fail(signal?.reason ?? new DOMException('Scene rebuild cancelled', 'AbortError'));
        signal?.addEventListener('abort', this.externalAbort, { once: true });
        this.cursor = 0; this.count = 0; this.highWater = this.index.highWater; this.phase = 'count';
    }
    private eligible(slot: number): boolean {
        return this.index.hasBounds(slot) && !this.unbounded.has(slot);
    }
    private send(): void {
        const revision = this.index.epoch, identity: BoardJobIdentity = { ...this.identity, revision };
        const snapshot: PackedSnapshot = { revision, slots: this.slots!.subarray(0, this.count),
            generations: this.generations!.subarray(0, this.count), versions: this.versions!.subarray(0, this.count),
            bounds: this.bounds!.subarray(0, this.count * 4) };
        const transfer: Transferable[] = [snapshot.slots.buffer as ArrayBuffer, snapshot.generations.buffer as ArrayBuffer,
            snapshot.versions.buffer as ArrayBuffer, snapshot.bounds.buffer as ArrayBuffer];
        this.slots = undefined; this.generations = undefined; this.versions = undefined; this.bounds = undefined;
        const sequence = this.sequence, count = this.count;
        this.phase = 'waiting';
        void this.client.request<unknown>('buildPacked', { identity, payload: snapshot }, {
            priority: 2, signal: this.controller!.signal, transfer, deadlineMs: 120_000, terminateOnDeadline: true,
        }).then(reply => {
            if (this.disposed || sequence !== this.sequence) return;
            if (!boardEnvelope(reply) || !matchingIdentity(identity, reply.identity)) throw new TypeError('Invalid packed scene reply identity');
            const data = reply.payload as PackedTreeData;
            if (!data || !(data.slots instanceof Uint32Array) || !(data.generations instanceof Uint32Array)
                || !(data.versions instanceof Uint32Array) || !(data.bounds instanceof Float64Array)
                || !(data.membership instanceof Uint32Array) || !(data.starts instanceof Uint32Array) || !(data.counts instanceof Uint8Array)
                || data.count !== count || data.revision !== revision || data.membership.length > Math.ceil(this.highWater / 32)) {
                throw new TypeError('Invalid packed scene reply');
            }
            this.ready = PackedTree.fromData(data);
            this.phase = 'ready';
            this.wake();
        }).catch(error => { if (!this.disposed && sequence === this.sequence) this.fail(error); });
    }
    step(maxWork: number): 'idle' | 'pending' | 'complete' {
        if (!Number.isSafeInteger(maxWork) || maxWork <= 0) throw new RangeError('Invalid scene rebuild slice');
        if (this.disposed || this.phase === 'idle') return 'idle';
        try {
            if (this.phase === 'count') {
                let work = 0;
                while (this.cursor < this.highWater && work++ < maxWork) {
                    if (this.eligible(this.cursor++)) this.count++;
                }
                if (this.cursor === this.highWater) {
                    // Slots may become bounded between passes. Reserve by high-water,
                    // not the first count, so unchanged late entries are never omitted.
                    this.slots = new Uint32Array(this.highWater); this.generations = new Uint32Array(this.highWater);
                    this.versions = new Uint32Array(this.highWater); this.bounds = new Float64Array(this.highWater * 4);
                    this.cursor = 0; this.count = 0; this.phase = 'copy';
                }
                return 'pending';
            }
            if (this.phase === 'copy') {
                let work = 0;
                while (this.cursor < this.highWater && work++ < maxWork) {
                    const slot = this.cursor++;
                    if (!this.eligible(slot)) continue;
                    const offset = slot * 4;
                    if (!validBox(this.columns.hit, offset)) throw new RangeError('Invalid scene hit bounds');
                    const out = this.count++;
                    this.slots![out] = slot; this.generations![out] = this.index.generation(slot); this.versions![out] = this.index.version(slot);
                    for (let i = 0; i < 4; i++) this.bounds![out * 4 + i] = this.columns.hit[offset + i];
                }
                if (this.cursor === this.highWater) this.send();
                return 'pending';
            }
            if (this.phase === 'waiting') return 'pending';
            if (this.phase === 'ready') {
                if (this.ready!.revision < this.index.packed.revision || this.ready!.revision > this.index.epoch) throw new Error('Packed scene snapshot is stale');
                if (!this.index.publish(this.ready!)) return 'pending';
                this.ready = undefined; this.phase = 'cleanup';
            }
            if (this.phase === 'cleanup') {
                if (!this.index.cleanupStep(maxWork)) return 'pending';
                this.clear(); return 'complete';
            }
        } catch (error) { this.fail(error); }
        return 'idle';
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true; this.sequence++;
        this.controller?.abort(); this.clear(); this.client.dispose();
    }
}
