import type { Rect, ViewState } from '../../platform/types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { FrameBudget, RenderToken } from '../../platform/render/types';
import { PaintBoundsJob } from './paintBounds';
import { inkCoverageChunks, type PaintFrame, type PaintItem, type PaintNode } from './paintStream';
import type { Blend } from './colour';
import type { PaintBand } from './material';
import type { PaintImageLease, PaintImageProvider } from './resources';
import type { ScenePaintNodeStream } from './scenePaintStream';
import { createCanvasPaintAdapter, type CanvasPaintAdapter } from './reference/canvasPaintAdapter';
import { paintItem2d } from './reference/paint2d';

const SIDE = 516, BITMAP_BYTES = SIDE * SIDE * 4;
const EMPTY_IDS: ReadonlySet<string> = new Set();
const intersects = (a: Readonly<Rect>, b: Readonly<Rect>) => a.x <= b.x + b.width && b.x <= a.x + a.width
    && a.y <= b.y + b.height && b.y <= a.y + a.height;
const sameToken = (a: RenderToken, b: RenderToken) => a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId
    && a.bytesGeneration === b.bytesGeneration && a.session === b.session;
const blendOf = (item: PaintItem): Blend => item.kind === 'image' ? item.blend : item.material.blend;

export interface StreamingDenseTileOptions {
    /** The stream must bind this signal so an active next() physically drains on abort. */
    readonly open: (apron: Readonly<Rect>, signal: AbortSignal) => Promise<ScenePaintNodeStream>;
    readonly rect: Readonly<Rect>;
    readonly scale: number;
    readonly band: PaintBand;
    /** Live node ids of this band. Each is a barrier the frame draws itself; its pixels are never here. */
    readonly barriers: ReadonlySet<string>;
    readonly token: RenderToken;
    readonly revision: number;
    readonly isCurrent: () => boolean;
    readonly images: PaintImageProvider;
    readonly host: LayerHost;
    readonly onError: (error: unknown) => void;
    readonly signal?: AbortSignal;
}
/** One rasterized sub-run of a tile: a single blend, drawn by the frame before `end`. The receiver
 * owns `bitmap` and `bytesLease` and must release both through `releaseDenseTilePart`. */
export interface DenseTilePart {
    readonly bitmap: ImageBitmap;
    readonly rect: Readonly<Rect>;
    readonly blend: Blend;
    /** The barrier node this part precedes, or null when it precedes the band's end. */
    readonly end: string | null;
    readonly bytesLease: ByteLease;
    readonly owner: MemoryAllocator;
    /** Image pixels depend on acquisition, so such a part is never kept as a complete session tile. */
    readonly hasImage: boolean;
}
export function releaseDenseTilePart(part: DenseTilePart): void {
    try { part.bitmap.close(); } finally { part.owner.release(part.bytesLease); }
}

interface Run {
    readonly canvas: OffscreenCanvas;
    readonly ctx: OffscreenCanvasRenderingContext2D;
    readonly scratch: ByteLease;
    readonly bitmapLease: ByteLease;
    readonly blend: Blend;
    painted: number;
    hasImage: boolean;
}

/** One tile of one band, built from its own bounded stream. The stream is read in canonical order;
 * items split into sub-runs at blend changes and at barriers, so the frame can interleave the
 * tile's parts with the live items it draws. No node or item array is kept. */
export class StreamingDenseTileJob {
    private readonly controller = new AbortController();
    private readonly apron: Readonly<Rect>;
    private readonly rect: Readonly<Rect>;
    private readonly token: RenderToken;
    private readonly pending = new Set<Promise<unknown>>();
    private stream: ScenePaintNodeStream | null = null;
    private opening = false;
    private pumping = false;
    /** Nodes read ahead in background slices; the render loop consumes them without awaiting. */
    private readonly queue: PaintNode[] = [];
    private readerEnded = false;
    private node: PaintNode | null = null;
    private itemIndex = 0;
    private item: PaintItem | null = null;
    private bounds: PaintBoundsJob | null = null;
    private adapter: CanvasPaintAdapter | null = null;
    private run: Run | null = null;
    private sealed: DenseTilePart[] = [];
    private finished: DenseTilePart[] = [];
    private lastBarrier: string | null = null;
    private barriers = 0;
    private imageBytes = 0;
    private pathLease: ByteLease | null = null;
    private estimate = 0;
    private clipIndex = 0;
    private chunkIndex = 0;
    private estimated = false;
    private painted = 0;
    private blockedValue = false;
    private state: 'start' | 'opening' | 'read' | 'items' | 'bounds' | 'estimate' | 'item' | 'retiring' | 'complete' | 'empty' | 'cancelled' | 'failed' = 'start';
    private retirement: Promise<void> | null = null;
    private readonly retired: Promise<void>;
    private resolveRetired!: () => void;
    private rejectRetired!: (error: unknown) => void;
    private readonly abortListener = () => this.cancel();
    constructor(private readonly options: StreamingDenseTileOptions) {
        const { rect, scale, revision, token } = options;
        if (!Number.isFinite(scale) || scale <= 0 || !Number.isSafeInteger(revision) || revision < 0
            || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
            throw new RangeError('Invalid streaming dense tile request');
        }
        const bleed = 2 / scale;
        const apron = { x: rect.x - bleed, y: rect.y - bleed, width: rect.width + 2 * bleed, height: rect.height + 2 * bleed };
        if (![apron.x, apron.y, apron.width, apron.height, apron.x + apron.width, apron.y + apron.height].every(Number.isFinite)) {
            throw new RangeError('Streaming tile apron overflows');
        }
        this.rect = Object.freeze({ ...rect }); this.apron = Object.freeze(apron); this.token = Object.freeze({ ...token });
        this.retired = new Promise<void>((resolve, reject) => { this.resolveRetired = resolve; this.rejectRetired = reject; });
        void this.retired.catch(() => {});
        options.signal?.addEventListener('abort', this.abortListener, { once: true });
        if (options.signal?.aborted) this.cancel();
    }
    get blocked(): boolean { return this.blockedValue; }
    get isComplete(): boolean { return this.state === 'complete'; }
    get isEmpty(): boolean { return this.state === 'empty'; }
    /** The tile's only part when no barrier split it: the complete band content of this apron. */
    get singlePart(): DenseTilePart | null {
        return this.barriers === 0 && this.finished.length === 1 && (this.state === 'complete') ? this.finished[0] : null;
    }
    get memoryBytes(): number {
        let bytes = this.imageBytes + (this.pathLease?.bytes ?? 0) + (this.run ? this.run.scratch.bytes + this.run.bitmapLease.bytes : 0);
        for (const part of this.sealed) bytes += part.bytesLease.bytes;
        for (const part of this.finished) bytes += part.bytesLease.bytes;
        return bytes;
    }
    get cpuWorkingSet(): number {
        return this.memoryBytes + (this.state === 'start' ? 2 * BITMAP_BYTES : this.state === 'estimate' && !this.pathLease ? this.estimate : 0);
    }
    needsFrame(): boolean {
        if (this.blockedValue || this.opening || this.pumping) return false;
        if (this.state === 'item') return !!this.adapter?.needsFrame();
        return this.state === 'start' || this.state === 'read' || this.state === 'items' || this.state === 'bounds' || this.state === 'estimate';
    }
    private report(error: unknown): void { try { this.options.onError(error); } catch { /* Reporting cannot prevent retirement. */ } }
    private valid(): boolean { return !this.controller.signal.aborted && !this.options.signal?.aborted && this.options.isCurrent(); }
    private track<T>(promise: Promise<T>): Promise<T> {
        this.pending.add(promise);
        void promise.then(() => { this.pending.delete(promise); }, () => { this.pending.delete(promise); });
        return promise;
    }
    private releasePath(): void {
        const adapter = this.adapter, lease = this.pathLease;
        this.adapter = null; this.pathLease = null; this.item = null; this.bounds = null;
        try { adapter?.dispose(); } finally { if (lease) this.options.host.allocator.cpu.release(lease); }
    }
    private reserve(bytes: number): ByteLease | null {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Streaming dense path estimate overflows');
        return this.options.host.allocator.cpu.reserve(Math.max(1, bytes));
    }
    /** Discards a sub-run's pixels and returns both of its leases. */
    private releaseRun(run: Run): void {
        try { run.canvas.width = 0; run.canvas.height = 0; }
        finally {
            try { this.options.host.allocator.cpu.release(run.scratch); }
            finally { this.options.host.allocator.cpu.release(run.bitmapLease); }
        }
    }
    private releaseParts(parts: DenseTilePart[]): void {
        for (const part of parts.splice(0)) {
            try { releaseDenseTilePart(part); } catch (error) { this.report(error); }
        }
    }
    /** Ends the current sub-run: pixels become a sealed part, an unpainted run returns its leases. */
    private closeRun(): void {
        const run = this.run;
        if (!run) return;
        this.run = null;
        if (!run.painted) { this.releaseRun(run); return; }
        const bitmap = run.canvas.transferToImageBitmap();
        run.canvas.width = 0; run.canvas.height = 0;
        this.options.host.allocator.cpu.release(run.scratch);
        this.sealed.push({ bitmap, rect: this.rect, blend: run.blend, end: null, bytesLease: run.bitmapLease,
            owner: this.options.host.allocator.cpu, hasImage: run.hasImage });
    }
    /** Every sealed part precedes this barrier, in the order they were rasterized. */
    private sealUntil(barrier: string | null): void {
        this.closeRun();
        for (const part of this.sealed.splice(0)) this.finished.push({ ...part, end: barrier });
    }
    private openRun(blend: Blend): boolean {
        const scratch = this.reserve(BITMAP_BYTES);
        if (!scratch) { this.blockedValue = true; return false; }
        const bitmapLease = this.reserve(BITMAP_BYTES);
        if (!bitmapLease) { this.options.host.allocator.cpu.release(scratch); this.blockedValue = true; return false; }
        const canvas = new OffscreenCanvas(SIDE, SIDE), ctx = canvas.getContext('2d');
        if (!ctx) {
            this.options.host.allocator.cpu.release(scratch); this.options.host.allocator.cpu.release(bitmapLease);
            throw new Error('Streaming dense tile context unavailable');
        }
        ctx.setTransform(this.options.scale, 0, 0, this.options.scale,
            2 - this.rect.x * this.options.scale, 2 - this.rect.y * this.options.scale);
        this.run = { canvas, ctx, scratch, bitmapLease, blend, painted: 0, hasImage: false };
        return true;
    }
    private stop(failed: boolean, error?: unknown): void {
        if (this.state === 'cancelled' || this.state === 'failed') return;
        this.state = failed ? 'failed' : 'cancelled';
        this.options.signal?.removeEventListener('abort', this.abortListener);
        this.controller.abort(error);
        for (const release of [() => this.releasePath(), () => { const run = this.run; this.run = null; if (run) this.releaseRun(run); },
            () => this.releaseParts(this.sealed), () => this.releaseParts(this.finished)]) {
            try { release(); } catch (cleanupError) { this.report(cleanupError); }
        }
        this.node = null; this.queue.length = 0;
        if (failed) this.report(error);
        void this.startRetirement();
    }
    private startRetirement(): Promise<void> {
        if (this.retirement) return this.retirement;
        this.retirement = (async () => {
            while (this.pending.size) await Promise.allSettled([...this.pending]);
            // Canvas adapter completion handlers release late image leases in their own microtask.
            await Promise.resolve();
            if (this.stream) await this.stream.release();
        })().catch(error => {
            this.report(error); this.rejectRetired(error);
            if (this.state === 'retiring') {
                this.state = 'failed';
                try { this.releaseParts(this.finished); } catch (cleanupError) { this.report(cleanupError); }
            }
        }).finally(() => {
            if (this.state === 'cancelled' || this.state === 'failed') this.options.signal?.removeEventListener('abort', this.abortListener);
            this.stream = null; this.node = null; this.queue.length = 0; this.resolveRetired();
            try { this.options.host.invalidate('streaming-dense-retired'); } catch (error) { this.report(error); }
        });
        return this.retirement;
    }
    cancel(): void { this.stop(false); }
    dispose(): void { this.cancel(); }
    whenRetired(): Promise<void> { return this.retired; }
    private requestStream(): void {
        this.state = 'opening'; this.opening = true;
        const pending = this.track(Promise.resolve().then(() => {
            this.controller.signal.throwIfAborted();
            return this.options.open(this.apron, this.controller.signal);
        }));
        void pending.then(stream => {
            this.opening = false; this.stream = stream;
            try {
                if (this.controller.signal.aborted) { void this.startRetirement(); return; }
                if (!sameToken(stream.token, this.token) || stream.sceneRevision !== this.options.revision || !this.options.isCurrent()) {
                    this.stop(true, new Error('Streaming dense source identity changed')); return;
                }
                this.state = 'read'; this.options.host.invalidate('streaming-dense-source');
            } catch (error) { this.stop(true, error); }
        }, error => { this.opening = false; if (!this.controller.signal.aborted) this.stop(true, error); });
    }
    /** Consumes the next read-ahead node, or starts a background slice that refills the queue. */
    private readNext(): void {
        if (this.queue.length) { this.node = this.queue.shift()!; this.itemIndex = 0; this.state = 'items'; return; }
        if (this.readerEnded) { this.finish(); return; }
        if (this.pumping) return;
        const stream = this.stream!; this.pumping = true;
        const started = performance.now();
        const slice = (async () => {
            // Bounded read-ahead: the queue holds at most eight nodes, and a slice ends after 4 ms.
            while (!this.controller.signal.aborted && !this.readerEnded && this.queue.length < 8 && performance.now() - started < 4) {
                const node = await stream.next();
                if (this.controller.signal.aborted) return;
                if (!this.options.isCurrent()) { this.stop(false); return; }
                if (node === null) { this.readerEnded = true; return; }
                this.queue.push(node);
            }
        })();
        this.track(slice).then(() => {
            this.pumping = false;
            if (!this.controller.signal.aborted) this.options.host.invalidate('streaming-dense-node');
        }, error => {
            this.pumping = false;
            if (!this.controller.signal.aborted) this.stop(true, error);
        });
    }
    private finish(): void {
        try {
            this.sealUntil(null);
            this.state = 'retiring';
            void this.startRetirement().then(() => {
                try {
                    if (this.state !== 'retiring') return;
                    if (!this.valid()) { this.cancel(); return; }
                    this.state = this.finished.length ? 'complete' : 'empty';
                    if (this.state === 'empty') this.options.signal?.removeEventListener('abort', this.abortListener);
                    this.options.host.invalidate('streaming-dense-ready');
                } catch (error) { this.stop(true, error); }
            });
        } catch (error) { this.stop(true, error); }
    }
    private estimateStep(item: PaintItem): boolean {
        if (this.clipIndex < item.clips.length) { this.estimate += item.clips[this.clipIndex++].d.length * 80; return false; }
        if (item.kind === 'ink') {
            const chunks = inkCoverageChunks(item.coverage);
            if (this.chunkIndex < chunks.length) {
                const chunk = chunks[this.chunkIndex++];
                this.estimate += (chunk.segments.length / 6 + chunk.discs.length / 3) * 40 * 80;
                return false;
            }
        } else if (item.kind === 'path') this.estimate += item.d.length * 80;
        return true;
    }
    private prepareItem(item: PaintItem): void {
        const stream = this.stream!;
        const frame: PaintFrame = { token: stream.token, sceneRevision: stream.sceneRevision, sourceDoc: stream.sourceDoc,
            underlay: [], content: [item], inkNodeIds: EMPTY_IDS };
        const images: PaintImageProvider = { acquire: (key, token, signal) => this.track(
            this.options.images.acquire(key, token, signal).then(lease => {
                if (!Number.isSafeInteger(lease.cpuBytes) || lease.cpuBytes < 0) {
                    lease.release(); throw new RangeError('Invalid streaming image accounting');
                }
                this.imageBytes += lease.cpuBytes;
                let held = true;
                return { source: lease.source, width: lease.width, height: lease.height, cpuBytes: lease.cpuBytes,
                    release: () => {
                        if (!held) return; held = false; this.imageBytes -= lease.cpuBytes; lease.release();
                    } } satisfies PaintImageLease;
            })) };
        this.adapter = createCanvasPaintAdapter({ frames: { readFrame: () => frame,
            isCurrent: candidate => candidate === frame && this.stream === stream && this.valid() },
        images, invalidate: () => {
            try { this.options.host.invalidate('streaming-dense-image'); } catch (error) { this.report(error); }
        } }, (_ctx, _view, paint) => paint(), error => this.stop(true, error));
    }
    /** Takes the sealed parts of a finished tile. The caller now owns every returned bitmap and lease. */
    takeParts(): readonly DenseTilePart[] {
        if (this.state !== 'complete' && this.state !== 'empty') throw new Error('Streaming tile is not finished');
        if (!this.valid()) { this.cancel(); throw new DOMException('Streaming tile is stale', 'AbortError'); }
        this.options.signal?.removeEventListener('abort', this.abortListener);
        const parts = this.finished; this.finished = [];
        this.state = 'cancelled';
        return Object.freeze(parts);
    }
    prepare(view: ViewState, budget: FrameBudget): void {
        if (!this.needsFrame() && !this.blockedValue) return;
        this.blockedValue = false;
        const deadline = performance.now() + 0.25;
        const sliced: FrameBudget = { ...budget, shouldYield: () => budget.shouldYield() || performance.now() >= deadline,
            claimUpload: bytes => budget.claimUpload(bytes) };
        try {
            while (!sliced.shouldYield()) {
                if (!this.valid()) { this.cancel(); return; }
                if (this.state === 'start') { this.requestStream(); return; }
                if (this.state === 'read') { this.readNext(); if (this.state === 'read') return; continue; }
                if (this.state === 'items') {
                    const items = this.options.band === 'underlay' ? this.node!.underlay ?? [] : this.node!.content;
                    if (this.itemIndex >= items.length) { this.node = null; this.state = 'read'; continue; }
                    const item = items[this.itemIndex++];
                    if (this.options.barriers.has(item.nodeId)) {
                        // A node's items are contiguous in its band, so one barrier event per node.
                        if (this.lastBarrier !== item.nodeId) {
                            this.lastBarrier = item.nodeId; this.barriers++;
                            this.sealUntil(item.nodeId);
                        }
                        continue;
                    }
                    this.lastBarrier = null;
                    const blend = blendOf(item);
                    if (blend !== 'normal' && blend !== 'multiply') throw new Error('Unsupported streaming dense blend');
                    if (this.run && this.run.blend !== blend) this.closeRun();
                    if (!this.run && !this.openRun(blend)) { this.itemIndex--; return; }
                    this.item = item; this.bounds = new PaintBoundsJob(item); this.state = 'bounds'; continue;
                }
                if (this.state === 'bounds') {
                    if (!this.bounds!.step(1)) continue;
                    const bounds = this.bounds!.result; this.bounds = null;
                    if (!bounds || !intersects(bounds, this.apron)) { this.item = null; this.state = 'items'; continue; }
                    this.estimate = 256; this.clipIndex = 0; this.chunkIndex = 0; this.estimated = false; this.state = 'estimate'; continue;
                }
                if (this.state === 'estimate') {
                    if (!this.estimated) { if (!this.estimateStep(this.item!)) continue; this.estimated = true; }
                    this.pathLease = this.reserve(this.estimate);
                    if (!this.pathLease) { this.blockedValue = true; return; }
                    this.prepareItem(this.item!); this.state = 'item'; continue;
                }
                if (this.state === 'item') {
                    const tileView: ViewState = { ...view, camera: { ...view.camera, z: this.options.scale }, viewport: { ...view.viewport, dpr: 1 } };
                    this.adapter!.prepare(tileView, sliced);
                    const prepared = this.adapter?.borrowPrepared();
                    if (!prepared) return;
                    const run = this.run!;
                    paintItem2d(run.ctx, this.item!, prepared.resources);
                    if (this.item!.kind === 'image') run.hasImage = true;
                    run.painted++;
                    this.releasePath(); this.painted++; this.state = 'items'; continue;
                }
                return;
            }
        } catch (error) { this.stop(true, error); }
    }
}

export function createStreamingDenseTileJob(options: StreamingDenseTileOptions): StreamingDenseTileJob {
    return new StreamingDenseTileJob(options);
}
