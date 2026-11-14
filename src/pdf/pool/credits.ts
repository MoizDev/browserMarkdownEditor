import type { PageTileArgs, PageTileResult } from '../worker/protocol';

const MAX_REPLIES = 8;
const MAX_BYTES = 16 * 1024 * 1024;

/** Credits cover posted requests AND arrived buffers until the bitmap consumer
 * explicitly releases them, so fast workers cannot outrun the upload budget. */
export class TileCredits {
    private count = 0;
    private bytes = 0;
    private readonly held = new WeakMap<PageTileResult, () => void>();
    constructor(private readonly changed: () => void) {}

    reserve(args: PageTileArgs): (() => void) | null {
        const { x, y, w, h } = args.rect;
        if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || !Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1 ||
            w + 2 > 2048 || h + 2 > 2048 ||
            !Number.isFinite(args.scale) || args.scale <= 0) throw new RangeError('Invalid PDF tile extent');
        const size = (w + 2) * (h + 2) * 4;
        if (!Number.isSafeInteger(size) || size > MAX_BYTES) throw new RangeError('PDF tile exceeds reply credit');
        if (this.count >= MAX_REPLIES || this.bytes + size > MAX_BYTES) return null;
        this.count++; this.bytes += size;
        let live = true;
        return () => {
            if (!live) return;
            live = false;
            this.count--; this.bytes -= size;
            this.changed();
        };
    }
    publish(result: PageTileResult, release: () => void): void {
        this.held.set(result, release);
    }
    release(result: PageTileResult): void {
        const release = this.held.get(result);
        if (!release) return;
        this.held.delete(result);
        release();
    }
}
