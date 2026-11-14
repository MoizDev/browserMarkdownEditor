import { RENDER_CONSTANTS as POLICY } from './constants';
import type { ByteLease } from './gfx/api';
import type { MemoryAllocator, MemoryCacheHandle, MemoryGovernor, MemorySessionOwner } from './memoryGovernor';
import type { ResizeSurface, SurfaceResizeResult } from './surfaceBroker.types';

export interface SurfaceBackingOptions {
    readonly governor: MemoryGovernor;
    readonly paneId: string;
    readonly owner: MemorySessionOwner;
    readonly id: string;
    readonly canvas: HTMLCanvasElement;
    readonly displayed: boolean;
    readonly now: number;
}

/** Browser-owned canvas backing, not arena memory. A rebuilding canvas is ordinary working
 * scratch until the old display is zeroed and this exact allocation is promoted. Counting both
 * against the one display grant would prevent a full-size pane from ever restoring its GPU.
 */
export class SurfaceBacking implements MemoryAllocator {
    private readonly display: MemoryCacheHandle;
    private readonly scratch: MemoryCacheHandle;
    private readonly leases = new Set<ByteLease>();
    private displayed: boolean;
    private closed = false;

    constructor(private readonly options: SurfaceBackingOptions) {
        if (options.canvas.width || options.canvas.height) throw new Error('A backing must start at zero size');
        this.displayed = options.displayed;
        const common = { paneId: options.paneId, owner: options.owner, hiddenAt: null, lastVisibleAt: options.now, lastUsedAt: options.now };
        const bytes = () => options.canvas.width * options.canvas.height * POLICY.surfaceReserveBytesPerPixel;
        this.display = options.governor.register({
            ...common, id: `${options.id}:display`, pool: 'gpu', kind: 'surface', class: 'critical',
            memory: () => ({ live: this.displayed ? bytes() : 0, retiring: 0 }), evict: () => {},
        });
        try {
            this.scratch = options.governor.register({
                ...common, id: `${options.id}:candidate`, pool: 'gpu', kind: 'canvas-working', class: 'critical',
                memory: () => ({ live: this.displayed ? 0 : bytes(), retiring: 0 }), evict: () => {},
            });
        } catch (error) { this.display.close(); throw error; }
    }

    /** Reservations can exceed a shrunken canvas until an indivisible lease can be returned. */
    get reservedBytes(): number { return [...this.leases].reduce((sum, lease) => sum + lease.bytes, 0); }

    reserve(bytes: number): ByteLease | null {
        if (this.closed) return null;
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes % POLICY.surfaceReserveBytesPerPixel !== 0) throw new RangeError('Invalid surface reservation');
        const lease = (this.displayed ? this.display : this.scratch).reserve(bytes);
        if (lease) this.leases.add(lease);
        return lease;
    }

    release(lease: ByteLease): void {
        if (!this.leases.has(lease)) throw new Error('Foreign surface lease');
        this.options.governor.releaseLease(lease);
        this.leases.delete(lease);
    }

    /** Reserve the incremental peak before asking the browser for the new backing. A failed
     * resize keeps its charge until the caller zeros the actual canvas, never pretending it freed.
     */
    resize(width: number, height: number, resizeSurface: ResizeSurface): SurfaceResizeResult | null {
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0) throw new RangeError('Invalid backing size');
        const requested = width * height * POLICY.surfaceReserveBytesPerPixel;
        if (!Number.isSafeInteger(requested)) throw new RangeError('Backing size exceeds safe accounting');
        const held = [...this.leases].reduce((sum, lease) => sum + lease.bytes, 0);
        if (requested > held && !this.reserve(requested - held)) return null;
        const result = resizeSurface(width, height);
        if (result.complete && result.width === width && result.height === height) {
            let spare = [...this.leases].reduce((sum, lease) => sum + lease.bytes, 0) - requested;
            for (const lease of this.leases) {
                if (lease.bytes <= spare) { this.release(lease); spare -= lease.bytes; }
            }
        }
        return result;
    }

    /** The caller has synchronously zeroed the actual canvas, not merely requested cleanup. */
    releaseZeroed(): void {
        if (this.options.canvas.width || this.options.canvas.height) throw new Error('Canvas backing is still live');
        for (const lease of this.leases) this.release(lease);
    }

    /** Called only after the selected old canvas has released its actual backing. */
    promote(): boolean {
        if (this.closed) return false;
        if (this.displayed) return true;
        if (!this.options.governor.promoteCanvasBacking([...this.leases], this.display)) return false;
        this.displayed = true;
        return true;
    }

    setVisible(visible: boolean, now: number): void {
        const activity = { hiddenAt: visible ? null : now, lastVisibleAt: now, lastUsedAt: now };
        this.display.updateActivity(activity);
        this.scratch.updateActivity(activity);
    }

    /** Compositor/backend teardown must really zero its canvas before its accounting disappears. */
    close(): void {
        if (this.closed) return;
        if (this.options.canvas.width || this.options.canvas.height || this.leases.size) throw new Error('Release the backing before closing its budget');
        this.closed = true;
        this.display.close();
        this.scratch.close();
    }
}
