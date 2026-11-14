/* PDF-private CPU mirrors for the temporary platform preview. The classic canvas remains
 * the producer and is never transferred or cleared by this store. */

import type { PreviewRect } from '../../utils/pdfPreviewTypes';

interface BitmapLease { readonly id: number; readonly bytes: number }

export interface BitmapAllocator {
    reserve(bytes: number): BitmapLease | null;
    release(lease: BitmapLease): void;
}

export interface PreviewTile {
    readonly bitmap: ImageBitmap;
    readonly destination: PreviewRect;
    readonly source: PreviewRect;
    readonly bytes: number;
    readonly lease: BitmapLease;
}

export interface PreviewPage {
    readonly key: string;
    readonly tiles: readonly PreviewTile[];
}

interface PendingCopy {
    cancelled: boolean;
}

// The 512px interior plus one real texel per side fits the scheduler's one-tile progress admission.
const CROP_SIDE = 512;

function closeTiles(tiles: readonly PreviewTile[], allocator: BitmapAllocator): void {
    for (const tile of tiles) {
        tile.bitmap.close();
        allocator.release(tile.lease);
    }
}

/** Owns its copies, not the viewer canvases. All mutation is on the main thread. */
export class PreviewBitmapStore {
    private readonly pages = new Map<number, PreviewPage>();
    private readonly pending = new Map<number, PendingCopy>();
    private visible = true;
    private disposed = false;
    private pendingBytes = 0;
    private revisionValue = 0;

    constructor(private readonly allocator: BitmapAllocator, private readonly onChange: () => void) {}

    get revision(): number { return this.revisionValue; }
    get entries(): ReadonlyMap<number, PreviewPage> { return this.pages; }

    get cpuBytes(): number {
        let bytes = this.pendingBytes;
        for (const page of this.pages.values()) {
            for (const tile of page.tiles) bytes += tile.bytes;
        }
        return bytes;
    }

    /** The caller's current predicate checks document identity, request serial and source canvas.
     * Check it after every await: createImageBitmap can finish after eviction, hide or a new blit. */
    async publish(index: number, key: string, canvas: HTMLCanvasElement, destination: PreviewRect, current: () => boolean, interest?: PreviewRect): Promise<boolean> {
        this.cancel(index);
        if (this.disposed || !this.visible || !current()) return false;
        const width = canvas.width;
        const height = canvas.height;
        if (width <= 0 || height <= 0 || !Number.isFinite(destination.x) || !Number.isFinite(destination.y)
            || !Number.isFinite(destination.width) || !Number.isFinite(destination.height)
            || destination.width <= 0 || destination.height <= 0) return false;
        if (interest && (!Number.isFinite(interest.x) || !Number.isFinite(interest.y)
            || !Number.isFinite(interest.width) || !Number.isFinite(interest.height)
            || interest.width <= 0 || interest.height <= 0)) return false;
        const x0 = interest ? Math.max(0, Math.floor((interest.x - destination.x) * width / destination.width)) : 0;
        const y0 = interest ? Math.max(0, Math.floor((interest.y - destination.y) * height / destination.height)) : 0;
        const x1 = interest ? Math.min(width, Math.ceil((interest.x + interest.width - destination.x) * width / destination.width)) : width;
        const y1 = interest ? Math.min(height, Math.ceil((interest.y + interest.height - destination.y) * height / destination.height)) : height;
        if (x1 <= x0 || y1 <= y0) return false;
        const pending: PendingCopy = { cancelled: false };
        this.pending.set(index, pending);
        const tiles: PreviewTile[] = [];
        let promoted = false;
        try {
            for (let y = y0; y < y1; y += CROP_SIDE) {
                for (let x = x0; x < x1; x += CROP_SIDE) {
                    const w = Math.min(CROP_SIDE, x1 - x);
                    const h = Math.min(CROP_SIDE, y1 - y);
                    const cropX = Math.max(0, x - 1), cropY = Math.max(0, y - 1);
                    const cropRight = Math.min(width, x + w + 1), cropBottom = Math.min(height, y + h + 1);
                    const cropWidth = cropRight - cropX, cropHeight = cropBottom - cropY;
                    const bytes = cropWidth * cropHeight * 4;
                    const lease = this.allocator.reserve(bytes);
                    if (!lease) return false;
                    this.pendingBytes += bytes;
                    let bitmap: ImageBitmap;
                    try {
                        bitmap = await createImageBitmap(canvas, cropX, cropY, cropWidth, cropHeight, { premultiplyAlpha: 'premultiply' });
                    } catch (error) {
                        this.pendingBytes -= bytes;
                        this.allocator.release(lease);
                        throw error;
                    }
                    tiles.push({
                        bitmap,
                        lease,
                        source: { x: x - cropX, y: y - cropY, width: w, height: h },
                        destination: {
                            x: destination.x + destination.width * x / width,
                            y: destination.y + destination.height * y / height,
                            width: destination.width * w / width,
                            height: destination.height * h / height,
                        },
                        bytes,
                    });
                    if (pending.cancelled || this.disposed || !this.visible || !current()
                        || canvas.width !== width || canvas.height !== height) return false;
                }
            }
            const old = this.pages.get(index);
            this.pendingBytes -= tiles.reduce((sum, tile) => sum + tile.bytes, 0);
            this.pages.set(index, { key, tiles });
            promoted = true;
            this.revisionValue++;
            try {
                this.onChange();
            } finally {
                if (old) closeTiles(old.tiles, this.allocator);
            }
            return true;
        } finally {
            if (this.pending.get(index) === pending) this.pending.delete(index);
            if (!promoted) {
                this.pendingBytes -= tiles.reduce((sum, tile) => sum + tile.bytes, 0);
                closeTiles(tiles, this.allocator);
            }
        }
    }

    remove(index: number): void {
        this.cancel(index);
        const old = this.pages.get(index);
        if (!old) return;
        this.pages.delete(index);
        this.revisionValue++;
        try {
            this.onChange();
        } finally {
            closeTiles(old.tiles, this.allocator);
        }
    }

    setVisible(visible: boolean): void {
        if (this.disposed || this.visible === visible) return;
        this.visible = visible;
        if (!visible) this.clear();
    }

    clear(): void {
        for (const pending of this.pending.values()) pending.cancelled = true;
        this.pending.clear();
        if (!this.pages.size) return;
        const old = Array.from(this.pages.values());
        this.pages.clear();
        this.revisionValue++;
        try {
            this.onChange();
        } finally {
            for (const page of old) closeTiles(page.tiles, this.allocator);
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.clear();
    }

    private cancel(index: number): void {
        const pending = this.pending.get(index);
        if (pending) pending.cancelled = true;
        this.pending.delete(index);
    }
}
