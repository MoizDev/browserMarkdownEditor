import { auditCount } from './renderAudit';
import type { Affine, Rgba } from '../types';
import type { LayerHost } from './compositor.types';
import type { BufferHandle, ClipHandle, CoverageOutput, CoverageTarget, GfxDevice, GpuPass, PipelineHandle, RectI, Samples, ShaderModule, StencilOp, StencilState, ByteLease } from './gfx/api';
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
/** A device's composite scratch, shared by every kit on that device. `refs` counts the live composite admissions of all
 * of them: the scratch exists exactly while one is in flight, and its lease is the device's, not any one kit's. */
interface SharedScratch { readonly device: GfxDevice; readonly target: CoverageTarget; readonly bytes: number; refs: number }
const deviceScratch = new WeakMap<GfxDevice, SharedScratch>();
/** The widest composite band any kit on a device has asked for. It outlives the scratch, so the next scratch is made at
 * this width and no kit grows it again (a notebook's paper, board and wet ink ask for different widths). */
const scratchWidth = new WeakMap<GfxDevice, number>();

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
}

export type PathCoverageAdmission =
    | { readonly status: 'ready'; readonly value: PreparedPathCoverage }
    | { readonly status: 'empty' }
    | { readonly status: 'denied' }
    /** The frame's upload allowance ran out mid-upload: retry next frame (a frame wait, not a memory wait). */
    | { readonly status: 'deferred' }
    | { readonly status: 'unsupported' };

/** A pre-admitted vertex buffer, plus the mask's own target and clip handle when the output is a mask. A composite
 * owns no target: it draws through the kit's shared scratch, one band at a time. */
export interface PreparedPathCoverage {
    readonly device: GfxDevice;
    readonly target: CoverageTarget | null;
    readonly vertices: BufferHandle;
    readonly clip: ClipHandle | null;
    readonly positiveVertices: number;
    readonly negativeVertices: number;
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
}

/** Platform stencil-coverage executor. Winding or union triangles fill an admitted stencil target,
 * one cover quad paints the colour under the not-equal test, and the scope composites once (or
 * leaves an R-channel clip mask). Admission and uploads happen in admit(); draws only borrow. */
export function createPathCoverageKit(host: LayerHost, report: (error: unknown) => void, audit = 'path-coverage') {
    let device: GfxDevice | null = null, pipelines: Pipelines | null = null, pending = false, failed = false, unsupported = false;
    let incarnation = 0, disposed = false, gpuBytes = 0, compositeLive = 0;
    const live = new Map<PreparedPathCoverage, number>();
    // One vertex buffer per triangle set, shared by every admission of it: the triangles are origin-relative, so all tile
    // views of an item at one scale draw the same buffer under their own affine. A buffer per admission uploaded and
    // charged a stroke once per tile it crossed, and the notebook's paper was refused for the room (267 refusals).
    const shared = new Map<Float64Array, { device: GfxDevice; buffer: BufferHandle; negative: Float64Array; refs: number; bytes: number }>();
    // A buffer larger than one frame's upload allowance fills across frames. Refused whole each frame, a stroke's outline
    // at 332% never uploaded and the board never presented again (measured: claimUpload refused 73 of 73 admissions).
    const uploading = new Map<Float64Array, { device: GfxDevice; buffer: BufferHandle; data: Float32Array; staging: ByteLease;
        written: number; negative: Float64Array; bytes: number }>();
    const dropUpload = (key: Float64Array) => {
        const up = uploading.get(key);
        if (!up) return;
        uploading.delete(key); gpuBytes -= up.bytes;
        host.allocator.cpu.release(up.staging); up.device.destroy(up.buffer);
    };
    const releaseShared = (entry: { device: GfxDevice; buffer: BufferHandle; refs: number; bytes: number }) => {
        if (--entry.refs > 0) return;
        for (const [key, value] of shared) if (value === entry) { shared.delete(key); break; }
        gpuBytes -= entry.bytes; entry.device.destroy(entry.buffer);
    };
    const releaseVertices = (prepared: PreparedPathCoverage) => {
        for (const entry of shared.values()) if (entry.buffer === prepared.vertices) { releaseShared(entry); return; }
    };
    const retireOwned = (prepared: PreparedPathCoverage) => {
        const bytes = live.get(prepared);
        if (bytes === undefined) return;
        live.delete(prepared); gpuBytes -= bytes;
        if (prepared.output.kind === 'composite') { compositeLive--; releaseScratch(prepared.device); }
        if (prepared.clip) prepared.device.destroy(prepared.clip);
        if (prepared.target) { prepared.device.destroy(prepared.target.target); prepared.device.destroy(prepared.target.texture); }
        releaseVertices(prepared);
    };
    // The composite scratch is one per DEVICE (a pane's context), shared by every kit there: coverage draws are sequential
    // within a frame. One per kit held 2 MiB for each of paper, board and wet, and the pane's working grant refused the
    // paper's path admissions for the room (measured: refused at pane-grant:working, 33 and 54 per draw).
    // A target per item, held for its plan, made every page-sized fill a 13-33 MB admission the pane never granted, so
    // the paper took the CPU raster route (measured: 330 fallbacks in one notebook pan).
    const scratchOf = (owner: GfxDevice | null): SharedScratch | undefined => owner ? deviceScratch.get(owner) : undefined;
    /** Drops one composite admission's hold on its device's scratch. The scratch is released when none is in flight. */
    const releaseScratch = (owner: GfxDevice) => {
        const shared = deviceScratch.get(owner);
        if (!shared || --shared.refs > 0) return;
        deviceScratch.delete(owner);
        owner.destroy(shared.target.target); owner.destroy(shared.target.texture);
    };
    /** Ensures the device's scratch holds a band of the given width; false when its lease is refused (a wait). It only
     * grows, and to the widest band the device has asked for, at the full height the cap allows: a grown scratch replaced
     * the one every kit drew from, and a band re-sized per request was a new target for each kit's width change. */
    const ensureScratch = (owner: GfxDevice, width: number): boolean | 'unsupported' => {
        const rowBytes = coverageTargetBytes(width, 1, PATH_COVERAGE_SAMPLES);
        if (rowBytes > PATH_COVERAGE_SCRATCH_BYTES) return 'unsupported';
        const current = deviceScratch.get(owner);
        // Draws loop over bands of the target's height, so any height serves; only the width must fit the request.
        if (current && current.target.width >= width) return true;
        const w = Math.max(width, current?.target.width ?? 0, scratchWidth.get(owner) ?? 0);
        const h = Math.floor(PATH_COVERAGE_SCRATCH_BYTES / coverageTargetBytes(w, 1, PATH_COVERAGE_SAMPLES));
        const bytes = coverageTargetBytes(w, h, PATH_COVERAGE_SAMPLES);
        const lease = host.allocator.gpu.reserve(bytes);
        if (!lease) return false;
        let target: CoverageTarget;
        try { target = owner.createCoverageTarget(w, h, PATH_COVERAGE_SAMPLES, lease); }
        catch (error) { host.allocator.gpu.release(lease); throw error; }
        // No admission holds the old target (draws read the scratch when they draw), and the device returns its lease.
        if (current) { owner.destroy(current.target.target); owner.destroy(current.target.texture); }
        scratchWidth.set(owner, w);
        deviceScratch.set(owner, { device: owner, target, bytes, refs: current?.refs ?? 0 });
        auditCount(audit, 'kit:scratch-new');
        return true;
    };
    const release = () => {
        incarnation++;
        for (const prepared of [...live.keys()]) retireOwned(prepared);
        for (const entry of shared.values()) { gpuBytes -= entry.bytes; entry.device.destroy(entry.buffer); }
        shared.clear();
        for (const key of [...uploading.keys()]) dropUpload(key);
        if (pipelines && device) for (const handle of Object.values(pipelines)) device.destroy(handle);
        pipelines = null; device = null; pending = false; failed = false; unsupported = false;
    };
    const ensurePipelines = () => {
        if (!device || pipelines || pending || failed) return;
        const owner = device, serial = ++incarnation; pending = true;
        const base = { topology: 'triangles', colorFormat: 'rgba8', samples: PATH_COVERAGE_SAMPLES, alphaToCoverage: false } as const;
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
        ]).then(([increment, decrement, invert, union, cover, coverAdd, coverModulate]) => {
            if (disposed || incarnation !== serial || device !== owner) {
                for (const handle of [increment, decrement, invert, union, cover, coverAdd, coverModulate]) owner.destroy(handle);
                return;
            }
            pipelines = { increment, decrement, invert, union, cover, coverAdd, coverModulate };
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
    const render = (pass: GpuPass, prepared: PreparedPathCoverage): void => {
        if (disposed || !live.has(prepared) || !pipelines || prepared.device !== device || host.device() !== device ||
            host.generation !== prepared.device.generation) throw new Error('Stale path coverage');
        const { affine, colour, viewport, output } = prepared;
        const target = prepared.target ?? scratchOf(prepared.device)?.target;
        if (!target || target.width < prepared.bounds.width) throw new Error('Stale path coverage');
        const windingData = new Float32Array(12);
        windingData.set([viewport.width, viewport.height, 0, 0, affine[0], affine[1], affine[2], affine[3], affine[4], affine[5], 0, 0]);
        const windingUniforms = host.uniforms(windingData);
        const whole = prepared.bounds;
        for (let y = whole.y; y < whole.y + whole.height; y += target.height) {
        const bounds: RectI = { x: whole.x, y, width: whole.width, height: Math.min(target.height, whole.y + whole.height - y) };
        const coverData = new Float32Array(12);
        coverData.set([viewport.width, viewport.height, 0, 0, bounds.x, bounds.y, bounds.width, bounds.height, ...colour]);
        const coverUniforms = host.uniforms(coverData);
        const token = pass.beginCoverage(target, bounds);
        try {
            const total = prepared.positiveVertices + prepared.negativeVertices;
            const drawWinding = (pipeline: PipelineHandle, first: number, count: number) => {
                if (!count) return;
                pass.draw({ pipeline, bindings: { uniforms: [{ binding: 0, slice: windingUniforms }], textures: [] },
                    vertices: [{ buffer: prepared.vertices, offset: 0, bytes: total * 8 }], first, count, instances: 1, scissor: bounds });
            };
            if (prepared.supersample && prepared.rule === 'union' && output.kind === 'composite') {
                const quarter = new Float32Array(12);
                quarter.set([viewport.width, viewport.height, 0, 0, bounds.x, bounds.y, bounds.width, bounds.height, ...colour.map(v => v * 0.25)]);
                const quarterUniforms = host.uniforms(quarter);
                for (const [dx, dy] of UNION_JITTER) {
                    const jittered = new Float32Array(12);
                    jittered.set([viewport.width, viewport.height, 0, 0, affine[0], affine[1], affine[2], affine[3], affine[4] + dx, affine[5] + dy, 0, 0]);
                    pass.draw({ pipeline: pipelines.union, bindings: { uniforms: [{ binding: 0, slice: host.uniforms(jittered) }], textures: [] },
                        vertices: [{ buffer: prepared.vertices, offset: 0, bytes: total * 8 }], first: 0, count: prepared.positiveVertices, instances: 1, scissor: bounds });
                    pass.draw({ pipeline: pipelines.coverAdd, bindings: { uniforms: [{ binding: 0, slice: quarterUniforms }], textures: [] },
                        vertices: [], first: 0, count: 4, instances: 1, scissor: bounds });
                }
            } else {
            if (prepared.rule === 'evenodd') drawWinding(pipelines.invert, 0, total);
            else if (prepared.rule === 'union') drawWinding(pipelines.union, 0, prepared.positiveVertices);
            else {
                drawWinding(pipelines.increment, 0, prepared.positiveVertices);
                drawWinding(pipelines.decrement, prepared.positiveVertices, prepared.negativeVertices);
            }
            pass.draw({ pipeline: prepared.modulate ? pipelines.coverModulate : pipelines.cover,
                bindings: { uniforms: [{ binding: 0, slice: coverUniforms }], textures: [] },
                vertices: [], first: 0, count: 4, instances: 1, scissor: bounds });
            }
        } finally { pass.endCoverage(token, output); }
        }
    };
    return {
        warm,
        ready: isReady,
        /** The scratch's lease is the device's; this kit reports the share its live composite admissions hold of it, so the
         * kits on one device sum to the scratch once and a hidden pane's kit reports none. */
        memory(): { gpuBytes: number; cpuBytes: number } {
            const shared = device ? deviceScratch.get(device) : undefined;
            const share = shared && compositeLive > 0 ? Math.round(shared.bytes * compositeLive / shared.refs) : 0;
            return { gpuBytes: gpuBytes + share, cpuBytes: 0 };
        },
        /** Admission happens here, in prepare: target, vertices and any clip handle are created before
         * any draw. Failure is permanent for this device incarnation and returns 'unsupported'. */
        admit(request: PathCoverageRequest, budget: FrameBudget): PathCoverageAdmission {
            // Failure is permanent for this device incarnation: the caller's exact route takes the item.
            if (disposed || failed || unsupported) return { status: 'unsupported' };
            warm();
            // Pipelines still compiling are a wait, not a fallback; ready invalidates the frame.
            if (!isReady()) return { status: pending || !device ? 'denied' : 'unsupported' };
            const owner = device!, { shapes, rule, affine, viewport, output } = request;
            if (owner.generation !== budget.token.deviceGeneration || host.generation !== budget.token.deviceGeneration) return { status: 'denied' };
            if (rule === 'nonzero' && shapes.edges > PATH_COVERAGE_STENCIL_MAX_EDGES) return { status: 'unsupported' };
            if (!Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height) || viewport.width <= 0 || viewport.height <= 0) {
                throw new RangeError('Invalid path coverage viewport');
            }
            if (!request.colour.every(Number.isFinite)) throw new RangeError('Invalid path coverage colour');
            const mapped = mapBounds(shapes.bounds, affine);
            const x0 = Math.max(0, Math.floor(mapped.x0)), y0 = Math.max(0, Math.floor(mapped.y0));
            const x1 = Math.min(viewport.width, Math.ceil(mapped.x1)), y1 = Math.min(viewport.height, Math.ceil(mapped.y1));
            if (x1 <= x0 || y1 <= y0) return { status: 'empty' };
            const bounds: RectI = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
            if (bounds.width > owner.limits.maxRenderTargetSize || bounds.height > owner.limits.maxRenderTargetSize) return { status: 'unsupported' };
            const vertexCount = (shapes.positive.length + shapes.negative.length) / 2;
            if (!Number.isSafeInteger(vertexCount) || vertexCount % 3) throw new RangeError('Invalid path triangle storage');
            if (vertexCount === 0) return { status: 'empty' };
            const vertexBytes = vertexCount * 8;
            const composite = output.kind === 'composite';
            const targetBytes = composite ? 0 : coverageTargetBytes(bounds.width, bounds.height, PATH_COVERAGE_SAMPLES);
            if (targetBytes > PATH_COVERAGE_MAX_TARGET_BYTES) { auditCount(audit, 'fallback:raster-route'); return { status: 'unsupported' }; }
            if (composite && coverageTargetBytes(bounds.width, 1, PATH_COVERAGE_SAMPLES) > PATH_COVERAGE_SCRATCH_BYTES) {
                auditCount(audit, 'fallback:raster-route'); return { status: 'unsupported' };
            }
            // One vertex buffer per triangle set, uploaded in chunks within each frame's allowance, then shared.
            let entry = shared.get(shapes.positive);
            if (entry && (entry.device !== owner || entry.negative !== shapes.negative || entry.bytes !== vertexBytes)) return { status: 'unsupported' };
            if (!entry) {
                let up = uploading.get(shapes.positive);
                if (up && (up.device !== owner || up.negative !== shapes.negative || up.bytes !== vertexBytes)) { dropUpload(shapes.positive); up = undefined; }
                if (!up) {
                    const staging = host.allocator.cpu.reserve(vertexBytes);
                    if (!staging) return { status: 'denied' };
                    // Positive triangles first, then negative: the draw ranges follow this order.
                    const data = new Float32Array(vertexCount * 2);
                    data.set(shapes.positive, 0);
                    data.set(shapes.negative, shapes.positive.length);
                    const lease = host.allocator.gpu.reserve(vertexBytes);
                    if (!lease) { host.allocator.cpu.release(staging); return { status: 'denied' }; }
                    let buffer: BufferHandle;
                    try { buffer = owner.createBuffer(vertexBytes, ['vertex', 'copy-dst'], lease); }
                    catch (error) {
                        host.allocator.gpu.release(lease); host.allocator.cpu.release(staging);
                        if (error instanceof ArenaError && error.code === 'unsupported') { unsupported = true; return { status: 'unsupported' }; }
                        throw error;
                    }
                    up = { device: owner, buffer, data, staging, written: 0, negative: shapes.negative, bytes: vertexBytes };
                    uploading.set(shapes.positive, up); gpuBytes += vertexBytes;
                }
                while (up.written < up.bytes) {
                    const piece = Math.min(PATH_COVERAGE_UPLOAD_CHUNK_BYTES, up.bytes - up.written);
                    if (!budget.claimUpload(piece)) return { status: 'deferred' };
                    owner.writeBuffer(up.buffer, up.written, up.data.subarray(up.written / 4, (up.written + piece) / 4));
                    auditCount(audit, 'upload:vertex', 1, { bytes: piece });
                    up.written += piece;
                }
                uploading.delete(shapes.positive); host.allocator.cpu.release(up.staging);
                entry = { device: owner, buffer: up.buffer, negative: shapes.negative, refs: 0, bytes: vertexBytes };
                shared.set(shapes.positive, entry);
            }
            entry.refs++;
            const vertices = entry.buffer;
            // The scratch is ensured after the buffer: a refused scratch then drops the buffer's hold, and the retry re-uploads.
            if (composite) {
                let fits: boolean | 'unsupported';
                try { fits = ensureScratch(owner, bounds.width); }
                catch (error) { releaseShared(entry); throw error; }
                if (fits !== true) {
                    releaseShared(entry);
                    if (fits === 'unsupported') { auditCount(audit, 'fallback:raster-route'); return { status: 'unsupported' }; }
                    return { status: 'denied' };
                }
            }
            const targetLease = composite ? null : host.allocator.gpu.reserve(targetBytes);
            if (!composite && !targetLease) { releaseShared(entry); return { status: 'denied' }; }
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
                releaseShared(entry);
                if (error instanceof ArenaError && error.code === 'unsupported') { unsupported = true; return { status: 'unsupported' }; }
                throw error;
            }
            // A modulate composite's source is k = C·c + 1 − α·c at full coverage: premultiplied colour plus one minus alpha.
            const modulate = output.kind === 'composite' && output.blend === 'modulate';
            const [pr, pg, pb, alpha] = [request.colour[0] * request.colour[3], request.colour[1] * request.colour[3], request.colour[2] * request.colour[3], request.colour[3]];
            const colour: readonly [number, number, number, number] = output.kind === 'mask' ? [1, 1, 1, 1]
                : modulate ? [pr + 1 - alpha, pg + 1 - alpha, pb + 1 - alpha, 1] : [pr, pg, pb, alpha];
            // The vertex buffer's bytes are the shared entry's, counted once; this admission owns only its target.
            const gpu = targetBytes;
            const prepared: PreparedPathCoverage = Object.freeze({ device: owner, target, vertices, clip,
                positiveVertices: shapes.positive.length / 2, negativeVertices: shapes.negative.length / 2, rule, output, bounds,
                viewport: Object.freeze({ width: viewport.width, height: viewport.height }),
                affine: Object.freeze([...affine]) as unknown as Affine,
                colour: Object.freeze([...colour]) as unknown as readonly [number, number, number, number], gpuBytes: gpu,
                supersample: request.supersample === true, modulate });
            live.set(prepared, gpu); gpuBytes += gpu;
            if (composite) { compositeLive++; deviceScratch.get(owner)!.refs++; }
            return { status: 'ready', value: prepared };
        },
        /** Composite output: borrows the admitted target inside the caller's pass. */
        draw(pass: GpuPass, prepared: PreparedPathCoverage): void {
            if (prepared.output.kind !== 'composite') throw new Error('Mask coverage is drawn with drawMask');
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
