import { auditCount, auditStage, PerDeviceMap, renderAuditEnabled } from './renderAudit';
import type { Affine, Rgba } from '../types';
import type { LayerHost } from './compositor.types';
import type { MemoryAllocator } from './memoryGovernor';
import type { BufferHandle, BufferSlice, ClipHandle, CoverageOutput, CoverageTarget, DrawCommand, GfxDevice, GpuPass, PipelineHandle, RectI, Samples, ShaderModule, StencilOp, StencilState, ByteLease, UniformSlice } from './gfx/api';
import { coverageTargetBytes } from './gfx/api';
import { ArenaError } from './resourceArena';
import type { FrameBudget } from './types';

export type PathCoverageRule = 'nonzero' | 'evenodd' | 'union';

/** Winding of any point is bounded by the number of edges crossing a ray from it, and an 8-bit
 * stencil counting with wrapping arithmetic keeps a nonzero winding nonzero while that bound is at
 * most 255. Nonzero shapes with more edges must take their exact fallback. */
export const PATH_COVERAGE_STENCIL_MAX_EDGES = 255;
export const PATH_COVERAGE_SAMPLES: Samples = 4;
const PATH_COVERAGE_MAX_TARGET_BYTES = 8 * 2 ** 20;
const PATH_COVERAGE_SCRATCH_BYTES = 2 * 2 ** 20;
const PATH_COVERAGE_GRID_SCRATCH_BYTES = 8 * 2 ** 20;
const scratchCap = (grid: CompositeGrid): number => grid === 4 ? PATH_COVERAGE_GRID_SCRATCH_BYTES : PATH_COVERAGE_SCRATCH_BYTES;
const PATH_COVERAGE_MIN_SCRATCH_BAND_BYTES = 256 * 1024;
const PATH_COVERAGE_UPLOAD_CHUNK_BYTES = 64 * 1024;
const PATH_COVERAGE_UPLOAD_MIN_PIECE_BYTES = 4 * 1024;
const PATH_COVERAGE_VERTEX_STRIDE_BYTES = 8;
const IDLE_VERTEX_BYTES = 8 * 2 ** 20;
interface Pack { readonly key: string; readonly shape: PathCoverageShapes; readonly lease: ByteLease; readonly bytes: number; usedFrame: number;
    readonly members: readonly number[] }
function premultipliedInto(into: number[], rgba: Rgba, modulate: boolean): number[] {
    const [r, g, b, a] = rgba;
    const pr = r * a, pg = g * a, pb = b * a;
    into[0] = modulate ? pr + 1 - a : pr; into[1] = modulate ? pg + 1 - a : pg; into[2] = modulate ? pb + 1 - a : pb;
    into[3] = modulate ? 1 : a;
    return into;
}
function copyShifted(src: Float64Array, dst: Float64Array, at: number, dx: number, dy: number): number {
    if (dx === 0 && dy === 0) { dst.set(src, at); return at + src.length; }
    for (let i = 0; i < src.length; i += 2) { dst[at + i] = src[i] + dx; dst[at + i + 1] = src[i + 1] + dy; }
    return at + src.length;
}
const kitsOnDevice = new PerDeviceMap<GfxDevice, Map<object, MemoryAllocator>>();
interface ScratchCharge { readonly holder: object; readonly gpu: MemoryAllocator; readonly lease: ByteLease }
interface SharedScratch { readonly device: GfxDevice; readonly target: CoverageTarget; readonly bytes: number; refs: number;
    usedFrame: number;
    charge: ScratchCharge;
    readonly targetLease: ByteLease }
const PATH_COVERAGE_SCRATCH_IDLE_FRAMES = 3;
type CompositeGrid = 1 | 4;
const scratchTables: Record<'1' | '4', { readonly targets: PerDeviceMap<GfxDevice, SharedScratch>; readonly widths: PerDeviceMap<GfxDevice, number> }> = {
    '1': { targets: new PerDeviceMap(), widths: new PerDeviceMap() },
    '4': { targets: new PerDeviceMap(), widths: new PerDeviceMap() },
};

export interface PathCoverageShapes {
    readonly positive: Float64Array;
    readonly negative: Float64Array;
    readonly edges: number;
    readonly bounds: Readonly<{ x0: number; y0: number; x1: number; y1: number }>;
    readonly shift?: readonly [number, number];
}

export interface PathCoverageRequest {
    readonly shapes: PathCoverageShapes;
    readonly rule: PathCoverageRule;
    readonly affine: Affine;
    readonly viewport: Readonly<{ width: number; height: number }>;
    readonly colour: Rgba;
    readonly output: CoverageOutput;
    readonly supersample?: boolean;
    readonly sampling?: 'msaa' | 'grid4';
}

export interface PathCoverageSetsRequest extends Omit<PathCoverageRequest, 'shapes'> {
    readonly sets: readonly PathCoverageShapes[];
}

export type PathCoverageAdmission =
    | { readonly status: 'ready'; readonly value: PreparedPathCoverage }
    | { readonly status: 'empty' }
    | { readonly status: 'denied'; readonly pool: 'gpu' | 'cpu'; readonly bytes: number }
    | { readonly status: 'deferred' }
    | { readonly status: 'unsupported' };

type Denial = Extract<PathCoverageAdmission, { readonly status: 'denied' }>;
export interface PreparedPathPart {
    readonly vertices: BufferHandle;
    readonly positiveVertices: number;
    readonly negativeVertices: number;
    readonly bindings: readonly BufferSlice[];
    readonly set: VertexSet;
}

interface VertexSet {
    readonly key: Float64Array;
    readonly device: GfxDevice;
    readonly buffer: BufferHandle;
    readonly negative: Float64Array;
    positiveVertices: number;
    readonly negativeVertices: number;
    refs: number;
    readonly bytes: number;
    used: number;
    readonly chain?: Chain;
    usedFrame: number;
}
interface Chain {
    readonly key: Float64Array;
    readonly lead: number;
    readonly data: Float32Array;
    readonly bytes: number;
    readonly lease: ByteLease;
    ids: readonly number[];
    len: number;
    released: boolean;
}
interface Upload {
    readonly key: Float64Array;
    readonly device: GfxDevice;
    readonly buffer: BufferHandle;
    readonly data: Float32Array;
    readonly staging: ByteLease | null;
    written: number;
    readonly negative: Float64Array;
    readonly positiveVertices: number;
    readonly negativeVertices: number;
    readonly bytes: number;
    readonly capacity: number;
    usedFrame: number;
    piece: number;
    readonly chain?: Chain;
}
const EMPTY_TRIANGLES = new Float64Array(0);

export interface PreparedPathCoverage {
    readonly device: GfxDevice;
    readonly target: CoverageTarget | null;
    readonly parts: readonly PreparedPathPart[];
    readonly clip: ClipHandle | null;
    readonly rule: PathCoverageRule;
    readonly output: CoverageOutput;
    readonly bounds: RectI;
    readonly viewport: Readonly<{ width: number; height: number }>;
    readonly affine: Affine;
    readonly colour: readonly [number, number, number, number];
    readonly gpuBytes: number;
    readonly supersample: boolean;
    readonly modulate: boolean;
    readonly grid: CompositeGrid;
    readonly scratch: boolean;
}

const KEEP_FACE = { fail: 'keep', depthFail: 'keep', pass: 'keep' } as const;
function winding(op: StencilOp): StencilState {
    const face = { fail: 'keep', depthFail: 'keep', pass: op } as const;
    return { enabled: true, compare: 'always', reference: 0, readMask: 255, writeMask: 255, front: face, back: face };
}
const UNION_STENCIL: StencilState = { enabled: true, compare: 'always', reference: 1, readMask: 255, writeMask: 255,
    front: { fail: 'keep', depthFail: 'keep', pass: 'replace' }, back: { fail: 'keep', depthFail: 'keep', pass: 'replace' } };
const COVER_STENCIL: StencilState = { enabled: true, compare: 'not-equal', reference: 0, readMask: 255, writeMask: 0,
    front: KEEP_FACE, back: KEEP_FACE };
const NO_COLOUR_WRITE = [false, false, false, false] as const;
const COVER_WHITE: readonly number[] = [1, 1, 1, 1];
const COVER_RESET_STENCIL: StencilState = { enabled: true, compare: 'not-equal', reference: 0, readMask: 255, writeMask: 255,
    front: { fail: 'keep', depthFail: 'keep', pass: 'zero' }, back: { fail: 'keep', depthFail: 'keep', pass: 'zero' } };
const UNION_JITTER: readonly (readonly [number, number])[] = [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]];

const UNIFORM_BYTES = 48;
const WINDING_SHADER: ShaderModule = {
    id: 'platform-path-winding', revision: 1,
    layout: { uniforms: [{ binding: 0, byteSize: UNIFORM_BYTES }], textures: [], attributes: [
        { location: 0, bufferSlot: 0, offset: 0, stride: 8, format: 'float32x2', step: 'vertex' },
    ] },
    glsl: {
        vertex: `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 { vec4 viewport; vec4 matrix; vec4 translation; };
layout(location=0) in vec2 local;
void main() {
    vec2 pixel=vec2(matrix.x*local.x+matrix.z*local.y+translation.x,matrix.y*local.x+matrix.w*local.y+translation.y);
    vec2 unit=pixel/viewport.xy;
    gl_Position=vec4(unit.x*2.0-1.0,1.0-unit.y*2.0,0.0,1.0);
}`,
        fragment: `#version 300 es
precision highp float;
out vec4 fragmentColour;
void main() { fragmentColour=vec4(0.0); }`,
    },
};
const COVER_SHADER: ShaderModule = {
    id: 'platform-path-cover', revision: 1,
    layout: { uniforms: [{ binding: 0, byteSize: UNIFORM_BYTES }], textures: [], attributes: [] },
    glsl: {
        vertex: `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 { vec4 viewport; vec4 rect; vec4 colour; };
flat out vec4 fillColour;
void main() {
    vec2 corner=vec2(float(gl_VertexID&1),float((gl_VertexID>>1)&1));
    vec2 pixel=rect.xy+corner*rect.zw;
    vec2 unit=pixel/viewport.xy;
    gl_Position=vec4(unit.x*2.0-1.0,1.0-unit.y*2.0,0.0,1.0);
    fillColour=colour;
}`,
        fragment: `#version 300 es
precision highp float;
flat in vec4 fillColour;
out vec4 fragmentColour;
void main() { fragmentColour=fillColour; }`,
    },
};

interface Pipelines {
    readonly increment: PipelineHandle; readonly decrement: PipelineHandle;
    readonly invert: PipelineHandle; readonly union: PipelineHandle; readonly cover: PipelineHandle; readonly coverAdd: PipelineHandle;
    readonly coverModulate: PipelineHandle;
    readonly gridIncrement: PipelineHandle; readonly gridDecrement: PipelineHandle; readonly gridInvert: PipelineHandle;
    readonly gridUnion: PipelineHandle; readonly gridCover: PipelineHandle;
}
interface SharedPipelines { users: number; value: Pipelines | null; dead: boolean; readonly generation: number; readonly promise: Promise<Pipelines> }
const pipelinesOnDevice = new PerDeviceMap<GfxDevice, SharedPipelines>();
function destroyPipelines(owner: GfxDevice, set: Pipelines): void { for (const handle of Object.values(set)) owner.destroy(handle); }
function acquirePipelines(owner: GfxDevice, create: () => Promise<Pipelines>): SharedPipelines {
    const known = pipelinesOnDevice.get(owner);
    if (known && known.generation === owner.generation) { known.users++; return known; }
    if (known) { known.dead = true; if (known.users === 0 && known.value) { destroyPipelines(owner, known.value); known.value = null; } }
    const entry: SharedPipelines = { users: 1, value: null, dead: false, generation: owner.generation, promise: create() };
    pipelinesOnDevice.set(owner, entry);
    entry.promise.then(set => { if (entry.dead && entry.users === 0) destroyPipelines(owner, set); else entry.value = set; },
        () => { entry.dead = true; if (pipelinesOnDevice.get(owner) === entry) pipelinesOnDevice.delete(owner); });
    return entry;
}
function releasePipelines(owner: GfxDevice, entry: SharedPipelines): void {
    if (--entry.users > 0 || !entry.dead) return;
    if (entry.value) { destroyPipelines(owner, entry.value); entry.value = null; }
}

export function createPathCoverageKit(host: LayerHost, report: (error: unknown) => void, audit = 'path-coverage',
    onFreed?: (key: Float64Array) => void) {
    let device: GfxDevice | null = null, pipelines: Pipelines | null = null, pending = false, failed = false, unsupported = false;
    let pipelineSet: SharedPipelines | null = null;
    let incarnation = 0, disposed = false, gpuBytes = 0;
    const live = new Map<PreparedPathCoverage, number>();
    const shared = new Map<Float64Array, VertexSet>();
    const chains = new Map<number, Chain>();
    const chainKeys = new WeakSet<Float64Array>();
    // Uniform data is filled and copied into the frame's ring by host.uniforms before the next fill (the ring copies it
    // synchronously), so one array serves every uniform a draw needs.
    const uniformScratch = new Float32Array(12);
    const uploading = new Map<Float64Array, Upload>();
    const packs = new Map<string, Pack>(), packOfArray = new Map<Float64Array, Pack>(), arrayIds = new WeakMap<Float64Array, number>();
    const packsOfMember = new Map<number, Set<Pack>>();
    let nextArrayId = 0, packedBytes = 0;
    const idOf = (array: Float64Array): number => {
        let id = arrayIds.get(array);
        if (id === undefined) arrayIds.set(array, id = ++nextArrayId);
        return id;
    };
    const freePack = (pack: Pack) => {
        packs.delete(pack.key); packOfArray.delete(pack.shape.positive); packedBytes -= pack.bytes;
        for (const id of pack.members) {
            const built = packsOfMember.get(id);
            if (built) { built.delete(pack); if (built.size === 0) packsOfMember.delete(id); }
        }
        host.allocator.cpu.release(pack.lease);
    };
    const freed = (key: Float64Array) => {
        if (chainKeys.has(key)) return;
        const pack = packOfArray.get(key);
        if (pack) freePack(pack); else onFreed?.(key);
    };
    const dropUpload = (key: Float64Array) => {
        const up = uploading.get(key);
        if (!up) return;
        uploading.delete(key); gpuBytes -= up.capacity;
        if (!shared.has(key)) freed(key);
        if (up.staging) host.allocator.cpu.release(up.staging);
        up.device.destroy(up.buffer);
        if (up.chain) releaseChain(up.chain);
    };
    const idle = new Map<Float64Array, VertexSet>();
    let idleBytes = 0, frame = 0;
    let scratchGrowth = false;
    let drawRefusedFrame = -1;
    const releaseChain = (chain: Chain): void => {
        if (chain.released) return;
        chain.released = true;
        if (chains.get(chain.lead) === chain) chains.delete(chain.lead);
        packedBytes -= chain.bytes; host.allocator.cpu.release(chain.lease);
    };
    const destroySet = (entry: VertexSet) => {
        shared.delete(entry.key); gpuBytes -= entry.bytes; entry.device.destroy(entry.buffer);
        if (entry.chain) releaseChain(entry.chain);
        if (!uploading.has(entry.key)) freed(entry.key);
    };
    const unidle = (entry: VertexSet) => { if (idle.delete(entry.key)) idleBytes -= entry.bytes; };
    const reclaimIdle = (bytes: number): number => {
        let freed = 0;
        for (const entry of idle.values()) {
            if (freed >= bytes) break;
            if (entry.usedFrame >= frame - 1) continue;
            idle.delete(entry.key); idleBytes -= entry.bytes; freed += entry.bytes; destroySet(entry);
        }
        return freed;
    };
    const holdSet = (entry: VertexSet) => { if (entry.refs === 0) unidle(entry); entry.refs++; entry.usedFrame = frame; };
    const releaseShared = (entry: VertexSet) => {
        if (--entry.refs > 0) return;
        entry.usedFrame = frame;
        idle.delete(entry.key); idle.set(entry.key, entry); idleBytes += entry.bytes;
        // Trimmed only here: a set reserved by an admission still being built has zero refs and must not be destroyed under it.
        if (idleBytes > IDLE_VERTEX_BYTES) reclaimIdle(idleBytes - IDLE_VERTEX_BYTES);
    };
    const retireOwned = (prepared: PreparedPathCoverage) => {
        const bytes = live.get(prepared);
        if (bytes === undefined) return;
        live.delete(prepared); gpuBytes -= bytes;
        if (prepared.scratch) releaseScratch(prepared.device, prepared.grid);
        if (prepared.clip) prepared.device.destroy(prepared.clip);
        if (prepared.target) { prepared.device.destroy(prepared.target.target); prepared.device.destroy(prepared.target.texture); }
        for (const part of prepared.parts) releaseShared(part.set);
    };
    const scratchOf = (owner: GfxDevice | null, grid: CompositeGrid): SharedScratch | undefined =>
        owner ? scratchTables[String(grid) as '1' | '4'].targets.get(owner) : undefined;
    const releaseScratch = (owner: GfxDevice, grid: CompositeGrid) => {
        const shared = scratchOf(owner, grid);
        if (shared && shared.refs > 0) shared.refs--;
    };
    const destroyScratchTarget = (owner: GfxDevice, shared: SharedScratch): void => {
        owner.destroy(shared.target.target); owner.destroy(shared.target.texture);
        if (shared.charge.lease !== shared.targetLease) shared.charge.gpu.release(shared.charge.lease);
    };
    const destroyScratch = (owner: GfxDevice, grid: CompositeGrid, reason: 'release' | 'evict' | 'growth'): number => {
        const table = scratchTables[String(grid) as '1' | '4'];
        const shared = table.targets.get(owner);
        if (!shared) return 0;
        auditCount(audit, `kit:scratch-dropped:${reason}`, 1, { bytes: shared.bytes });
        table.targets.delete(owner);
        destroyScratchTarget(owner, shared);
        return shared.bytes;
    };
    const kitToken = {};
    const joinDevice = (owner: GfxDevice): void => {
        let kits = kitsOnDevice.get(owner);
        if (!kits) kitsOnDevice.set(owner, kits = new Map());
        kits.set(kitToken, host.allocator.gpu);
    };
    const rehome = (owner: GfxDevice, grid: CompositeGrid): void => {
        const shared = scratchOf(owner, grid);
        const kits = kitsOnDevice.get(owner);
        if (!shared || !kits || kits.has(shared.charge.holder)) return;
        for (const [holder, gpu] of kits) {
            const lease = gpu.reserve(shared.bytes);
            if (!lease) continue;
            // A reservation can trim the pool, and that can drop this very scratch: then the new lease is not needed.
            if (scratchOf(owner, grid) !== shared) { gpu.release(lease); return; }
            shared.charge.gpu.release(shared.charge.lease);
            shared.charge = { holder, gpu, lease };
            auditCount(audit, 'kit:scratch-rehomed', 1, { bytes: shared.bytes });
            return;
        }
        auditCount(audit, 'kit:scratch-rehome-refused', 1, { bytes: shared.bytes });
    };
    const leaveDevice = (owner: GfxDevice): void => {
        const kits = kitsOnDevice.get(owner);
        if (!kits || !kits.delete(kitToken)) return;
        if (kits.size > 0) { rehome(owner, 1); rehome(owner, 4); return; }
        destroyScratch(owner, 1, 'release'); destroyScratch(owner, 4, 'release');
    };
    const ensureScratch = (owner: GfxDevice, width: number, height: number, grid: CompositeGrid): true | number | 'unsupported' => {
        const table = scratchTables[String(grid) as '1' | '4'];
        const samples = grid === 4 ? 1 : PATH_COVERAGE_SAMPLES;
        const rowBytes = coverageTargetBytes(width, 1, samples, grid);
        if (rowBytes > scratchCap(grid)) return 'unsupported';
        const cap = owner.limits.maxRenderTargetSize;
        if (width * grid > cap) return 'unsupported';
        const fullBand = (w: number): number =>
            Math.min(Math.floor(scratchCap(grid) / coverageTargetBytes(w, 1, samples, grid)), Math.floor(cap / grid));
        const current = table.targets.get(owner);
        const kept = current && current.target.width >= width ? current.target.width : 0;
        const needed = Math.max(width, table.widths.get(owner) ?? 0);
        const rounded = 2 ** Math.ceil(Math.log2(needed));
        const fitsRounded = rounded * grid <= cap && coverageTargetBytes(rounded, 1, samples, grid) <= scratchCap(grid);
        const w = kept || (fitsRounded ? rounded : needed);
        if (w * grid > cap) return 'unsupported';
        const band = fullBand(w);
        const exact = Math.min(height, band);
        if (current && kept && current.target.height >= exact) { rehome(owner, grid); return true; }
        const roundedHeight = Math.min(band, 2 ** Math.ceil(Math.log2(exact)));
        const sizes: number[] = roundedHeight > exact ? [roundedHeight, exact] : [exact];
        const minRows = Math.max(1, Math.floor(PATH_COVERAGE_MIN_SCRATCH_BAND_BYTES / coverageTargetBytes(w, 1, samples, grid)));
        for (let rows = Math.floor(exact / 2); rows >= minRows; rows = Math.floor(rows / 2)) sizes.push(rows);
        let reclaimed = false;
        if (current && current.refs === 0) { table.targets.delete(owner); destroyScratchTarget(owner, current); reclaimed = true; }
        let lease: ByteLease | null = null;
        let h = exact, bytes = 0;
        for (let attempt = 0; attempt < sizes.length; attempt++) {
            h = sizes[attempt]; bytes = coverageTargetBytes(w, h, samples, grid);
            lease = host.allocator.gpu.reserve(bytes);
            if (lease) break;
            if (attempt + 1 < sizes.length) auditCount(audit, 'kit:scratch-height-fallback', 1, { bytes });
        }
        if (!lease) {
            auditCount(audit, 'kit:scratch-refused', 1, { bytes, asked: coverageTargetBytes(w, sizes[0], samples, grid) });
            if (current && current.refs > 0) scratchGrowth = true;
            return bytes;
        }
        let target: CoverageTarget;
        try { target = owner.createCoverageTarget(w, h, samples, lease, grid === 4 ? { grid: 4 } : undefined); }
        catch (error) { host.allocator.gpu.release(lease); throw error; }
        if (current && !reclaimed) destroyScratchTarget(owner, current);
        table.widths.set(owner, w);
        table.targets.set(owner, { device: owner, target, bytes, refs: current?.refs ?? 0, usedFrame: frame,
            charge: { holder: kitToken, gpu: host.allocator.gpu, lease }, targetLease: lease });
        auditCount(audit, grid === 4 ? 'kit:grid4-scratch-new' : 'kit:scratch-new', 1, { bytes });
        return true;
    };
    const release = () => {
        incarnation++;
        const owner = device;
        for (const prepared of [...live.keys()]) retireOwned(prepared);
        for (const entry of shared.values()) { gpuBytes -= entry.bytes; entry.device.destroy(entry.buffer); if (entry.chain) releaseChain(entry.chain); }
        const held = [...shared.keys()];
        shared.clear(); idle.clear(); idleBytes = 0;
        for (const key of held) if (!uploading.has(key)) freed(key);
        for (const key of [...uploading.keys()]) dropUpload(key);
        for (const pack of [...packs.values()]) freePack(pack);
        for (const chain of [...chains.values()]) releaseChain(chain);
        if (pipelineSet && owner) releasePipelines(owner, pipelineSet);
        pipelineSet = null; pipelines = null; device = null; pending = false; failed = false; unsupported = false;
        if (owner) leaveDevice(owner);
    };
    const ensurePipelines = () => {
        if (!device || pipelines || pending || failed) return;
        const owner = device, serial = ++incarnation;
        const base = { topology: 'triangles', colorFormat: 'rgba8', samples: PATH_COVERAGE_SAMPLES, alphaToCoverage: false } as const;
        const gridBase = { topology: 'triangles', colorFormat: 'r8', samples: 1, alphaToCoverage: false } as const;
        const hidden = { blend: 'replace', colorWrite: NO_COLOUR_WRITE } as const;
        const entry = pipelineSet = acquirePipelines(owner, () => Promise.all([
            owner.createPipeline({ ...base, ...hidden, shader: WINDING_SHADER, stencil: winding('increment-wrap') }),
            owner.createPipeline({ ...base, ...hidden, shader: WINDING_SHADER, stencil: winding('decrement-wrap') }),
            owner.createPipeline({ ...base, ...hidden, shader: WINDING_SHADER, stencil: winding('invert') }),
            owner.createPipeline({ ...base, ...hidden, shader: WINDING_SHADER, stencil: UNION_STENCIL }),
            owner.createPipeline({ ...base, topology: 'triangle-strip', shader: COVER_SHADER, blend: 'source-over',
                colorWrite: [true, true, true, true], stencil: COVER_STENCIL }),
            owner.createPipeline({ ...base, topology: 'triangle-strip', shader: COVER_SHADER, blend: 'add',
                colorWrite: [true, true, true, true], stencil: COVER_RESET_STENCIL }),
            owner.createPipeline({ ...base, topology: 'triangle-strip', shader: COVER_SHADER, blend: 'modulate',
                colorWrite: [true, true, true, true], stencil: COVER_STENCIL }),
            owner.createPipeline({ ...gridBase, ...hidden, shader: WINDING_SHADER, stencil: winding('increment-wrap') }),
            owner.createPipeline({ ...gridBase, ...hidden, shader: WINDING_SHADER, stencil: winding('decrement-wrap') }),
            owner.createPipeline({ ...gridBase, ...hidden, shader: WINDING_SHADER, stencil: winding('invert') }),
            owner.createPipeline({ ...gridBase, ...hidden, shader: WINDING_SHADER, stencil: UNION_STENCIL }),
            owner.createPipeline({ ...gridBase, topology: 'triangle-strip', shader: COVER_SHADER, blend: 'replace',
                colorWrite: [true, false, false, false], stencil: COVER_STENCIL }),
        ]).then(([increment, decrement, invert, union, cover, coverAdd, coverModulate,
            gridIncrement, gridDecrement, gridInvert, gridUnion, gridCover]): Pipelines => ({ increment, decrement, invert, union, cover, coverAdd,
            coverModulate, gridIncrement, gridDecrement, gridInvert, gridUnion, gridCover })));
        if (renderAuditEnabled()) auditCount(audit, entry.value ? 'pipelines:shared-ready' : entry.users > 1 ? 'pipelines:shared-pending' : 'pipelines:created');
        if (entry.value) { pipelines = entry.value; return; }
        pending = true;
        entry.promise.then(set => {
            if (disposed || incarnation !== serial || device !== owner || pipelineSet !== entry) return;
            pipelines = set; pending = false; host.invalidate('path-coverage-ready');
        }, error => {
            if (incarnation !== serial) return;
            pending = false; failed = true; report(error); host.invalidate('path-coverage-fallback');
        });
    };
    const warm = () => {
        if (disposed) return;
        const next = host.device();
        if (device !== next) { release(); device = next; if (next) joinDevice(next); }
        ensurePipelines();
    };
    const isReady = (): boolean => !disposed && !failed && !unsupported && !!pipelines && !!device &&
        host.device() === device && host.generation === device.generation;
    const supersedePacks = (members: readonly number[]): void => {
        const group = members.join(',');
        for (const pack of [...(packsOfMember.get(members[0]) ?? [])]) {
            if (pack.members.join(',') !== group || pack.usedFrame >= frame || uploading.has(pack.shape.positive)) continue;
            const entry = shared.get(pack.shape.positive);
            if (entry && entry.refs > 0) continue;
            if (entry) { unidle(entry); destroySet(entry); }
            freePack(pack);
            auditCount(audit, 'kit:pack-superseded');
        }
    };
    const packSets = (sets: readonly PathCoverageShapes[]): Pack | { readonly refused: number } => {
        const members = sets.flatMap(set => [idOf(set.positive), idOf(set.negative)]);
        const key = sets.map(set => `${idOf(set.positive)}.${idOf(set.negative)}@${set.shift?.[0] ?? 0},${set.shift?.[1] ?? 0}`).join('|');
        const known = packs.get(key);
        if (known) { known.usedFrame = frame; return known; }
        supersedePacks(members);
        let positive = 0, negative = 0, edges = 0;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const set of sets) {
            positive += set.positive.length; negative += set.negative.length; edges += set.edges;
            const [sx, sy] = set.shift ?? [0, 0];
            x0 = Math.min(x0, set.bounds.x0 + sx); y0 = Math.min(y0, set.bounds.y0 + sy);
            x1 = Math.max(x1, set.bounds.x1 + sx); y1 = Math.max(y1, set.bounds.y1 + sy);
        }
        const bytes = (positive + negative) * 8;
        const lease = host.allocator.cpu.reserve(bytes);
        if (!lease) return { refused: bytes };
        const pos = new Float64Array(positive), neg = new Float64Array(negative);
        let p = 0, n = 0;
        for (const set of sets) {
            const [sx, sy] = set.shift ?? [0, 0];
            p = copyShifted(set.positive, pos, p, sx, sy);
            n = copyShifted(set.negative, neg, n, sx, sy);
        }
        const pack: Pack = { key, shape: { positive: pos, negative: neg, edges, bounds: { x0, y0, x1, y1 } }, lease, bytes, usedFrame: frame, members };
        packs.set(key, pack); packOfArray.set(pos, pack); packedBytes += bytes;
        for (const id of members) {
            let built = packsOfMember.get(id);
            if (!built) packsOfMember.set(id, built = new Set());
            built.add(pack);
        }
        auditCount(audit, 'kit:pack', 1, { bytes });
        return pack;
    };
    const mapBounds = (bounds: PathCoverageShapes['bounds'], affine: Affine): { x0: number; y0: number; x1: number; y1: number } => {
        const [a, b, c, d, e, f] = affine;
        const corners = [[bounds.x0, bounds.y0], [bounds.x1, bounds.y0], [bounds.x0, bounds.y1], [bounds.x1, bounds.y1]];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of corners) {
            const px = a * x + c * y + e, py = b * x + d * y + f;
            if (!Number.isFinite(px) || !Number.isFinite(py)) throw new RangeError('Path device bounds are not finite');
            x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
        }
        return { x0, y0, x1, y1 };
    };
    const NO_TEXTURES: readonly never[] = Object.freeze([]), NO_VERTICES: readonly never[] = Object.freeze([]);
    const uniformEntry: { binding: number; slice: UniformSlice }[] = [{ binding: 0, slice: null as unknown as UniformSlice }];
    const command: DrawCommand = { pipeline: null as unknown as PipelineHandle, bindings: { uniforms: uniformEntry, textures: NO_TEXTURES },
        vertices: NO_VERTICES, first: 0, count: 0, instances: 1, scissor: null as unknown as RectI };
    const issue = (pass: GpuPass, pipeline: PipelineHandle, slice: UniformSlice, vertices: readonly BufferSlice[], first: number,
        count: number, scissor: RectI): void => {
        uniformEntry[0].slice = slice; command.pipeline = pipeline; command.vertices = vertices;
        command.first = first; command.count = count; command.scissor = scissor;
        pass.draw(command);
    };
    const drawWinding = (pass: GpuPass, part: PreparedPathPart, pipeline: PipelineHandle, windingUniforms: UniformSlice, scissor: RectI,
        first: number, count: number): void => {
        if (!count) return;
        issue(pass, pipeline, windingUniforms, part.bindings, first, count, scissor);
    };
    const paintCover: number[] = [0, 0, 0, 0];
    const paintOutput: { kind: 'paint'; blend: 'normal' | 'modulate'; rgb: [number, number, number]; alpha: number } =
        { kind: 'paint', blend: 'normal', rgb: [0, 0, 0], alpha: 0 };
    const bandRect: RectI = { x: 0, y: 0, width: 0, height: 0 };
    const renderCoverage = (pass: GpuPass, prepared: PreparedPathCoverage, paint?: Rgba): void => {
        if (disposed || !live.has(prepared) || !pipelines || prepared.device !== device || host.device() !== device ||
            host.generation !== prepared.device.generation) throw new Error('Stale path coverage');
        const { affine, viewport, output } = prepared;
        for (const part of prepared.parts) part.set.usedFrame = frame;
        if (paint && output.kind === 'mask') throw new Error('A paint colour applies to a composite, not a mask');
        const grid = prepared.grid === 4;
        const colour: readonly number[] = paint ? (grid ? paint : premultipliedInto(paintCover, paint, prepared.modulate)) : prepared.colour;
        let drawOutput: CoverageOutput = output;
        if (paint && output.kind === 'paint') {
            paintOutput.blend = output.blend; paintOutput.alpha = paint[3];
            paintOutput.rgb[0] = paint[0]; paintOutput.rgb[1] = paint[1]; paintOutput.rgb[2] = paint[2];
            drawOutput = paintOutput;
        }
        const target = prepared.target ?? scratchOf(prepared.device, prepared.grid)?.target;
        if (!target || target.width < prepared.bounds.width) throw new Error('Stale path coverage');
        const set = pipelines;
        const increment = grid ? set.gridIncrement : set.increment, decrement = grid ? set.gridDecrement : set.decrement;
        const invert = grid ? set.gridInvert : set.invert, union = grid ? set.gridUnion : set.union;
        const coverPipeline = grid ? set.gridCover : prepared.modulate ? set.coverModulate : set.cover;
        const coverColour = grid ? COVER_WHITE : colour;
        const windingUniforms = windingSlice(viewport, affine, 0, 0);
        const whole = prepared.bounds;
        const band = bandRect;
        band.x = whole.x; band.y = whole.y; band.width = whole.width; band.height = 0;
        const clip = pass.clipRect();
        if (clip.width <= 0 || clip.height <= 0 || clip.x >= whole.x + whole.width || clip.x + clip.width <= whole.x) { auditCount(audit, 'kit:clipped-out'); return; }
        const first = whole.y + Math.max(0, Math.floor((clip.y - whole.y) / target.height)) * target.height;
        const last = Math.min(whole.y + whole.height, clip.y + clip.height);
        for (let y = first; y < last; y += target.height) {
            band.y = y; band.height = Math.min(target.height, whole.y + whole.height - y);
            const coverUniforms = coverSlice(viewport, band, coverColour, 1);
            const token = pass.beginCoverage(target, band);
            if (grid) auditCount(audit, 'kit:resolve-bands');
            try {
                if (prepared.supersample && prepared.rule === 'union' && output.kind === 'composite') {
                    const quarterUniforms = coverSlice(viewport, band, colour, 0.25);
                    for (const [dx, dy] of UNION_JITTER) {
                        const jitteredUniforms = windingSlice(viewport, affine, dx, dy);
                        for (const part of prepared.parts) drawWinding(pass, part, union, jitteredUniforms, band, 0, part.positiveVertices);
                        issue(pass, set.coverAdd, quarterUniforms, NO_VERTICES, 0, 4, band);
                    }
                } else {
                    for (const part of prepared.parts) {
                        if (prepared.rule === 'evenodd') drawWinding(pass, part, invert, windingUniforms, band, 0, part.positiveVertices + part.negativeVertices);
                        else if (prepared.rule === 'union') drawWinding(pass, part, union, windingUniforms, band, 0, part.positiveVertices);
                        else {
                            drawWinding(pass, part, increment, windingUniforms, band, 0, part.positiveVertices);
                            drawWinding(pass, part, decrement, windingUniforms, band, part.positiveVertices, part.negativeVertices);
                        }
                    }
                    issue(pass, coverPipeline, coverUniforms, NO_VERTICES, 0, 4, band);
                }
            } finally { pass.endCoverage(token, drawOutput); }
        }
    };
    const render = (pass: GpuPass, prepared: PreparedPathCoverage, paint?: Rgba): void => {
        const started = renderAuditEnabled() ? performance.now() : null;
        try { renderCoverage(pass, prepared, paint); }
        catch (error) {
            if (!(error instanceof ArenaError) || error.code !== 'out-of-budget') throw error;
            drawRefusedFrame = frame;
            auditCount(audit, 'kit:draw-refused');
            host.invalidate('path-coverage-refused');
        } finally { if (started !== null) auditStage(audit, 'draw', performance.now() - started); }
    };
    const windingSlice = (viewport: Readonly<{ width: number; height: number }>, affine: Affine, dx: number, dy: number) => {
        const u = uniformScratch;
        u[0] = viewport.width; u[1] = viewport.height; u[2] = 0; u[3] = 0;
        u[4] = affine[0]; u[5] = affine[1]; u[6] = affine[2]; u[7] = affine[3]; u[8] = affine[4] + dx; u[9] = affine[5] + dy; u[10] = 0; u[11] = 0;
        return host.uniforms(u);
    };
    const coverSlice = (viewport: Readonly<{ width: number; height: number }>, bounds: RectI, colour: readonly number[], scale: number) => {
        const u = uniformScratch;
        u[0] = viewport.width; u[1] = viewport.height; u[2] = 0; u[3] = 0;
        u[4] = bounds.x; u[5] = bounds.y; u[6] = bounds.width; u[7] = bounds.height;
        u[8] = colour[0] * scale; u[9] = colour[1] * scale; u[10] = colour[2] * scale; u[11] = colour[3] * scale;
        return host.uniforms(u);
    };
    const idsOf = (sets: readonly PathCoverageShapes[]): number[] => sets.flatMap(set => [idOf(set.positive), idOf(set.negative)]);
    const extendsIds = (ids: readonly number[], sets: readonly PathCoverageShapes[]): boolean => {
        if (ids.length > 2 * sets.length) return false;
        for (let i = 0; i < ids.length; i++) {
            const set = sets[i >> 1];
            if (ids[i] !== idOf((i & 1) === 1 ? set.negative : set.positive)) return false;
        }
        return true;
    };
    const unionBounds = (sets: readonly PathCoverageShapes[]): PathCoverageShapes['bounds'] => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const set of sets) {
            x0 = Math.min(x0, set.bounds.x0); y0 = Math.min(y0, set.bounds.y0);
            x1 = Math.max(x1, set.bounds.x1); y1 = Math.max(y1, set.bounds.y1);
        }
        return { x0, y0, x1, y1 };
    };
    const capacityFor = (bytes: number): number => 2 ** Math.ceil(Math.log2(bytes));
    const writeUpload = (up: Upload, budget: FrameBudget): 'done' | 'deferred' | 'unsupported' => {
        while (up.written < up.bytes) {
            const piece = Math.min(up.piece, up.bytes - up.written);
            if (!budget.claimUpload(piece)) {
                const cause = budget.shouldYield() ? 'yield' : budget.upload.remainingBytes >= piece ? 'room' : 'allowance';
                auditCount(audit, `upload:deferred:${cause}`, 1, { bytes: piece });
                if (cause === 'room') up.piece = Math.max(PATH_COVERAGE_UPLOAD_MIN_PIECE_BYTES,
                    Math.floor(piece / 2 / PATH_COVERAGE_VERTEX_STRIDE_BYTES) * PATH_COVERAGE_VERTEX_STRIDE_BYTES);
                return 'deferred';
            }
            const offset = up.written;
            if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(piece) || offset < 0 || piece <= 0 || offset % 4 !== 0 ||
                piece % 4 !== 0 || offset + piece > up.bytes) {
                throw new RangeError(`Invalid path vertex upload: offset ${offset}, bytes ${piece}, buffer ${up.bytes}`);
            }
            const writeStarted = renderAuditEnabled() ? performance.now() : 0;
            try { up.device.writeBuffer(up.buffer, offset, up.data.subarray(offset / 4, (offset + piece) / 4)); }
            catch (error) {
                if (!(error instanceof ArenaError) || error.code !== 'invalid-input') throw error;
                dropUpload(up.key);
                auditCount(audit, 'fallback:path-coverage:upload-refused', 1, { bytes: piece });
                return 'unsupported';
            }
            if (writeStarted) auditStage(audit, 'upload', performance.now() - writeStarted);
            auditCount(audit, 'upload:vertex', 1, { bytes: piece });
            up.written += piece;
        }
        return 'done';
    };
    const finishUpload = (up: Upload): VertexSet => {
        uploading.delete(up.key);
        if (up.staging) host.allocator.cpu.release(up.staging);
        const entry: VertexSet = { key: up.key, device: up.device, buffer: up.buffer, negative: up.negative,
            positiveVertices: up.positiveVertices, negativeVertices: up.negativeVertices, refs: 0, bytes: up.capacity, used: up.bytes,
            usedFrame: frame, chain: up.chain };
        shared.set(up.key, entry);
        idle.set(entry.key, entry); idleBytes += entry.bytes;
        return entry;
    };
    const appendChain = (owner: GfxDevice, head: VertexSet, chain: Chain, sets: readonly PathCoverageShapes[],
        budget: FrameBudget): VertexSet | 'unsupported' | null => {
        let total = 0;
        for (const part of sets) total += part.positive.length;
        const bytes = total * 4;
        let floats = 0;
        for (const part of sets.slice(chain.ids.length / 2)) floats += part.positive.length;
        if (chain.len + floats !== total || bytes > head.bytes || total > chain.data.length ||
            floats * 4 > PATH_COVERAGE_UPLOAD_CHUNK_BYTES) return null;
        if (floats > 0 && !budget.claimUpload(floats * 4)) return null;
        const from = chain.len;
        let at = from;
        for (const part of sets.slice(chain.ids.length / 2)) { chain.data.set(part.positive, at); at += part.positive.length; }
        if (floats > 0) {
            try { owner.writeBuffer(head.buffer, from * 4, chain.data.subarray(from, total)); }
            catch (error) {
                if (!(error instanceof ArenaError) || error.code !== 'invalid-input') throw error;
                auditCount(audit, 'fallback:path-coverage:append-refused', 1, { bytes: floats * 4 });
                return 'unsupported';
            }
            auditCount(audit, 'kit:pack:append', 1, { bytes: floats * 4 });
        }
        chain.len = total; chain.ids = idsOf(sets);
        head.used = bytes; head.positiveVertices = total / 2; head.usedFrame = frame;
        return head;
    };
    const chainSetFor = (owner: GfxDevice, sets: readonly PathCoverageShapes[], budget: FrameBudget):
        VertexSet | Denial | 'deferred' | 'unsupported' => {
        const chain = chains.get(idOf(sets[0].positive));
        if (chain && extendsIds(chain.ids, sets)) {
            const pending = uploading.get(chain.key);
            if (pending) {
                pending.usedFrame = frame;
                const state = writeUpload(pending, budget);
                if (state !== 'done') return state;
                finishUpload(pending);
            }
            const head = shared.get(chain.key);
            if (head) {
                const appended = appendChain(owner, head, chain, sets, budget);
                if (appended !== null) return appended;
            }
        }
        return newChain(owner, sets, budget);
    };
    const newChain = (owner: GfxDevice, sets: readonly PathCoverageShapes[], budget: FrameBudget):
        VertexSet | Denial | 'deferred' | 'unsupported' => {
        let total = 0;
        for (const part of sets) total += part.positive.length;
        const bytes = total * 4;
        let capacity = capacityFor(bytes);
        let lease = host.allocator.cpu.reserve(capacity);
        if (!lease && capacity > bytes) { capacity = bytes; lease = host.allocator.cpu.reserve(bytes); }
        if (!lease) return { status: 'denied', pool: 'cpu', bytes: capacity };
        let gpuCapacity = capacityFor(bytes);
        let gpuLease = host.allocator.gpu.reserve(gpuCapacity);
        if (!gpuLease && gpuCapacity > bytes) { gpuCapacity = bytes; gpuLease = host.allocator.gpu.reserve(bytes); }
        if (!gpuLease) { host.allocator.cpu.release(lease); return { status: 'denied', pool: 'gpu', bytes: gpuCapacity }; }
        let buffer: BufferHandle;
        try { buffer = owner.createBuffer(gpuCapacity, ['vertex', 'copy-dst'], gpuLease); }
        catch (error) {
            host.allocator.gpu.release(gpuLease); host.allocator.cpu.release(lease);
            if (error instanceof ArenaError && error.code === 'unsupported') { unsupported = true; auditCount(audit, 'fallback:path-coverage:vertex-buffer'); return 'unsupported'; }
            throw error;
        }
        const earlier = chains.get(idOf(sets[0].positive));
        if (earlier && uploading.has(earlier.key)) dropUpload(earlier.key);
        const data = new Float32Array(capacity / 4);
        let at = 0;
        for (const part of sets) { data.set(part.positive, at); at += part.positive.length; }
        const key = new Float64Array(0);
        const chain: Chain = { key, lead: idOf(sets[0].positive), data, bytes: capacity, lease, ids: idsOf(sets), len: total, released: false };
        chainKeys.add(key); chains.set(chain.lead, chain); packedBytes += capacity;
        const up: Upload = { key, device: owner, buffer, data, staging: null, written: 0, negative: EMPTY_TRIANGLES,
            positiveVertices: total / 2, negativeVertices: 0, bytes, capacity: gpuCapacity, usedFrame: frame,
            piece: PATH_COVERAGE_UPLOAD_CHUNK_BYTES, chain };
        uploading.set(key, up); gpuBytes += gpuCapacity;
        const state = writeUpload(up, budget);
        return state === 'done' ? finishUpload(up) : state;
    };
    const vertexSetFor = (owner: GfxDevice, set: PathCoverageShapes, vertexCount: number, budget: FrameBudget):
        VertexSet | Denial | 'deferred' | 'unsupported' => {
        const vertexBytes = vertexCount * 8;
        const found = shared.get(set.positive);
        if (found && found.device === owner && found.negative === set.negative && found.used === vertexBytes) { auditCount(audit, 'kit:set-hit', 1, { bytes: vertexBytes }); return found; }
        if (found) {
            if (found.refs > 0) { auditCount(audit, 'fallback:path-coverage:shared-mismatch'); return 'unsupported'; }
            unidle(found); shared.delete(set.positive); gpuBytes -= found.bytes; found.device.destroy(found.buffer);
        }
        let up = uploading.get(set.positive);
        if (up && (up.device !== owner || up.negative !== set.negative || up.bytes !== vertexBytes)) { dropUpload(set.positive); up = undefined; }
        if (up) up.usedFrame = frame;
        if (!up) {
            auditCount(audit, 'kit:set-new', 1, { bytes: vertexBytes });
            const staging = host.allocator.cpu.reserve(vertexBytes);
            if (!staging) return { status: 'denied', pool: 'cpu', bytes: vertexBytes };
            const data = new Float32Array(vertexCount * 2);
            data.set(set.positive, 0);
            data.set(set.negative, set.positive.length);
            const lease = host.allocator.gpu.reserve(vertexBytes);
            if (!lease) { host.allocator.cpu.release(staging); return { status: 'denied', pool: 'gpu', bytes: vertexBytes }; }
            let buffer: BufferHandle;
            try { buffer = owner.createBuffer(vertexBytes, ['vertex', 'copy-dst'], lease); }
            catch (error) {
                host.allocator.gpu.release(lease); host.allocator.cpu.release(staging);
                if (error instanceof ArenaError && error.code === 'unsupported') { unsupported = true; auditCount(audit, 'fallback:path-coverage:vertex-buffer'); return 'unsupported'; }
                throw error;
            }
            up = { key: set.positive, device: owner, buffer, data, staging, written: 0, negative: set.negative,
                positiveVertices: set.positive.length / 2, negativeVertices: set.negative.length / 2, bytes: vertexBytes,
                capacity: vertexBytes, usedFrame: frame, piece: PATH_COVERAGE_UPLOAD_CHUNK_BYTES };
            uploading.set(set.positive, up); gpuBytes += vertexBytes;
        }
        const state = writeUpload(up, budget);
        return state === 'done' ? finishUpload(up) : state;
    };
    const admitSets = (request: PathCoverageSetsRequest, budget: FrameBudget): PathCoverageAdmission => {
        if (!renderAuditEnabled()) return admitSetsUntimed(request, budget);
        const started = performance.now();
        let result: PathCoverageAdmission;
        try { result = admitSetsUntimed(request, budget); } finally { auditStage(audit, 'admit', performance.now() - started); }
        const log = ((globalThis as { __bmeKitLog?: unknown[] }).__bmeKitLog ??= []) as unknown[];
        if (log.length < 20000) log.push({ at: started, ms: performance.now() - started, status: result.status, left: budget.upload.remainingBytes,
            budgetMs: budget.prepareDeadline - performance.now(), yield: budget.shouldYield(), phase: budget.phase, audit });
        return result;
    };
    const unsupportedBecause = (reason: string): PathCoverageAdmission => {
        auditCount(audit, `fallback:path-coverage:${reason}`);
        return { status: 'unsupported' };
    };
    const admitSetsUntimed = (request: PathCoverageSetsRequest, budget: FrameBudget): PathCoverageAdmission => {
        if (disposed || failed || unsupported) return unsupportedBecause(disposed ? 'disposed' : failed ? 'failed' : 'device-unsupported');
        warm();
        if (device && (device.generation !== budget.token.deviceGeneration || host.generation !== budget.token.deviceGeneration)) {
            auditCount(audit, 'path-coverage:rebound:generation');
            release(); warm();
        }
        if (!isReady()) {
            if (!device) { auditCount(audit, 'path-coverage:deferred:no-device'); return { status: 'deferred' }; }
            if (pending) { auditCount(audit, 'path-coverage:deferred:compiling'); return { status: 'deferred' }; }
            return unsupportedBecause('not-ready');
        }
        const owner = device!, { sets, rule, affine, viewport, output } = request;
        const nonEmpty = sets.filter(set => set.positive.length + set.negative.length > 0);
        if (!nonEmpty.length) return { status: 'empty' };
        let edges = 0;
        for (const set of nonEmpty) edges += set.edges;
        if (rule === 'nonzero' && edges > PATH_COVERAGE_STENCIL_MAX_EDGES) return unsupportedBecause('stencil-edges');
        if (!Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height) || viewport.width <= 0 || viewport.height <= 0) {
            throw new RangeError('Invalid path coverage viewport');
        }
        if (!request.colour.every(Number.isFinite)) throw new RangeError('Invalid path coverage colour');
        const chainSets = nonEmpty.length > 1 && nonEmpty.every(part => part.negative.length === 0 && !part.shift) ? nonEmpty : null;
        let shape: PathCoverageShapes = chainSets ? { positive: EMPTY_TRIANGLES, negative: EMPTY_TRIANGLES, edges, bounds: unionBounds(chainSets) } : nonEmpty[0];
        if (!chainSets && (nonEmpty.length > 1 || nonEmpty[0].shift)) {
            const packed = packSets(nonEmpty);
            if ('refused' in packed) return { status: 'denied', pool: 'cpu', bytes: packed.refused };
            shape = packed.shape;
        }
        const mapped = mapBounds(shape.bounds, affine);
        const x0 = Math.max(0, Math.floor(mapped.x0)), y0 = Math.max(0, Math.floor(mapped.y0));
        const x1 = Math.min(viewport.width, Math.ceil(mapped.x1)), y1 = Math.min(viewport.height, Math.ceil(mapped.y1));
        if (x1 <= x0 || y1 <= y0) return { status: 'empty' };
        const bounds: RectI = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        if (bounds.width > owner.limits.maxRenderTargetSize || bounds.height > owner.limits.maxRenderTargetSize) return unsupportedBecause('bounds');
        const composite = output.kind === 'composite';
        const grid: CompositeGrid = composite && request.sampling === 'grid4' ? 4 : 1;
        const targetBytes = composite ? 0 : coverageTargetBytes(bounds.width, bounds.height, PATH_COVERAGE_SAMPLES);
        if (targetBytes > PATH_COVERAGE_MAX_TARGET_BYTES) { auditCount(audit, 'fallback:raster-route'); return { status: 'unsupported' }; }
        if (composite && coverageTargetBytes(bounds.width, 1, grid === 4 ? 1 : PATH_COVERAGE_SAMPLES, grid) > scratchCap(grid)) {
            auditCount(audit, 'fallback:raster-route'); return { status: 'unsupported' };
        }
        const vertexCount = chainSets ? chainSets.reduce((sum, part) => sum + part.positive.length, 0) / 2
            : (shape.positive.length + shape.negative.length) / 2;
        if (!Number.isSafeInteger(vertexCount) || vertexCount % 3) throw new RangeError('Invalid path triangle storage');
        const entry = chainSets ? chainSetFor(owner, chainSets, budget) : vertexSetFor(owner, shape, vertexCount, budget);
        if (entry === 'deferred') auditCount(audit, 'upload:deferred:admission');
        if (entry === 'deferred' || entry === 'unsupported') return { status: entry };
        if ('status' in entry) return entry;
        const parts: VertexSet[] = [entry];
        // The scratch is ensured after the buffers, and before any reference is taken: a refusal leaves nothing held.
        if (composite) {
            const fits = ensureScratch(owner, bounds.width, bounds.height, grid);
            if (fits !== true) {
                if (fits === 'unsupported') { auditCount(audit, 'fallback:raster-route'); return { status: 'unsupported' }; }
                return { status: 'denied', pool: 'gpu', bytes: fits };
            }
        }
        const targetLease = composite ? null : host.allocator.gpu.reserve(targetBytes);
        if (!composite && !targetLease) return { status: 'denied', pool: 'gpu', bytes: targetBytes };
        for (const part of parts) holdSet(part);
        let target: CoverageTarget | null = null, clip: ClipHandle | null = null;
        let targetAttached = false;
        try {
            if (targetLease) target = owner.createCoverageTarget(bounds.width, bounds.height, PATH_COVERAGE_SAMPLES, targetLease);
            targetAttached = true;
            if (output.kind === 'mask') clip = owner.createClip(target!.texture, bounds);
        } catch (error) {
            if (clip) owner.destroy(clip);
            if (target) { owner.destroy(target.target); owner.destroy(target.texture); }
            if (!targetAttached && targetLease) host.allocator.gpu.release(targetLease);
            for (const part of parts) releaseShared(part);
            if (error instanceof ArenaError && error.code === 'unsupported') { unsupported = true; return unsupportedBecause('device-refused'); }
            throw error;
        }
        const modulate = grid === 1 && output.kind === 'composite' && output.blend === 'modulate';
        const [pr, pg, pb, alpha] = [request.colour[0] * request.colour[3], request.colour[1] * request.colour[3], request.colour[2] * request.colour[3], request.colour[3]];
        const colour: readonly [number, number, number, number] = output.kind === 'mask' ? [1, 1, 1, 1]
            : grid === 4 ? [request.colour[0], request.colour[1], request.colour[2], request.colour[3]]
            : modulate ? [pr + 1 - alpha, pg + 1 - alpha, pb + 1 - alpha, 1] : [pr, pg, pb, alpha];
        const preparedOutput: CoverageOutput = output.kind === 'composite' && grid === 4
            ? { kind: 'paint', blend: output.blend === 'modulate' ? 'modulate' : 'normal', rgb: [request.colour[0], request.colour[1], request.colour[2]], alpha: request.colour[3] }
            : output;
        const prepared: PreparedPathCoverage = Object.freeze({ device: owner, target, clip, rule, output: preparedOutput, bounds, grid,
            parts: Object.freeze(parts.map(set => Object.freeze({ vertices: set.buffer, positiveVertices: set.positiveVertices,
                negativeVertices: set.negativeVertices,
                bindings: Object.freeze([{ buffer: set.buffer, offset: 0, bytes: (set.positiveVertices + set.negativeVertices) * 8 }]), set }))),
            viewport: Object.freeze({ width: viewport.width, height: viewport.height }),
            affine: Object.freeze([...affine]) as unknown as Affine,
            colour: Object.freeze([...colour]) as unknown as readonly [number, number, number, number], gpuBytes: targetBytes,
            supersample: grid === 1 && request.supersample === true, modulate, scratch: composite });
        live.set(prepared, targetBytes); gpuBytes += targetBytes;
        if (composite) {
            if (grid === 4) auditCount(audit, 'kit:supersample-4');
            const shared = scratchOf(owner, grid)!;
            shared.refs++; shared.usedFrame = frame;
        }
        return { status: 'ready', value: prepared };
    };
    warm();
    return {
        warm,
        ready: isReady,
        drawRefusedThisFrame: (): boolean => drawRefusedFrame === frame,
        beginFrame(next: number): void {
            if (next === frame) { frame = next; return; }
            auditCount(audit, 'kit:frame');
            frame = next;
            if (scratchGrowth && device) {
                for (const grid of [1, 4] as const) { const held = scratchOf(device, grid); if (held && held.refs === 0) destroyScratch(device, grid, 'growth'); }
                scratchGrowth = [1, 4].some(grid => (scratchOf(device!, grid as CompositeGrid)?.refs ?? 0) > 0);
            }
            if (!disposed && !failed && !unsupported) warm();
        },
        holds(key: Float64Array): boolean { return shared.has(key) || uploading.has(key); },
        forgetTriangles(key: Float64Array): void {
            const id = arrayIds.get(key);
            const built = id === undefined ? undefined : packsOfMember.get(id);
            if (!built) return;
            for (const pack of [...built]) if (!shared.has(pack.shape.positive) && !uploading.has(pack.shape.positive)) freePack(pack);
        },
        evict(bytes: number, gestureLive = false): number {
            let freed = reclaimIdle(bytes);
            for (const [key, up] of [...uploading]) {
                if (freed >= bytes) break;
                if (up.usedFrame >= frame - 1) continue;
                freed += up.capacity; dropUpload(key);
            }
            for (const pack of [...packs.values()]) {
                if (freed >= bytes) break;
                if (pack.usedFrame >= frame - 1 || shared.has(pack.shape.positive) || uploading.has(pack.shape.positive)) continue;
                freed += pack.bytes; freePack(pack);
            }
            if (device && freed < bytes) for (const grid of [1, 4] as const) {
                const shared = scratchOf(device, grid);
                if (!shared || shared.refs > 0) continue;
                if (gestureLive) { auditCount(audit, 'kit:scratch-kept:gesture', 1, { bytes: shared.bytes }); continue; }
                if (shared.usedFrame > frame - PATH_COVERAGE_SCRATCH_IDLE_FRAMES) { auditCount(audit, 'kit:scratch-kept', 1, { bytes: shared.bytes }); continue; }
                freed += destroyScratch(device, grid, 'evict');
            }
            return freed;
        },
        memory(): { gpuBytes: number; cpuBytes: number } {
            const reported = (grid: CompositeGrid): number => {
                const shared = device ? scratchOf(device, grid) : undefined;
                return shared && shared.charge.holder === kitToken ? shared.bytes : 0;
            };
            return { gpuBytes: gpuBytes + reported(1) + reported(4), cpuBytes: packedBytes };
        },
        admit(request: PathCoverageRequest, budget: FrameBudget): PathCoverageAdmission {
            const { shapes, ...rest } = request;
            return admitSets({ ...rest, sets: [shapes] }, budget);
        },
        admitSets,
        draw(pass: GpuPass, prepared: PreparedPathCoverage, paint?: { readonly colour: Rgba }): void {
            if (prepared.output.kind === 'mask') throw new Error('Mask coverage is drawn with drawMask');
            render(pass, prepared, paint?.colour);
        },
        drawMask(pass: GpuPass, prepared: PreparedPathCoverage): void {
            if (prepared.output.kind !== 'mask' || !prepared.clip) throw new Error('Composite coverage is drawn with draw');
            render(pass, prepared);
        },
        retire(prepared: PreparedPathCoverage): void { retireOwned(prepared); },
        release,
        dispose(): void { if (!disposed) { disposed = true; release(); } },
    };
}
