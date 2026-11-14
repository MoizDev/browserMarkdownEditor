import type { Rect, Rgba, ViewState } from '../../platform/types';
import type { FrameBudget, GpuReleaseReason, Layer } from '../../platform/render/types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { GfxDevice, GpuPass, TextureHandle } from '../../platform/render/gfx/api';

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

function deviceRect(rect: Readonly<Rect>, view: ViewState): Rect {
    const scale = view.camera.z * view.viewport.dpr;
    return { x: (rect.x - view.camera.x) * scale, y: (rect.y - view.camera.y) * scale,
        width: rect.width * scale, height: rect.height * scale };
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

    constructor(private readonly host: LayerHost, private palette: PdfHighlightPalette) {}

    setRects(rects: PdfHighlightRects): void {
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
        [this.rects.find, this.rects.current, this.rects.selection].forEach((rects, index) => {
            for (const rect of rects) {
                const destination = deviceRect(rect, view);
                if (visible(destination, view)) this.host.drawTexturedQuad(pass, texture.handle,
                    { x: index, y: 0, width: 1, height: 1 }, destination, { opacity: 1, sampling: 'nearest' });
            }
        });
    }
    draw2d(ctx: CanvasRenderingContext2D, view: ViewState): void {
        if (this.disposed) return;
        const colors = [this.palette.find, this.palette.current, this.palette.selection];
        [this.rects.find, this.rects.current, this.rects.selection].forEach((rects, index) => {
            ctx.fillStyle = css(colors[index]);
            for (const rect of rects) {
                const destination = deviceRect(rect, view);
                if (visible(destination, view)) ctx.fillRect(destination.x, destination.y, destination.width, destination.height);
            }
        });
    }
    releaseGpu(reason: GpuReleaseReason): void {
        if (this.texture && reason !== 'context-lost') this.texture.device.destroy(this.texture.handle);
        this.texture = null; this.pending = false;
    }
    memory(): { gpuBytes: number; cpuBytes: number } {
        return { gpuBytes: this.texture ? 12 : 0,
            cpuBytes: (this.rects.find.length + this.rects.current.length + this.rects.selection.length) * 32 };
    }
    needsFrame(): boolean { return this.pending; }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true; this.releaseGpu('pressure');
        this.rects = { find: [], current: [], selection: [] };
    }
}
