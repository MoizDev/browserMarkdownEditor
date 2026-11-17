import type { Rect, Rgba, ViewState } from '../../platform/types';
import type { FrameBudget, GpuReleaseReason, Layer } from '../../platform/render/types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease, GfxDevice, GpuPass, TextureHandle } from '../../platform/render/gfx/api';
import { QuadList } from '../layer/quadList';

export interface PdfHighlightRects {
    /** World-space rectangles, already clipped to their physical pages. */
    readonly find: readonly Readonly<Rect>[];
    readonly current: readonly Readonly<Rect>[];
    readonly selection: readonly Readonly<Rect>[];
}
export interface PdfHighlightPalette {
    readonly find: Rgba;
    readonly current: Rgba;
    readonly selection: Rgba;
}

/** Writes the rect's device-pixel placement into `out`: a frame draws every highlight, so no object is made per rect. */
function deviceRect(rect: Readonly<Rect>, view: ViewState, out: Rect): Rect {
    const scale = view.camera.z * view.viewport.dpr;
    out.x = (rect.x - view.camera.x) * scale;
    out.y = (rect.y - view.camera.y) * scale;
    out.width = rect.width * scale;
    out.height = rect.height * scale;
    return out;
}
function visible(rect: Rect, view: ViewState): boolean {
    return rect.width > 0 && rect.height > 0 && rect.x < view.viewport.width * view.viewport.dpr &&
        rect.y < view.viewport.height * view.viewport.dpr && rect.x + rect.width > 0 && rect.y + rect.height > 0;
}
function channel(value: number): number { return Math.round(Math.max(0, Math.min(1, value)) * 255); }
function css(color: Rgba): string { return `rgba(${channel(color[0])}, ${channel(color[1])}, ${channel(color[2])}, ${Math.max(0, Math.min(1, color[3]))})`; }

/** Find is painted below the selection, as chrome so the PDF invert filter never touches it. */
export class PdfTextHighlightLayer implements Layer {
    private rects: PdfHighlightRects = { find: [], current: [], selection: [] };
    private texture: { device: GfxDevice; handle: TextureHandle } | null = null;
    private disposed = false;
    private pending = false;
    private lease: ByteLease | null = null;
    private readonly scratch: Rect = { x: 0, y: 0, width: 0, height: 0 };
    /** Every highlight of a frame, in find, current, selection order, drawn as one batch from the palette texture. */
    private readonly quads = new QuadList();

    constructor(private readonly host: LayerHost, private palette: PdfHighlightPalette) {}

    setRects(rects: PdfHighlightRects): void {
        // Reported bytes need a covering reservation: an unreserved report made every governor readout throw
        // 'unaccounted' once find or a selection had highlights. A refused reservation still shows the highlights,
        // which are a few rectangles, but reports nothing it does not hold.
        const bytes = (rects.find.length + rects.current.length + rects.selection.length) * 32;
        if (this.lease) { this.host.allocator.cpu.release(this.lease); this.lease = null; }
        if (bytes) this.lease = this.host.allocator.cpu.reserve(bytes);
        this.rects = rects;
        this.host.invalidate('pdf-text-highlights');
    }
    setPalette(palette: PdfHighlightPalette): void {
        this.palette = palette;
        this.releaseGpu('pressure');
        this.host.invalidate('pdf-text-highlight-colours');
    }
    prepare(_view: ViewState, budget: FrameBudget): void {
        this.pending = false;
        const device = this.host.device();
        if (!device || this.disposed || this.texture?.device === device) return;
        if (this.texture) this.releaseGpu('pressure');
        if (budget.shouldYield() || !budget.claimUpload(12)) { this.pending = true; return; }
        const lease = this.host.allocator.gpu.reserve(12);
        if (!lease) return;
        let handle: TextureHandle;
        try { handle = device.createTexture(3, 1, 'rgba8', ['sample', 'copy-dst'], lease); }
        catch (error) { this.host.allocator.gpu.release(lease); throw error; }
        const colors = [this.palette.find, this.palette.current, this.palette.selection];
        const pixels = new Uint8Array(12);
        colors.forEach((color, index) => {
            const alpha = Math.max(0, Math.min(1, color[3]));
            pixels[index * 4] = channel(color[0] * alpha);
            pixels[index * 4 + 1] = channel(color[1] * alpha);
            pixels[index * 4 + 2] = channel(color[2] * alpha);
            pixels[index * 4 + 3] = channel(alpha);
        });
        try {
            device.writeTexture(handle, { x: 0, y: 0, width: 3, height: 1 },
                { source: pixels, rowBytes: 12, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
            this.texture = { device, handle };
        } catch (error) { device.destroy(handle); throw error; }
    }
    drawGpu(pass: GpuPass, view: ViewState): void {
        const texture = this.texture;
        if (!texture || texture.device !== this.host.device() || this.disposed) return;
        // Each group samples its own texel of the 3×1 palette texture (find, current, selection).
        const quads = this.quads;
        quads.reset();
        this.addGpuGroup(quads, view, this.rects.find, 0);
        this.addGpuGroup(quads, view, this.rects.current, 1);
        this.addGpuGroup(quads, view, this.rects.selection, 2);
        quads.drawAll(batch => this.host.drawTexturedQuads(pass, texture.handle, batch, { opacity: 1, sampling: 'nearest' }));
    }
    draw2d(ctx: CanvasRenderingContext2D, view: ViewState): void {
        if (this.disposed) return;
        ctx.save();
        try {
            this.draw2dGroup(ctx, view, this.rects.find, this.palette.find);
            this.draw2dGroup(ctx, view, this.rects.current, this.palette.current);
            this.draw2dGroup(ctx, view, this.rects.selection, this.palette.selection);
        } finally { ctx.restore(); }
    }
    /** Queues the visible rects of one group, each sampling its texel. One scratch rect serves every rect. */
    private addGpuGroup(quads: QuadList, view: ViewState, rects: readonly Readonly<Rect>[], texel: number): void {
        const source = { x: texel, y: 0, width: 1, height: 1 };
        for (const rect of rects) {
            deviceRect(rect, view, this.scratch);
            if (visible(this.scratch, view)) quads.add(source, this.scratch);
        }
    }
    private draw2dGroup(ctx: CanvasRenderingContext2D, view: ViewState, rects: readonly Readonly<Rect>[], color: Rgba): void {
        ctx.fillStyle = css(color);
        for (const rect of rects) {
            deviceRect(rect, view, this.scratch);
            if (visible(this.scratch, view)) ctx.fillRect(this.scratch.x, this.scratch.y, this.scratch.width, this.scratch.height);
        }
    }
    releaseGpu(reason: GpuReleaseReason): void {
        if (this.texture && reason !== 'context-lost') this.texture.device.destroy(this.texture.handle);
        this.texture = null; this.pending = false;
    }
    memory(): { gpuBytes: number; cpuBytes: number } {
        return { gpuBytes: this.texture ? 12 : 0, cpuBytes: this.lease?.bytes ?? 0 };
    }
    needsFrame(): boolean { return this.pending; }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true; this.releaseGpu('pressure');
        this.rects = { find: [], current: [], selection: [] };
        if (this.lease) { this.host.allocator.cpu.release(this.lease); this.lease = null; }
    }
}
