import type { Affine } from '../types';
import type { LayerHost } from './compositor.types';
import type { BufferHandle, CoverageTarget, GfxDevice, GpuPass, PipelineHandle, RectI, Samples, ShaderModule, StencilOp, StencilState } from './gfx/api';
import { coverageTargetBytes } from './gfx/api';
import { ArenaError } from './resourceArena';
import type { FrameBudget } from './types';

/** Winding of any point is bounded by the number of edges crossing a ray from it, and an 8-bit
 * stencil counting with wrapping arithmetic keeps a nonzero winding nonzero while that bound is at
 * most 255. Callers with more edges under the nonzero rule must use their exact fallback. */
export const PATH_COVERAGE_STENCIL_MAX_EDGES = 255;
/** Multisample storage is required for the boundary coverage; the display surface is never used. */
export const PATH_COVERAGE_SAMPLES: Samples = 4;

/** Origin-relative triangles, six values per triangle, as produced by a generic path tessellator.
 * `positive` adds +1 winding, `negative` adds -1; the sum is the winding everywhere off the edges. */
export interface PathCoverageShapes {
    readonly positive: Float64Array;
    readonly negative: Float64Array;
    readonly edges: number;
    readonly rule: 'nonzero' | 'evenodd';
    /** Origin-relative bounds of the shapes, in the same units as the triangles. */
    readonly bounds: Readonly<{ x0: number; y0: number; x1: number; y1: number }>;
}

export type PathCoverageAdmission =
    | { readonly status: 'ready'; readonly value: PreparedPathCoverage }
    | { readonly status: 'empty' }
    | { readonly status: 'denied' }
    | { readonly status: 'unsupported' };

/** A pre-admitted coverage target and a vertex buffer, both owned by this preparation. */
export interface PreparedPathCoverage {
    readonly device: GfxDevice;
    readonly target: CoverageTarget;
    readonly vertices: BufferHandle;
    readonly positiveVertices: number;
    readonly negativeVertices: number;
    readonly rule: 'nonzero' | 'evenodd';
    readonly bounds: RectI;
    /** The viewport the affine and bounds were admitted against; the shader maps pixels through it. */
    readonly viewport: Readonly<{ width: number; height: number }>;
    /** Origin-relative local to device-pixel affine, [a, b, c, d, e, f], frozen at preparation. */
    readonly affine: Affine;
    readonly colour: readonly [number, number, number, number];
    readonly gpuBytes: number;
}

const FACE_KEEP = { fail: 'keep', depthFail: 'keep', pass: 'keep' } as const;
function winding(op: StencilOp): StencilState {
    const face = { fail: 'keep', depthFail: 'keep', pass: op } as const;
    return { enabled: true, compare: 'always', reference: 0, readMask: 255, writeMask: 255, front: face, back: face };
}
const COVER_STENCIL: StencilState = { enabled: true, compare: 'not-equal', reference: 0, readMask: 255, writeMask: 0,
    front: FACE_KEEP, back: FACE_KEEP };
const NO_COLOUR_WRITE = [false, false, false, false] as const;

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

interface Pipelines { incrementWinding: PipelineHandle; decrementWinding: PipelineHandle; invertWinding: PipelineHandle; cover: PipelineHandle }

/** Platform stencil-winding executor: winding triangles into an admitted stencil target, then one
 * cover quad of the fill colour under the not-equal test, composited once at the scope's clip.
 * Callers prepare (admission, upload) in prepare() and only borrow the result while drawing. */
export function createPathCoverageKit(host: LayerHost, report: (error: unknown) => void) {
    let device: GfxDevice | null = null, pipelines: Pipelines | null = null, pending = false, failed = false, unsupported = false;
    let incarnation = 0, disposed = false, gpuBytes = 0;
    const live = new Map<PreparedPathCoverage, number>();
    const retireOwned = (prepared: PreparedPathCoverage) => {
        if (!live.has(prepared)) return;
        const bytes = live.get(prepared)!;
        live.delete(prepared); gpuBytes -= bytes;
        prepared.device.destroy(prepared.target.target);
        prepared.device.destroy(prepared.target.texture);
        prepared.device.destroy(prepared.vertices);
    };
    const release = () => {
        incarnation++;
        for (const prepared of [...live.keys()]) retireOwned(prepared);
        if (pipelines && device) {
            for (const handle of Object.values(pipelines)) device.destroy(handle);
        }
        pipelines = null; device = null; pending = false; failed = false; unsupported = false;
    };
    const ensurePipelines = () => {
        if (!device || pipelines || pending || failed) return;
        const owner = device, serial = ++incarnation; pending = true;
        const base = { topology: 'triangles', colorFormat: 'rgba8', samples: PATH_COVERAGE_SAMPLES, alphaToCoverage: false } as const;
        Promise.all([
            owner.createPipeline({ ...base, shader: WINDING_SHADER, blend: 'replace', colorWrite: NO_COLOUR_WRITE, stencil: winding('increment-wrap') }),
            owner.createPipeline({ ...base, shader: WINDING_SHADER, blend: 'replace', colorWrite: NO_COLOUR_WRITE, stencil: winding('decrement-wrap') }),
            owner.createPipeline({ ...base, shader: WINDING_SHADER, blend: 'replace', colorWrite: NO_COLOUR_WRITE, stencil: winding('invert') }),
            owner.createPipeline({ ...base, shader: COVER_SHADER, topology: 'triangle-strip', blend: 'source-over',
                colorWrite: [true, true, true, true], stencil: COVER_STENCIL }),
        ]).then(([incrementWinding, decrementWinding, invertWinding, cover]) => {
            if (disposed || incarnation !== serial || device !== owner) {
                for (const handle of [incrementWinding, decrementWinding, invertWinding, cover]) owner.destroy(handle);
                return;
            }
            pipelines = { incrementWinding, decrementWinding, invertWinding, cover };
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
    return {
        warm,
        ready: isReady,
        memory(): { gpuBytes: number; cpuBytes: number } { return { gpuBytes, cpuBytes: 0 }; },
        /** Admission happens here, in prepare: target and vertex storage are reserved and created
         * before any draw. The device and generation are those the caller will draw with. */
        admit(shapes: PathCoverageShapes, affine: Affine, viewport: { width: number; height: number }, colour: readonly [number, number, number, number],
            budget: FrameBudget): PathCoverageAdmission {
            // Failure is permanent for this device incarnation: the caller's exact route takes the item.
            if (disposed || failed || unsupported) return { status: 'unsupported' };
            warm();
            // Pipelines still compiling are a wait, not a fallback; ready invalidates the frame.
            if (!isReady()) return { status: pending || !device ? 'denied' : 'unsupported' };
            const owner = device!;
            if (owner.generation !== budget.token.deviceGeneration || host.generation !== budget.token.deviceGeneration) return { status: 'denied' };
            if (shapes.rule === 'nonzero' && shapes.edges > PATH_COVERAGE_STENCIL_MAX_EDGES) return { status: 'unsupported' };
            if (!Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height) || viewport.width <= 0 || viewport.height <= 0) {
                throw new RangeError('Invalid path coverage viewport');
            }
            if (!colour.every(Number.isFinite)) throw new RangeError('Invalid path coverage colour');
            const mapped = mapBounds(shapes.bounds, affine);
            const x0 = Math.max(0, Math.floor(mapped.x0)), y0 = Math.max(0, Math.floor(mapped.y0));
            const x1 = Math.min(viewport.width, Math.ceil(mapped.x1)), y1 = Math.min(viewport.height, Math.ceil(mapped.y1));
            if (x1 <= x0 || y1 <= y0) return { status: 'empty' };
            const bounds: RectI = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
            if (bounds.width > owner.limits.maxRenderTargetSize || bounds.height > owner.limits.maxRenderTargetSize) return { status: 'unsupported' };
            const triangles = shapes.positive.length / 6 + shapes.negative.length / 6;
            const vertexCount = triangles * 3, vertexBytes = vertexCount * 8;
            if (!Number.isSafeInteger(vertexBytes)) throw new RangeError('Path vertex storage exceeds safe accounting');
            if (vertexCount === 0) return { status: 'empty' };
            const targetBytes = coverageTargetBytes(bounds.width, bounds.height, PATH_COVERAGE_SAMPLES);
            const staging = host.allocator.cpu.reserve(vertexBytes);
            if (!staging) return { status: 'denied' };
            let data: Float32Array;
            try {
                // Positive triangles first, then negative: the draw ranges follow this order.
                data = new Float32Array(vertexCount * 2);
                data.set(shapes.positive, 0);
                data.set(shapes.negative, shapes.positive.length);
            } finally { host.allocator.cpu.release(staging); }
            const vertexLease = host.allocator.gpu.reserve(vertexBytes);
            if (!vertexLease) return { status: 'denied' };
            if (!budget.claimUpload(vertexBytes)) { host.allocator.gpu.release(vertexLease); return { status: 'denied' }; }
            const targetLease = host.allocator.gpu.reserve(targetBytes);
            if (!targetLease) { host.allocator.gpu.release(vertexLease); return { status: 'denied' }; }
            let vertices: BufferHandle | null = null, target: CoverageTarget | null = null, attached = false;
            try {
                vertices = owner.createBuffer(vertexBytes, ['vertex', 'copy-dst'], vertexLease); attached = true;
                owner.writeBuffer(vertices, 0, data);
                target = owner.createCoverageTarget(bounds.width, bounds.height, PATH_COVERAGE_SAMPLES, targetLease);
            } catch (error) {
                if (vertices) owner.destroy(vertices);
                if (!attached) host.allocator.gpu.release(vertexLease);
                host.allocator.gpu.release(targetLease);
                if (error instanceof ArenaError && error.code === 'unsupported') { unsupported = true; return { status: 'unsupported' }; }
                throw error;
            }
            const gpu = vertexBytes + targetBytes;
            const prepared: PreparedPathCoverage = Object.freeze({ device: owner, target, vertices, positiveVertices: shapes.positive.length / 6 * 3,
                negativeVertices: shapes.negative.length / 6 * 3, rule: shapes.rule, bounds,
                viewport: Object.freeze({ width: viewport.width, height: viewport.height }),
                affine: Object.freeze([...affine] as const) as Affine,
                colour: Object.freeze([colour[0] * colour[3], colour[1] * colour[3], colour[2] * colour[3], colour[3]] as const),
                gpuBytes: gpu });
            live.set(prepared, gpu); gpuBytes += gpu;
            return { status: 'ready', value: prepared };
        },
        draw(pass: GpuPass, prepared: PreparedPathCoverage): void {
            if (disposed || !live.has(prepared) || !pipelines || prepared.device !== device || host.device() !== device ||
                host.generation !== prepared.device.generation) throw new Error('Stale path coverage');
            const { bounds, affine, colour, target, viewport } = prepared;
            const windingData = new Float32Array(12);
            windingData.set([viewport.width, viewport.height, 0, 0, affine[0], affine[1], affine[2], affine[3], affine[4], affine[5], 0, 0]);
            const coverData = new Float32Array(12);
            coverData.set([viewport.width, viewport.height, 0, 0, bounds.x, bounds.y, bounds.width, bounds.height, ...colour]);
            const windingUniforms = host.uniforms(windingData), coverUniforms = host.uniforms(coverData);
            const token = pass.beginCoverage(target, bounds);
            try {
                const drawWinding = (pipeline: PipelineHandle, first: number, count: number) => {
                    if (!count) return;
                    pass.draw({ pipeline, bindings: { uniforms: [{ binding: 0, slice: windingUniforms }], textures: [] },
                        vertices: [{ buffer: prepared.vertices, offset: 0, bytes: (prepared.positiveVertices + prepared.negativeVertices) * 8 }],
                        first, count, instances: 1, scissor: bounds });
                };
                if (prepared.rule === 'evenodd') {
                    drawWinding(pipelines.invertWinding, 0, prepared.positiveVertices + prepared.negativeVertices);
                } else {
                    drawWinding(pipelines.incrementWinding, 0, prepared.positiveVertices);
                    drawWinding(pipelines.decrementWinding, prepared.positiveVertices, prepared.negativeVertices);
                }
                pass.draw({ pipeline: pipelines.cover, bindings: { uniforms: [{ binding: 0, slice: coverUniforms }], textures: [] },
                    vertices: [], first: 0, count: 4, instances: 1, scissor: bounds });
            } finally { pass.endCoverage(token); }
        },
        retire(prepared: PreparedPathCoverage): void { retireOwned(prepared); },
        release,
        dispose(): void { if (!disposed) { disposed = true; release(); } },
    };
}

