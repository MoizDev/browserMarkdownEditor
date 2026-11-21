import { auditCount, auditStage, renderAuditEnabled } from './renderAudit';
import type { Affine, Rgba } from '../types';
import type { LayerHost } from './compositor.types';
import type { MemoryAllocator } from './memoryGovernor';
import type { BufferHandle, BufferSlice, ClipHandle, CoverageOutput, CoverageTarget, DrawCommand, GfxDevice, GpuPass, PipelineHandle, RectI, Samples, ShaderModule, StencilOp, StencilState, ByteLease, UniformSlice } from './gfx/api';
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
/** The grid scratch's cap. A grid-4 texel row costs 144 B per device pixel (16 r8 texels and their stencil), so at 2 MiB a band
 * of a 936 px view was 15 rows (7 at DPR 2): an ink stroke 70 px tall took five passes, each a render-target switch and a resolve
 * (measured, notebook saturated zoom: 29 resolves and ~145 switches per frame). The scratch is one per device, shared by every
 * kit (the paper no longer holds one), and a refused band still halves down to the smallest. */
const PATH_COVERAGE_GRID_SCRATCH_BYTES = 8 * 2 ** 20;
const scratchCap = (grid: CompositeGrid): number => grid === 4 ? PATH_COVERAGE_GRID_SCRATCH_BYTES : PATH_COVERAGE_SCRATCH_BYTES;
/** The smallest band a refused scratch shrinks to: a band below it draws too many passes per item to be worth its target. Between this
 * and the cap the scratch is halved on each refusal, so a pool that cannot grant the request's own band grants a smaller one (go-gpu:
 * a 1.68 MiB request refused three times while the pool had less than that free). */
const PATH_COVERAGE_MIN_SCRATCH_BAND_BYTES = 256 * 1024;
/** One vertex upload piece; a frame's allowance takes as many as it covers. 64 KiB, not larger: the scheduler's progress grant
 * admits an oversize claim only while less than 64 KiB has been admitted this frame, once per frame (scheduler.ts,
 * claimUpload). A 256 KiB piece therefore passes only in a frame that is almost empty, and a busy frame refused it every time
 * (measured in a drag: upload:deferred repeated on one admission). At 64 KiB the piece passes the ordinary allowance. */
const PATH_COVERAGE_UPLOAD_CHUNK_BYTES = 64 * 1024;
/** The smallest piece a refused upload shrinks to: 4 KiB is a whole number of vertices and of float32s. */
const PATH_COVERAGE_UPLOAD_MIN_PIECE_BYTES = 4 * 1024;
/** A vertex is two float32s (the draw's float32x2 attribute): every piece is a whole number of vertices, so a piece never splits one. */
const PATH_COVERAGE_VERTEX_STRIDE_BYTES = 8;
/** GPU bytes of triangle buffers that no live admission holds. A stroke's tiles share them, so a few megabytes is a few
 * strokes' worth; past it the least recently retired are destroyed and re-uploaded if drawn again. */
const IDLE_VERTEX_BYTES = 8 * 2 ** 20;
/** Several sets of one request (or one shifted set), copied into one set with each set's shift baked into its vertices. The pack is
 * keyed by its sets' identities and shifts and lives while the buffer it backs does: the packed positive array is that buffer's key. */
interface Pack { readonly key: string; readonly shape: PathCoverageShapes; readonly lease: ByteLease; readonly bytes: number; usedFrame: number;
    /** The ids of the member arrays it was built from: forgetting one of them releases the pack. */
    readonly members: readonly number[] }
/** A straight colour's cover colour, written into `into`: premultiplied, and for a modulate composite k = C·c + 1 − α·c (the form
 * admission uses). In place, so a draw with a paint colour allocates nothing. */
function premultipliedInto(into: number[], rgba: Rgba, modulate: boolean): number[] {
    const [r, g, b, a] = rgba;
    const pr = r * a, pg = g * a, pb = b * a;
    into[0] = modulate ? pr + 1 - a : pr; into[1] = modulate ? pg + 1 - a : pg; into[2] = modulate ? pb + 1 - a : pb;
    into[3] = modulate ? 1 : a;
    return into;
}
/** Copies `src` (interleaved x, y) into `dst` at `at`, each point moved by (dx, dy); returns the next index. */
function copyShifted(src: Float64Array, dst: Float64Array, at: number, dx: number, dy: number): number {
    if (dx === 0 && dy === 0) { dst.set(src, at); return at + src.length; }
    for (let i = 0; i < src.length; i += 2) { dst[at + i] = src[i] + dx; dst[at + i + 1] = src[i + 1] + dy; }
    return at + src.length;
}
/** The kits alive on each device, each with the GPU allocator it reserves from. A device's scratch exists while one of them lives: the
 * scratch is only dropped, not per-admission, by the last kit leaving the device (or the governor's evict when nothing is in flight). */
const kitsOnDevice = new WeakMap<GfxDevice, Map<object, MemoryAllocator>>();
/** Where a scratch's bytes are charged: the GPU allocator of the kit that holds the charge, and the lease it holds there. The
 * scratch's own lease (`targetLease`) is attached to its target and only returned when the target is destroyed. */
interface ScratchCharge { readonly holder: object; readonly gpu: MemoryAllocator; readonly lease: ByteLease }
/** A device's composite scratch, shared by every kit on that device. `refs` counts the live composite admissions of all
 * of them: the scratch exists exactly while one is in flight, and its lease is the device's, not any one kit's. Only the
 * holder of `charge` reports its bytes; when the holder leaves while others remain, the charge moves to one of them. */
interface SharedScratch { readonly device: GfxDevice; readonly target: CoverageTarget; readonly bytes: number; refs: number;
    /** The frame a composite last used it in: a scratch used this frame is never evicted. */
    usedFrame: number;
    charge: ScratchCharge;
    readonly targetLease: ByteLease }
/** A scratch an admission used within this many frames is kept by the governor's evict (see evict): idle for this long, it may go. */
const PATH_COVERAGE_SCRATCH_IDLE_FRAMES = 3;
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
    /** Where this set's origin sits relative to the request's origin, in the request's local units (default 0,0). A request's sets
     * may then each keep their own origin and cache entry: the kit moves each by this shift on the device, so a group of paths is
     * one stencil and one cover without copying their triangles into one set. */
    readonly shift?: readonly [number, number];
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
    /** A memory refusal: the pool that refused and the bytes this admission needed from it, so the caller waits on the right pool
     * for the bytes that will fit. */
    | { readonly status: 'denied'; readonly pool: 'gpu' | 'cpu'; readonly bytes: number }
    /** The frame's upload allowance ran out mid-upload, or the pipelines are still compiling: retry next frame (a frame wait,
     * not a memory wait). */
    | { readonly status: 'deferred' }
    | { readonly status: 'unsupported' };

type Denial = Extract<PathCoverageAdmission, { readonly status: 'denied' }>;
/** One triangle set of an admission: its shared buffer (positive triangles first, then negative), and how many of each. */
export interface PreparedPathPart {
    readonly vertices: BufferHandle;
    readonly positiveVertices: number;
    readonly negativeVertices: number;
    /** The part's whole buffer as the one vertex binding of every draw of it, built once at admission. */
    readonly bindings: readonly BufferSlice[];
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
    /** Mutable: a chain's buffer draws more vertices after each append. */
    positiveVertices: number;
    readonly negativeVertices: number;
    refs: number;
    /** The buffer's size, which is what it costs: a chain's buffer is larger than the bytes it draws (capacity doubling). */
    readonly bytes: number;
    /** The bytes the set draws: the prefix of the buffer that holds its triangles. Equal to `bytes` except for a chain. */
    used: number;
    /** A chain's buffer (see Chain). */
    readonly chain?: Chain;
    /** The frame this set was last held or retired in: an idle set used in the current frame is never evicted. */
    usedFrame: number;
}
/** A union chain: one stroke's sets in one buffer, which grows by append. `data` is the CPU copy the buffer is written from, with
 * capacity: an append writes the new sets at its end, and a re-upload is made from it. `len` (floats) and `ids` describe what the
 * buffer holds once its upload has finished. Its key is a placeholder array, so no owner array can collide with it. */
interface Chain {
    readonly key: Float64Array;
    readonly lead: number;
    readonly data: Float32Array;
    /** The CPU lease's bytes: the capacity of `data`. */
    readonly bytes: number;
    readonly lease: ByteLease;
    ids: readonly number[];
    len: number;
    released: boolean;
}
/** An upload in progress: the buffer and how many of its bytes are written, within the frame's allowance. */
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
    /** The bytes the set draws. */
    readonly bytes: number;
    /** The buffer's size (what the GPU lease holds). */
    readonly capacity: number;
    usedFrame: number;
    piece: number;
    readonly chain?: Chain;
}
const EMPTY_TRIANGLES = new Float64Array(0);

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
    /** True when this admission took a reference on its device's composite scratch, and retire releases exactly that reference. */
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
/** One pipeline set per device incarnation, shared by every kit on it (the set has no per-kit parameter) and kept while the device lives:
 * it is a dozen programs, no governed bytes. Each kit compiled its own, and released it with the kit: the preview's kits are made per
 * drag, so every drag's first frame waited on a compile, drew no overlay ink and went unanswered (measured: pipelines:created at each
 * drag start, path-coverage:deferred:compiling 8 in the saturated drag; canvas2d answered that input). A restored context's
 * incarnation compiles a new set; the old one is destroyed once its last kit has let go. */
interface SharedPipelines { users: number; value: Pipelines | null; dead: boolean; readonly generation: number; readonly promise: Promise<Pipelines> }
const pipelinesOnDevice = new WeakMap<GfxDevice, SharedPipelines>();
function destroyPipelines(owner: GfxDevice, set: Pipelines): void { for (const handle of Object.values(set)) owner.destroy(handle); }
function acquirePipelines(owner: GfxDevice, create: () => Promise<Pipelines>): SharedPipelines {
    // A set compiled for an earlier incarnation of the device (a restored context) is not reused: its users let go of it as they rebind.
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
    // The current incarnation's set stays for the next kit; a superseded one goes with its last user.
    if (--entry.users > 0 || !entry.dead) return;
    if (entry.value) { destroyPipelines(owner, entry.value); entry.value = null; }
}

/** Platform stencil-coverage executor. Winding or union triangles fill an admitted stencil target,
 * one cover quad paints the colour under the not-equal test, and the scope composites once (or
 * leaves an R-channel clip mask). Admission and uploads happen in admit(); draws only borrow. */
/** `onFreed(key)` runs when the kit stops holding a triangle array it was given (its shared set and its upload are the only
 * holders), so an owner that leases the array's memory can release the lease then, not before. */
export function createPathCoverageKit(host: LayerHost, report: (error: unknown) => void, audit = 'path-coverage',
    onFreed?: (key: Float64Array) => void) {
    let device: GfxDevice | null = null, pipelines: Pipelines | null = null, pending = false, failed = false, unsupported = false;
    let pipelineSet: SharedPipelines | null = null;
    let incarnation = 0, disposed = false, gpuBytes = 0;
    const live = new Map<PreparedPathCoverage, number>();
    // One vertex buffer per triangle set, shared by every admission of it: the triangles are origin-relative, so all tile
    // views of an item at one scale draw the same buffer under their own affine. A buffer per admission uploaded and
    // charged a stroke once per tile it crossed, and the notebook's paper was refused for the room (267 refusals).
    const shared = new Map<Float64Array, VertexSet>();
    // A union request of several unshifted sets (ink: one set per chunk of a stroke) is a chain: its buffer and its CPU copy hold the
    // sets, and a request whose leading sets are the chain's, with more after them, appends only those sets. Keyed by the leading set.
    const chains = new Map<number, Chain>();
    // Chains are keyed by placeholder arrays: freeing one tells the owner nothing (it holds no array of the owner's).
    const chainKeys = new WeakSet<Float64Array>();
    // Uniform data is filled and copied into the frame's ring by host.uniforms before the next fill (the ring copies it
    // synchronously), so one array serves every uniform a draw needs.
    const uniformScratch = new Float32Array(12);
    // A buffer larger than one frame's upload allowance fills across frames. Refused whole each frame, a stroke's outline
    // at 332% never uploaded and the board never presented again (measured: claimUpload refused 73 of 73 admissions).
    const uploading = new Map<Float64Array, Upload>();
    // Packs (see Pack): a composition's copy is made once while its buffer lives; the ids name the sets, and an id is never reused.
    const packs = new Map<string, Pack>(), packOfArray = new Map<Float64Array, Pack>(), arrayIds = new WeakMap<Float64Array, number>();
    // Packs by member id: the owner's forget of a member releases the packs built from it, with no walk over every pack.
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
    /** The kit has let go of a triangle array: a pack's lease goes with it; any other array is the owner's, told through onFreed. */
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
    // A set with no live admission stays on the GPU: the next tile that draws the same stroke then uploads nothing. The
    // composer retires each run right after drawing it, so without this every tile of a stroke re-uploaded it. Idle sets
    // are ordered oldest first and destroyed past IDLE_VERTEX_BYTES, and release() frees them all. Invariant: a set in
    // `shared` has refs 0 exactly when it is in `idle`.
    const idle = new Map<Float64Array, VertexSet>();
    let idleBytes = 0, frame = 0;
    /** A composite scratch's growth was refused while an admission still held the scratch: the next frame's start reclaims it. */
    let scratchGrowth = false;
    /** The frame whose draw was refused by the uniform ring (-1: none). */
    let drawRefusedFrame = -1;
    /** A chain's CPU copy and its lease go with the chain: when its buffer is gone (or its upload was dropped). */
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
    /** Destroys idle sets, oldest first, until `bytes` are freed, skipping any stamped in the current or the previous frame: those are
     * what is on screen, and partial eviction must not take them. Returns the bytes freed; the governor's evict(bytes) and the idle
     * bound both come here. */
    const reclaimIdle = (bytes: number): number => {
        let freed = 0;
        for (const entry of idle.values()) {
            if (freed >= bytes) break;
            if (entry.usedFrame >= frame - 1) continue;
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
        if (prepared.scratch) releaseScratch(prepared.device, prepared.grid);
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
    // The refcount says only whether an admission is in flight; the scratch itself is dropped by destroyScratch, not here.
    const releaseScratch = (owner: GfxDevice, grid: CompositeGrid) => {
        const shared = scratchOf(owner, grid);
        if (shared && shared.refs > 0) shared.refs--;
    };
    /** Destroys a scratch's target and returns the charge its bytes held: the target's own lease goes back with the target, and a
     * charge that was moved to another kit's allocator is returned there. */
    const destroyScratchTarget = (owner: GfxDevice, shared: SharedScratch): void => {
        owner.destroy(shared.target.target); owner.destroy(shared.target.texture);
        if (shared.charge.lease !== shared.targetLease) shared.charge.gpu.release(shared.charge.lease);
    };
    /** Destroys a device's scratch of one grid and returns the bytes its target held. Callers ensure no admission is in flight. */
    const destroyScratch = (owner: GfxDevice, grid: CompositeGrid, reason: 'release' | 'evict' | 'growth'): number => {
        const table = scratchTables[String(grid) as '1' | '4'];
        const shared = table.targets.get(owner);
        if (!shared) return 0;
        auditCount(audit, `kit:scratch-dropped:${reason}`, 1, { bytes: shared.bytes });
        table.targets.delete(owner);
        destroyScratchTarget(owner, shared);
        return shared.bytes;
    };
    /** This kit's token on its device: the device's scratch is kept while any kit holds one. */
    const kitToken = {};
    const joinDevice = (owner: GfxDevice): void => {
        let kits = kitsOnDevice.get(owner);
        if (!kits) kitsOnDevice.set(owner, kits = new Map());
        kits.set(kitToken, host.allocator.gpu);
    };
    /** The holder of a device's scratch has left while others remain: its charge moves to one of them. The new lease is reserved
     * before the old one is released, so a refusal leaves the charge where it was (and is counted; the next composite retries). */
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
        // The last kit on the device: no admission can be in flight (each kit retired its own before leaving), so both grids go.
        destroyScratch(owner, 1, 'release'); destroyScratch(owner, 4, 'release');
    };
    /** Ensures the device's scratch of this grid holds a band of the given size: true; the refused GPU bytes when its lease is refused
     * (a wait); 'unsupported' past the caps. The scratch is sized to the request, not to the full band: a one-rectangle preview asked
     * for the full 2 MiB band, and was refused while the page's tiles held the pool (measured: 24 refusals in one PDF annotate run).
     * Its width is the widest band the device has asked for, so every kit draws from one target. Its height is the request's own,
     * rounded up to a power of two (a growing drag re-creates the scratch once per doubling) and capped at the full band. Draws loop
     * over bands of the target's height, so a shorter scratch means more bands, not a wrong one. A refused rounded height retries at
     * the request's exact height before it waits. An idle scratch is released by the governor's evict, or by the last kit leaving. A
     * grid scratch is 4× the texels per device pixel, so its band is sized by the grid's bytes (coverageTargetBytes with the grid). */
    const ensureScratch = (owner: GfxDevice, width: number, height: number, grid: CompositeGrid): true | number | 'unsupported' => {
        const table = scratchTables[String(grid) as '1' | '4'];
        const samples = grid === 4 ? 1 : PATH_COVERAGE_SAMPLES;
        const rowBytes = coverageTargetBytes(width, 1, samples, grid);
        if (rowBytes > scratchCap(grid)) return 'unsupported';
        // A grid texture is (grid·width) texels wide, and the device's largest texture side bounds both axes of it.
        const cap = owner.limits.maxRenderTargetSize;
        if (width * grid > cap) return 'unsupported';
        // The tallest band a scratch of width w may take: the scratch cap's bytes, and the device's side (grid texels per row). Draws loop
        // over bands of this height, so a band taller than the largest texture side is never asked for (measured: a notebook asked 2×20164
        // against a 16384 cap, and createCoverageTarget refused it).
        const fullBand = (w: number): number =>
            Math.min(Math.floor(scratchCap(grid) / coverageTargetBytes(w, 1, samples, grid)), Math.floor(cap / grid));
        const current = table.targets.get(owner);
        // A current scratch at least as wide is kept (its width is the device's widest), and grows only in height when the request is taller.
        const kept = current && current.target.width >= width ? current.target.width : 0;
        // Growth rounds the width up to a power of two while the rounded band still fits the scratch cap and the device: a scratch grown to
        // each new widest request was re-created once per admission that was wider than any before (21 in one draw phase, with
        // no drop). Rounded, the scratch grows at most once per doubling; otherwise the exact request is used.
        const needed = Math.max(width, table.widths.get(owner) ?? 0);
        const rounded = 2 ** Math.ceil(Math.log2(needed));
        const fitsRounded = rounded * grid <= cap && coverageTargetBytes(rounded, 1, samples, grid) <= scratchCap(grid);
        const w = kept || (fitsRounded ? rounded : needed);
        if (w * grid > cap) return 'unsupported';
        const band = fullBand(w);
        const exact = Math.min(height, band);
        if (current && kept && current.target.height >= exact) { rehome(owner, grid); return true; }
        // The request's height, rounded to a power of two within the band, as the width is. A refused rounded height retries at the exact one.
        const roundedHeight = Math.min(band, 2 ** Math.ceil(Math.log2(exact)));
        // The attempts, largest first: the rounded height, the exact height, then halvings of the exact height down to the smallest band.
        // Bounded by the halvings of one band (about log2 of its rows), and each refusal is counted.
        const sizes: number[] = roundedHeight > exact ? [roundedHeight, exact] : [exact];
        const minRows = Math.max(1, Math.floor(PATH_COVERAGE_MIN_SCRATCH_BAND_BYTES / coverageTargetBytes(w, 1, samples, grid)));
        for (let rows = Math.floor(exact / 2); rows >= minRows; rows = Math.floor(rows / 2)) sizes.push(rows);
        // The pool counts the old scratch's lease until it is returned, so a growth that reserves first is refused for bytes the kit
        // itself holds. When no admission holds the old scratch (its draws read it at draw time, and none is pending), its lease goes
        // back first. An admission still holding it keeps it, and a refused growth then waits for the pool: retiring that admission only
        // drops its reference, so the scratch is reclaimed at the next frame's start (beginFrame, once nothing holds it), which returns its
        // lease and wakes the wait. Without that reclaim the wait had no source of capacity.
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
            // The wait is for the smallest band the kit accepts (the last attempt); `asked` is the request's own rounded height.
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
            gridIncrement, gridDecrement, gridInvert, gridUnion, gridCover]): Pipelines => ({ increment, decrement, invert, union, cover, coverAdd,
            coverModulate, gridIncrement, gridDecrement, gridInvert, gridUnion, gridCover })));
        if (renderAuditEnabled()) auditCount(audit, entry.value ? 'pipelines:shared-ready' : entry.users > 1 ? 'pipelines:shared-pending' : 'pipelines:created');
        // Another kit on this device compiled the set already: ready in this frame.
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
    /** The packs of one member group at other shifts are superseded by a new shift's pack: a moving group (a drag) is a new key on each
     * move, so without this every move kept its copy and its buffer. Only packs no admission of this frame uses are dropped (an
     * in-use one stays until a later frame's new shift finds it idle), so at most one idle copy per group survives a frame. */
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
    /** The sets as one set: each one's vertices moved by its shift, copied into a new pack. A composition already packed is reused. */
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
    // Draws bind no texture and, for a cover, no vertices: one shared empty list each.
    const NO_TEXTURES: readonly never[] = Object.freeze([]), NO_VERTICES: readonly never[] = Object.freeze([]);
    // One command and one uniform entry serve every draw of the kit: the pass validates and copies a draw's bindings, vertices and
    // scissor when it is issued, so each draw writes its fields here and nothing is kept past the call (by reading: webgl2Frame's draw).
    const uniformEntry: { binding: number; slice: UniformSlice }[] = [{ binding: 0, slice: null as unknown as UniformSlice }];
    const command: DrawCommand = { pipeline: null as unknown as PipelineHandle, bindings: { uniforms: uniformEntry, textures: NO_TEXTURES },
        vertices: NO_VERTICES, first: 0, count: 0, instances: 1, scissor: null as unknown as RectI };
    const issue = (pass: GpuPass, pipeline: PipelineHandle, slice: UniformSlice, vertices: readonly BufferSlice[], first: number,
        count: number, scissor: RectI): void => {
        uniformEntry[0].slice = slice; command.pipeline = pipeline; command.vertices = vertices;
        command.first = first; command.count = count; command.scissor = scissor;
        pass.draw(command);
    };
    /** One winding draw of one triangle set's range, under the band's scissor. */
    const drawWinding = (pass: GpuPass, part: PreparedPathPart, pipeline: PipelineHandle, windingUniforms: UniformSlice, scissor: RectI,
        first: number, count: number): void => {
        if (!count) return;
        issue(pass, pipeline, windingUniforms, part.bindings, first, count, scissor);
    };
    // Draws with a paint colour write their cover colour, output and band here, in place: the frame copies a cover's colour and a
    // composite's output when it is issued (webgl2Frame compositeGrid, uniforms), and a scope keeps its band only until endCoverage.
    const paintCover: number[] = [0, 0, 0, 0];
    const paintOutput: { kind: 'paint'; blend: 'normal' | 'modulate'; rgb: [number, number, number]; alpha: number } =
        { kind: 'paint', blend: 'normal', rgb: [0, 0, 0], alpha: 0 };
    const bandRect: RectI = { x: 0, y: 0, width: 0, height: 0 };
    const renderCoverage = (pass: GpuPass, prepared: PreparedPathCoverage, paint?: Rgba): void => {
        if (disposed || !live.has(prepared) || !pipelines || prepared.device !== device || host.device() !== device ||
            host.generation !== prepared.device.generation) throw new Error('Stale path coverage');
        const { affine, viewport, output } = prepared;
        // Drawn in this frame: stamped like an admission, so partial eviction keeps what is on screen (the sets are the draw's own).
        for (const part of prepared.parts) part.set.usedFrame = frame;
        if (paint && output.kind === 'mask') throw new Error('A paint colour applies to a composite, not a mask');
        // A grid composite draws its own one-sample r8 set and covers with coverage 1 in each texel; its colour is the 'paint' output's
        // straight rgb and alpha, at draw. An MSAA composite covers in its premultiplied colour, given at draw or the admitted one.
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
        // Each uniform is copied into the frame's ring by host.uniforms before the scratch is filled for the next one.
        const windingUniforms = windingSlice(viewport, affine, 0, 0);
        const whole = prepared.bounds;
        // One rect serves every band: a scope keeps its bounds only until its endCoverage, and the next band rewrites the rect after that.
        const band = bandRect;
        band.x = whole.x; band.y = whole.y; band.width = whole.width; band.height = 0;
        for (let y = whole.y; y < whole.y + whole.height; y += target.height) {
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
    /** One coverage draw's encode time (CPU), named 'draw'; the timed path is taken only while the render audit is on. */
    const render = (pass: GpuPass, prepared: PreparedPathCoverage, paint?: Rgba): void => {
        const started = renderAuditEnabled() ? performance.now() : null;
        try { renderCoverage(pass, prepared, paint); }
        catch (error) {
            // A uniform-ring refusal costs this draw only: the rest of the frame still draws. The frame's coverage is then incomplete
            // (drawRefusedThisFrame), so a critical layer refuses it and the previous complete picture stays; the next frame is requested.
            if (!(error instanceof ArenaError) || error.code !== 'out-of-budget') throw error;
            drawRefusedFrame = frame;
            auditCount(audit, 'kit:draw-refused');
            host.invalidate('path-coverage-refused');
        } finally { if (started !== null) auditStage(audit, 'draw', performance.now() - started); }
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
    /** The ids of a request's sets, two per set (positive, negative): a chain is matched by them, so it retains no arrays. */
    const idsOf = (sets: readonly PathCoverageShapes[]): number[] => sets.flatMap(set => [idOf(set.positive), idOf(set.negative)]);
    /** Whether a chain's committed ids are a prefix of the request's sets: the same sets, possibly with more after them. */
    const extendsIds = (ids: readonly number[], sets: readonly PathCoverageShapes[]): boolean => {
        if (ids.length > 2 * sets.length) return false;
        for (let i = 0; i < ids.length; i++) {
            const set = sets[i >> 1];
            if (ids[i] !== idOf((i & 1) === 1 ? set.negative : set.positive)) return false;
        }
        return true;
    };
    /** The bounds of several unshifted sets together. */
    const unionBounds = (sets: readonly PathCoverageShapes[]): PathCoverageShapes['bounds'] => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const set of sets) {
            x0 = Math.min(x0, set.bounds.x0); y0 = Math.min(y0, set.bounds.y0);
            x1 = Math.max(x1, set.bounds.x1); y1 = Math.max(y1, set.bounds.y1);
        }
        return { x0, y0, x1, y1 };
    };
    /** A buffer's capacity: the next power of two that holds its bytes, so appends fit until the chain doubles. */
    const capacityFor = (bytes: number): number => 2 ** Math.ceil(Math.log2(bytes));
    /** Writes an upload's pieces within the frame's allowance: 'done' once every byte is in the buffer. A refused or deferred upload keeps
     * what it wrote, and the retry resumes it; a piece the device refuses drops the upload, and its item takes the CPU route. */
    const writeUpload = (up: Upload, budget: FrameBudget): 'done' | 'deferred' | 'unsupported' => {
        while (up.written < up.bytes) {
            const piece = Math.min(up.piece, up.bytes - up.written);
            if (!budget.claimUpload(piece)) {
                // By cause, so a repeat is visible as its cause. 'room': the frame's allowance still had the piece, so the scheduler
                // refused it for another reason, the layer's optional share. The same bytes then retry in smaller pieces.
                const cause = budget.shouldYield() ? 'yield' : budget.upload.remainingBytes >= piece ? 'room' : 'allowance';
                auditCount(audit, `upload:deferred:${cause}`, 1, { bytes: piece });
                // Halved to whole vertices: a piece of 4k+2 words' worth halved to a non-word size, which the range check refuses.
                if (cause === 'room') up.piece = Math.max(PATH_COVERAGE_UPLOAD_MIN_PIECE_BYTES,
                    Math.floor(piece / 2 / PATH_COVERAGE_VERTEX_STRIDE_BYTES) * PATH_COVERAGE_VERTEX_STRIDE_BYTES);
                return 'deferred';
            }
            // The chunk's range is whole words inside the buffer the upload created: the device refuses anything else as invalid-input.
            const offset = up.written;
            if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(piece) || offset < 0 || piece <= 0 || offset % 4 !== 0 ||
                piece % 4 !== 0 || offset + piece > up.bytes) {
                throw new RangeError(`Invalid path vertex upload: offset ${offset}, bytes ${piece}, buffer ${up.bytes}`);
            }
            const writeStarted = renderAuditEnabled() ? performance.now() : 0;
            try { up.device.writeBuffer(up.buffer, offset, up.data.subarray(offset / 4, (offset + piece) / 4)); }
            catch (error) {
                if (!(error instanceof ArenaError) || error.code !== 'invalid-input') throw error;
                // The counter names the refused range, so the device's refusal can be read against its numbers.
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
    /** An upload that has written every byte is the shared entry for its key. */
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
    /** Appends the request's sets after a chain's committed sets: their vertices go to the CPU copy's end and to the buffer's end, and the
     * chain then holds them. Returns the chain's entry, 'unsupported' when the device refuses the write, or null when the chain cannot take
     * them (the request is then uploaded whole: its capacity is past, or its appended bytes need more than one upload claim). */
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
        // The appended vertices go to the CPU copy's end first. Nothing reads that region until the commit below, so a refused write
        // leaves the chain as it was.
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
    /** The entry for a union chain: a request that extends the chain appends to its buffer (after finishing its upload if one is in progress);
     * anything else is a new chain, uploaded whole. */
    const chainSetFor = (owner: GfxDevice, sets: readonly PathCoverageShapes[], budget: FrameBudget):
        VertexSet | Denial | 'deferred' | 'unsupported' => {
        const chain = chains.get(idOf(sets[0].positive));
        if (chain && extendsIds(chain.ids, sets)) {
            const pending = uploading.get(chain.key);
            if (pending) {
                // The chain's committed sets are still uploading: finish them, then append what the request adds.
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
    /** A new chain: its sets copied into a CPU copy with capacity, and uploaded whole into a buffer of the same capacity. Each takes its
     * spare capacity only when its pool grants it; a refusal asks for the exact size. */
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
        // The lead's earlier chain is replaced: an upload of its sets that is still in progress is one nothing resumes, so it goes.
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
    /** The shared buffer of one triangle set, uploaded in chunks within each frame's allowance. Returns the entry, or why not:
     * a refused or deferred upload keeps what it wrote, and the retry resumes it. */
    const vertexSetFor = (owner: GfxDevice, set: PathCoverageShapes, vertexCount: number, budget: FrameBudget):
        VertexSet | Denial | 'deferred' | 'unsupported' => {
        const vertexBytes = vertexCount * 8;
        const found = shared.get(set.positive);
        if (found && found.device === owner && found.negative === set.negative && found.used === vertexBytes) { auditCount(audit, 'kit:set-hit', 1, { bytes: vertexBytes }); return found; }
        if (found) {
            // The same positive array with another negative or size (or a stale device) holds a buffer this set cannot draw. A held set
            // cannot be replaced while a draw reads it: that is a fallback, counted. An idle one is replaced by a fresh upload; the array
            // stays held here, so the owner is not told it was freed (destroySet would tell it).
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
            // Positive triangles first, then negative: the draw ranges follow this order.
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
    /** Admission, timed as 'admit' (its uploads are timed as 'upload' within it) while the render audit is on. */
    const admitSets = (request: PathCoverageSetsRequest, budget: FrameBudget): PathCoverageAdmission => {
        if (!renderAuditEnabled()) return admitSetsUntimed(request, budget);
        const started = performance.now();
        let result: PathCoverageAdmission;
        try { result = admitSetsUntimed(request, budget); } finally { auditStage(audit, 'admit', performance.now() - started); }
        // Debug log (audit only): one entry per admission, with the time it began, its outcome, the upload allowance left and whether
        // the frame had yielded. A measurement reads it from globalThis.__bmeKitLog and joins it to presents by time.
        const log = ((globalThis as { __bmeKitLog?: unknown[] }).__bmeKitLog ??= []) as unknown[];
        if (log.length < 20000) log.push({ at: started, ms: performance.now() - started, status: result.status, left: budget.upload.remainingBytes,
            budgetMs: budget.prepareDeadline - performance.now(), yield: budget.shouldYield(), phase: budget.phase, audit });
        return result;
    };
    /** Admission happens here, in prepare: targets, vertex buffers and any clip handle are created before any draw. Failure is
     * permanent for this device incarnation and returns 'unsupported'. A set uploaded by an admission that is then refused
     * keeps its buffer at zero refs, so the retry uploads nothing; release() frees it. */
    /** The kit's own fallback, named by its reason: the caller's route draws the item exactly, and the counter says why it could not. */
    const unsupportedBecause = (reason: string): PathCoverageAdmission => {
        auditCount(audit, `fallback:path-coverage:${reason}`);
        return { status: 'unsupported' };
    };
    const admitSetsUntimed = (request: PathCoverageSetsRequest, budget: FrameBudget): PathCoverageAdmission => {
        // Failure is permanent for this device incarnation: the caller's exact route takes the item.
        if (disposed || failed || unsupported) return unsupportedBecause(disposed ? 'disposed' : failed ? 'failed' : 'device-unsupported');
        warm();
        // A generation change under this kit (the device's context was lost and restored since the frame began): the kit rebinds in this
        // frame, releasing the old device's state and binding the current one, instead of deferring the admission a frame. The release
        // also retires every live admission, including the earlier ones of this frame whose draws are still pending: those draws throw
        // 'Stale path coverage' (renderCoverage's generation check), as they did on the mismatch before this change. Later frames are unaffected.
        if (device && (device.generation !== budget.token.deviceGeneration || host.generation !== budget.token.deviceGeneration)) {
            auditCount(audit, 'path-coverage:rebound:generation');
            release(); warm();
        }
        // The three frame waits, each counted by its reason: pipelines still compiling (an async creation, so the first admission of a new
        // device waits for it), no device yet bound. Nothing is refused for memory here, so nothing is named as a fallback.
        if (!isReady()) {
            if (!device) { auditCount(audit, 'path-coverage:deferred:no-device'); return { status: 'deferred' }; }
            if (pending) { auditCount(audit, 'path-coverage:deferred:compiling'); return { status: 'deferred' }; }
            return unsupportedBecause('not-ready');
        }
        const owner = device!, { sets, rule, affine, viewport, output } = request;
        // Empty sets draw nothing. The rest are one set: several sets, or one shifted set, are packed into a copy with the shifts
        // baked in (see packSets), so the admission draws one winding per band, not one per set.
        const nonEmpty = sets.filter(set => set.positive.length + set.negative.length > 0);
        if (!nonEmpty.length) return { status: 'empty' };
        let edges = 0;
        for (const set of nonEmpty) edges += set.edges;
        if (rule === 'nonzero' && edges > PATH_COVERAGE_STENCIL_MAX_EDGES) return unsupportedBecause('stencil-edges');
        if (!Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height) || viewport.width <= 0 || viewport.height <= 0) {
            throw new RangeError('Invalid path coverage viewport');
        }
        if (!request.colour.every(Number.isFinite)) throw new RangeError('Invalid path coverage colour');
        // A union request of several unshifted sets is a chain (see chainSetFor): its sets are never packed, so a publication copies and
        // uploads only the sets it adds. Other sets are packed (packSets).
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
        // A 'grid4' composite is ink's: one sample per subsample of the 4×4 grid, resolved by its 'paint' output. A mask is always MSAA.
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
        // One count per refused admission: the admission returns here, so a repeat is one more admission, not more pieces.
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
    // The kit starts its pipelines when it is created: a device already bound starts their compile now, and beginFrame starts it again
    // for a device bound later. Pipeline creation is async, so by the time a person draws, the compile has long finished.
    warm();
    return {
        warm,
        ready: isReady,
        /** True when a draw of the current frame was refused by the uniform ring: the frame's coverage is incomplete. */
        drawRefusedThisFrame: (): boolean => drawRefusedFrame === frame,
        /** Marks the frame the calls that follow belong to. An idle set used in this frame is never reclaimed. */
        beginFrame(next: number): void {
            if (next === frame) { frame = next; return; }
            auditCount(audit, 'kit:frame');
            frame = next;
            if (scratchGrowth && device) {
                // The frame's start: nothing of the last frame is pending, so a scratch nothing holds goes now. Its lease returns to the pool,
                // which wakes a refused growth's wait; a scratch still held keeps the flag for the next frame.
                for (const grid of [1, 4] as const) { const held = scratchOf(device, grid); if (held && held.refs === 0) destroyScratch(device, grid, 'growth'); }
                scratchGrowth = [1, 4].some(grid => (scratchOf(device!, grid as CompositeGrid)?.refs ?? 0) > 0);
            }
            // Pipelines compile from the frame's start, not from its first admission (an async creation: a device bound at a release or a
            // context loss waits for them, so the start is the earliest that wait can end).
            if (!disposed && !failed && !unsupported) warm();
        },
        /** Whether the kit still holds this triangle array (a shared set or an upload in progress). */
        holds(key: Float64Array): boolean { return shared.has(key) || uploading.has(key); },
        /** The owner has let go of a triangle array (its outline was dropped): the packs built from it are released with it. A pack
         * whose buffer is still in use is released when that buffer goes (freed), so nothing a draw reads is freed here. */
        forgetTriangles(key: Float64Array): void {
            const id = arrayIds.get(key);
            const built = id === undefined ? undefined : packsOfMember.get(id);
            if (!built) return;
            for (const pack of [...built]) if (!shared.has(pack.shape.positive) && !uploading.has(pack.shape.positive)) freePack(pack);
        },
        /** The governor's reclaim for this kit's idle triangle buffers: destroys the oldest unused ones until `bytes` are freed,
         * and returns the bytes actually freed (their leases return to the device's allocator as they retire). */
        evict(bytes: number, gestureLive = false): number {
            // Cheapest to lose first: idle sets (re-uploaded on use), then uploads a frame did not finish (they start over: their
            // admission is retried), then an idle scratch (re-created on the next composite). Each respects the current frame.
            // `gestureLive` is the governor's liveGesture (a pane is interacting): while it holds, no scratch is a victim, because a
            // gesture re-creates the scratch it just lost at once (the zoom churn). At rest a scratch goes once idle for the window.
            let freed = reclaimIdle(bytes);
            for (const [key, up] of [...uploading]) {
                if (freed >= bytes) break;
                if (up.usedFrame >= frame - 1) continue;
                freed += up.capacity; dropUpload(key);
            }
            // A pack no buffer holds (its admission was refused before the upload) is host CPU memory nothing uses: it goes first.
            for (const pack of [...packs.values()]) {
                if (freed >= bytes) break;
                if (pack.usedFrame >= frame - 1 || shared.has(pack.shape.positive) || uploading.has(pack.shape.positive)) continue;
                freed += pack.bytes; freePack(pack);
            }
            if (device && freed < bytes) for (const grid of [1, 4] as const) {
                const shared = scratchOf(device, grid);
                if (!shared || shared.refs > 0) continue;
                // A scratch an admission used in the last few frames is frame-critical: an evict re-creates it at once (the zoom churn: 30
                // grid4 scratches in one zoom, each freed for paper tiles and then needed again), so it goes only once idle for the window.
                if (gestureLive) { auditCount(audit, 'kit:scratch-kept:gesture', 1, { bytes: shared.bytes }); continue; }
                if (shared.usedFrame > frame - PATH_COVERAGE_SCRATCH_IDLE_FRAMES) { auditCount(audit, 'kit:scratch-kept', 1, { bytes: shared.bytes }); continue; }
                freed += destroyScratch(device, grid, 'evict');
            }
            return freed;
        },
        /** A device's scratch is reported once, by the kit whose allocator holds its charge (the kit that reserved it, or the one it
         * moved to); every other kit on the device reports none of it, so no bytes are published that a host did not reserve. */
        memory(): { gpuBytes: number; cpuBytes: number } {
            const reported = (grid: CompositeGrid): number => {
                const shared = device ? scratchOf(device, grid) : undefined;
                return shared && shared.charge.holder === kitToken ? shared.bytes : 0;
            };
            return { gpuBytes: gpuBytes + reported(1) + reported(4), cpuBytes: packedBytes };
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
        /** Draws a composite. `paint` replaces the admitted colour at draw: the cover uses its premultiplied form, and a grid composite's
         * 'paint' output takes its straight rgb and alpha. Admission keeps the geometry, rule, affine, viewport and output kind. */
        draw(pass: GpuPass, prepared: PreparedPathCoverage, paint?: { readonly colour: Rgba }): void {
            if (prepared.output.kind === 'mask') throw new Error('Mask coverage is drawn with drawMask');
            render(pass, prepared, paint?.colour);
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
