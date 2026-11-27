import type { Rect, ViewState } from '../types';
import type { FrameEncoder, GpuPass } from './gfx/api';
import type { Webgl2Owner } from './gfx/webgl2';
import type { MemoryAllocator, MemorySessionOwner } from './memoryGovernor';
import { getPlatformRuntime } from './platformRuntime';
import { PaneCapturer } from './capture';
import type { CaptureExportOptions, CaptureGpuOwner, CaptureOptions, CapturePngEncoder, CaptureRequest, CaptureSnapshot } from './capture';
import { CaptureQueue } from './captureQueue';
import { GpuIsolationPlan } from './gpuIsolationPlan';
import type { RenderToken } from './types';

const queue = new CaptureQueue();
let cacheSerial = 0;

interface CaptureGpuScope {
    withCapturePass(encoder: FrameEncoder, pass: GpuPass, view: ViewState, paint: (scope: GpuPass) => void): void;
}
type ScopedCaptureOwner = CaptureGpuOwner & CaptureGpuScope;
const gpuOwners = new Map<string, { readonly token: RenderToken; readonly getOwner: () => ScopedCaptureOwner | null }>();

export function registerCaptureGpu(paneId: string, token: RenderToken, getOwner: () => ScopedCaptureOwner | null): () => void {
    if (gpuOwners.has(paneId)) throw new Error('A GPU capture route is already registered for this pane');
    const route = { token: Object.freeze({ ...token }), getOwner };
    gpuOwners.set(paneId, route);
    return () => { if (gpuOwners.get(paneId) === route) gpuOwners.delete(paneId); };
}

export function captureGpuOwner(owner: Webgl2Owner, compositor: CaptureGpuScope): ScopedCaptureOwner {
    return {
        resources: owner.resources,
        acquireTarget: request => owner.acquireTarget(request),
        releaseTarget: lease => owner.releaseTarget(lease),
        discardFrame: encoder => owner.discardFrame(encoder),
        prepareIsolation: (view, inventory) => {
            const plan = new GpuIsolationPlan(Math.ceil(view.viewport.width * view.viewport.dpr),
                Math.ceil(view.viewport.height * view.viewport.dpr));
            for (const declaration of inventory) plan.declare(declaration);
            return owner.admitIsolation(plan.finish());
        },
        withCapturePass: (encoder, pass, view, paint) => compositor.withCapturePass(encoder, pass, view, paint),
    };
}

export interface PlatformCapturerOptions {
    readonly paneId: string;
    readonly owner: MemorySessionOwner;
    snapshot(request: CaptureRequest, memory: MemoryAllocator): CaptureSnapshot;
    readonly encodePngTiles?: CapturePngEncoder;
}

export function createPlatformCapturer(options: PlatformCapturerOptions): {
    captureRegion(worldRect: Rect, maxSidePx: number, options: CaptureOptions): Promise<ImageBitmap>;
    captureBlob(worldRect: Rect, maxSidePx: number, options: CaptureOptions): Promise<Blob>;
    captureExportBlob(worldRect: Rect, maxSidePx: number, options: CaptureExportOptions): Promise<Blob>;
    dispose(): Promise<void>;
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
        encodePngTiles: options.encodePngTiles,
        tryGpu: snapshot => {
            for (const route of gpuOwners.values()) {
                const a = route.token, b = snapshot.token;
                if (a.vaultEpoch !== b.vaultEpoch || a.documentId !== b.documentId ||
                    a.bytesGeneration !== b.bytesGeneration || a.session !== b.session) continue;
                const owner = route.getOwner();
                if (owner) return owner;
            }
            return null;
        } });
    let closing: Promise<void> | null = null;
    return {
        captureRegion: (rect, maxSide, request) => capturer.captureRegion(rect, maxSide, request),
        captureBlob: (rect, maxSide, request) => capturer.captureBlob(rect, maxSide, request),
        captureExportBlob: (rect, maxSide, request) => capturer.captureExportBlob(rect, maxSide, request),
        dispose: () => closing ??= capturer.dispose().finally(() => cache.close()),
    };
}
