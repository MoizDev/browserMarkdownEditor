import type { ViewState } from '../../platform/types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { BufferHandle, BufferSlice, ByteLease, GfxDevice, GpuPass, PipelineHandle, RectI } from '../../platform/render/gfx/api';
import type { FrameBudget, FrameToken } from '../../platform/render/types';
import { analyticInkPaint, type AnalyticInkPaint } from './analyticInk';
import { auditCount } from '../../platform/render/renderAudit';
import type { Admission, PreparedRun } from './gpu/contracts';
import type { PaintInkItem } from './paintStream';
import { ANALYTIC_INK_BATCH_SHADER, ANALYTIC_INK_RUN_SHADER, ANALYTIC_INK_RUN_STRIDE } from './analyticInkBatchShader';

const STRIDE = 48, SLABS = [64 * 1024, 128 * 1024, 256 * 1024] as const;
type Slab = Readonly<{ buffer: BufferHandle; count: number; size: number; firstPaintIndex: number; bounds: RectI }>;
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
    device: GfxDevice; index: number; slabs: Slab[]; pending: PendingSlab | null;
    nodeIndices: Map<string, number[]> | null; mapLease: ByteLease | null };
function mapBytes(count: number): number {
    const bytes = 1024 + count * 192;
    if (!Number.isSafeInteger(bytes)) throw new RangeError('Analytic batch index exceeds safe accounting');
    return bytes;
}
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
    // A refused reservation does not poll (needsFrame() is false while denied): it waits for a real capacity change.
    const awaitCapacity = (): void => {
        const wake = () => host.invalidate('analytic-batch-capacity');
        host.allocator.cpu.whenAvailable?.(wake); host.allocator.gpu.whenAvailable?.(wake);
    };
    let device: GfxDevice | null = null, pipeline: PipelineHandle | null = null, pendingPipeline = false, failed = false, incarnation = 0;
    let building: Build | null = null, disposed = false, denied = false, gpuBytes = 0, cpuBytes = 0;
    let currentToken: FrameToken | null = null, currentCameraEpoch = -1;
    const live = new Map<PreparedAnalyticInkBatch, { viewport: Float32Array; lease: ByteLease; mapLease: ByteLease; nodeIndices: Map<string, number[]> }>();
    const dropBuild = () => {
        const old = building; building = null;
        if (!old) return;
        if (old.pending) { host.allocator.cpu.release(old.pending.lease); cpuBytes -= old.pending.lease.bytes; }
        if (old.mapLease) { host.allocator.cpu.release(old.mapLease); cpuBytes -= old.mapLease.bytes; }
        for (const slab of old.slabs) { old.device.destroy(slab.buffer); gpuBytes -= slab.size; }
    };
    const retire = (batch: PreparedAnalyticInkBatch) => {
        const owned = live.get(batch);
        if (!owned) return;
        live.delete(batch); host.allocator.cpu.release(owned.lease); host.allocator.cpu.release(owned.mapLease);
        cpuBytes -= owned.lease.bytes + owned.mapLease.bytes;
        for (const slab of batch.slabs) { batch.device.destroy(slab.buffer); gpuBytes -= slab.size; }
    };
    const release = () => {
        incarnation++; dropBuild(); for (const batch of live.keys()) retire(batch);
        if (pipeline) device?.destroy(pipeline);
        device = null; pipeline = null; pendingPipeline = false; failed = false; denied = false; currentToken = null; currentCameraEpoch = -1;
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
    const warm = () => {
        if (disposed) return;
        const next = host.device();
        if (device !== next) { release(); device = next; }
        ensurePipeline();
    };
    return {
        warm,
        ready(): boolean { return !disposed && !failed && !!pipeline && !!device && host.device() === device && host.generation === device.generation; },
        failed(): boolean { return failed; },
        needsFrame(): boolean { return !disposed && !failed && !!pipeline && !!building && !denied; },
        memory(): { gpuBytes: number; cpuBytes: number } { return { gpuBytes, cpuBytes }; },
        cpuWorkingSet(nextPaintCount = 0): { mandatoryBytes: number; prefetchBytes: number } {
            return { mandatoryBytes: cpuBytes + SLABS[2] + 16 + (building?.mapLease ? 0 : mapBytes(nextPaintCount)), prefetchBytes: 0 };
        },
        prepare(paints: readonly AnalyticInkPaint[], view: ViewState, budget: FrameBudget): PreparedAnalyticInkBatch | null {
            if (disposed) return null;
            warm();
            if (!device || device.generation !== budget.token.deviceGeneration || host.generation !== budget.token.deviceGeneration) return null;
            currentToken = { ...budget.token }; currentCameraEpoch = budget.cameraEpoch; denied = false;
            if (!pipeline || failed) return null;
            const key = projection(view);
            const matches = (candidate: { paints: readonly AnalyticInkPaint[]; token: FrameToken; cameraEpoch: number; projection: string; device: GfxDevice }) =>
                candidate.paints === paints && sameToken(candidate.token, budget.token) && candidate.cameraEpoch === budget.cameraEpoch &&
                candidate.projection === key && candidate.device === device;
            for (const batch of live.keys()) if (matches(batch)) return batch;
            if (building && !matches(building)) dropBuild();
            if (!building) building = { paints, token: { ...budget.token }, cameraEpoch: budget.cameraEpoch, projection: key,
                device, index: 0, slabs: [], pending: null, nodeIndices: null, mapLease: null };
            const build = building;
            try {
                if (!build.mapLease) {
                    const lease = host.allocator.cpu.reserve(mapBytes(paints.length));
                    if (!lease) { denied = true; awaitCapacity(); return null; }
                    cpuBytes += lease.bytes; build.mapLease = lease; build.nodeIndices = new Map();
                }
                if (!build.pending && build.index < paints.length) {
                    if (budget.shouldYield()) return null;
                    const remaining = paints.length - build.index;
                    const size = SLABS.find(bytes => Math.floor(bytes / STRIDE) >= remaining) ?? SLABS[2];
                    const lease = host.allocator.cpu.reserve(size);
                    if (!lease) { denied = true; awaitCapacity(); return null; }
                    cpuBytes += lease.bytes;
                    try { build.pending = { data: new Float32Array(size / 4), lease, size,
                        count: Math.min(remaining, Math.floor(size / STRIDE)), index: 0, bounds: null }; }
                    catch (error) { host.allocator.cpu.release(lease); cpuBytes -= lease.bytes; throw error; }
                }
                const slab = build.pending;
                if (slab) {
                    while (slab.index < slab.count && !budget.shouldYield()) {
                        const paint = paints[build.index + slab.index];
                        if (paint.data.length !== 16) throw new RangeError('Invalid analytic ink instance');
                        slab.data.set(paint.data.subarray(4, 16), slab.index * 12);
                        const indices = build.nodeIndices!.get(paint.item.nodeId);
                        if (indices) indices.push(build.index + slab.index);
                        else build.nodeIndices!.set(paint.item.nodeId, [build.index + slab.index]);
                        if (paint.bounds.width && paint.bounds.height) slab.bounds = union(slab.bounds, paint.bounds);
                        slab.index++;
                    }
                    if (slab.index < slab.count) return null;
                    const gpuLease = host.allocator.gpu.reserve(slab.size);
                    if (!gpuLease) { denied = true; awaitCapacity(); return null; }
                    const bytes = slab.count * STRIDE;
                    if (!budget.claimUpload(bytes)) { host.allocator.gpu.release(gpuLease); return null; }
                    let buffer: BufferHandle | null = null, attached = false;
                    try {
                        buffer = device.createBuffer(slab.size, ['vertex', 'copy-dst'], gpuLease); attached = true;
                        device.writeBuffer(buffer, 0, slab.data.subarray(0, slab.count * 12));
                        build.slabs.push({ buffer, count: slab.count, size: slab.size, firstPaintIndex: build.index, bounds: slab.bounds ?? { x: 0, y: 0, width: 0, height: 0 } });
                        gpuBytes += slab.size; buffer = null;
                    } finally {
                        if (buffer) device.destroy(buffer);
                        if (!attached) host.allocator.gpu.release(gpuLease);
                    }
                    build.index += slab.count; host.allocator.cpu.release(slab.lease); cpuBytes -= slab.lease.bytes; build.pending = null;
                    if (build.index < paints.length) return null;
                }
                const lease = host.allocator.cpu.reserve(16);
                if (!lease) { denied = true; awaitCapacity(); return null; }
                cpuBytes += lease.bytes;
                try {
                    const viewport = new Float32Array([Math.round(view.viewport.width * view.viewport.dpr), Math.round(view.viewport.height * view.viewport.dpr), 0, 0]);
                    const batch: PreparedAnalyticInkBatch = Object.freeze({ paints, token: Object.freeze({ ...build.token }), cameraEpoch: build.cameraEpoch,
                        projection: key, device, slabs: Object.freeze(build.slabs) });
                    live.set(batch, { viewport, lease, mapLease: build.mapLease!, nodeIndices: build.nodeIndices! }); building = null; return batch;
                } catch (error) { host.allocator.cpu.release(lease); cpuBytes -= lease.bytes; throw error; }
            } catch (error) { dropBuild(); failed = true; report(error); return null; }
        },
        draw(pass: GpuPass, batch: PreparedAnalyticInkBatch, view: ViewState, omitNodes?: ReadonlySet<string>): void {
            if (disposed || !live.has(batch) || !pipeline || batch.device !== device || host.device() !== device ||
                !currentToken || !sameToken(batch.token, currentToken) || batch.cameraEpoch !== currentCameraEpoch ||
                host.generation !== batch.token.deviceGeneration || batch.projection !== projection(view)) throw new Error('Stale analytic ink batch');
            const owned = live.get(batch)!;
            const omitted: number[] = [];
            if (omitNodes?.size) for (const node of omitNodes) {
                const indices = owned.nodeIndices.get(node);
                if (indices) for (const index of indices) omitted.push(index);
            }
            omitted.sort((a, b) => a - b);
            const uniforms = host.uniforms(owned.viewport);
            let omitIndex = 0;
            for (const slab of batch.slabs) {
                const start = slab.firstPaintIndex, end = start + slab.count;
                while (omitIndex < omitted.length && omitted[omitIndex] < start) omitIndex++;
                let next = start;
                const drawRange = (from: number, to: number) => {
                    if (to <= from || !slab.bounds.width || !slab.bounds.height) return;
                    pass.draw({ pipeline: pipeline!, bindings: { uniforms: [{ binding: 0, slice: uniforms }], textures: [] },
                        vertices: [{ buffer: slab.buffer, offset: (from - start) * STRIDE, bytes: (to - from) * STRIDE }],
                        first: 0, count: 4, instances: to - from, scissor: slab.bounds });
                };
                while (omitIndex < omitted.length && omitted[omitIndex] < end) {
                    const index = omitted[omitIndex++];
                    if (index >= next) { drawRange(next, index); next = index + 1; }
                }
                drawRange(next, end);
            }
        },
        cancel(paints: readonly AnalyticInkPaint[]): void { if (building?.paints === paints) dropBuild(); },
        retire,
        release,
        dispose(): void { if (!disposed) { disposed = true; release(); } },
    };
}

// The run route (gpu-h5): a run of analytic capsules is packed once, uploaded in slabs, and drawn as one instanced draw
// per slab. It is the route behind inkRouteFor's 'ink-analytic'; the batch above stays only for the running adapter.

const NO_TEXTURES: readonly never[] = [];
/** Slabs are bounded so one upload stays inside a frame's allowance; a run larger than a slab takes several. */
const RUN_SLAB_BYTES = 256 * 1024;
const RUN_STRIDE = ANALYTIC_INK_RUN_STRIDE;
/** One uploaded slab, of one colour group. Its vertex slice is built once, at admission, so a draw builds only the command. */
interface AnalyticSlab {
    readonly buffer: BufferHandle; readonly count: number; readonly bytes: number; readonly bounds: RectI;
    readonly vertices: readonly BufferSlice[]; readonly group: number;
}
/** Consecutive items of one colour, in item order: a draw's colour is one uniform, so a colour change starts a group. The
 * colour is read from the group's first item at each draw (a run holds its items), and written into `uniforms` in place. */
interface ColourGroup { readonly items: readonly PaintInkItem[]; readonly uniforms: Float32Array }
/** A run admitted for one view. Its slabs are immutable GPU buffers, drawn in item order, one colour group at a time. */
export class AnalyticInkRun implements PreparedRun {
    readonly route = 'ink-analytic' as const;
    readonly blend = 'over' as const;
    constructor(readonly device: GfxDevice, readonly slabs: readonly AnalyticSlab[], readonly groups: readonly ColourGroup[],
        readonly instances: number) {}
}

/** Admits runs of analytic capsules, one view at a time. Packing is the single-item function's (analyticInkPaint), so the
 * run's pixels are the single item's pixels; only the upload and the draw are batched. */
export function createAnalyticInkRuns(host: LayerHost, audit: string) {
    let device: GfxDevice | null = null, pipeline: PipelineHandle | null = null, pending = false, failed = false, incarnation = 0;
    let gpuBytes = 0;
    // One packing scratch, reused across admissions: writeBuffer copies its bytes before it returns. It is a CPU lease like
    // any other: the governor requires every byte a route reports to be reserved, so the scratch reports exactly its lease.
    const FLOATS = RUN_STRIDE / 4;
    let staging = new Float32Array(0), stagingLease: ByteLease | null = null;
    const growStaging = (instances: number): boolean => {
        if (staging.length >= instances * FLOATS) return true;
        const bytes = Math.max(instances * RUN_STRIDE, staging.byteLength * 2);
        const lease = host.allocator.cpu.reserve(bytes);
        if (!lease) return false;
        const next = new Float32Array(bytes / 4);
        next.set(staging); staging = next;
        if (stagingLease) host.allocator.cpu.release(stagingLease);
        stagingLease = lease;
        return true;
    };
    const live = new Set<AnalyticInkRun>();
    const destroyRun = (run: AnalyticInkRun): void => {
        if (!live.delete(run)) return;
        for (const slab of run.slabs) { run.device.destroy(slab.buffer); gpuBytes -= slab.bytes; }
    };
    const release = (): void => {
        incarnation++;
        for (const run of [...live]) destroyRun(run);
        if (pipeline && device) device.destroy(pipeline);
        pipeline = null; device = null; pending = false; failed = false;
        if (stagingLease) host.allocator.cpu.release(stagingLease);
        stagingLease = null; staging = new Float32Array(0);
    };
    const ensurePipeline = (owner: GfxDevice): boolean => {
        if (pipeline) return true;
        if (pending || failed) return false;
        const serial = ++incarnation; pending = true;
        try {
            owner.createPipeline({ shader: ANALYTIC_INK_RUN_SHADER, topology: 'triangle-strip', colorFormat: 'rgba8', samples: 1,
                blend: 'source-over', alphaToCoverage: false, colorWrite: [true, true, true, true], stencil: { enabled: false } })
                .then(value => {
                    if (incarnation !== serial || device !== owner) { owner.destroy(value); return; }
                    pipeline = value; pending = false; host.invalidate('analytic-batch-ready');
                }, () => {
                    if (incarnation !== serial) return;
                    pending = false; failed = true; auditCount(audit, 'error:analytic-pipeline'); host.invalidate('analytic-batch-fallback');
                });
        } catch {
            pending = false; failed = true; auditCount(audit, 'error:analytic-pipeline');
        }
        return false;
    };
    return {
        admit(items: readonly PaintInkItem[], view: ViewState, budget: FrameBudget): Admission<AnalyticInkRun> {
            const current = host.device();
            if (!current) return { status: 'unsupported', why: 'no-device' };
            if (current !== device) { release(); device = current; }
            if (failed) return { status: 'unsupported', why: 'analytic-pipeline' };
            if (!ensurePipeline(current)) return { status: 'deferred' };
            if (current.generation !== budget.token.deviceGeneration || host.generation !== budget.token.deviceGeneration) return { status: 'deferred' };
            // Phase one packs every drawn instance's geometry into the scratch and groups consecutive items of one colour, in
            // item order: the groups change the uniform between draws, never the order the items composite in.
            const rects: RectI[] = [], groupOf: number[] = [], groupItems: PaintInkItem[][] = [], groupKeys: number[][] = [];
            for (const item of items) {
                const paint = analyticInkPaint(item, view);
                if (!paint) return { status: 'unsupported', why: 'analytic-unpackable' };
                if (!paint.bounds.width || !paint.bounds.height) continue;
                const n = rects.length;
                if (!growStaging(n + 1)) return { status: 'denied', pool: 'cpu', bytes: (n + 1) * RUN_STRIDE };
                staging.set(paint.data.subarray(4, 12), n * FLOATS);
                rects.push(paint.bounds);
                const colour = item.material.color, last = groupKeys.length - 1;
                if (last < 0 || !sameColour(groupKeys[last], colour)) { groupKeys.push([colour[0], colour[1], colour[2], colour[3]]); groupItems.push([item]); }
                else groupItems[last].push(item);
                groupOf.push(groupKeys.length - 1);
            }
            if (!rects.length) return { status: 'empty' };
            const groups: ColourGroup[] = groupItems.map(items => ({ items, uniforms: Float32Array.of(width(view), height(view), 0, 0, 0, 0, 0, 0) }));
            // Phase two uploads one slab at a time, never across a colour group; any refusal retires the slabs already made.
            const perSlab = Math.floor(RUN_SLAB_BYTES / RUN_STRIDE);
            const created: AnalyticSlab[] = [];
            const rollback = (): void => {
                for (const slab of created) { current.destroy(slab.buffer); gpuBytes -= slab.bytes; }
            };
            for (let start = 0; start < rects.length;) {
                if (start > 0 && budget.shouldYield()) { rollback(); return { status: 'deferred' }; }
                const group = groupOf[start];
                let end = start;
                while (end < rects.length && groupOf[end] === group && end - start < perSlab) end++;
                const bytes = (end - start) * RUN_STRIDE;
                if (!budget.claimUpload(bytes)) { rollback(); return { status: 'deferred' }; }
                const lease = host.allocator.gpu.reserve(bytes);
                if (!lease) { rollback(); return { status: 'denied', pool: 'gpu', bytes }; }
                let buffer: BufferHandle | null = null;
                try {
                    buffer = current.createBuffer(bytes, ['vertex', 'copy-dst'], lease);
                    current.writeBuffer(buffer, 0, staging.subarray(start * FLOATS, end * FLOATS));
                } catch (error) {
                    if (buffer) current.destroy(buffer); else host.allocator.gpu.release(lease);
                    rollback();
                    throw error;
                }
                let bounds: RectI | null = null;
                for (let i = start; i < end; i++) bounds = union(bounds, rects[i]);
                created.push({ buffer, count: end - start, bytes, bounds: bounds!, group,
                    vertices: [{ buffer, offset: 0, bytes }] });
                gpuBytes += bytes;
                auditCount(audit, 'upload:vertex', 1, { bytes });
                start = end;
            }
            const run = new AnalyticInkRun(current, created, groups, rects.length);
            live.add(run);
            return { status: 'ready', value: run };
        },
        draw(pass: GpuPass, run: AnalyticInkRun): void {
            const ready = pipeline;
            if (!live.has(run) || !ready || run.device !== device || host.device() !== device || host.generation !== run.device.generation) {
                throw new Error('Stale analytic ink run');
            }
            let drawn = -1;
            for (const slab of run.slabs) {
                const group = run.groups[slab.group];
                // The colour is the group's current colour, read from its first item and premultiplied in place: no allocation.
                if (slab.group !== drawn) { drawn = slab.group; writeColour(group); }
                // The uniform slice is per frame, so one is taken per draw; the empty texture list is shared.
                const bindings = { uniforms: [{ binding: 0, slice: host.uniforms(group.uniforms) }], textures: NO_TEXTURES };
                pass.draw({ pipeline: ready, bindings, vertices: slab.vertices, first: 0, count: 4, instances: slab.count, scissor: slab.bounds });
            }
            auditCount(audit, 'route:ink-analytic', run.instances);
        },
        retire: destroyRun,
        release,
        memory(): { gpuBytes: number; cpuBytes: number } { return { gpuBytes, cpuBytes: stagingLease?.bytes ?? 0 }; },
    };
}
function width(view: ViewState): number { return Math.round(view.viewport.width * view.viewport.dpr); }
function height(view: ViewState): number { return Math.round(view.viewport.height * view.viewport.dpr); }
function sameColour(key: readonly number[], colour: readonly number[]): boolean {
    return key[0] === colour[0] && key[1] === colour[1] && key[2] === colour[2] && key[3] === colour[3];
}
/** Writes a group's premultiplied colour (the packing's own convention: rgb·α, α) into its uniforms, in place. */
function writeColour(group: ColourGroup): void {
    const colour = group.items[0].material.color, alpha = colour[3], u = group.uniforms;
    u[4] = colour[0] * alpha; u[5] = colour[1] * alpha; u[6] = colour[2] * alpha; u[7] = alpha;
}
