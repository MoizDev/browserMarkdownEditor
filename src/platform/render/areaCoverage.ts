/** Exact-area coverage kit: path shapes drawn by the exact area of their outline, the GPU route's answer to 4x MSAA's quarter
 * steps (FAULT-GPU.md: the yardstick is the truth, measured 1-3 levels from it against canvas2d's 44-99).
 *
 * Geometry: an outline is its closed contours as EDGES (x0, y0, x1, y1), item-local and origin-relative, uploaded once as one
 * shared edge set per content and tolerance band (the caller caches the array; the kit keys its buffer on that array). A view
 * is a uniform: the edges are transformed on the GPU, so a pan or a zoom inside a band uploads nothing and computes nothing on
 * the CPU. Measured before this design (CPU-cut cells, one upload per admission): 1,024 shapes in a saturated zoom took 0.94 ms
 * of board prepare per frame against the MSAA route's 0.21.
 *
 * Drawing accumulates into one SCRATCH r32f target per device, shared by every kit there. A batch packs a run's areas into regions
 * of the scratch (shelf packing) and accumulates them all in ONE pass; then each area is composited from its region in paint order.
 * In a region, the area clears it, then every edge instance covers the strip from its leftmost pixel to the region's right side of
 * each row it crosses, and the fragment adds
 * the exact signed area that the edge leaves to its right inside that pixel (font-rs's accumulation, integrated per pixel rather
 * than prefix-summed). Summed, |acc| clamped to 1 is the outline's nonzero coverage, exact where the contours cross and touch
 * nothing and nest with opposite signs (the caller's areaNestingExact). The composite paints min(1, |acc|) with the output.
 *
 * Uploads are resumable: an edge set's pieces persist across a deferral, so no byte is uploaded twice, and a refused piece halves
 * down to MIN_PIECE_INSTANCES before the admission defers. An edge set lives while an admission holds it; idle sets are kept up to
 * IDLE_EDGE_BYTES, least recently used first out, and re-uploaded if drawn again.
 *
 * The kit only takes the device's own float targets: a device without EXT_color_buffer_float and EXT_float_blend is refused as
 * 'unsupported', and its caller keeps the coverage route, counted. Leases are handed to the device at creation (it returns them
 * on destroy), so nothing is released twice. */
import type { Affine } from '../types';
import type { AreaOutput, AreaTarget, BufferHandle, GfxDevice, GpuPass, PipelineHandle, RectI, ShaderModule } from './gfx/api';
import type { LayerHost } from './compositor.types';
import type { FrameBudget } from './types';
import { ArenaError } from './resourceArena';

/** One uploaded piece of an edge set: a vertex buffer of `count` edges (16 bytes each). */
interface EdgePiece { readonly buffer: BufferHandle; readonly count: number; readonly bytes: number }

/** One content's edges on one device: uploaded once, shared by every admission that draws them. */
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

/** What one area draws: its edge sets, each under its own item-local to band-local device affine, summed in one accumulation. */
export interface AreaPart { readonly edges: Float32Array; readonly affine: Affine }

export interface PreparedArea {
    readonly device: GfxDevice;
    readonly generation: number;
    readonly sets: readonly EdgeSet[];
    readonly affines: readonly Affine[];
    /** The band rectangle in device px: the area's texels in the scratch, which is at least the band's size. */
    readonly bounds: RectI;
}

export type AreaAdmission =
    | { readonly status: 'ready'; readonly value: PreparedArea }
    | { readonly status: 'empty' }
    /** Retry with the same parts: the uploads resume where they stopped. */
    | { readonly status: 'deferred' }
    | { readonly status: 'denied'; readonly pool: 'gpu' | 'cpu'; readonly bytes: number }
    | { readonly status: 'unsupported'; readonly why: string };

export interface AreaKit {
    /** Admits the parts (each an edge array the caller keeps alive and unchanged, and its affine to band-local px) over `bounds`. */
    admit(host: LayerHost, parts: readonly AreaPart[], bounds: RectI, budget: FrameBudget, viewport: { readonly width: number; readonly height: number }): AreaAdmission;
    /** Starts a batch: the areas placed until endBatch share one accumulation pass on the scratch, each in its own region. */
    beginBatch(host: LayerHost): void;
    /** Places and accumulates these areas (one item's fill and stroke) in the open batch, all or none: false when they do not all fit
     * in what is left of the scratch (end the batch, composite what it holds, and start another). Throws an out-of-budget ArenaError
     * from the uniform ring after closing nothing: the caller ends the batch. */
    place(host: LayerHost, pass: GpuPass, areas: readonly PreparedArea[]): boolean;
    endBatch(pass: GpuPass): void;
    /** Paints a placed area's coverage with the output, in the current scope (after endBatch). False when it was not placed. */
    composite(pass: GpuPass, prepared: PreparedArea, output: AreaOutput): boolean;
    retire(prepared: PreparedArea): void;
    /** The caller no longer keeps this edge array: its buffer goes once no admission holds it. */
    forget(edges: Float32Array): void;
    beginFrame(frame: number): void;
    release(): void;
    memory(): { readonly gpuBytes: number };
}

/** An upload piece is 4096 edges (64 KiB) at most; a refused piece halves down to 256 (4 KiB) before the admission defers. */
const PIECE_INSTANCES = 4096;
const MIN_PIECE_INSTANCES = 256;
const INSTANCE_BYTES = 16;
/** GPU bytes of edge sets no admission holds. A shape's tiles share its set, so a few megabytes is thousands of shapes' worth. */
const IDLE_EDGE_BYTES = 8 * 2 ** 20;
/** viewport, band, matrix, translation: four vec4. */
const UNIFORM_BYTES = 64;

/** One instance per edge: a strip from its leftmost pixel to the band's right edge over the rows it crosses. */
const EDGE_SHADER: ShaderModule = {
    id: 'platform-area-edge', revision: 3,
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
    float ta = a.x + (v0 - a.y) * dxdy - p.x, tb = a.x + (v1 - a.y) * dxdy - p.x;
    // The mean share over the edge's run through this row: exact for a straight edge.
    float mean = abs(tb - ta) > 1e-5 ? (share(tb) - share(ta)) / (tb - ta) : clamp(1.0 - 0.5 * (ta + tb), 0.0, 1.0);
    accumulated = dir * (v1 - v0) * mean;
}`,
    },
};

/** The band's clear pass: a band-sized quad written with zero, so the area starts from nothing without clearing the scratch. */
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

/** The shared scratch of one device: one r32f target at least as large as every viewport an area kit there has drawn into, used by
 * every area kit on the device. `holder` is the kit that reports its bytes (one report, however many kits draw with it). */
interface Scratch { readonly target: AreaTarget; readonly bytes: number; users: number; holder: object | null }
const scratchOf = new WeakMap<GfxDevice, Scratch>();

export function createAreaKit(): AreaKit {
    let device: GfxDevice | null = null;
    let edgePipeline: PipelineHandle | null = null;
    let clear: PipelineHandle | null = null;
    let pending = false, failed = false, serial = 0, frame = 0;
    /** Every edge set on the device, by its edge array; idle ones (refs 0) are the least recently used first. */
    const sets = new Map<Float32Array, EdgeSet>();
    const live = new Set<PreparedArea>();
    /** Whether this kit holds a reference on the device's scratch (taken at its first ready area, returned at release). */
    let holding = false;
    let setBytes = 0, idleBytes = 0;
    const uniformScratch = new Float32Array(UNIFORM_BYTES / 4);
    /** The open batch: its scratch, its accumulation token (opened by the first placement), the shelf cursor, and where each placed
     * area sits. Reused across batches: nothing is allocated per frame once the map has grown. */
    let batchScratch: Scratch | null = null, batchToken: ReturnType<GpuPass['beginArea']> | null = null;
    let shelfX = 0, shelfY = 0, shelfH = 0;
    const placed = new Map<PreparedArea, { x: number; y: number }>();
    const spare: { x: number; y: number }[] = [];
    const tentative: { x: number; y: number }[] = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
    /** The scissor of every accumulation draw: the whole scratch (each draw stays inside its region by its own geometry). */
    const whole = { x: 0, y: 0, width: 0, height: 0 };
    /** One draw's uniforms: the scratch size, the region (x0, y0, x1, y1), and the item-local to scratch affine (null for the clear). */
    const regionUniforms = (host: LayerHost, W: number, H: number, at: { x: number; y: number }, bounds: RectI, affine: Affine | null) => {
        uniformScratch[0] = W; uniformScratch[1] = H; uniformScratch[2] = 0; uniformScratch[3] = 0;
        uniformScratch[4] = at.x; uniformScratch[5] = at.y; uniformScratch[6] = at.x + bounds.width; uniformScratch[7] = at.y + bounds.height;
        uniformScratch[8] = affine ? affine[0] : 0; uniformScratch[9] = affine ? affine[1] : 0;
        uniformScratch[10] = affine ? affine[2] : 0; uniformScratch[11] = affine ? affine[3] : 0;
        uniformScratch[12] = affine ? affine[4] + at.x : 0; uniformScratch[13] = affine ? affine[5] + at.y : 0; uniformScratch[14] = 0; uniformScratch[15] = 0;
        return host.uniforms(uniformScratch);
    };
    /** This kit's identity as a scratch holder. */
    const kitToken = {};

    /** Whether the area pipelines are ready: false while they compile, 'failed' after a refused compile, which the caller takes as
     * unsupported (the coverage route draws the shape, counted) rather than a wait that never ends. */
    const ensurePipelines = (owner: GfxDevice): boolean | 'failed' => {
        if (edgePipeline && clear && device === owner) return true;
        if (device !== owner) { release(); device = owner; }
        if (failed) return 'failed';
        if (pending) return false;
        pending = true;
        const mine = ++serial;
        const make = (shader: ShaderModule, blend: 'add' | 'replace') => owner.createPipeline({ shader, topology: 'triangle-strip',
            colorFormat: 'r32f', samples: 1, blend, alphaToCoverage: false, colorWrite: [true, true, true, true], stencil: NO_STENCIL });
        Promise.all([make(EDGE_SHADER, 'add'), make(CLEAR_SHADER, 'replace')]).then(([edgeHandle, clearHandle]) => {
            pending = false;
            if (device === owner && mine === serial) { edgePipeline = edgeHandle; clear = clearHandle; }
            else { owner.destroy(edgeHandle); owner.destroy(clearHandle); }
        }, () => { pending = false; failed = true; });
        return false;
    };

    /** The device's scratch, large enough for `viewport`: created at its size on first use, and grown to the larger of each side when a
     * larger viewport arrives (a tile's composer and a pane-sized preview share it). An area larger than its scratch is refused by
     * beginArea as invalid input, so a scratch kept at the first viewport's size failed every later, larger one. Growth replaces the
     * target: draws look the scratch up at draw time, and the device retires the old target's lease. A refused growth keeps the old one. */
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
            if (error instanceof ArenaError && error.code === 'out-of-budget') return 'denied';
            throw error;
        }
        if (existing) { owner.destroy(existing.target.target); owner.destroy(existing.target.texture); }
        const scratch: Scratch = { target, bytes, users: existing?.users ?? 0, holder: kitToken };
        scratchOf.set(owner, scratch);
        return scratch;
    };
    const destroySet = (set: EdgeSet): void => {
        if (sets.get(set.key) === set) sets.delete(set.key);
        if (set.refs === 0) idleBytes -= set.bytes;
        setBytes -= set.bytes;
        for (const piece of set.pieces) set.device.destroy(piece.buffer);
        set.pieces.length = 0;
    };
    /** Keeps idle sets within IDLE_EDGE_BYTES, least recently used first out; a set used this frame stays. */
    const trimIdle = (): void => {
        if (idleBytes <= IDLE_EDGE_BYTES) return;
        for (const set of [...sets.values()]) {
            if (idleBytes <= IDLE_EDGE_BYTES) break;
            if (set.refs === 0 && set.usedFrame < frame) destroySet(set);
        }
    };
    const unref = (set: EdgeSet): void => {
        if (--set.refs !== 0) return;
        idleBytes += set.bytes; set.usedFrame = frame;
        // Most recently used last, so the trim takes the oldest first. A set no longer indexed (forgotten, or of an old device
        // generation) goes with its last holder.
        if (sets.get(set.key) === set) { sets.delete(set.key); sets.set(set.key, set); }
        else destroySet(set);
    };
    /** Uploads what the frame allows of one set: true once every edge is on the device. A refused lease is a denial. */
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
            // A set no admission holds yet counts as idle while it uploads, so a refused admission's pieces are trimmed like any other.
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
            if (scratch && --scratch.users === 0) {
                scratchOf.delete(device);
                device.destroy(scratch.target.target); device.destroy(scratch.target.texture);
            } else if (scratch && scratch.holder === kitToken) scratch.holder = null;
        }
        holding = false;
        if (edgePipeline && device) device.destroy(edgePipeline);
        if (clear && device) device.destroy(clear);
        edgePipeline = null; clear = null; pending = false; failed = false; device = null;
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
                // The upload resumes where it stopped: pieces already written stay on the set, whatever this admission does next.
                const uploaded = upload(host, set, budget);
                if (uploaded === 'deferred') return { status: 'deferred' };
                if (uploaded === 'unsupported') return { status: 'unsupported', why: 'vertex-buffer' };
                if (uploaded !== true) return { status: 'denied', pool: 'gpu', bytes: uploaded.denied };
                held.push(set);
            }
            if (!held.length) return { status: 'empty' };
            // The pipelines and the scratch come after the edges: a deferral here keeps every piece already uploaded.
            const pipelines = ensurePipelines(owner);
            if (pipelines === 'failed') return { status: 'unsupported', why: 'pipeline' };
            if (!pipelines) return { status: 'deferred' };
            const scratch = acquireScratch(host, owner, viewport);
            if (scratch === 'denied') return { status: 'denied', pool: 'gpu', bytes: viewport.width * viewport.height * 4 };
            if (!holding) { scratch.users++; holding = true; }
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
            // Shelf packing, decided for every area before any is drawn: an item's fill and stroke go into one batch or the next.
            let x = shelfX, y = shelfY, h = shelfH;
            for (let i = 0; i < areas.length; i++) {
                const prepared = areas[i];
                if (!live.has(prepared) || prepared.device !== host.device() || prepared.generation !== host.generation) throw new Error('Stale area');
                const { width, height } = prepared.bounds;
                if (x + width > W) { y += h; x = 0; h = 0; }
                if (y + height > H || width > W) return false;
                const at = tentative[i] ?? (tentative[i] = { x: 0, y: 0 });
                at.x = x; at.y = y;
                x += width; h = Math.max(h, height);
            }
            shelfX = x; shelfY = y; shelfH = h;
            if (!batchToken) batchToken = pass.beginArea(scratch.target);
            whole.width = W; whole.height = H;
            for (let i = 0; i < areas.length; i++) {
                const prepared = areas[i], { bounds } = prepared, at = tentative[i];
                // The region's own clear first: the area accumulates from zero, and no other region is touched.
                pass.draw({ pipeline: clear, bindings: { uniforms: [{ binding: 0, slice: regionUniforms(host, W, H, at, bounds, null) }], textures: [] },
                    vertices: [], first: 0, count: 4, instances: 1, scissor: whole });
                for (let s = 0; s < prepared.sets.length; s++) {
                    const slice = regionUniforms(host, W, H, at, bounds, prepared.affines[s]);
                    for (const piece of prepared.sets[s].pieces) {
                        pass.draw({ pipeline: edgePipeline, bindings: { uniforms: [{ binding: 0, slice }], textures: [] },
                            vertices: [{ buffer: piece.buffer, offset: 0, bytes: piece.bytes }], first: 0, count: 4, instances: piece.count, scissor: whole });
                    }
                }
                const kept = spare.pop() ?? { x: 0, y: 0 };
                kept.x = at.x; kept.y = at.y;
                placed.set(prepared, kept);
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
            pass.compositeArea(batchScratch.target, at, prepared.bounds, output);
            return true;
        },
        retire,
        forget(edges): void {
            const set = sets.get(edges);
            if (!set) return;
            // A set still held is dropped from the index and destroyed by the last retire's trim once it is idle and unindexed.
            if (set.refs === 0) destroySet(set);
            else sets.delete(edges);
        },
        beginFrame(next): void { frame = next; },
        release,
        // The scratch is reported once, by its holder; when the holder lets go while others draw with it, the next of them to be
        // asked takes the report.
        memory: () => {
            const scratch = holding && device ? scratchOf.get(device) : undefined;
            if (scratch && scratch.holder === null) scratch.holder = kitToken;
            return { gpuBytes: setBytes + (scratch && scratch.holder === kitToken ? scratch.bytes : 0) };
        },
    };
}
