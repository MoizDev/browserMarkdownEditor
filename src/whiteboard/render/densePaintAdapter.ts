import type { Rect, ViewState } from '../../platform/types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { FrameBudget } from '../../platform/render/types';
import { PaintBoundsJob } from './paintBounds';
import { inkCoverageChunks, type PaintFrame, type PaintItem } from './paintStream';
import type { PaintLayerResources } from './resources';
import { createCanvasPaintAdapter, type CanvasPaintAdapter } from './reference/canvasPaintAdapter';
import { paintItem2d } from './reference/paint2d';

const SIDE = 516;
const BITMAP_BYTES = SIDE * SIDE * 4;
const intersects = (a: Rect, b: Rect) => a.x <= b.x + b.width && b.x <= a.x + a.width
    && a.y <= b.y + b.height && b.y <= a.y + a.height;
export interface DenseTileBitmap {
    readonly bitmap: ImageBitmap;
    readonly rect: Readonly<Rect>;
    release(): void;
}

/** One private raster tile. It retains at most one native prepared item at a time. The caller
 * owns the source frame pin and supplies an ordered, normal-blend interval from that frame. */
export class DenseTileJob {
    private canvas: OffscreenCanvas | null = null;
    private ctx: OffscreenCanvasRenderingContext2D | null = null;
    private scratch: ByteLease | null = null;
    private bitmapLease: ByteLease | null = null;
    private pathLease: ByteLease | null = null;
    private adapter: CanvasPaintAdapter | null = null;
    private bounds: PaintBoundsJob | null = null;
    private index = 0;
    private estimateClip = 0;
    private estimateChunk = 0;
    private estimate = 0;
    private estimated = false;
    private painted = 0;
    private bitmapHeld = false;
    private phase: 'start' | 'bounds' | 'estimate' | 'item' | 'complete' | 'empty' | 'cancelled' = 'start';
    private blocked = false;
    private resultValue: DenseTileBitmap | null = null;
    private readonly end: number;
    constructor(private readonly resources: PaintLayerResources, private readonly host: LayerHost,
        private readonly report: (error: unknown) => void, private readonly source: PaintFrame,
        private readonly items: readonly PaintItem[], private readonly rect: Readonly<Rect>, private readonly scale: number,
        range?: Readonly<{ first: number; end: number }>) {
        this.index = range?.first ?? 0; this.end = range?.end ?? items.length;
        if (!Number.isSafeInteger(this.index) || !Number.isSafeInteger(this.end) || this.index < 0
            || this.end < this.index || this.end > items.length) throw new RangeError('Invalid dense paint interval');
        if (!Number.isFinite(scale) || scale <= 0 || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
            || rect.width <= 0 || rect.height <= 0) throw new RangeError('Invalid dense tile geometry');
    }
    get result(): DenseTileBitmap { if (!this.resultValue) throw new Error('Dense tile is not complete'); return this.resultValue; }
    get isEmpty(): boolean { return this.phase === 'empty'; }
    get memoryBytes(): number { return (this.scratch?.bytes ?? 0) + (this.bitmapLease?.bytes ?? 0) + (this.pathLease?.bytes ?? 0)
        + (this.bitmapHeld ? BITMAP_BYTES : 0); }
    get cpuWorkingSet(): number {
        return this.memoryBytes + (this.phase === 'start' ? 2 * BITMAP_BYTES : this.phase === 'estimate' && !this.pathLease ? this.estimate : 0);
    }
    needsFrame(): boolean { return !this.blocked && this.phase !== 'complete' && this.phase !== 'empty' && this.phase !== 'cancelled'
        && (this.phase !== 'item' || !!this.adapter?.needsFrame()); }
    private releasePath(): void {
        this.adapter?.dispose(); this.adapter = null;
        if (this.pathLease) { this.host.allocator.cpu.release(this.pathLease); this.pathLease = null; }
    }
    private releaseScratch(): void {
        if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0; }
        this.ctx = null; this.canvas = null;
        if (this.scratch) { this.host.allocator.cpu.release(this.scratch); this.scratch = null; }
    }
    cancel(): void {
        if (this.phase === 'cancelled') return;
        this.phase = 'cancelled'; this.releasePath(); this.releaseScratch();
        if (this.bitmapLease) { this.host.allocator.cpu.release(this.bitmapLease); this.bitmapLease = null; }
        this.resultValue?.release(); this.resultValue = null;
    }
    private reserve(bytes: number): ByteLease | null {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Dense item memory estimate overflows');
        return this.host.allocator.cpu.reserve(Math.max(1, bytes));
    }
    private estimateStep(item: PaintItem): boolean {
        if (this.estimateClip < item.clips.length) { this.estimate += item.clips[this.estimateClip++].d.length * 80; return false; }
        if (item.kind === 'ink') {
            const chunks = inkCoverageChunks(item.coverage);
            if (this.estimateChunk < chunks.length) {
                const chunk = chunks[this.estimateChunk++];
                this.estimate += (chunk.segments.length / 6 + chunk.discs.length / 3) * 40 * 80;
                return false;
            }
        } else if (item.kind === 'path') this.estimate += item.d.length * 80;
        return true;
    }
    private startItem(item: PaintItem): void {
        const frame: PaintFrame = { token: this.source.token, sceneRevision: this.source.sceneRevision,
            underlay: [], content: [item], inkNodeIds: this.source.inkNodeIds };
        this.adapter = createCanvasPaintAdapter({ frames: { readFrame: () => frame,
            isCurrent: candidate => candidate === frame && this.resources.frames.isCurrent(this.source) },
        images: this.resources.images, invalidate: this.resources.invalidate }, (_ctx, _view, paint) => paint(), error => {
            this.cancel(); this.report(error);
        });
    }
    /** Call only from the host's prepare pass. Denial does not spin a frame loop. */
    prepare(view: ViewState, budget: FrameBudget): void {
        if (this.phase === 'complete' || this.phase === 'empty' || this.phase === 'cancelled') return;
        this.blocked = false;
        try {
            while (!budget.shouldYield()) {
                if (!this.resources.frames.isCurrent(this.source)) { this.cancel(); return; }
                if (this.phase === 'start') {
                    this.scratch = this.reserve(BITMAP_BYTES);
                    if (!this.scratch) { this.blocked = true; return; }
                    this.bitmapLease = this.reserve(BITMAP_BYTES);
                    if (!this.bitmapLease) { this.host.allocator.cpu.release(this.scratch); this.scratch = null; this.blocked = true; return; }
                    this.canvas = new OffscreenCanvas(SIDE, SIDE);
                    this.ctx = this.canvas.getContext('2d');
                    if (!this.ctx) throw new Error('Dense tile 2D context unavailable');
                    this.ctx.setTransform(this.scale, 0, 0, this.scale, 2 - this.rect.x * this.scale, 2 - this.rect.y * this.scale);
                    this.phase = 'bounds';
                } else if (this.phase === 'bounds') {
                    if (this.index === this.end) {
                        if (!this.painted) {
                            this.releaseScratch();
                            if (this.bitmapLease) { this.host.allocator.cpu.release(this.bitmapLease); this.bitmapLease = null; }
                            this.phase = 'empty'; return;
                        }
                        const bitmap = this.canvas!.transferToImageBitmap(), lease = this.bitmapLease!;
                        this.bitmapHeld = true;
                        this.bitmapLease = null; this.releaseScratch();
                        let held = true;
                        this.resultValue = { bitmap, rect: this.rect, release: () => {
                            if (!held) return; held = false; this.bitmapHeld = false; bitmap.close(); this.host.allocator.cpu.release(lease);
                        } };
                        this.phase = 'complete'; return;
                    }
                    const item = this.items[this.index];
                    if ((item.kind === 'image' ? item.blend : item.material.blend) !== 'normal') throw new Error('Backdrop-dependent paint cannot enter a dense tile');
                    this.bounds ??= new PaintBoundsJob(item);
                    if (!this.bounds.step(1)) continue;
                    const bounds = this.bounds.result; this.bounds = null;
                    const bleed = 2 / this.scale;
                    const visible = { x: this.rect.x - bleed, y: this.rect.y - bleed,
                        width: this.rect.width + 2 * bleed, height: this.rect.height + 2 * bleed };
                    if (!bounds || !intersects(bounds, visible)) { this.index++; continue; }
                    this.estimate = 256; this.estimateClip = 0; this.estimateChunk = 0; this.estimated = false; this.phase = 'estimate';
                } else if (this.phase === 'estimate') {
                    const item = this.items[this.index];
                    if (!this.estimated) {
                        if (!this.estimateStep(item)) continue;
                        this.estimated = true;
                    }
                    this.pathLease = this.reserve(this.estimate);
                    if (!this.pathLease) { this.blocked = true; return; }
                    this.startItem(item); this.phase = 'item';
                } else if (this.phase === 'item') {
                    const tileView: ViewState = { ...view, camera: { ...view.camera, z: this.scale }, viewport: { ...view.viewport, dpr: 1 } };
                    this.adapter!.prepare(tileView, budget);
                    const prepared = this.adapter!.borrowPrepared();
                    if (!prepared) return;
                    paintItem2d(this.ctx!, this.items[this.index], prepared.resources);
                    this.releasePath(); this.index++; this.painted++; this.phase = 'bounds';
                } else return;
            }
        } catch (error) { this.cancel(); this.report(error); }
    }
}
