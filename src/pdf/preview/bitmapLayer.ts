import type { ViewState, LayerHost, GfxDevice, GpuPass, TextureHandle, FrameBudget, GpuReleaseReason, Layer } from '../../platform/render';
import { PreviewBitmapStore } from './bitmapStore';
import type { PreviewRect, PreviewTile } from './bitmapStore';

interface UploadedTile {
    readonly device: GfxDevice;
    readonly texture: TextureHandle;
    readonly bytes: number;
}

function project(rect: PreviewRect, view: ViewState): PreviewRect {
    const scale = view.camera.z * view.viewport.dpr;
    return {
        x: (rect.x - view.camera.x) * scale,
        y: (rect.y - view.camera.y) * scale,
        width: rect.width * scale,
        height: rect.height * scale,
    };
}

function onScreen(rect: PreviewRect, view: ViewState): boolean {
    const projected = project(rect, view);
    return projected.x < view.viewport.width * view.viewport.dpr && projected.y < view.viewport.height * view.viewport.dpr
        && projected.x + projected.width > 0 && projected.y + projected.height > 0;
}

/** A temporary PDF-owned layer; scheduling, device and both drawing paths come from the host. */
export class PreviewBitmapLayer implements Layer {
    readonly bitmaps: PreviewBitmapStore;
    private readonly uploaded = new Map<PreviewTile, UploadedTile>();
    private pendingFrame = false;
    private disposed = false;
    private expected = new Map<number, PreviewRect>();

    constructor(private readonly host: LayerHost) {
        this.bitmaps = new PreviewBitmapStore(host.allocator.cpu, () => {
            this.retireRemoved();
            host.invalidate('pdf-preview-bitmap');
        });
    }

    setExpected(pages: ReadonlyMap<number, PreviewRect>): void {
        this.expected = new Map(pages);
        this.host.invalidate('pdf-preview-layout');
    }

    coverage(view: ViewState, gpu: boolean): { complete: boolean; sharp: boolean } {
        const bounds = {
            x: view.camera.x, y: view.camera.y,
            width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z,
        };
        for (const [index, pageRect] of this.expected) {
            const left = Math.max(bounds.x, pageRect.x);
            const top = Math.max(bounds.y, pageRect.y);
            const right = Math.min(bounds.x + bounds.width, pageRect.x + pageRect.width);
            const bottom = Math.min(bounds.y + bounds.height, pageRect.y + pageRect.height);
            if (right <= left || bottom <= top) continue;
            const page = this.bitmaps.entries.get(index);
            if (!page || !page.tiles.length) return { complete: false, sharp: false };
            const tiles = page.tiles;
            const x0 = Math.min(...tiles.map(tile => tile.destination.x));
            const y0 = Math.min(...tiles.map(tile => tile.destination.y));
            const x1 = Math.max(...tiles.map(tile => tile.destination.x + tile.destination.width));
            const y1 = Math.max(...tiles.map(tile => tile.destination.y + tile.destination.height));
            if (x0 > left || y0 > top || x1 < right || y1 < bottom) return { complete: false, sharp: false };
            if (gpu && tiles.some(tile => onScreen(tile.destination, view) && this.uploaded.get(tile)?.device !== this.host.device())) {
                return { complete: false, sharp: false };
            }
        }
        return { complete: true, sharp: true };
    }

    prepare(view: ViewState, budget: FrameBudget): void {
        this.pendingFrame = false;
        const device = this.host.device();
        if (!device || this.disposed) return;
        for (const page of this.bitmaps.entries.values()) {
            for (const tile of page.tiles) {
                if (!onScreen(tile.destination, view)) continue;
                const existing = this.uploaded.get(tile);
                if (existing?.device === device) continue;
                if (existing) this.retire(tile, existing);
                if (budget.shouldYield() || !budget.claimUpload(tile.bytes)) {
                    this.pendingFrame = true;
                    return;
                }
                const lease = this.host.allocator.gpu.reserve(tile.bytes);
                if (!lease) return;
                let texture: TextureHandle;
                try {
                    texture = device.createTexture(tile.bitmap.width, tile.bitmap.height, 'rgba8', ['sample', 'copy-dst'], lease);
                } catch (error) {
                    this.host.allocator.gpu.release(lease);
                    throw error;
                }
                try {
                    device.writeTexture(texture, { x: 0, y: 0, width: tile.bitmap.width, height: tile.bitmap.height }, {
                        source: tile.bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left',
                    });
                    this.uploaded.set(tile, { device, texture, bytes: tile.bytes });
                } catch (error) {
                    device.destroy(texture);
                    throw error;
                }
            }
        }
    }

    drawGpu(pass: GpuPass, view: ViewState): void {
        for (const page of this.bitmaps.entries.values()) {
            for (const tile of page.tiles) {
                const uploaded = this.uploaded.get(tile);
                if (!uploaded || uploaded.device !== this.host.device() || !onScreen(tile.destination, view)) continue;
                this.host.drawTexturedQuad(pass, uploaded.texture, { x: 0, y: 0, width: tile.bitmap.width, height: tile.bitmap.height },
                    project(tile.destination, view), { opacity: 1, sampling: 'linear' });
            }
        }
    }

    draw2d(ctx: CanvasRenderingContext2D, view: ViewState): void {
        for (const page of this.bitmaps.entries.values()) {
            for (const tile of page.tiles) {
                if (!onScreen(tile.destination, view)) continue;
                this.host.drawTexturedQuad(ctx, tile.bitmap, { x: 0, y: 0, width: tile.bitmap.width, height: tile.bitmap.height },
                    project(tile.destination, view), { opacity: 1, sampling: 'linear' });
            }
        }
    }

    releaseGpu(_reason: GpuReleaseReason): void {
        for (const [tile, uploaded] of this.uploaded) this.retire(tile, uploaded);
        this.pendingFrame = false;
    }

    memory(): { gpuBytes: number; cpuBytes: number } {
        let gpuBytes = 0;
        for (const entry of this.uploaded.values()) gpuBytes += entry.bytes;
        return { gpuBytes, cpuBytes: this.bitmaps.cpuBytes };
    }

    needsFrame(): boolean { return this.pendingFrame; }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.releaseGpu('pressure');
        this.bitmaps.dispose();
    }

    private retireRemoved(): void {
        const live = new Set<PreviewTile>();
        for (const page of this.bitmaps.entries.values()) for (const tile of page.tiles) live.add(tile);
        for (const [tile, uploaded] of this.uploaded) if (!live.has(tile)) this.retire(tile, uploaded);
    }

    private retire(tile: PreviewTile, uploaded: UploadedTile): void {
        this.uploaded.delete(tile);
        if (this.host.device() === uploaded.device) uploaded.device.destroy(uploaded.texture);
    }
}
