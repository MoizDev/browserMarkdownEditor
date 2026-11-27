import type { Rect } from '../../platform/types';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { PaintBoundsJob } from './paintBounds';
import type { PaintNode } from './paintStream';
import { paintNodeBytes } from './residentBytes';
import type { ScenePaintNodeStream } from './scenePaintStream';

const CHUNK = 64 * 1024;
export const PLAN_NODE_BUFFER_MAX_BYTES = 32 * 1024 * 1024;

const contains = (outer: Readonly<Rect>, inner: Readonly<Rect>) => inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
const intersects = (a: Readonly<Rect>, b: Readonly<Rect>) => a.x <= b.x + b.width && b.x <= a.x + a.width
    && a.y <= b.y + b.height && b.y <= a.y + a.height;

function meets(node: PaintNode, apron: Readonly<Rect>): boolean {
    for (const items of [node.underlay ?? [], node.content]) for (const item of items) {
        const job = new PaintBoundsJob(item);
        while (!job.step(64));
        const bounds = job.result;
        if (bounds && intersects(bounds, apron)) return true;
    }
    return false;
}

export interface PlanNodeBufferOptions {
    readonly world: Readonly<Rect>;
    readonly open: (world: Readonly<Rect>, signal: AbortSignal) => Promise<ScenePaintNodeStream>;
    readonly memory: MemoryAllocator;
    readonly maxBytes?: number;
}

export class PlanNodeBuffer {
    private readonly controller = new AbortController();
    private nodes: PaintNode[] = [];
    private readonly leases: ByteLease[] = [];
    private readonly maxBytes: number;
    private stream: ScenePaintNodeStream | null = null;
    private opening: Promise<ScenePaintNodeStream> | null = null;
    private pulling: Promise<unknown> = Promise.resolve();
    private owner: Reader | null = null;
    private bytes = 0;
    private leased = 0;
    private keeping = true;
    private ended = false;
    private broken = false;
    private disposed = false;

    constructor(private readonly options: PlanNodeBufferOptions) {
        this.maxBytes = options.maxBytes ?? PLAN_NODE_BUFFER_MAX_BYTES;
    }

    async serve(apron: Readonly<Rect>, signal: AbortSignal): Promise<ScenePaintNodeStream | null> {
        if (this.disposed || this.broken || !contains(this.options.world, apron)) return null;
        if (this.ended) return this.keeping && this.stream ? new Reader(this, this.stream, apron, signal, false) : null;
        if (this.owner) return null;
        let stream: ScenePaintNodeStream;
        try { stream = await this.ensureStream(); } catch { this.broken = true; return null; }
        // Another serve may have claimed the read while this one was opening it.
        if (this.disposed || this.broken || this.ended || this.owner) return null;
        const reader = new Reader(this, stream, apron, signal, true);
        this.owner = reader;
        return reader;
    }

    private ensureStream(): Promise<ScenePaintNodeStream> {
        if (this.stream) return Promise.resolve(this.stream);
        this.opening ??= this.options.open(this.options.world, this.controller.signal).then(stream => {
            this.stream = stream;
            return stream;
        });
        return this.opening;
    }

    /** The owner's next node from the shared stream. Reads are serialised: the stream admits one next() at a time. */
    pull(stream: ScenePaintNodeStream): Promise<PaintNode | null> {
        const next = this.pulling.then(() => stream.next());
        this.pulling = next.then(() => undefined, () => undefined);
        return next;
    }

    keep(node: PaintNode): void {
        if (!this.keeping) return;
        const needed = this.bytes + paintNodeBytes(node);
        if (needed > this.maxBytes) { this.shed(); return; }
        if (needed > this.leased) {
            const lease = this.options.memory.reserve(Math.max(CHUNK, needed - this.leased), { prefetch: true });
            if (!lease) { this.shed(); return; }
            this.leases.push(lease); this.leased += lease.bytes;
        }
        this.bytes = needed;
        this.nodes.push(node);
    }

    /** Stops keeping for good and returns every kept node's charge now; returns the bytes released. Later passes open their own
     * streams, as after a refusal. A pass already replaying keeps the list it started on (see snapshot) until it ends: the charge
     * goes now, as a retained source item keeps evicted geometry by reference, because the plan sheds this buffer to make room for
     * the very pass that may be replaying it, and a release deferred to that pass's end would wait on itself. */
    shed(): number {
        const freed = this.leased;
        this.keeping = false;
        this.nodes = [];
        this.bytes = 0;
        this.leased = 0;
        for (const lease of this.leases.splice(0)) this.options.memory.release(lease);
        return freed;
    }

    isKeeping(): boolean { return this.keeping; }
    get chargedBytes(): number { return this.leased; }
    count(): number { return this.nodes.length; }
    at(index: number): PaintNode { return this.nodes[index]!; }
    snapshot(): readonly PaintNode[] { return this.nodes; }

    finish(): void { this.ended = true; this.owner = null; }

    abandon(owner: Reader): Promise<void> {
        if (this.owner === owner) this.owner = null;
        if (this.ended) return Promise.resolve();
        this.broken = true;
        const stream = this.stream;
        this.stream = null;
        return stream ? this.pulling.then(() => stream.release()).catch(() => {}) : Promise.resolve();
    }

    dispose(): Promise<void> {
        if (this.disposed) return Promise.resolve();
        this.disposed = true; this.broken = true; this.owner = null;
        this.controller.abort();
        this.nodes = [];
        for (const lease of this.leases.splice(0)) this.options.memory.release(lease);
        this.leased = 0; this.bytes = 0;
        const stream = this.stream;
        this.stream = null;
        return stream ? this.pulling.then(() => stream.release()).catch(() => {}) : Promise.resolve();
    }

    static meets = meets;
}

class Reader implements ScenePaintNodeStream {
    private cursor = 0;
    private released = false;
    readonly token: ScenePaintNodeStream['token'];
    readonly theme: ScenePaintNodeStream['theme'];
    readonly sceneRevision: number;
    readonly sourceDoc: ScenePaintNodeStream['sourceDoc'];
    readonly sensitiveNodes: ScenePaintNodeStream['sensitiveNodes'];
    readonly sessionRasters: ScenePaintNodeStream['sessionRasters'];
    readonly rasterVariant: ScenePaintNodeStream['rasterVariant'];
    readonly sourceWorld: ScenePaintNodeStream['sourceWorld'];
    readonly regionChangesSince: ScenePaintNodeStream['regionChangesSince'];
    readonly changedNodesSince: ScenePaintNodeStream['changedNodesSince'];
    readonly sensitiveMayMeet: ScenePaintNodeStream['sensitiveMayMeet'];
    readonly mayPaint: ScenePaintNodeStream['mayPaint'];
    readonly occupiedRoot: ScenePaintNodeStream['occupiedRoot'];

    private readonly replay: readonly PaintNode[] | null;

    constructor(private readonly buffer: PlanNodeBuffer, private readonly source: ScenePaintNodeStream,
        private readonly apron: Readonly<Rect>, private readonly signal: AbortSignal, private readonly owns: boolean) {
        this.replay = owns ? null : buffer.snapshot();
        this.token = source.token; this.theme = source.theme; this.sceneRevision = source.sceneRevision; this.sourceDoc = source.sourceDoc;
        this.sensitiveNodes = source.sensitiveNodes; this.sessionRasters = source.sessionRasters; this.rasterVariant = source.rasterVariant;
        this.sourceWorld = source.sourceWorld; this.regionChangesSince = source.regionChangesSince;
        this.changedNodesSince = source.changedNodesSince;
        this.sensitiveMayMeet = source.sensitiveMayMeet; this.mayPaint = source.mayPaint; this.occupiedRoot = source.occupiedRoot;
    }

    isCurrent(): boolean { return !this.released && !this.signal.aborted && this.source.isCurrent(); }

    async next(): Promise<PaintNode | null> {
        if (this.released) return null;
        this.signal.throwIfAborted();
        for (;;) {
            if (this.replay) {
                if (this.cursor >= this.replay.length) return null;
                const node = this.replay[this.cursor++]!;
                if (PlanNodeBuffer.meets(node, this.apron)) return node;
                continue;
            }
            if (this.cursor < this.buffer.count()) {
                const node = this.buffer.at(this.cursor++);
                if (PlanNodeBuffer.meets(node, this.apron)) return node;
                continue;
            }
            const node = await this.buffer.pull(this.source);
            if (node === null) { this.buffer.finish(); return null; }
            if (this.buffer.isKeeping()) this.buffer.keep(node);
            this.cursor++;
            if (PlanNodeBuffer.meets(node, this.apron)) return node;
        }
    }

    async release(): Promise<void> {
        if (this.released) return;
        this.released = true;
        if (this.owns) await this.buffer.abandon(this);
    }
}
