import { auditCount } from './renderAudit';
import type { Affine, Rgba } from '../types';
import type { LayerHost } from './compositor.types';
import type { BufferHandle, ClipHandle, CoverageOutput, CoverageTarget, GfxDevice, GpuPass, PipelineHandle, RectI, Samples, ShaderModule, StencilOp, StencilState, ByteLease, UniformSlice } from './gfx/api';
import { coverageTargetBytes } from './gfx/api';
import { ArenaError } from './resourceArena';
import type { FrameBudget } from './types';

/** How the triangles combine. `nonzero` and `evenodd` count or parity-test the signed winding;
 * `union` sets a stencil bit per covered sample, for overlapping convex pieces (stroke outlines)
 * whose union needs no counting at all. */
export type PathCoverageRule = 'nonzero' | 'evenodd' | 'union';

/** Winding of any point is bounded by the number of edges crossing a ray from it, and an 8-bit
 * stencil counting with wrapping arithmetic keeps a nonzero winding nonzero while that bound is at
 * most 255. Nonzero shapes with more edges must take their exact fallback. */
export const PATH_COVERAGE_STENCIL_MAX_EDGES = 255;
/** Multisample storage is required for the boundary coverage; the display surface is never used. */
export const PATH_COVERAGE_SAMPLES: Samples = 4;
/** Largest coverage target one path item may take. A target costs ~52 bytes per pixel (resolve, 4x colour, stencil), so a
 * notebook page's clip mask asked 13-33 MB, which a pane's GPU share never grants: 'denied' meant waiting forever and the
 * paper never drew on the GPU (measured: 54 of 54 page-mask admissions refused). Larger items take the exact canonical
 * raster route, which tiles within any budget. */
const PATH_COVERAGE_MAX_TARGET_BYTES = 8 * 2 ** 20;
/** The shared composite scratch's cap: one band of a path, reused band by band. 8 MiB per layer's kit was the 7.98 MB
 * request that pushed a notebook's load over the GPU pool (paper, board and wet layers each hold a kit), degrading it;
 * at 2 MiB a 516-texel tile draws in about four bands. */
const PATH_COVERAGE_SCRATCH_BYTES = 2 * 2 ** 20;
/** One vertex upload piece; a frame's allowance takes as many as it covers. */
const PATH_COVERAGE_UPLOAD_CHUNK_BYTES = 256 * 1024;
/** The share of a device's scratch that `live` composite admissions of one grid hold (the kits on a device sum to it once). */
function scratchShare(device: GfxDevice | null, grid: CompositeGrid, live: number): number {
    const shared = device && live > 0 ? scratchTables[String(grid) as '1' | '4'].targets.get(device) : undefined;
    return shared ? Math.round(shared.bytes * live / shared.refs) : 0;
}
/** GPU bytes of triangle buffers that no live admission holds. A stroke's tiles share them, so a few megabytes is a few
 * strokes' worth; past it the least recently retired are destroyed and re-uploaded if drawn again. */
const IDLE_VERTEX_BYTES = 8 * 2 ** 20;
/** A device's composite scratch, shared by every kit on that device. `refs` counts the live composite admissions of all
 * of them: the scratch exists exactly while one is in flight, and its lease is the device's, not any one kit's. */
interface SharedScratch { readonly device: GfxDevice; readonly target: CoverageTarget; readonly bytes: number; refs: number }
/** How a composite draws: 1 is the device-resolution MSAA colour target (paths); 4 is the grid target (ink): one r8 texel per
 * subsample, a 4×4 box resolve in the composite. Each has its own scratch, because the formats differ. */
type CompositeGrid = 1 | 4;
/** The widest composite band a kit has asked for on a device, per grid. It outlives the scratch, so the next scratch is made at
 * this width and no kit grows it again (a notebook's paper, board and wet ink ask for different widths). */
const scratchTables: Record<'1' | '4', { readonly targets: WeakMap<GfxDevice, SharedScratch>; readonly widths: WeakMap<GfxDevice, number> }> = {
    '1': { targets: new WeakMap(), widths: new WeakMap() },
    '4': { targets: new WeakMap(), widths: new WeakMap() },
};

/** Origin-relative triangles, six values per triangle. `positive` adds +1 winding and `negative`
 * adds -1; for `union` every triangle is in `positive` and `negative` is empty. */
export interface PathCoverageShapes {
    readonly positive: Float64Array;
    readonly negative: Float64Array;
    readonly edges: number;
    /** Origin-relative bounds of the shapes, in the same units as the triangles. */
    readonly bounds: Readonly<{ x0: number; y0: number; x1: number; y1: number }>;
}

export interface PathCoverageRequest {
    readonly shapes: PathCoverageShapes;
    readonly rule: PathCoverageRule;
    /** Origin-relative local to device-pixel affine, [a, b, c, d, e, f]. */
    readonly affine: Affine;
    readonly viewport: Readonly<{ width: number; height: number }>;
    /** Straight colour; premultiplied at admission. A mask request ignores it and covers with white. */
    readonly colour: Rgba;
    readonly output: CoverageOutput;
    /** Union coverage drawn in four jittered passes (16 samples): for ink, where antialiased edges stack. Never for crisp
     * axis-aligned strokes (paper ruling): the jitter spread a one-row line over three rows. */
    readonly supersample?: boolean;
    /** How a composite samples its coverage. 'msaa' (default): the device-resolution colour target with MSAA, plus `supersample`
     * jitter when asked. 'grid4' (ink only, composite output): one sample per subsample of a 4×4 grid per device pixel, box-averaged
     * in the composite; `supersample` does not apply to it. A mask output is always 'msaa'. */
    readonly sampling?: 'msaa' | 'grid4';
}

/** A multi-set request: several triangle sets drawn as one coverage, each with its own buffer (a growing stroke appends a
 * chunk per input frame, and only the new chunk's triangles are uploaded). Same rules as `PathCoverageRequest`. */
export interface PathCoverageSetsRequest extends Omit<PathCoverageRequest, 'shapes'> {
    readonly sets: readonly PathCoverageShapes[];
}

export type PathCoverageAdmission =
    | { readonly status: 'ready'; readonly value: PreparedPathCoverage }
    | { readonly status: 'empty' }
    | { readonly status: 'denied' }
    /** The frame's upload allowance ran out mid-upload: retry next frame (a frame wait, not a memory wait). */
    | { readonly status: 'deferred' }
    | { readonly status: 'unsupported' };

/** One triangle set of an admission: its shared buffer (positive triangles first, then negative), and how many of each. */
export interface PreparedPathPart {
    readonly vertices: BufferHandle;
    readonly positiveVertices: number;
    readonly negativeVertices: number;
    /** The buffer's shared entry; the admission holds one reference on it. */
    readonly set: VertexSet;
}

/** One triangle set's buffer, shared by every admission of that set. Its `refs` count the live admissions holding it; a set
 * whose refs reach zero is freed. A set uploaded by an admission that was then refused stays at zero refs, so the retry
 * uploads nothing, and release() frees it. */
interface VertexSet {
    readonly key: Float64Array;
    readonly device: GfxDevice;
    readonly buffer: BufferHandle;
    readonly negative: Float64Array;
    readonly positiveVertices: number;
    readonly negativeVertices: number;
    refs: number;
    readonly bytes: number;
    /** The frame this set was last held or retired in: an idle set used in the current frame is never evicted. */
    usedFrame: number;
}

/** Pre-admitted vertex buffers, plus the mask's own target and clip handle when the output is a mask. A composite
 * owns no target: it draws through the kit's shared scratch, one band at a time. */
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
    /** A 'modulate' composite: its colour is the multiply source k = C·c + 1 − α·c, drawn by the modulate cover. */
    readonly modulate: boolean;
    /** 4 for a 'grid4' composite (its output is then 'paint' with straight colour); 1 otherwise. */
    readonly grid: CompositeGrid;
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
/** Covers where the stencil is set and clears it there, so the next jittered pass starts from zero. */
const COVER_RESET_STENCIL: StencilState = { enabled: true, compare: 'not-equal', reference: 0, readMask: 255, writeMask: 255,
    front: { fail: 'keep', depthFail: 'keep', pass: 'zero' }, back: { fail: 'keep', depthFail: 'keep', pass: 'zero' } };
/** Union coverage (ink) is drawn four times at these device-pixel offsets, each adding a quarter: with 4× MSAA that is 16
 * samples a pixel. Where two antialiased ink edges stack (a crossing, a highlighter over ink), 4× MSAA's quarter steps
 * added up to two steps against canvas2d (max 100-113); the GPU offers no 8× (probed: 2 and 4 only). */
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
    /** The grid composite's set: one sample per subsample in an r8 target, no MSAA (a grid target's format and sample count). */
    readonly gridIncrement: PipelineHandle; readonly gridDecrement: PipelineHandle; readonly gridInvert: PipelineHandle;
    readonly gridUnion: PipelineHandle; readonly gridCover: PipelineHandle;
}

/** Platform stencil-coverage executor. Winding or union triangles fill an admitted stencil target,
 * one cover quad paints the colour under the not-equal test, and the scope composites once (or
 * leaves an R-channel clip mask). Admission and uploads happen in admit(); draws only borrow. */
/** `onFreed(key)` runs when the kit stops holding a triangle array it was given (its shared set and its upload are the only
 * holders), so an owner that leases the array's memory can release the lease then, not before. */
export function createPathCoverageKit(host: LayerHost, report: (error: unknown) => void, audit = 'path-coverage',
    onFreed?: (key: Float64Array) => void) {
    let device: GfxDevice | null = null, pipelines: Pipelines | null = null, pending = false, failed = false, unsupported = false;
    let incarnation = 0, disposed = false, gpuBytes = 0, compositeLive = 0, gridLive = 0;
    const live = new Map<PreparedPathCoverage, number>();
    // One vertex buffer per triangle set, shared by every admission of it: the triangles are origin-relative, so all tile
    // views of an item at one scale draw the same buffer under their own affine. A buffer per admission uploaded and
    // charged a stroke once per tile it crossed, and the notebook's paper was refused for the room (267 refusals).
    const shared = new Map<Float64Array, VertexSet>();
    // Uniform data is filled and copied into the frame's ring by host.uniforms before the next fill (the ring copies it
    // synchronously), so one array serves every uniform a draw needs.
    const uniformScratch = new Float32Array(12);
    // A buffer larger than one frame's upload allowance fills across frames. Refused whole each frame, a stroke's outline
    // at 332% never uploaded and the board never presented again (measured: claimUpload refused 73 of 73 admissions).
    const uploading = new Map<Float64Array, { device: GfxDevice; buffer: BufferHandle; data: Float32Array; staging: ByteLease;
        written: number; negative: Float64Array; bytes: number }>();
    const dropUpload = (key: Float64Array) => {
        const up = uploading.get(key);
        if (!up) return;
        uploading.delete(key); gpuBytes -= up.bytes;
        if (!shared.has(key)) onFreed?.(key);
        host.allocator.cpu.release(up.staging); up.device.destroy(up.buffer);
    };
    // A set with no live admission stays on the GPU: the next tile that draws the same stroke then uploads nothing. The
    // composer retires each run right after drawing it, so without this every tile of a stroke re-uploaded it. Idle sets
    // are ordered oldest first and destroyed past IDLE_VERTEX_BYTES, and release() frees them all. Invariant: a set in
    // `shared` has refs 0 exactly when it is in `idle`.
    const idle = new Map<Float64Array, VertexSet>();
    let idleBytes = 0, frame = 0;
    const destroySet = (entry: VertexSet) => {
        shared.delete(entry.key); gpuBytes -= entry.bytes; entry.device.destroy(entry.buffer);
        if (!uploading.has(entry.key)) onFreed?.(entry.key);
    };
    const unidle = (entry: VertexSet) => { if (idle.delete(entry.key)) idleBytes -= entry.bytes; };
    /** Destroys idle sets, oldest first, until `bytes` are freed, skipping any used in the current frame. Returns the bytes freed;
     * the governor's evict(bytes) and the idle bound both come here, so a set in use this frame is never reclaimed. */
    const reclaimIdle = (bytes: number): number => {
        let freed = 0;
        for (const entry of idle.values()) {
            if (freed >= bytes) break;
            if (entry.usedFrame >= frame) continue;
            idle.delete(entry.key); idleBytes -= entry.bytes; freed += entry.bytes; destroySet(entry);
        }
        return freed;
    };
    /** Takes one reference on a set, which leaves the idle list. */
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
        if (prepared.output.kind !== 'mask') {
            if (prepared.grid === 4) gridLive--; else compositeLive--;
            releaseScratch(prepared.device, prepared.grid);
        }
        if (prepared.clip) prepared.device.destroy(prepared.clip);
        if (prepared.target) { prepared.device.destroy(prepared.target.target); prepared.device.destroy(prepared.target.texture); }
        for (const part of prepared.parts) releaseShared(part.set);
    };
    // The composite scratch is one per DEVICE (a pane's context), shared by every kit there: coverage draws are sequential
    // within a frame. One per kit held 2 MiB for each of paper, board and wet, and the pane's working grant refused the
    // paper's path admissions for the room (measured: refused at pane-grant:working, 33 and 54 per draw).
    // A target per item, held for its plan, made every page-sized fill a 13-33 MB admission the pane never granted, so
    // the paper took the CPU raster route (measured: 330 fallbacks in one notebook pan).
    const scratchOf = (owner: GfxDevice | null, grid: CompositeGrid): SharedScratch | undefined =>
        owner ? scratchTables[String(grid) as '1' | '4'].targets.get(owner) : undefined;
    /** Drops one composite admission's hold on its device's scratch. The scratch is released when none is in flight. */
    const releaseScratch = (owner: GfxDevice, grid: CompositeGrid) => {
        const table = scratchTables[String(grid) as '1' | '4'];
        const shared = table.targets.get(owner);
        if (!shared || --shared.refs > 0) return;
        table.targets.delete(owner);
        owner.destroy(shared.target.target); owner.destroy(shared.target.texture);
    };
    /** Ensures the device's scratch of this grid holds a band of the given width; false when its lease is refused (a wait). It
     * only grows, and to the widest band the device has asked for, at the full height the cap allows: a grown scratch replaced
     * the one every kit drew from, and a band re-sized per request was a new target for each kit's width change. A grid scratch
     * is 4× the texels per device pixel, so its band is sized by the grid's bytes (coverageTargetBytes with the grid). */
    const ensureScratch = (owner: GfxDevice, width: number, grid: CompositeGrid): boolean | 'unsupported' => {
        const table = scratchTables[String(grid) as '1' | '4'];
        const rowBytes = coverageTargetBytes(width, 1, grid === 4 ? 1 : PATH_COVERAGE_SAMPLES, grid);
        if (rowBytes > PATH_COVERAGE_SCRATCH_BYTES) return 'unsupported';
        // A grid texture is (4·width) texels wide, and the device's largest texture side bounds it.
        if (grid === 4 && width * 4 > owner.limits.maxRenderTargetSize) return 'unsupported';
        const current = table.targets.get(owner);
        // Draws loop over bands of the target's height, so any height serves; only the width must fit the request.
        if (current && current.target.width >= width) return true;
        const w = Math.max(width, current?.target.width ?? 0, table.widths.get(owner) ?? 0);
        const samples = grid === 4 ? 1 : PATH_COVERAGE_SAMPLES;
        const h = Math.floor(PATH_COVERAGE_SCRATCH_BYTES / coverageTargetBytes(w, 1, samples, grid));
        const bytes = coverageTargetBytes(w, h, samples, grid);
        const lease = host.allocator.gpu.reserve(bytes);
        if (!lease) return false;
        let target: CoverageTarget;
        try { target = owner.createCoverageTarget(w, h, samples, lease, grid === 4 ? { grid: 4 } : undefined); }
        catch (error) { host.allocator.gpu.release(lease); throw error; }
        // No admission holds the old target (draws read the scratch when they draw), and the device returns its lease.
        if (current) { owner.destroy(current.target.target); owner.destroy(current.target.texture); }
        table.widths.set(owner, w);
        table.targets.set(owner, { device: owner, target, bytes, refs: current?.refs ?? 0 });
        auditCount(audit, grid === 4 ? 'kit:grid4-scratch-new' : 'kit:scratch-new');
        return true;
    };
    const release = () => {
        incarnation++;
        for (const prepared of [...live.keys()]) retireOwned(prepared);
        for (const entry of shared.values()) { gpuBytes -= entry.bytes; entry.device.destroy(entry.buffer); }
        const held = [...shared.keys()];
        shared.clear(); idle.clear(); idleBytes = 0;
        for (const key of held) if (!uploading.has(key)) onFreed?.(key);
        for (const key of [...uploading.keys()]) dropUpload(key);
        if (pipelines && device) for (const handle of Object.values(pipelines)) device.destroy(handle);
        pipelines = null; device = null; pending = false; failed = false; unsupported = false;
    };
    const ensurePipelines = () => {
        if (!device || pipelines || pending || failed) return;
        const owner = device, serial = ++incarnation; pending = true;
        const base = { topology: 'triangles', colorFormat: 'rgba8', samples: PATH_COVERAGE_SAMPLES, alphaToCoverage: false } as const;
        const gridBase = { topology: 'triangles', colorFormat: 'r8', samples: 1, alphaToCoverage: false } as const;
        const hidden = { blend: 'replace', colorWrite: NO_COLOUR_WRITE } as const;
        Promise.all([
            owner.createPipeline({ ...base, ...hidden, shader: WINDING_SHADER, stencil: winding('increment-wrap') }),
            owner.createPipeline({ ...base, ...hidden, shader: WINDING_SHADER, stencil: winding('decrement-wrap') }),
            owner.createPipeline({ ...base, ...hidden, shader: WINDING_SHADER, stencil: winding('invert') }),
            owner.createPipeline({ ...base, ...hidden, shader: WINDING_SHADER, stencil: UNION_STENCIL }),
            owner.createPipeline({ ...base, topology: 'triangle-strip', shader: COVER_SHADER, blend: 'source-over',
                colorWrite: [true, true, true, true], stencil: COVER_STENCIL }),
            owner.createPipeline({ ...base, topology: 'triangle-strip', shader: COVER_SHADER, blend: 'add',
                colorWrite: [true, true, true, true], stencil: COVER_RESET_STENCIL }),
            // The multiply cover: the device's fixed-function dst·src step writes k into every covered sample, so a white
            // slice is multiplied by each item in turn with no backdrop copy.
            owner.createPipeline({ ...base, topology: 'triangle-strip', shader: COVER_SHADER, blend: 'modulate',
                colorWrite: [true, true, true, true], stencil: COVER_STENCIL }),
            // The grid set: the same stencil rules at one sample per texel of an r8 grid target. The cover writes coverage 1
            // into each covered texel; the composite's 'paint' output box-averages them.
            owner.createPipeline({ ...gridBase, ...hidden, shader: WINDING_SHADER, stencil: winding('increment-wrap') }),
            owner.createPipeline({ ...gridBase, ...hidden, shader: WINDING_SHADER, stencil: winding('decrement-wrap') }),
            owner.createPipeline({ ...gridBase, ...hidden, shader: WINDING_SHADER, stencil: winding('invert') }),
            owner.createPipeline({ ...gridBase, ...hidden, shader: WINDING_SHADER, stencil: UNION_STENCIL }),
            owner.createPipeline({ ...gridBase, topology: 'triangle-strip', shader: COVER_SHADER, blend: 'replace',
                colorWrite: [true, false, false, false], stencil: COVER_STENCIL }),
        ]).then(([increment, decrement, invert, union, cover, coverAdd, coverModulate,
            gridIncrement, gridDecrement, gridInvert, gridUnion, gridCover]) => {
            const made = [increment, decrement, invert, union, cover, coverAdd, coverModulate, gridIncrement, gridDecrement, gridInvert, gridUnion, gridCover];
            if (disposed || incarnation !== serial || device !== owner) {
                for (const handle of made) owner.destroy(handle);
                return;
            }
            pipelines = { increment, decrement, invert, union, cover, coverAdd, coverModulate,
                gridIncrement, gridDecrement, gridInvert, gridUnion, gridCover };
            pending = false; host.invalidate('path-coverage-ready');
        }, error => {
            if (incarnation !== serial) return;
            pending = false; failed = true; report(error); host.invalidate('path-coverage-fallback');
        });
    };
    const warm = () => {
        if (disposed) return;
        const next = host.device();
        if (device !== next) { release(); device = next; }
        ensurePipelines();
    };
    const isReady = (): boolean => !disposed && !failed && !unsupported && !!pipelines && !!device &&
        host.device() === device && host.generation === device.generation;
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
    /** One winding draw of one triangle set's range, under the band's scissor. A kit-level function, so a draw builds no closure. */
    const drawWinding = (pass: GpuPass, part: PreparedPathPart, pipeline: PipelineHandle, windingUniforms: UniformSlice, bounds: RectI,
        first: number, count: number): void => {
        if (!count) return;
        pass.draw({ pipeline, bindings: { uniforms: [{ binding: 0, slice: windingUniforms }], textures: [] },
            vertices: [{ buffer: part.vertices, offset: 0, bytes: (part.positiveVertices + part.negativeVertices) * 8 }],
            first, count, instances: 1, scissor: bounds });
    };
    const render = (pass: GpuPass, prepared: PreparedPathCoverage): void => {
        if (disposed || !live.has(prepared) || !pipelines || prepared.device !== device || host.device() !== device ||
            host.generation !== prepared.device.generation) throw new Error('Stale path coverage');
        const { affine, colour, viewport, output } = prepared;
        // A grid composite draws its own one-sample r8 set, and covers with coverage 1 in each texel; its colour is applied by
        // the 'paint' output at the composite. An MSAA composite keeps its own set and colour.
        const grid = prepared.grid === 4;
        const target = prepared.target ?? scratchOf(prepared.device, prepared.grid)?.target;
        if (!target || target.width < prepared.bounds.width) throw new Error('Stale path coverage');
        const set = pipelines;
        const increment = grid ? set.gridIncrement : set.increment, decrement = grid ? set.gridDecrement : set.decrement;
        const invert = grid ? set.gridInvert : set.invert, union = grid ? set.gridUnion : set.union;
        const coverPipeline = grid ? set.gridCover : prepared.modulate ? set.coverModulate : set.cover;
        const coverColour = grid ? COVER_WHITE : colour;
        // Each uniform is copied into the frame's ring by host.uniforms before the scratch is filled for the next one.
        const windingUniforms = windingSlice(viewport, affine, 0, 0);
        const whole = prepared.bounds;
        for (let y = whole.y; y < whole.y + whole.height; y += target.height) {
        const bounds: RectI = { x: whole.x, y, width: whole.width, height: Math.min(target.height, whole.y + whole.height - y) };
        const coverUniforms = coverSlice(viewport, bounds, coverColour, 1);
        const token = pass.beginCoverage(target, bounds);
        if (grid) auditCount(audit, 'kit:resolve-bands');
        try {
            if (prepared.supersample && prepared.rule === 'union' && output.kind === 'composite') {
                const quarterUniforms = coverSlice(viewport, bounds, colour, 0.25);
                for (const [dx, dy] of UNION_JITTER) {
                    const jitteredUniforms = windingSlice(viewport, affine, dx, dy);
                    for (const part of prepared.parts) {
                        drawWinding(pass, part, union, jitteredUniforms, bounds, 0, part.positiveVertices);
                    }
                    pass.draw({ pipeline: set.coverAdd, bindings: { uniforms: [{ binding: 0, slice: quarterUniforms }], textures: [] },
                        vertices: [], first: 0, count: 4, instances: 1, scissor: bounds });
                }
            } else {
                for (const part of prepared.parts) {
                    if (prepared.rule === 'evenodd') drawWinding(pass, part, invert, windingUniforms, bounds, 0, part.positiveVertices + part.negativeVertices);
                    else if (prepared.rule === 'union') drawWinding(pass, part, union, windingUniforms, bounds, 0, part.positiveVertices);
                    else {
                        drawWinding(pass, part, increment, windingUniforms, bounds, 0, part.positiveVertices);
                        drawWinding(pass, part, decrement, windingUniforms, bounds, part.positiveVertices, part.negativeVertices);
                    }
                }
                pass.draw({ pipeline: coverPipeline,
                    bindings: { uniforms: [{ binding: 0, slice: coverUniforms }], textures: [] },
                    vertices: [], first: 0, count: 4, instances: 1, scissor: bounds });
            }
        } finally { pass.endCoverage(token, output); }
        }
    };
    /** The winding and cover uniforms, written into the kit's one scratch and copied by the frame's ring at once. */
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
    /** The shared buffer of one triangle set, uploaded in chunks within each frame's allowance. Returns the entry, or why not:
     * a refused or deferred upload keeps what it wrote, and the retry resumes it. */
    const vertexSetFor = (owner: GfxDevice, set: PathCoverageShapes, vertexCount: number, budget: FrameBudget):
        VertexSet | 'denied' | 'deferred' | 'unsupported' => {
        const vertexBytes = vertexCount * 8;
        const found = shared.get(set.positive);
        if (found) return found.device !== owner || found.negative !== set.negative || found.bytes !== vertexBytes ? 'unsupported' : found;
        let up = uploading.get(set.positive);
        if (up && (up.device !== owner || up.negative !== set.negative || up.bytes !== vertexBytes)) { dropUpload(set.positive); up = undefined; }
        if (!up) {
            const staging = host.allocator.cpu.reserve(vertexBytes);
            if (!staging) return 'denied';
            // Positive triangles first, then negative: the draw ranges follow this order.
            const data = new Float32Array(vertexCount * 2);
            data.set(set.positive, 0);
            data.set(set.negative, set.positive.length);
            const lease = host.allocator.gpu.reserve(vertexBytes);
            if (!lease) { host.allocator.cpu.release(staging); return 'denied'; }
            let buffer: BufferHandle;
            try { buffer = owner.createBuffer(vertexBytes, ['vertex', 'copy-dst'], lease); }
            catch (error) {
                host.allocator.gpu.release(lease); host.allocator.cpu.release(staging);
                if (error instanceof ArenaError && error.code === 'unsupported') { unsupported = true; return 'unsupported'; }
                throw error;
            }
            up = { device: owner, buffer, data, staging, written: 0, negative: set.negative, bytes: vertexBytes };
            uploading.set(set.positive, up); gpuBytes += vertexBytes;
        }
        while (up.written < up.bytes) {
            const piece = Math.min(PATH_COVERAGE_UPLOAD_CHUNK_BYTES, up.bytes - up.written);
            if (!budget.claimUpload(piece)) return 'deferred';
            owner.writeBuffer(up.buffer, up.written, up.data.subarray(up.written / 4, (up.written + piece) / 4));
            auditCount(audit, 'upload:vertex', 1, { bytes: piece });
            up.written += piece;
        }
        uploading.delete(set.positive); host.allocator.cpu.release(up.staging);
        const entry: VertexSet = { key: set.positive, device: owner, buffer: up.buffer, negative: set.negative,
            positiveVertices: set.positive.length / 2, negativeVertices: set.negative.length / 2, refs: 0, bytes: vertexBytes, usedFrame: frame };
        shared.set(set.positive, entry);
        idle.set(entry.key, entry); idleBytes += entry.bytes;
        return entry;
    };
    /** Admission happens here, in prepare: targets, vertex buffers and any clip handle are created before any draw. Failure is
     * permanent for this device incarnation and returns 'unsupported'. A set uploaded by an admission that is then refused
     * keeps its buffer at zero refs, so the retry uploads nothing; release() frees it. */
    const admitSets = (request: PathCoverageSetsRequest, budget: FrameBudget): PathCoverageAdmission => {
        // Failure is permanent for this device incarnation: the caller's exact route takes the item.
        if (disposed || failed || unsupported) return { status: 'unsupported' };
        warm();
        // Pipelines still compiling are a wait, not a fallback; ready invalidates the frame.
        if (!isReady()) return { status: pending || !device ? 'denied' : 'unsupported' };
        const owner = device!, { sets, rule, affine, viewport, output } = request;
        if (owner.generation !== budget.token.deviceGeneration || host.generation !== budget.token.deviceGeneration) return { status: 'denied' };
        let edges = 0;
        for (const set of sets) edges += set.edges;
        if (rule === 'nonzero' && edges > PATH_COVERAGE_STENCIL_MAX_EDGES) return { status: 'unsupported' };
        if (!Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height) || viewport.width <= 0 || viewport.height <= 0) {
            throw new RangeError('Invalid path coverage viewport');
        }
        if (!request.colour.every(Number.isFinite)) throw new RangeError('Invalid path coverage colour');
        let mx0 = Infinity, my0 = Infinity, mx1 = -Infinity, my1 = -Infinity;
        for (const set of sets) {
            if (set.positive.length + set.negative.length === 0) continue;
            const mapped = mapBounds(set.bounds, affine);
            mx0 = Math.min(mx0, mapped.x0); my0 = Math.min(my0, mapped.y0); mx1 = Math.max(mx1, mapped.x1); my1 = Math.max(my1, mapped.y1);
        }
        if (mx0 === Infinity) return { status: 'empty' };
        const x0 = Math.max(0, Math.floor(mx0)), y0 = Math.max(0, Math.floor(my0));
        const x1 = Math.min(viewport.width, Math.ceil(mx1)), y1 = Math.min(viewport.height, Math.ceil(my1));
        if (x1 <= x0 || y1 <= y0) return { status: 'empty' };
        const bounds: RectI = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        if (bounds.width > owner.limits.maxRenderTargetSize || bounds.height > owner.limits.maxRenderTargetSize) return { status: 'unsupported' };
        const composite = output.kind === 'composite';
        // A 'grid4' composite is ink's: one sample per subsample of the 4×4 grid, resolved by its 'paint' output. A mask is always MSAA.
        const grid: CompositeGrid = composite && request.sampling === 'grid4' ? 4 : 1;
        const targetBytes = composite ? 0 : coverageTargetBytes(bounds.width, bounds.height, PATH_COVERAGE_SAMPLES);
        if (targetBytes > PATH_COVERAGE_MAX_TARGET_BYTES) { auditCount(audit, 'fallback:raster-route'); return { status: 'unsupported' }; }
        if (composite && coverageTargetBytes(bounds.width, 1, grid === 4 ? 1 : PATH_COVERAGE_SAMPLES, grid) > PATH_COVERAGE_SCRATCH_BYTES) {
            auditCount(audit, 'fallback:raster-route'); return { status: 'unsupported' };
        }
        const parts: VertexSet[] = [];
        for (const set of sets) {
            const vertexCount = (set.positive.length + set.negative.length) / 2;
            if (!Number.isSafeInteger(vertexCount) || vertexCount % 3) throw new RangeError('Invalid path triangle storage');
            if (vertexCount === 0) continue;
            const entry = vertexSetFor(owner, set, vertexCount, budget);
            if (typeof entry === 'string') return { status: entry };
            parts.push(entry);
        }
        if (!parts.length) return { status: 'empty' };
        // The scratch is ensured after the buffers, and before any reference is taken: a refusal leaves nothing held.
        if (composite) {
            const fits = ensureScratch(owner, bounds.width, grid);
            if (fits !== true) {
                if (fits === 'unsupported') { auditCount(audit, 'fallback:raster-route'); return { status: 'unsupported' }; }
                return { status: 'denied' };
            }
        }
        const targetLease = composite ? null : host.allocator.gpu.reserve(targetBytes);
        if (!composite && !targetLease) return { status: 'denied' };
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
            if (error instanceof ArenaError && error.code === 'unsupported') { unsupported = true; return { status: 'unsupported' }; }
            throw error;
        }
        // A modulate composite's source is k = C·c + 1 − α·c at full coverage: premultiplied colour plus one minus alpha.
        // A grid composite's colour is straight: its 'paint' output mixes rgb with alpha·coverage in the resolve, and the device
        // handles the modulate blend there. So the grid is the only case without premultiplication.
        const modulate = grid === 1 && output.kind === 'composite' && output.blend === 'modulate';
        const [pr, pg, pb, alpha] = [request.colour[0] * request.colour[3], request.colour[1] * request.colour[3], request.colour[2] * request.colour[3], request.colour[3]];
        const colour: readonly [number, number, number, number] = output.kind === 'mask' ? [1, 1, 1, 1]
            : grid === 4 ? [request.colour[0], request.colour[1], request.colour[2], request.colour[3]]
            : modulate ? [pr + 1 - alpha, pg + 1 - alpha, pb + 1 - alpha, 1] : [pr, pg, pb, alpha];
        const preparedOutput: CoverageOutput = output.kind === 'composite' && grid === 4
            ? { kind: 'paint', blend: output.blend === 'modulate' ? 'modulate' : 'normal', rgb: [request.colour[0], request.colour[1], request.colour[2]], alpha: request.colour[3] }
            : output;
        // The vertex buffers' bytes are the shared sets', counted once; this admission owns only its target.
        const prepared: PreparedPathCoverage = Object.freeze({ device: owner, target, clip, rule, output: preparedOutput, bounds, grid,
            parts: Object.freeze(parts.map(set => Object.freeze({ vertices: set.buffer, positiveVertices: set.positiveVertices,
                negativeVertices: set.negativeVertices, set }))),
            viewport: Object.freeze({ width: viewport.width, height: viewport.height }),
            affine: Object.freeze([...affine]) as unknown as Affine,
            colour: Object.freeze([...colour]) as unknown as readonly [number, number, number, number], gpuBytes: targetBytes,
            supersample: grid === 1 && request.supersample === true, modulate });
        live.set(prepared, targetBytes); gpuBytes += targetBytes;
        if (composite) {
            if (grid === 4) { gridLive++; auditCount(audit, 'kit:supersample-4'); } else compositeLive++;
            scratchTables[String(grid) as '1' | '4'].targets.get(owner)!.refs++;
        }
        return { status: 'ready', value: prepared };
    };
    return {
        warm,
        ready: isReady,
        /** Marks the frame the calls that follow belong to. An idle set used in this frame is never reclaimed. */
        beginFrame(next: number): void { frame = next; },
        /** Whether the kit still holds this triangle array (a shared set or an upload in progress). */
        holds(key: Float64Array): boolean { return shared.has(key) || uploading.has(key); },
        /** The governor's reclaim for this kit's idle triangle buffers: destroys the oldest unused ones until `bytes` are freed,
         * and returns the bytes actually freed (their leases return to the device's allocator as they retire). */
        evict(bytes: number): number { return reclaimIdle(bytes); },
        /** The scratch's lease is the device's; this kit reports the share its live composite admissions hold of it, so the
         * kits on one device sum to the scratch once and a hidden pane's kit reports none. */
        memory(): { gpuBytes: number; cpuBytes: number } {
            return { gpuBytes: gpuBytes + scratchShare(device, 1, compositeLive) + scratchShare(device, 4, gridLive), cpuBytes: 0 };
        },
        /** Admission happens here, in prepare: target, vertices and any clip handle are created before
         * any draw. Failure is permanent for this device incarnation and returns 'unsupported'. */
        /** Single-set admission: the sets form of `admitSets` with one set. */
        admit(request: PathCoverageRequest, budget: FrameBudget): PathCoverageAdmission {
            const { shapes, ...rest } = request;
            return admitSets({ ...rest, sets: [shapes] }, budget);
        },
        admitSets,
        /** Composite output: borrows the admitted target inside the caller's pass. */
        draw(pass: GpuPass, prepared: PreparedPathCoverage): void {
            if (prepared.output.kind === 'mask') throw new Error('Mask coverage is drawn with drawMask');
            render(pass, prepared);
        },
        /** Mask output: renders the R-channel clip mask; the prepared clip handle is then pushed. */
        drawMask(pass: GpuPass, prepared: PreparedPathCoverage): void {
            if (prepared.output.kind !== 'mask' || !prepared.clip) throw new Error('Composite coverage is drawn with draw');
            render(pass, prepared);
        },
        retire(prepared: PreparedPathCoverage): void { retireOwned(prepared); },
        release,
        dispose(): void { if (!disposed) { disposed = true; release(); } },
    };
}
