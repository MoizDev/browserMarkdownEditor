import type { ViewState } from '../../platform/types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { BufferHandle, ByteLease, GfxDevice, GpuPass, PipelineHandle, RectI } from '../../platform/render/gfx/api';
import type { FrameBudget, FrameToken } from '../../platform/render/types';
import type { AnalyticInkPaint } from './analyticInk';
import { ANALYTIC_INK_BATCH_SHADER } from './analyticInkBatchShader';

const STRIDE = 48, SLABS = [64 * 1024, 128 * 1024, 256 * 1024] as const;
type Slab = Readonly<{ buffer: BufferHandle; count: number; bounds: RectI }>;
export interface PreparedAnalyticInkBatch {
    readonly paints: readonly AnalyticInkPaint[];
    readonly token: FrameToken;
    readonly cameraEpoch: number;
    readonly projection: string;
    readonly device: GfxDevice;
    readonly slabs: readonly Slab[];
}
type PendingSlab = { data: Float32Array; lease: ByteLease; size: number; count: number; index: number; bounds: RectI | null };
type Build = { paints: readonly AnalyticInkPaint[]; token: FrameToken; cameraEpoch: number; projection: string;
    device: GfxDevice; index: number; slabs: Slab[]; pending: PendingSlab | null };
function projection(view: ViewState): string {
    const { camera: c, viewport: v } = view;
    return JSON.stringify([c.x, c.y, c.z, v.width, v.height, v.dpr]);
}
function sameToken(a: FrameToken, b: FrameToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration &&
        a.session === b.session && a.viewLease === b.viewLease && a.deviceGeneration === b.deviceGeneration;
}
function union(a: RectI | null, b: RectI): RectI {
    if (!a) return { ...b };
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Immutable uploaded slabs are never overwritten while a submitted frame can still read them. */
export function createAnalyticInkBatch(host: LayerHost, report: (error: unknown) => void) {
    let device: GfxDevice | null = null, pipeline: PipelineHandle | null = null, pendingPipeline = false, failed = false, incarnation = 0;
    let building: Build | null = null, disposed = false;
    let currentToken: FrameToken | null = null, currentCameraEpoch = -1;
    const live = new Map<PreparedAnalyticInkBatch, { viewport: Float32Array; lease: ByteLease }>();
    const dropBuild = () => {
        const old = building; building = null;
        if (!old) return;
        if (old.pending) host.allocator.cpu.release(old.pending.lease);
        for (const slab of old.slabs) old.device.destroy(slab.buffer);
    };
    const retire = (batch: PreparedAnalyticInkBatch) => {
        const owned = live.get(batch);
        if (!owned) return;
        live.delete(batch); host.allocator.cpu.release(owned.lease);
        for (const slab of batch.slabs) batch.device.destroy(slab.buffer);
    };
    const release = () => {
        incarnation++; dropBuild(); for (const batch of live.keys()) retire(batch);
        if (pipeline) device?.destroy(pipeline);
        device = null; pipeline = null; pendingPipeline = false; failed = false; currentToken = null; currentCameraEpoch = -1;
    };
    const ensurePipeline = () => {
        if (!device || pipeline || pendingPipeline || failed) return;
        const owner = device, serial = ++incarnation; pendingPipeline = true;
        try {
            owner.createPipeline({ shader: ANALYTIC_INK_BATCH_SHADER, topology: 'triangle-strip', colorFormat: 'rgba8', samples: 1,
                blend: 'source-over', alphaToCoverage: false, colorWrite: [true, true, true, true], stencil: { enabled: false } })
                .then(value => {
                    if (disposed || incarnation !== serial || device !== owner) { owner.destroy(value); return; }
                    pipeline = value; pendingPipeline = false; host.invalidate('analytic-batch-ready');
                }, error => {
                    if (incarnation !== serial) return;
                    pendingPipeline = false; failed = true; report(error); host.invalidate('analytic-batch-fallback');
                });
        } catch (error) { pendingPipeline = false; failed = true; report(error); }
    };
    return {
        prepare(paints: readonly AnalyticInkPaint[], view: ViewState, budget: FrameBudget): PreparedAnalyticInkBatch | null {
            if (disposed) return null;
            const next = host.device();
            if (device !== next) { release(); device = next; }
            if (!device || device.generation !== budget.token.deviceGeneration || host.generation !== budget.token.deviceGeneration) return null;
            currentToken = { ...budget.token }; currentCameraEpoch = budget.cameraEpoch;
            ensurePipeline();
            if (!pipeline) return null;
            const key = projection(view);
            const matches = (candidate: { paints: readonly AnalyticInkPaint[]; token: FrameToken; cameraEpoch: number; projection: string; device: GfxDevice }) =>
                candidate.paints === paints && sameToken(candidate.token, budget.token) && candidate.cameraEpoch === budget.cameraEpoch &&
                candidate.projection === key && candidate.device === device;
            for (const batch of live.keys()) if (matches(batch)) return batch;
            if (building && !matches(building)) dropBuild();
            if (!building) building = { paints, token: { ...budget.token }, cameraEpoch: budget.cameraEpoch, projection: key,
                device, index: 0, slabs: [], pending: null };
            const build = building;
            try {
                if (!build.pending && build.index < paints.length) {
                    if (budget.shouldYield()) return null;
                    const remaining = paints.length - build.index;
                    const size = SLABS.find(bytes => Math.floor(bytes / STRIDE) >= remaining) ?? SLABS[2];
                    const lease = host.allocator.cpu.reserve(size);
                    if (!lease) return null;
                    try { build.pending = { data: new Float32Array(size / 4), lease, size,
                        count: Math.min(remaining, Math.floor(size / STRIDE)), index: 0, bounds: null }; }
                    catch (error) { host.allocator.cpu.release(lease); throw error; }
                }
                const slab = build.pending;
                if (slab) {
                    while (slab.index < slab.count && !budget.shouldYield()) {
                        const paint = paints[build.index + slab.index];
                        if (paint.data.length !== 16) throw new RangeError('Invalid analytic ink instance');
                        slab.data.set(paint.data.subarray(4, 16), slab.index * 12);
                        if (paint.bounds.width && paint.bounds.height) slab.bounds = union(slab.bounds, paint.bounds);
                        slab.index++;
                    }
                    if (slab.index < slab.count) return null;
                    const gpuLease = host.allocator.gpu.reserve(slab.size);
                    if (!gpuLease) return null;
                    const bytes = slab.count * STRIDE;
                    if (!budget.claimUpload(bytes)) { host.allocator.gpu.release(gpuLease); return null; }
                    let buffer: BufferHandle | null = null, attached = false;
                    try {
                        buffer = device.createBuffer(slab.size, ['vertex', 'copy-dst'], gpuLease); attached = true;
                        device.writeBuffer(buffer, 0, slab.data.subarray(0, slab.count * 12));
                        build.slabs.push({ buffer, count: slab.count, bounds: slab.bounds ?? { x: 0, y: 0, width: 0, height: 0 } });
                        buffer = null;
                    } finally {
                        if (buffer) device.destroy(buffer);
                        if (!attached) host.allocator.gpu.release(gpuLease);
                    }
                    build.index += slab.count; host.allocator.cpu.release(slab.lease); build.pending = null;
                    if (build.index < paints.length) return null;
                }
                const lease = host.allocator.cpu.reserve(16);
                if (!lease) return null;
                try {
                    const viewport = new Float32Array([Math.round(view.viewport.width * view.viewport.dpr), Math.round(view.viewport.height * view.viewport.dpr), 0, 0]);
                    const batch: PreparedAnalyticInkBatch = Object.freeze({ paints, token: Object.freeze({ ...build.token }), cameraEpoch: build.cameraEpoch,
                        projection: key, device, slabs: Object.freeze(build.slabs) });
                    live.set(batch, { viewport, lease }); building = null; return batch;
                } catch (error) { host.allocator.cpu.release(lease); throw error; }
            } catch (error) { dropBuild(); report(error); return null; }
        },
        draw(pass: GpuPass, batch: PreparedAnalyticInkBatch, view: ViewState): void {
            if (disposed || !live.has(batch) || !pipeline || batch.device !== device || host.device() !== device ||
                !currentToken || !sameToken(batch.token, currentToken) || batch.cameraEpoch !== currentCameraEpoch ||
                host.generation !== batch.token.deviceGeneration || batch.projection !== projection(view)) throw new Error('Stale analytic ink batch');
            const uniforms = host.uniforms(live.get(batch)!.viewport);
            for (const slab of batch.slabs) {
                if (!slab.bounds.width || !slab.bounds.height) continue;
                pass.draw({ pipeline, bindings: { uniforms: [{ binding: 0, slice: uniforms }], textures: [] },
                    vertices: [{ buffer: slab.buffer, offset: 0, bytes: slab.count * STRIDE }], first: 0, count: 4,
                    instances: slab.count, scissor: slab.bounds });
            }
        },
        retire,
        release,
        dispose(): void { if (!disposed) { disposed = true; release(); } },
    };
}
