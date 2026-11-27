import type { Affine } from '../types';
import type { AreaOutput, AreaTarget, BufferHandle, ByteLease, GfxDevice, GpuPass, PipelineHandle, RectI, ShaderModule } from './gfx/api';
import type { LayerHost } from './compositor.types';
import type { MemoryAllocator } from './memoryGovernor';
import type { FrameBudget } from './types';
import { ArenaError } from './resourceArena';
import { auditCount, PerDeviceMap } from './renderAudit';

interface EdgePiece { readonly buffer: BufferHandle; readonly count: number; readonly bytes: number }

interface EdgeSet {
    readonly key: Float32Array;
    readonly device: GfxDevice;
    readonly generation: number;
    readonly pieces: EdgePiece[];
    uploaded: number;
    piece: number;
    bytes: number;
    refs: number;
    usedFrame: number;
}

export interface AreaPart { readonly edges: Float32Array; readonly affine: Affine }

export interface PreparedArea {
    readonly device: GfxDevice;
    readonly generation: number;
    readonly sets: readonly EdgeSet[];
    readonly affines: readonly Affine[];
    readonly bounds: RectI;
}

export type AreaAdmission =
    | { readonly status: 'ready'; readonly value: PreparedArea }
    | { readonly status: 'empty' }
    | { readonly status: 'deferred' }
    | { readonly status: 'denied'; readonly pool: 'gpu' | 'cpu'; readonly bytes: number }
    | { readonly status: 'unsupported'; readonly why: string };

export interface AreaKit {
    admit(host: LayerHost, parts: readonly AreaPart[], bounds: RectI, budget: FrameBudget, viewport: { readonly width: number; readonly height: number }): AreaAdmission;
    beginBatch(host: LayerHost): void;
    place(host: LayerHost, pass: GpuPass, areas: readonly PreparedArea[]): boolean;
    endBatch(pass: GpuPass): void;
    composite(pass: GpuPass, prepared: PreparedArea, output: AreaOutput): boolean;
    retire(prepared: PreparedArea): void;
    forget(edges: Float32Array): void;
    evictIdle(bytes: number, keepRecent?: boolean): number;
    warm(host: LayerHost): void;
    beginFrame(frame: number): void;
    release(): void;
    memory(): { readonly gpuBytes: number };
}

const PIECE_INSTANCES = 4096;
const MIN_PIECE_INSTANCES = 256;
const INSTANCE_BYTES = 16;
const IDLE_EDGE_BYTES = 8 * 2 ** 20;
const UNIFORM_BYTES = 64;

interface Placed { x: number; y: number; readonly rect: { x: number; y: number; width: number; height: number } }

const EDGE_SHADER: ShaderModule = {
    id: 'platform-area-edge', revision: 4,
    layout: {
        uniforms: [{ binding: 0, byteSize: UNIFORM_BYTES }],
        textures: [],
        attributes: [{ location: 0, bufferSlot: 0, offset: 0, stride: INSTANCE_BYTES, format: 'float32x4', step: 'instance' }],
    },
    glsl: {
        vertex: `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 { vec4 viewport; vec4 band; vec4 matrix; vec4 translation; };
layout(location=0) in vec4 edge;
flat out vec4 ends;
void main() {
    vec2 a = vec2(matrix.x * edge.x + matrix.z * edge.y, matrix.y * edge.x + matrix.w * edge.y) + translation.xy;
    vec2 b = vec2(matrix.x * edge.z + matrix.z * edge.w, matrix.y * edge.z + matrix.w * edge.w) + translation.xy;
    ends = vec4(a, b);
    vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
    // band is the area's region of the scratch, (x0, y0, x1, y1): the strip runs from the edge to the region's right side.
    float left = clamp(floor(min(a.x, b.x)), band.x, band.z);
    float top = clamp(floor(min(a.y, b.y)), band.y, band.w), bottom = clamp(ceil(max(a.y, b.y)), band.y, band.w);
    vec2 pixel = vec2(mix(left, band.z, corner.x), mix(top, bottom, corner.y));
    vec2 unit = pixel / viewport.xy;
    gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
}`,
        fragment: `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 { vec4 viewport; vec4 band; vec4 matrix; vec4 translation; };
flat in vec4 ends;
out float accumulated;
// The antiderivative of clamp(1 - t, 0, 1), the share of a pixel column right of an edge at column offset t.
float share(float t) { return t <= 0.0 ? t : (t >= 1.0 ? 0.5 : t - 0.5 * t * t); }
void main() {
    // Rows count from the top here (the vertex stage maps pixel y to 1 - 2y/height); gl_FragCoord counts from the bottom.
    vec2 p = vec2(floor(gl_FragCoord.x), floor(viewport.y - gl_FragCoord.y));
    vec2 a = ends.xy, b = ends.zw;
    float dir = 1.0;
    if (a.y > b.y) { vec2 s = a; a = b; b = s; dir = -1.0; }
    float v0 = max(p.y, a.y), v1 = min(p.y + 1.0, b.y);
    if (!(v1 > v0) || !(b.y > a.y)) { accumulated = 0.0; return; }
    float dxdy = (b.x - a.x) / (b.y - a.y);
    // The run's column offsets: ta, and tb as ta plus the run's own width d, so the two never round apart. Taken as two separate
    // differences of pixel-sized coordinates, a near-vertical run's tb - ta (about 1e-4) was rounding noise of the same size, and
    // fast-math compiles the quotient's two sides differently: every column right of the edge took a wrong share, a streak to the
    // area's right side (measured on Apple's GPU, exact-area ink: 1 to 6 levels along up to 1,000 px of a row).
    float ta = (a.x - p.x) + (v0 - a.y) * dxdy, d = (v1 - v0) * dxdy, tb = ta + d;
    // The mean share over the edge's run through this row: exact for a straight edge. Wholly left of the column it is all of the run,
    // wholly right none; a run narrower than 1e-3 px takes the midpoint (off by at most d / 8 where it straddles a column side).
    float mean = max(ta, tb) <= 0.0 ? 1.0 : (min(ta, tb) >= 1.0 ? 0.0
        : (abs(d) >= 1e-3 ? (share(tb) - share(ta)) / d : clamp(1.0 - 0.5 * (ta + tb), 0.0, 1.0)));
    accumulated = dir * (v1 - v0) * mean;
}`,
    },
};

const CLEAR_SHADER: ShaderModule = {
    id: 'platform-area-clear', revision: 3,
    layout: { uniforms: [{ binding: 0, byteSize: UNIFORM_BYTES }], textures: [], attributes: [] },
    glsl: {
        vertex: `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 { vec4 viewport; vec4 band; vec4 matrix; vec4 translation; };
void main() {
    vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
    vec2 unit = mix(band.xy, band.zw, corner) / viewport.xy;
    gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
}`,
        fragment: `#version 300 es
precision highp float;
out float accumulated;
void main() { accumulated = 0.0; }`,
    },
};
const NO_STENCIL = { enabled: false } as const;

interface ScratchCharge { readonly holder: object; readonly gpu: MemoryAllocator; readonly lease: ByteLease }
interface Scratch { readonly target: AreaTarget; readonly bytes: number; readonly users: Map<object, MemoryAllocator>; charge: ScratchCharge;
    readonly targetLease: ByteLease }
const scratchOf = new PerDeviceMap<GfxDevice, Scratch>();

interface SharedAreaPipelines { users: number; edge: PipelineHandle | null; clear: PipelineHandle | null; failed: boolean; dead: boolean; readonly generation: number }
const areaPipelinesOn = new PerDeviceMap<GfxDevice, SharedAreaPipelines>();
function acquireAreaPipelines(owner: GfxDevice): SharedAreaPipelines {
    const known = areaPipelinesOn.get(owner);
    if (known && known.generation === owner.generation) { known.users++; return known; }
    if (known) { known.dead = true; if (known.users === 0) destroyAreaPipelines(owner, known); }
    const entry: SharedAreaPipelines = { users: 1, edge: null, clear: null, failed: false, dead: false, generation: owner.generation };
    areaPipelinesOn.set(owner, entry);
    const make = (shader: ShaderModule, blend: 'add' | 'replace') => owner.createPipeline({ shader, topology: 'triangle-strip',
        colorFormat: 'r32f', samples: 1, blend, alphaToCoverage: false, colorWrite: [true, true, true, true], stencil: NO_STENCIL });
    Promise.all([make(EDGE_SHADER, 'add'), make(CLEAR_SHADER, 'replace')]).then(([edge, clear]) => {
        entry.edge = edge; entry.clear = clear;
        if (entry.dead && entry.users === 0) destroyAreaPipelines(owner, entry);
    }, () => { entry.failed = true; if (areaPipelinesOn.get(owner) === entry) areaPipelinesOn.delete(owner); });
    return entry;
}
function destroyAreaPipelines(owner: GfxDevice, entry: SharedAreaPipelines): void {
    if (entry.edge) owner.destroy(entry.edge);
    if (entry.clear) owner.destroy(entry.clear);
    entry.edge = null; entry.clear = null;
}
function releaseAreaPipelines(owner: GfxDevice, entry: SharedAreaPipelines): void {
    if (--entry.users === 0 && entry.dead) destroyAreaPipelines(owner, entry);
}

export function createAreaKit(): AreaKit {
    let device: GfxDevice | null = null;
    let edgePipeline: PipelineHandle | null = null;
    let clear: PipelineHandle | null = null;
    let pipelineSet: SharedAreaPipelines | null = null, frame = 0, previous = -1;
    const sets = new Map<Float32Array, EdgeSet>();
    const live = new Set<PreparedArea>();
    let holding = false;
    let setBytes = 0, idleBytes = 0;
    const uniformScratch = new Float32Array(UNIFORM_BYTES / 4);
    let batchScratch: Scratch | null = null, batchToken: ReturnType<GpuPass['beginArea']> | null = null;
    let shelfX = 0, shelfY = 0, shelfH = 0;
    const placed = new Map<PreparedArea, Placed>();
    const spare: Placed[] = [];
    const tentative: Placed[] = [];
    const whole = { x: 0, y: 0, width: 0, height: 0 };
    const regionUniforms = (host: LayerHost, W: number, H: number, at: Placed, bounds: RectI, affine: Affine | null) => {
        const sx = at.x - (at.rect.x - bounds.x), sy = at.y - (at.rect.y - bounds.y);
        uniformScratch[0] = W; uniformScratch[1] = H; uniformScratch[2] = 0; uniformScratch[3] = 0;
        uniformScratch[4] = at.x; uniformScratch[5] = at.y; uniformScratch[6] = at.x + at.rect.width; uniformScratch[7] = at.y + at.rect.height;
        uniformScratch[8] = affine ? affine[0] : 0; uniformScratch[9] = affine ? affine[1] : 0;
        uniformScratch[10] = affine ? affine[2] : 0; uniformScratch[11] = affine ? affine[3] : 0;
        uniformScratch[12] = affine ? affine[4] + sx : 0; uniformScratch[13] = affine ? affine[5] + sy : 0; uniformScratch[14] = 0; uniformScratch[15] = 0;
        return host.uniforms(uniformScratch);
    };
    const kitToken = {};

    const ensurePipelines = (owner: GfxDevice): boolean | 'failed' => {
        if (edgePipeline && clear && device === owner) return true;
        if (device !== owner) { if (device) release(); device = owner; }
        pipelineSet ??= acquireAreaPipelines(owner);
        if (pipelineSet.failed) return 'failed';
        if (!pipelineSet.edge || !pipelineSet.clear) return false;
        edgePipeline = pipelineSet.edge; clear = pipelineSet.clear;
        return true;
    };

    const acquireScratch = (host: LayerHost, owner: GfxDevice, viewport: { width: number; height: number }): Scratch | 'denied' => {
        const existing = scratchOf.get(owner);
        if (existing && existing.target.width >= viewport.width && existing.target.height >= viewport.height) return existing;
        const width = Math.max(viewport.width, existing?.target.width ?? 0), height = Math.max(viewport.height, existing?.target.height ?? 0);
        const bytes = width * height * 4;
        const lease = host.allocator.gpu.reserve(bytes);
        if (!lease || lease.bytes < bytes) {
            if (lease) host.allocator.gpu.release(lease);
            return 'denied';
        }
        let target: AreaTarget;
        try {
            const made = owner.createRenderTexture(width, height, lease, { format: 'r32f' });
            target = { target: made.target, texture: made.texture, width, height };
        } catch (error) {
            host.allocator.gpu.release(lease);
            if (error instanceof ArenaError && error.code === 'out-of-budget') return 'denied';
            throw error;
        }
        if (existing) destroyScratch(owner, existing);
        const scratch: Scratch = { target, bytes, users: existing?.users ?? new Map(), charge: { holder: kitToken, gpu: host.allocator.gpu, lease },
            targetLease: lease };
        scratchOf.set(owner, scratch);
        return scratch;
    };
    const destroyScratch = (owner: GfxDevice, scratch: Scratch): void => {
        owner.destroy(scratch.target.target); owner.destroy(scratch.target.texture);
        if (scratch.charge.lease !== scratch.targetLease) scratch.charge.gpu.release(scratch.charge.lease);
    };
    const rehome = (owner: GfxDevice, scratch: Scratch): void => {
        if (scratch.users.has(scratch.charge.holder)) return;
        for (const [holder, gpu] of scratch.users) {
            const lease = gpu.reserve(scratch.bytes);
            if (!lease || lease.bytes < scratch.bytes) { if (lease) gpu.release(lease); continue; }
            // A reservation can trim the pool, and that can drop this very scratch: then the new lease is not needed.
            if (scratchOf.get(owner) !== scratch) { gpu.release(lease); return; }
            scratch.charge.gpu.release(scratch.charge.lease);
            scratch.charge = { holder, gpu, lease };
            auditCount('area', 'scratch-rehomed', 1, { bytes: scratch.bytes });
            return;
        }
        auditCount('area', 'scratch-rehome-refused', 1, { bytes: scratch.bytes });
    };
    const destroySet = (set: EdgeSet): void => {
        if (sets.get(set.key) === set) sets.delete(set.key);
        if (set.refs === 0) idleBytes -= set.bytes;
        setBytes -= set.bytes;
        for (const piece of set.pieces) set.device.destroy(piece.buffer);
        set.pieces.length = 0;
    };
    const trimIdle = (): void => {
        if (idleBytes <= IDLE_EDGE_BYTES) return;
        for (const set of [...sets.values()]) {
            if (idleBytes <= IDLE_EDGE_BYTES) break;
            if (set.refs === 0 && set.usedFrame < previous) destroySet(set);
        }
    };
    const unref = (set: EdgeSet): void => {
        if (--set.refs !== 0) return;
        idleBytes += set.bytes;
        if (sets.get(set.key) === set) { sets.delete(set.key); sets.set(set.key, set); }
        else destroySet(set);
    };
    const upload = (host: LayerHost, set: EdgeSet, budget: FrameBudget): true | 'deferred' | { denied: number } | 'unsupported' => {
        const count = set.key.length >> 2;
        while (set.uploaded < count) {
            const n = Math.min(set.piece, count - set.uploaded);
            const bytes = n * INSTANCE_BYTES;
            if (!budget.claimUpload(bytes)) {
                if (set.piece > MIN_PIECE_INSTANCES) { set.piece = Math.max(MIN_PIECE_INSTANCES, set.piece >> 1); continue; }
                return 'deferred';
            }
            const lease = host.allocator.gpu.reserve(bytes);
            if (!lease || lease.bytes < bytes) { if (lease) host.allocator.gpu.release(lease); return { denied: bytes }; }
            let buffer: BufferHandle;
            try { buffer = set.device.createBuffer(bytes, ['vertex', 'copy-dst'], lease); }
            catch (error) {
                host.allocator.gpu.release(lease);
                if (error instanceof ArenaError && error.code === 'unsupported') return 'unsupported';
                throw error;
            }
            set.device.writeBuffer(buffer, 0, set.key.subarray(set.uploaded * 4, (set.uploaded + n) * 4));
            set.pieces.push({ buffer, count: n, bytes });
            set.uploaded += n; set.bytes += bytes; setBytes += bytes;
            if (set.refs === 0) idleBytes += bytes;
        }
        return true;
    };
    function release(): void {
        placed.clear(); batchScratch = null; batchToken = null;
        for (const prepared of [...live]) retire(prepared);
        for (const set of [...sets.values()]) { set.refs = 0; destroySet(set); }
        idleBytes = 0; setBytes = 0;
        if (device && holding) {
            const scratch = scratchOf.get(device);
            if (scratch && scratch.users.delete(kitToken)) {
                if (scratch.users.size === 0) { scratchOf.delete(device); destroyScratch(device, scratch); }
                else rehome(device, scratch);
            }
        }
        holding = false;
        if (pipelineSet && device) releaseAreaPipelines(device, pipelineSet);
        pipelineSet = null; edgePipeline = null; clear = null; device = null;
    }
    function retire(prepared: PreparedArea): void {
        if (!live.delete(prepared)) return;
        for (const set of prepared.sets) unref(set);
        trimIdle();
    }

    return {
        admit(host, parts, bounds, budget, viewport): AreaAdmission {
            const owner = host.device();
            if (!owner) return { status: 'unsupported', why: 'no-device' };
            if (!owner.areaTargets) return { status: 'unsupported', why: 'no-float-targets' };
            if (!parts.length || bounds.width <= 0 || bounds.height <= 0) return { status: 'empty' };
            if (device && device !== owner) release();
            const held: EdgeSet[] = [];
            for (const part of parts) {
                if (!part.edges.length) continue;
                let set = sets.get(part.edges);
                if (set && (set.device !== owner || set.generation !== host.generation)) { if (set.refs === 0) destroySet(set); else sets.delete(set.key); set = undefined; }
                if (!set) {
                    set = { key: part.edges, device: owner, generation: host.generation, pieces: [], uploaded: 0, piece: PIECE_INSTANCES, bytes: 0, refs: 0, usedFrame: frame };
                    sets.set(part.edges, set);
                }
                set.usedFrame = frame;
                const uploaded = upload(host, set, budget);
                if (uploaded === 'deferred') { auditCount('area', 'deferred:upload'); return { status: 'deferred' }; }
                if (uploaded === 'unsupported') return { status: 'unsupported', why: 'vertex-buffer' };
                if (uploaded !== true) return { status: 'denied', pool: 'gpu', bytes: uploaded.denied };
                held.push(set);
            }
            if (!held.length) return { status: 'empty' };
            // The pipelines and the scratch come after the edges: a deferral here keeps every piece already uploaded.
            const pipelines = ensurePipelines(owner);
            if (pipelines === 'failed') return { status: 'unsupported', why: 'pipeline' };
            if (!pipelines) { auditCount('area', pipelineSet && pipelineSet.users > 1 ? 'deferred:compiling:shared' : 'deferred:compiling'); return { status: 'deferred' }; }
            const scratch = acquireScratch(host, owner, viewport);
            if (scratch === 'denied') return { status: 'denied', pool: 'gpu', bytes: viewport.width * viewport.height * 4 };
            if (!holding) { scratch.users.set(kitToken, host.allocator.gpu); holding = true; }
            rehome(owner, scratch);
            for (const set of held) { if (set.refs++ === 0) idleBytes -= set.bytes; }
            const prepared: PreparedArea = { device: owner, generation: host.generation, sets: held,
                affines: parts.filter(part => part.edges.length).map(part => part.affine), bounds };
            live.add(prepared);
            return { status: 'ready', value: prepared };
        },
        beginBatch(host): void {
            for (const at of placed.values()) spare.push(at);
            placed.clear();
            batchToken = null; shelfX = 0; shelfY = 0; shelfH = 0;
            batchScratch = device && device === host.device() ? scratchOf.get(device) ?? null : null;
        },
        place(host, pass, areas): boolean {
            const scratch = batchScratch;
            if (!scratch || !edgePipeline || !clear) throw new Error('Stale area');
            const W = scratch.target.width, H = scratch.target.height;
            const clip = pass.clipRect();
            let x = shelfX, y = shelfY, h = shelfH;
            for (let i = 0; i < areas.length; i++) {
                const prepared = areas[i];
                if (!live.has(prepared) || prepared.device !== host.device() || prepared.generation !== host.generation) throw new Error('Stale area');
                const at = tentative[i] ?? (tentative[i] = { x: 0, y: 0, rect: { x: 0, y: 0, width: 0, height: 0 } });
                const b = prepared.bounds;
                const x0 = Math.max(b.x, clip.x), y0 = Math.max(b.y, clip.y);
                const x1 = Math.min(b.x + b.width, clip.x + clip.width), y1 = Math.min(b.y + b.height, clip.y + clip.height);
                at.rect.x = x0; at.rect.y = y0; at.rect.width = Math.max(0, x1 - x0); at.rect.height = Math.max(0, y1 - y0);
                const { width, height } = at.rect;
                if (!width || !height) { at.x = 0; at.y = 0; continue; }
                if (x + width > W) { y += h; x = 0; h = 0; }
                if (y + height > H || width > W) return false;
                at.x = x; at.y = y;
                x += width; h = Math.max(h, height);
            }
            shelfX = x; shelfY = y; shelfH = h;
            if (!batchToken) batchToken = pass.beginArea(scratch.target);
            whole.width = W; whole.height = H;
            for (let i = 0; i < areas.length; i++) {
                const prepared = areas[i], { bounds } = prepared, at = tentative[i];
                const kept = spare.pop() ?? { x: 0, y: 0, rect: { x: 0, y: 0, width: 0, height: 0 } };
                kept.x = at.x; kept.y = at.y; kept.rect.x = at.rect.x; kept.rect.y = at.rect.y; kept.rect.width = at.rect.width; kept.rect.height = at.rect.height;
                placed.set(prepared, kept);
                if (!at.rect.width || !at.rect.height) { auditCount('area', 'clipped-out'); continue; }
                pass.draw({ pipeline: clear, bindings: { uniforms: [{ binding: 0, slice: regionUniforms(host, W, H, at, bounds, null) }], textures: [] },
                    vertices: [], first: 0, count: 4, instances: 1, scissor: whole });
                for (let s = 0; s < prepared.sets.length; s++) {
                    const slice = regionUniforms(host, W, H, at, bounds, prepared.affines[s]);
                    for (const piece of prepared.sets[s].pieces) {
                        pass.draw({ pipeline: edgePipeline, bindings: { uniforms: [{ binding: 0, slice }], textures: [] },
                            vertices: [{ buffer: piece.buffer, offset: 0, bytes: piece.bytes }], first: 0, count: 4, instances: piece.count, scissor: whole });
                    }
                }
            }
            return true;
        },
        endBatch(pass): void {
            if (batchToken) pass.endArea(batchToken);
            batchToken = null;
        },
        composite(pass, prepared, output): boolean {
            const at = placed.get(prepared);
            if (!at || !batchScratch) return false;
            if (at.rect.width && at.rect.height) pass.compositeArea(batchScratch.target, at, at.rect, output);
            return true;
        },
        retire,
        warm(host): void {
            const owner = host.device();
            if (owner?.areaTargets) ensurePipelines(owner);
        },
        forget(edges): void {
            const set = sets.get(edges);
            if (!set) return;
            if (set.refs === 0) destroySet(set);
            else sets.delete(edges);
        },
        beginFrame(next): void { if (next !== frame) { previous = frame; frame = next; } },
        evictIdle(bytes, keepRecent = false): number {
            let freed = 0;
            for (const set of [...sets.values()]) {
                if (freed >= bytes) break;
                if (set.refs !== 0 || set.usedFrame >= (keepRecent ? previous : frame)) continue;
                freed += set.bytes; destroySet(set);
            }
            return freed;
        },
        release,
        memory: () => {
            const scratch = holding && device ? scratchOf.get(device) : undefined;
            return { gpuBytes: setBytes + (scratch && scratch.charge.holder === kitToken ? scratch.bytes : 0) };
        },
    };
}
