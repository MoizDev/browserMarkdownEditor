import type { Rect, ViewState } from '../types';
import type { FrameEncoder, GpuPass } from './gfx/api';
import type { Webgl2Owner } from './gfx/webgl2';
import type { MemoryAllocator, MemorySessionOwner } from './memoryGovernor';
import { getPlatformRuntime } from './platformRuntime';
import { PaneCapturer } from './capture';
import type { CaptureGpuOwner, CaptureOptions, CaptureRequest, CaptureSnapshot } from './capture';
import { CaptureQueue } from './captureQueue';

/** One queue across every session; it never starts work or retains a pane by itself (design §4.6). */
const queue = new CaptureQueue();
let cacheSerial = 0;

interface CaptureGpuScope {
    withCapturePass(encoder: FrameEncoder, pass: GpuPass, view: ViewState, paint: (scope: GpuPass) => void): void;
}
type ScopedCaptureOwner = CaptureGpuOwner & CaptureGpuScope;
const gpuOwners = new Map<string, () => ScopedCaptureOwner | null>();

/** Internal pane adapter capability; document/PDF code never receives a WebGL owner. */
export function registerCaptureGpu(paneId: string, getOwner: () => ScopedCaptureOwner | null): () => void {
    if (gpuOwners.has(paneId)) throw new Error('A GPU capture route is already registered for this pane');
    gpuOwners.set(paneId, getOwner);
    return () => { if (gpuOwners.get(paneId) === getOwner) gpuOwners.delete(paneId); };
}

/** Callbacks remain bound to the originating generation, including a loss during readback. */
export function captureGpuOwner(owner: Webgl2Owner, compositor: CaptureGpuScope): ScopedCaptureOwner {
    return {
        resources: owner.resources,
        acquireTarget: request => owner.acquireTarget(request),
        releaseTarget: lease => owner.releaseTarget(lease),
        discardFrame: encoder => owner.discardFrame(encoder),
        withCapturePass: (encoder, pass, view, paint) => compositor.withCapturePass(encoder, pass, view, paint),
    };
}

export interface PlatformCapturerOptions {
    readonly paneId: string;
    readonly owner: MemorySessionOwner;
    /** Synchronously retain one immutable revision and its resources. */
    snapshot(request: CaptureRequest, memory: MemoryAllocator): CaptureSnapshot;
}

/** Session-owned, never view-owned: a hide/unmount removes only the optional GPU route.
 * CPU temporary backing is admitted separately from the producer's retained source leases.
 */
export function createPlatformCapturer(options: PlatformCapturerOptions): {
    captureRegion(worldRect: Rect, maxSidePx: number, options: CaptureOptions): Promise<ImageBitmap>;
    dispose(): void;
} {
    const now = performance.now();
    let live = 0;
    const cache = getPlatformRuntime().governor.register({ id: `capture:${options.paneId}:${++cacheSerial}`,
        owner: options.owner, pool: 'cpu', kind: 'capture', class: 'critical', hiddenAt: null,
        lastVisibleAt: now, lastUsedAt: now, memory: () => ({ live, retiring: 0 }), evict: () => {} });
    const memory: MemoryAllocator = {
        reserve: bytes => { const lease = cache.reserve(bytes); if (lease) live += lease.bytes; return lease; },
        release: lease => { cache.release(lease); live -= lease.bytes; },
    };
    const capturer = new PaneCapturer({ paneId: options.paneId, queue, memory, snapshot: request => options.snapshot(request, memory),
        tryGpu: () => gpuOwners.get(options.paneId)?.() ?? null });
    let disposed = false;
    return {
        captureRegion: (rect, maxSide, request) => capturer.captureRegion(rect, maxSide, request),
        dispose: () => { if (!disposed) { disposed = true; capturer.dispose(); cache.close(); } },
    };
}
