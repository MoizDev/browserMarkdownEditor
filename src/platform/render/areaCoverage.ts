/** Exact-area coverage kit: the union ink route's alternative to the stencil grid (see whiteboard/render/inkAreaCells.ts).
 *
 * A stroke admits its cells (instances (x0, y, n, A), band-local device px), uploaded once as vertex buffers in pieces of at
 * most PIECE_INSTANCES instances. A non-critical layer is granted only its own allowance per frame, so a refused piece halves
 * down to MIN_PIECE_INSTANCES before the admission defers.
 *
 * Drawing accumulates the cells into one SCRATCH r32f target per device, shared by every kit there and sized to the viewport
 * (the largest band a view can have). Each area is drawn in turn: its band is cleared by the kit's clear pass, its pieces
 * accumulate by additive blending, and the composite resolves min(1, |acc|) with the paint output before the next area starts.
 * Areas are sequential within a frame, so the shared scratch is never read across two of them. Only the cells stay resident
 * per stroke, so GPU bytes are the cells plus one scratch, not a target per stroke.
 *
 * Admission is resumable. `begin` is pure: it holds the cells, no device work. `admit` uploads what the frame's allowance
 * takes and keeps every piece it has uploaded across a deferral; the retry resumes at the next piece, so no byte is uploaded
 * twice. `discard` is the only way an unfinished admission lets go of its pieces.
 *
 * The kit only takes the device's own float targets: a device without EXT_color_buffer_float and EXT_float_blend is refused as
 * 'unsupported', and its caller keeps the grid route, counted.
 *
 * Ownership: leases are handed to the device at creation (it returns them on destroy), so nothing is released twice. */
import type { AreaOutput, AreaTarget, BufferHandle, GfxDevice, GpuPass, PipelineHandle, RectI, ShaderModule } from './gfx/api';
import type { LayerHost } from './compositor.types';
import type { FrameBudget } from './types';
import { ArenaError } from './resourceArena';

/** The admitted cells of one area: four floats per instance, `count` instances, band-local device px. */
export interface AreaSpans {
    readonly cells: Float32Array;
    readonly count: number;
}

/** One uploaded piece of an area's cells: a vertex buffer of `count` instances (16 bytes each). */
interface AreaPiece {
    readonly buffer: BufferHandle;
    readonly count: number;
    readonly bytes: number;
}

/** An admission in progress: its cells and the pieces uploaded so far. Owned by the caller until it is ready or discarded. */
export interface AreaPending {
    readonly spans: AreaSpans;
    readonly bounds: RectI;
    readonly pieces: AreaPiece[];
    uploaded: number;
    piece: number;
    bytes: number;
    device: GfxDevice | null;
    generation: number;
}

export interface PreparedArea {
    readonly device: GfxDevice;
    readonly generation: number;
    readonly pieces: readonly AreaPiece[];
    readonly bytes: number;
    /** The band rectangle in device px: the area's texels in the scratch, which is the band's own size. */
    readonly bounds: RectI;
}

export type AreaAdmission =
    | { readonly status: 'ready'; readonly value: PreparedArea }
    | { readonly status: 'empty' }
    /** The pending admission is kept: retry it with the same AreaPending, and it resumes where it stopped. */
    | { readonly status: 'deferred' }
    /** The device or its generation moved under the pending admission: it was discarded. */
    | { readonly status: 'stale' }
    /** The pending admission was discarded. */
    | { readonly status: 'denied'; readonly pool: 'gpu' | 'cpu'; readonly bytes: number }
    /** The pending admission was discarded. */
    | { readonly status: 'unsupported'; readonly why: string };

export interface AreaKit {
    begin(spans: AreaSpans, bounds: RectI): AreaPending;
    admit(host: LayerHost, pending: AreaPending, budget: FrameBudget, viewport: { readonly width: number; readonly height: number }): AreaAdmission;
    discard(pending: AreaPending): void;
    draw(host: LayerHost, pass: GpuPass, prepared: PreparedArea, output: AreaOutput): void;
    retire(prepared: PreparedArea): void;
    release(): void;
    memory(): { readonly gpuBytes: number };
}

/** An upload piece is 4096 instances (64 KiB) at most. A refused piece halves down to MIN_PIECE_INSTANCES (4 KiB, as the path kit's
 * pieces do) before the admission defers: a fixed 64 KiB piece deferred every frame on a busy layer. */
const PIECE_INSTANCES = 4096;
const MIN_PIECE_INSTANCES = 256;
const INSTANCE_BYTES = 16;

/** One instance per span: vertices are a 4-vertex strip from x0 to the band's right edge, covering row y. */
const SPAN_SHADER: ShaderModule = {
    id: 'platform-area-span', revision: 2,
    layout: {
        uniforms: [{ binding: 0, byteSize: 32 }],
        textures: [],
        attributes: [{ location: 0, bufferSlot: 0, offset: 0, stride: INSTANCE_BYTES, format: 'float32x4', step: 'instance' }],
    },
    glsl: {
        vertex: `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 { vec4 viewport; vec4 band; };
layout(location=0) in vec4 span;
flat out vec4 ramp;
void main() {
    vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
    float left = max(span.x, 0.0);
    vec2 pixel = vec2(mix(left, band.x, corner.x), span.y + corner.y);
    vec2 unit = pixel / viewport.xy;
    gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
    ramp = vec4(span.x, span.z, span.w, 0.0);
}`,
        fragment: `#version 300 es
precision highp float;
flat in vec4 ramp;
out float accumulated;
void main() {
    // The fragment's device px is floor(gl_FragCoord.x); the instance adds A·clamp(x − x0 + 1, 0, n) there.
    float x = floor(gl_FragCoord.x);
    accumulated = ramp.z * clamp(x - ramp.x + 1.0, 0.0, ramp.y);
}`,
    },
};

/** The band's clear pass: a band-sized quad written with zero, so the area starts from nothing without clearing the scratch. */
const CLEAR_SHADER: ShaderModule = {
    id: 'platform-area-clear', revision: 1,
    layout: { uniforms: [{ binding: 0, byteSize: 32 }], textures: [], attributes: [] },
    glsl: {
        vertex: `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 { vec4 viewport; vec4 band; };
void main() {
    vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
    vec2 unit = (corner * band.xy) / viewport.xy;
    gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
}`,
        fragment: `#version 300 es
precision highp float;
out float accumulated;
void main() { accumulated = 0.0; }`,
    },
};
const NO_STENCIL = { enabled: false } as const;

/** The shared scratch of one device: one r32f target sized to the viewport, used by every area kit on the device. */
interface Scratch { readonly target: AreaTarget; readonly bytes: number; users: number }
const scratchOf = new WeakMap<GfxDevice, Scratch>();

export function createAreaKit(): AreaKit {
    let device: GfxDevice | null = null;
    let span: PipelineHandle | null = null;
    let clear: PipelineHandle | null = null;
    let pending = false, failed = false, serial = 0;
    const live = new Map<PreparedArea, number>();
    /** Admissions with uploaded pieces that are not yet ready: the kit holds their bytes until they are ready or discarded. */
    const uploading = new Set<AreaPending>();
    /** Whether this kit holds a reference on the device's scratch (taken at its first ready area, returned at release). */
    let holding = false;
    let pieceBytes = 0;
    /** The scratch's bytes, counted while this kit holds it. */
    let scratchBytes = 0;
    const uniformScratch = new Float32Array(8);

    /** The area pipelines, or null while they compile (or after a refused compile, which the caller sees as deferral). */
    const ensurePipelines = (owner: GfxDevice): boolean => {
        if (span && clear && device === owner) return true;
        if (device !== owner) { release(); device = owner; }
        if (pending || failed) return false;
        pending = true;
        const mine = ++serial;
        const make = (shader: ShaderModule, blend: 'add' | 'replace') => owner.createPipeline({ shader, topology: 'triangle-strip',
            colorFormat: 'r32f', samples: 1, blend, alphaToCoverage: false, colorWrite: [true, true, true, true], stencil: NO_STENCIL });
        Promise.all([make(SPAN_SHADER, 'add'), make(CLEAR_SHADER, 'replace')]).then(([spanHandle, clearHandle]) => {
            pending = false;
            if (device === owner && mine === serial) { span = spanHandle; clear = clearHandle; }
            else { owner.destroy(spanHandle); owner.destroy(clearHandle); }
        }, () => { pending = false; failed = true; });
        return false;
    };

    /** Takes a reference on the device's scratch, creating it at the viewport's size on first use. */
    const acquireScratch = (host: LayerHost, owner: GfxDevice, viewport: { width: number; height: number }): Scratch | 'denied' => {
        const existing = scratchOf.get(owner);
        if (existing) return existing;
        const bytes = viewport.width * viewport.height * 4;
        const lease = host.allocator.gpu.reserve(bytes);
        if (!lease || lease.bytes < bytes) {
            if (lease) host.allocator.gpu.release(lease);
            return 'denied';
        }
        let target: AreaTarget;
        try {
            const made = owner.createRenderTexture(viewport.width, viewport.height, lease, { format: 'r32f' });
            target = { target: made.target, texture: made.texture, width: viewport.width, height: viewport.height };
        } catch (error) {
            if (error instanceof ArenaError && error.code === 'out-of-budget') return 'denied';
            throw error;
        }
        const scratch: Scratch = { target, bytes, users: 0 };
        scratchOf.set(owner, scratch);
        return scratch;
    };
    /** Frees an unfinished admission's pieces. Idempotent: an admission the kit already discarded is not counted twice. */
    const discard = (admission: AreaPending): void => {
        if (!uploading.delete(admission)) return;
        for (const piece of admission.pieces) admission.device?.destroy(piece.buffer);
        pieceBytes -= admission.bytes;
        admission.pieces.length = 0; admission.uploaded = 0; admission.bytes = 0; admission.device = null;
    };
    const destroy = (prepared: PreparedArea): void => {
        if (!live.delete(prepared)) return;
        pieceBytes -= prepared.bytes;
        for (const piece of prepared.pieces) prepared.device.destroy(piece.buffer);
    };
    function release(): void {
        for (const admission of [...uploading]) discard(admission);
        for (const prepared of [...live.keys()]) destroy(prepared);
        if (device && holding) {
            const scratch = scratchOf.get(device);
            if (scratch && --scratch.users === 0) {
                scratchOf.delete(device);
                device.destroy(scratch.target.target); device.destroy(scratch.target.texture);
            }
        }
        holding = false; scratchBytes = 0;
        if (span && device) device.destroy(span);
        if (clear && device) device.destroy(clear);
        span = null; clear = null; pending = false; failed = false; device = null;
    }

    return {
        begin(spans, bounds): AreaPending {
            return { spans, bounds, pieces: [], uploaded: 0, piece: PIECE_INSTANCES, bytes: 0, device: null, generation: 0 };
        },
        admit(host, admission, budget, viewport): AreaAdmission {
            const owner = host.device();
            if (!owner) return { status: 'unsupported', why: 'no-device' };
            if (!owner.areaTargets) return { status: 'unsupported', why: 'no-float-targets' };
            if (admission.device && (admission.device !== owner || admission.generation !== host.generation)) {
                discard(admission);
                return { status: 'stale' };
            }
            if (admission.spans.count === 0) return { status: 'empty' };
            if (!admission.device) {
                admission.device = owner; admission.generation = host.generation;
                uploading.add(admission);
            }
            // The cells upload first, resuming at the first piece not yet written: a piece is never uploaded twice.
            while (admission.uploaded < admission.spans.count) {
                const count = Math.min(admission.piece, admission.spans.count - admission.uploaded);
                const bytes = count * INSTANCE_BYTES;
                if (!budget.claimUpload(bytes)) {
                    if (admission.piece > MIN_PIECE_INSTANCES) { admission.piece = Math.max(MIN_PIECE_INSTANCES, admission.piece >> 1); continue; }
                    return { status: 'deferred' };
                }
                const lease = host.allocator.gpu.reserve(bytes);
                if (!lease || lease.bytes < bytes) {
                    if (lease) host.allocator.gpu.release(lease);
                    discard(admission);
                    return { status: 'denied', pool: 'gpu', bytes };
                }
                // copy-dst: each piece is written once after creation, as the path kit's triangle buffers are.
                let buffer: BufferHandle;
                try { buffer = owner.createBuffer(bytes, ['vertex', 'copy-dst'], lease); }
                catch (error) {
                    host.allocator.gpu.release(lease); discard(admission);
                    if (error instanceof ArenaError && error.code === 'unsupported') return { status: 'unsupported', why: 'vertex-buffer' };
                    throw error;
                }
                owner.writeBuffer(buffer, 0, admission.spans.cells.subarray(admission.uploaded * 4, (admission.uploaded + count) * 4));
                admission.pieces.push({ buffer, count, bytes });
                admission.uploaded += count; admission.bytes += bytes; pieceBytes += bytes;
            }
            // The pipelines and the scratch come after the cells: a deferral here keeps every piece already uploaded.
            if (!ensurePipelines(owner)) return { status: 'deferred' };
            const scratch = acquireScratch(host, owner, viewport);
            if (scratch === 'denied') { discard(admission); return { status: 'denied', pool: 'gpu', bytes: viewport.width * viewport.height * 4 }; }
            if (!holding) { scratch.users++; holding = true; scratchBytes = scratch.bytes; }
            uploading.delete(admission);
            const prepared: PreparedArea = { device: owner, generation: admission.generation, pieces: admission.pieces.slice(),
                bytes: admission.bytes, bounds: admission.bounds };
            live.set(prepared, admission.bytes);
            return { status: 'ready', value: prepared };
        },
        discard,
        draw(host, pass, prepared, output): void {
            const scratch = prepared.device === host.device() && host.generation === prepared.generation ? scratchOf.get(prepared.device) : undefined;
            if (!live.has(prepared) || !scratch || !span || !clear) throw new Error('Stale area');
            const token = pass.beginArea(scratch.target, prepared.bounds);
            const { bounds } = prepared;
            // Both passes map band-local px through the scratch's size (the area's own viewport, see beginArea): the band's texels
            // are the top-left corner of the scratch, rows counted from its top, which the composite reads the same way.
            uniformScratch[0] = scratch.target.width; uniformScratch[1] = scratch.target.height; uniformScratch[2] = 0; uniformScratch[3] = 0;
            uniformScratch[4] = bounds.width; uniformScratch[5] = bounds.height; uniformScratch[6] = 0; uniformScratch[7] = 0;
            const slice = host.uniforms(uniformScratch);
            const whole = { x: 0, y: 0, width: scratch.target.width, height: scratch.target.height };
            // The band's own clear first: the area accumulates from zero, and nothing outside the band is touched.
            pass.draw({ pipeline: clear, bindings: { uniforms: [{ binding: 0, slice }], textures: [] }, vertices: [], first: 0, count: 4,
                instances: 1, scissor: whole });
            for (const piece of prepared.pieces) {
                pass.draw({ pipeline: span, bindings: { uniforms: [{ binding: 0, slice }], textures: [] },
                    vertices: [{ buffer: piece.buffer, offset: 0, bytes: piece.bytes }], first: 0, count: 4,
                    instances: piece.count, scissor: whole });
            }
            pass.endArea(token, output);
        },
        retire(prepared): void { destroy(prepared); },
        release,
        memory: () => ({ gpuBytes: pieceBytes + scratchBytes }),
    };
}
