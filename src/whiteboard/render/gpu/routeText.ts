import type { Rgba } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { BufferHandle, ByteLease, DrawCommand, GfxDevice, GpuPass, PipelineHandle, RectI, SamplerHandle, ShaderModule, TextureHandle, UniformSlice } from '../../../platform/render/gfx/api';
import type { FrameBudget, OffscreenPasses } from '../../../platform/render/types';
import { auditCount } from '../../../platform/render/renderAudit';
import type { FontKey } from '../../text/fonts';
import type { PaintItem, PaintTextItem } from '../paintStream';
import { ATLAS_PAGE, IdentityIndex, ShelfPacker, TextAtlas, type AtlasEntry, type AtlasPage, type Indexed } from '../textAtlas';
import { MASK_CANVAS_BYTES, MEMO_ENTRY_BYTES, copyIdentity, createCpuAccount, createMaskRaster, fillIdentity, identityHash, needsColourMask,
    newIdentity, sliceCell, type CpuAccount, type MaskCell, type MaskGeometry, type MaskIdentity, type MaskRaster, type MaskRequest } from './textMasks';
import type { Admission, Blend, CreateTextRoute, ItemRoute, PreparedRun } from './contracts';

/** The text route as the composer sees it. `evictTextures` is the governor's hook (h9): whole atlas pages, coldest first.
 * `encodeOffscreen` converts this frame's staged mono coverage into its R8 pages, before any tile pass (a2ff745b). */
export interface TextRoute extends ItemRoute<PaintTextItem> {
    evictTextures(bytes: number, frameId: number): number;
    encodeOffscreen(passes: OffscreenPasses): void;
}

// The board's text route. A text run is drawn from exact-size mask cells (textMasks.ts) that live on atlas pages
// (textAtlas.ts). A mask larger than one cell is a grid of cells, each drawn as its own quad. Solid backgrounds and
// decorations are analytic-coverage rectangles in the same instance stream, so one run is one buffer and a few instanced
// draws, in paint order: backgrounds, glyph masks, decorations, per item. Keys are numbers, and a composition reuses its
// arrays: the only objects it makes are the ones a run keeps (its batches and pins), once per run, never per quad.
// A mono cell is never read back: its bitmap is staged and converted on the GPU into its R8 page.

/** Per instance: device rect (x, y, w, h), page uv rect (u0, v0, u1, v1; u0 = -1 marks a solid rect), premultiplied colour. */
const INSTANCE_BYTES = 48;
/** A batch's uniform before its first draw writes the frame's slice into it. It is never submitted. */
const NO_UNIFORM: UniformSlice = { buffer: null as unknown as BufferHandle, offset: 0, bytes: 0 };
const SOLID_UV = -1;
const PARALLELOGRAM_UV = -2;
const MONO_PAGES = 8, COLOUR_PAGES = 2;
/** Stand-in records kept at once; cleared whole when full, as the measurement memo is. */
const STANDIN_LIMIT = 4096;
/** CPU pool chunk for the stand-in memo: one lease per 64 KB, so its accounting is a handful of leases, not one per entry. */
const MEMO_CHUNK = 64 * 1024;
/** The instance scratch starts at this many floats (one quad is 12) and doubles; its lease is exact, so it is never over-reported. */
const SCRATCH_FLOOR = 12 * 64;
/** The conversion's instance buffer starts at this many cells and doubles, as the scratch does. */
const CONVERT_FLOOR = 64;
/** The staging texture is one page wide and as tall as the frame's cells need: it starts a quarter page tall and doubles, and
 * grows only while nothing is pending in it (a resize recreates it). */
const STAGE_WIDTH = ATLAS_PAGE, STAGE_MIN_HEIGHT = ATLAS_PAGE / 8, STAGE_MAX_HEIGHT = ATLAS_PAGE;
/** Idle time, in ms, before a staging texture that no frame converts through is released. */
const STAGE_IDLE_MS = 5000;

const ATTRIBUTES: ShaderModule['layout']['attributes'] = [
    { location: 0, bufferSlot: 0, offset: 0, stride: INSTANCE_BYTES, format: 'float32x4', step: 'instance' },
    { location: 1, bufferSlot: 0, offset: 16, stride: INSTANCE_BYTES, format: 'float32x4', step: 'instance' },
    { location: 2, bufferSlot: 0, offset: 32, stride: INSTANCE_BYTES, format: 'float32x4', step: 'instance' },
];

// The vertex stage is one expanded instance quad. A solid rect grows by a pixel so the fragment can compute its
// exact area coverage per pixel; a mask quad is exactly its whole-pixel rect, so its texels map 1:1.
// Re-read against GLSL ES 3.00 (by reading): every `out` has a matching `flat in` or `in`; step, mix, min, max and
// textureLod take float operands; the loops have constant bounds; the block is one vec4, matching the 16-byte ring slice.
const VERTEX = `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 { vec4 viewport; };
layout(location=0) in vec4 instanceRect;
layout(location=1) in vec4 instanceUv;
layout(location=2) in vec4 instanceColour;
out vec2 pixel; out vec2 uv;
flat out vec4 edges; flat out vec4 colour; flat out float shape;
flat out vec2 origin; flat out vec2 axisU; flat out vec2 axisV;
void main() {
    vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
    // uv.x = -2 marks a parallelogram: rect.xy is its origin, rect.zw the first edge, uv.yz the second. uv.x = -1 an axis-aligned solid.
    float isRotated = step(instanceUv.x, -1.5);
    float isSolid = step(instanceUv.x, -0.5) - isRotated;
    vec2 axisPixel = instanceRect.xy - isSolid + corner * (instanceRect.zw + 2.0 * isSolid);
    // The parallelogram's device bounds, grown by a pixel so its supersampled edges are not clipped.
    vec2 p0 = instanceRect.xy, e1 = instanceRect.zw, e2 = instanceUv.yz;
    vec2 c1 = p0 + e1, c2 = p0 + e2, c3 = p0 + e1 + e2;
    vec2 lo = min(min(p0, c1), min(c2, c3)) - 1.0, hi = max(max(p0, c1), max(c2, c3)) + 1.0;
    vec2 p = mix(axisPixel, mix(lo, hi, corner), isRotated);
    pixel = p;
    uv = mix(instanceUv.xy, instanceUv.zw, corner);
    edges = vec4(instanceRect.xy, instanceRect.xy + instanceRect.zw);
    colour = instanceColour;
    shape = isSolid + 2.0 * isRotated;
    origin = p0; axisU = e1; axisV = e2;
    vec2 unit = p / viewport.xy;
    gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
}`;
const HEADER = `#version 300 es
precision highp float;
uniform sampler2D gfxTexture0;
in vec2 pixel; in vec2 uv;
flat in vec4 edges; flat in vec4 colour; flat in float shape;
flat in vec2 origin; flat in vec2 axisU; flat in vec2 axisV;
layout(location=0) out vec4 gfxColour;
`;
/** Coverage of a mask texel, the exact area of an axis-aligned solid in this pixel, or the area of a parallelogram in this
 * pixel by 8 × 8 point samples (within 1/64 of the area, which is below the 8-level parity bar at any edge). */
const COVERAGE = `
float coverage() {
    if (shape > 1.5) {
        float det = axisU.x * axisV.y - axisU.y * axisV.x;
        if (abs(det) < 1e-12) return 0.0;
        vec2 cell = floor(pixel);
        float hits = 0.0;
        for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) {
            vec2 d = cell + vec2((float(i) + 0.5) / 8.0, (float(j) + 0.5) / 8.0) - origin;
            float u = (d.x * axisV.y - d.y * axisV.x) / det;
            float v = (axisU.x * d.y - axisU.y * d.x) / det;
            if (u >= 0.0 && u <= 1.0 && v >= 0.0 && v <= 1.0) hits += 1.0;
        }
        return hits / 64.0;
    }
    if (shape > 0.5) {
        vec2 cell = floor(pixel);
        vec2 span = clamp(min(edges.zw, cell + 1.0) - max(edges.xy, cell), 0.0, 1.0);
        return span.x * span.y;
    }
    return textureLod(gfxTexture0, uv, 0.0).r;
}`;
/** Premultiplied source-over; the 'modulate' form is dst · (1 − α + α·C), the multiply slice's own algebra (rgb ZERO, SRC_COLOR). */
const BODY: Record<'mono-over' | 'mono-modulate' | 'colour-over' | 'colour-modulate', string> = {
    'mono-over': `${COVERAGE}
void main() { gfxColour = colour * coverage(); }`,
    'mono-modulate': `${COVERAGE}
void main() { float m = coverage(); gfxColour = vec4(vec3(1.0) - m * colour.a + m * colour.rgb, 1.0); }`,
    'colour-over': `void main() { gfxColour = textureLod(gfxTexture0, uv, 0.0); }`,
    'colour-modulate': `void main() { vec4 t = textureLod(gfxTexture0, uv, 0.0); gfxColour = vec4(vec3(1.0) - t.a + t.rgb, 1.0); }`,
};

/** The conversion: a staged RGBA cell's alpha is written as the R8 page's coverage. Its quad lands on the page rect and samples
 * the staging rect with the same uv convention as a mask quad, so texel (i, j) of the cell lands on page pixel (x + i, y + j). */
const CONVERT_VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec4 instanceRect;
layout(location=1) in vec4 instanceUv;
out vec2 uv;
void main() {
    vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
    vec2 unit = (instanceRect.xy + corner * instanceRect.zw) / ${ATLAS_PAGE}.0;
    uv = mix(instanceUv.xy, instanceUv.zw, corner);
    gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
}`;
const CONVERT_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D gfxTexture0;
in vec2 uv;
layout(location=0) out vec4 gfxColour;
void main() { gfxColour = vec4(textureLod(gfxTexture0, uv, 0.0).a, 0.0, 0.0, 1.0); }`;

type Mode = 'mono' | 'colour';
type Variant = `${Mode}-${Blend}`;
/** Index order is the pipeline table's: the variant of (mode, blend) sits at pipelineIndex(mode, blend). */
const VARIANTS: readonly Variant[] = ['mono-over', 'mono-modulate', 'colour-over', 'colour-modulate'];
function pipelineIndex(mode: Mode, blend: Blend): number { return (mode === 'mono' ? 0 : 2) + (blend === 'modulate' ? 1 : 0); }

function shaderFor(variant: Variant): ShaderModule {
    const mode = variant.startsWith('mono') ? 'mono' : 'colour';
    return { id: `board-text-${variant}`, revision: 1,
        layout: { uniforms: [{ binding: 0, byteSize: 16 }], textures: [{ binding: 0, format: mode === 'mono' ? 'r8' : 'rgba8' }], attributes: ATTRIBUTES },
        glsl: { vertex: VERTEX, fragment: HEADER + BODY[variant] } };
}
function convertShader(): ShaderModule {
    return { id: 'board-text-convert', revision: 1,
        layout: { uniforms: [], textures: [{ binding: 0, format: 'rgba8' }], attributes: ATTRIBUTES.slice(0, 2) },
        glsl: { vertex: CONVERT_VERTEX, fragment: CONVERT_FRAGMENT } };
}

/** A face's stand-in label, from its upstream key and not its css: the css of an unloaded face is its fallback family, so it
 * differs from the loaded face's, and a stand-in must still find the loaded face's earlier mask. Built once, never per call. */
const FAMILY_INDEX: Record<FontKey['family'], number> = { draw: 0, sans: 1, serif: 2, mono: 3 };
const FACE_LABELS: readonly string[] = Array.from({ length: 16 }, (_, i) => `face-${i}`);
function faceLabel(key: FontKey): string {
    return FACE_LABELS[FAMILY_INDEX[key.family] * 4 + (key.bold ? 2 : 0) + (key.italic ? 1 : 0)];
}

/** A run's quads, in paint order. Each batch is consecutive quads that share a pipeline and texture: one instanced draw.
 * `command` is built once at admission and reused by every draw of the run: a draw writes only `uniform.slice`, the frame's uniforms. */
interface Batch { readonly mode: Mode; readonly texture: TextureHandle; readonly first: number; readonly count: number; readonly pipeline: PipelineHandle;
    readonly uniform: { binding: number; slice: UniformSlice }; readonly command: DrawCommand }
/** A batch under construction. The build keeps these objects and reuses them across compositions. */
interface BuildBatch { mode: Mode; texture: TextureHandle; first: number; count: number }
/** A single-cell mask the index can stand in for, with the geometry it is scaled from. */
interface StandIn extends Indexed { readonly atlas: TextAtlas; readonly entry: AtlasEntry; readonly scale: number; readonly originX: number; readonly originY: number; readonly w: number; readonly h: number }
/** What the last cell lookup found: an exact entry, or a stand-in with the device rect it is drawn in. One object, reused. */
interface Slot { entry: AtlasEntry | null; rgba: boolean; standIn: boolean; x: number; y: number; w: number; h: number }
/** A staged mono cell awaiting its conversion: the entry it fills and where its bitmap sits in the staging texture. */
interface PendingCell { entry: AtlasEntry; x: number; y: number }
/** One R8 page's share of the conversion: its cells are the instances [first, first + count) of the conversion buffer. */
interface PageRun { page: AtlasPage; first: number; count: number; fill: number }
interface TextRun extends PreparedRun {
    readonly device: GfxDevice;
    readonly buffer: BufferHandle;
    readonly bufferLease: ByteLease;
    readonly batches: readonly Batch[];
    readonly pinAtlases: readonly TextAtlas[];
    readonly pinEntries: readonly AtlasEntry[];
    readonly viewW: number;
    readonly viewH: number;
    readonly scissor: RectI;
    readonly bytes: number;
}
type Stop = Exclude<Admission<PreparedRun>, { status: 'ready' }>;
/** The run under construction. Its arrays and batch objects are reused by every composition; a finished run takes its own copies. */
interface Build {
    count: number;
    batches: BuildBatch[];
    batchCount: number;
    pinAtlas: TextAtlas[];
    pinEntry: AtlasEntry[];
    x0: number; y0: number; x1: number; y1: number;
}
type Writable<T> = { -readonly [K in keyof T]: T[K] };

export const createTextRoute: CreateTextRoute = (host: LayerHost, audit: string): TextRoute => {
    // Every CPU byte the route holds is leased: the canvas, the instance, uniform and conversion scratch, and the stand-in memo.
    const memoAccount: CpuAccount = createCpuAccount(host.allocator.cpu, MEMO_CHUNK);
    // The stand-in records have their own account, so clearing them returns their chunks without touching the measure memo's.
    const standAccount: CpuAccount = createCpuAccount(host.allocator.cpu, MEMO_CHUNK);
    // Refused measurements are counted under the audit surface (h13's text:measure-uncached), so a pool at its limit shows.
    const raster: MaskRaster = createMaskRaster(memoAccount, audit);
    let rasterLease: ByteLease | null = null;
    let scratch: Float32Array<ArrayBuffer> = new Float32Array(0), scratchLease: ByteLease | null = null;
    let uniformData: Float32Array<ArrayBuffer> | null = null, uniformLease: ByteLease | null = null;
    let device: GfxDevice | null = null;
    let incarnation = 0;
    let pipelines: (PipelineHandle | undefined)[] = [undefined, undefined, undefined, undefined];
    let convertPipeline: PipelineHandle | null = null;
    let pipelinesReady = false, pipelinesPending = false, failed = false;
    let mono: TextAtlas | null = null, colour: TextAtlas | null = null;
    let white: TextureHandle | null = null, whiteLease: ByteLease | null = null, sampler: SamplerHandle | null = null;
    /** The RGBA staging texture the mono bitmaps are written into, one frame's worth at a time, reset after its conversion. */
    let stage: { texture: TextureHandle; lease: ByteLease; packer: ShelfPacker; height: number } | null = null;
    /** The idle release: a timer, armed when a conversion ends and cancelled when one begins. A timer asks for no frame, so an
     * idle board stays idle; deleting a texture needs no pass, so it runs outside the frame. */
    let stageTimer: ReturnType<typeof setTimeout> | null = null;
    /** The conversion's instance buffer and its CPU twin: grown to the pending count, never shrunk. */
    let convertBuffer: BufferHandle | null = null, convertLease: ByteLease | null = null, convertCapacity = 0;
    let convertScratch: Float32Array<ArrayBuffer> = new Float32Array(0), convertScratchLease: ByteLease | null = null;
    const pending: PendingCell[] = [];
    let pendingCount = 0;
    const pageRuns: PageRun[] = [];
    let pageRunCount = 0;
    const live = new Set<TextRun>();
    /** The latest single-cell mask of each identity, ignoring the font epoch: the stand-in for motion, and for a face that is
     * still loading. Keys are numeric and compared exactly. */
    const standIns = new IdentityIndex<StandIn>();
    // Reused by every lookup and composition: a probe is read at once and never kept, a request is read at once too.
    const probe = newIdentity(), standProbe = newIdentity();
    const request: Writable<MaskRequest> = { epoch: 0, css: '', text: '', rtl: false, loaded: false, a: 0, b: 0, c: 0, d: 0, x: 0, y: 0 };
    const deviceMap = new Float64Array(6);
    const slot: Slot = { entry: null, rgba: false, standIn: false, x: 0, y: 0, w: 0, h: 0 };
    const cell: MaskCell = { x: 0, y: 0, w: 0, h: 0 };
    const build: Build = { count: 0, batches: [], batchCount: 0, pinAtlas: [], pinEntry: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };

    const atlasHost = { reserve: (bytes: number) => host.allocator.gpu.reserve(bytes), release: (lease: ByteLease) => host.allocator.gpu.release(lease) };

    const retireRun = (run: TextRun): void => {
        if (!live.delete(run)) return;
        for (let i = 0; i < run.pinEntries.length; i++) run.pinAtlases[i].unpin(run.pinEntries[i]);
        run.device.destroy(run.buffer);
        host.allocator.gpu.release(run.bufferLease);
    };
    /** The canvas and its memo: freed on release and on governor pressure, and created again by the next raster. */
    const releaseRaster = (): void => {
        raster.release();
        if (rasterLease) { host.allocator.cpu.release(rasterLease); rasterLease = null; }
    };
    /** Every GPU resource of the current device. Runs go first, so their pins drop before the atlases are disposed. */
    const releaseGpu = (): void => {
        incarnation++;
        for (const run of [...live]) retireRun(run);
        const owner = device;
        if (owner) {
            for (const pipeline of pipelines) if (pipeline) owner.destroy(pipeline);
            if (convertPipeline) owner.destroy(convertPipeline);
            if (sampler) owner.destroy(sampler);
            if (white) owner.destroy(white);
            if (convertBuffer) owner.destroy(convertBuffer);
            if (stage) owner.destroy(stage.texture);
        }
        mono?.dispose(); colour?.dispose();
        if (whiteLease) host.allocator.gpu.release(whiteLease);
        if (stage) host.allocator.gpu.release(stage.lease);
        if (convertLease) host.allocator.gpu.release(convertLease);
        // The CPU scratch goes with the device: each is leased again on demand by the next admit.
        if (scratchLease) host.allocator.cpu.release(scratchLease);
        if (uniformLease) host.allocator.cpu.release(uniformLease);
        if (convertScratchLease) host.allocator.cpu.release(convertScratchLease);
        scratch = new Float32Array(0); scratchLease = null;
        uniformData = null; uniformLease = null;
        convertScratch = new Float32Array(0); convertScratchLease = null;
        pipelines = [undefined, undefined, undefined, undefined]; convertPipeline = null;
        pipelinesReady = false; pipelinesPending = false; failed = false;
        mono = null; colour = null; white = null; whiteLease = null; sampler = null;
        clearStageTimer(); stage = null; convertBuffer = null; convertLease = null; convertCapacity = 0; pendingCount = 0; pageRunCount = 0;
        // Stand-in records name the atlases this device just disposed: none may be drawn from again.
        standIns.clear(); standAccount.reset();
        releaseRaster();
        device = null;
    };

    /** Creates the variants and the conversion once per device. Until they land, a run waits: the composer retries on the wake. */
    const ensurePipelines = (owner: GfxDevice): boolean => {
        if (pipelinesReady) return true;
        if (pipelinesPending || failed) return false;
        const serial = incarnation;
        pipelinesPending = true;
        try {
            Promise.all([
                ...VARIANTS.map(variant => owner.createPipeline({ shader: shaderFor(variant), topology: 'triangle-strip',
                    colorFormat: 'rgba8', samples: 1, blend: variant.endsWith('modulate') ? 'modulate' : 'source-over',
                    alphaToCoverage: false, colorWrite: [true, true, true, true], stencil: { enabled: false } })),
                owner.createPipeline({ shader: convertShader(), topology: 'triangle-strip', colorFormat: 'r8', samples: 1,
                    blend: 'replace', alphaToCoverage: false, colorWrite: [true, true, true, true], stencil: { enabled: false } }),
            ]).then(made => {
                if (serial !== incarnation || device !== owner) { for (const pipeline of made) owner.destroy(pipeline); return; }
                for (let i = 0; i < VARIANTS.length; i++) pipelines[i] = made[i];
                convertPipeline = made[VARIANTS.length];
                pipelinesReady = true; pipelinesPending = false; host.invalidate('text-pipelines-ready');
            }, () => {
                if (serial !== incarnation) return;
                pipelinesPending = false; failed = true; host.invalidate('text-pipelines-failed');
            });
        } catch { pipelinesPending = false; failed = true; }
        return false;
    };

    const ensureDeviceObjects = (owner: GfxDevice): Stop | null => {
        if (!mono) mono = new TextAtlas(owner, atlasHost, { format: 'r8', maxPages: MONO_PAGES, surface: audit });
        if (!colour) colour = new TextAtlas(owner, atlasHost, { format: 'rgba8', maxPages: COLOUR_PAGES, surface: audit });
        // Linear, not nearest: an exact quad sits on whole pixels with texel-centre samples, so it reads the same texels either
        // way; a stand-in is scaled, and only linear filtering keeps it smooth.
        if (!sampler) sampler = owner.createSampler('linear');
        if (!white) {
            const lease = host.allocator.gpu.reserve(1);
            if (!lease) return { status: 'denied', pool: 'gpu', bytes: 1 };
            whiteLease = lease;
            white = owner.createTexture(1, 1, 'r8', ['sample', 'copy-dst'], lease);
            owner.writeTexture(white, { x: 0, y: 0, width: 1, height: 1 },
                { source: new Uint8Array([255]), rowBytes: 1, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
        }
        return null;
    };

    const ensureRasterLease = (): boolean => {
        if (rasterLease) return true;
        rasterLease = host.allocator.cpu.reserve(MASK_CANVAS_BYTES);
        return rasterLease !== null;
    };
    const ensureUniformData = (): boolean => {
        if (uniformData) return true;
        uniformLease = host.allocator.cpu.reserve(16);
        if (!uniformLease) return false;
        uniformData = new Float32Array(4);
        return true;
    };
    /** Grows the leased instance scratch to hold `floats`, keeping what this run has written. False when the pool refuses. */
    const reserveScratch = (floats: number): boolean => {
        if (floats <= scratch.length) return true;
        const capacity = Math.max(floats, scratch.length * 2, SCRATCH_FLOOR);
        const lease = host.allocator.cpu.reserve(capacity * 4);
        if (!lease) return false;
        const grown = new Float32Array(capacity);
        grown.set(scratch);
        if (scratchLease) host.allocator.cpu.release(scratchLease);
        scratch = grown; scratchLease = lease;
        return true;
    };
    /** Grows the conversion's buffers to hold `cells` instances. Nothing is copied: a pending cell is read at encode time. False
     * when the pool or the grant refuses, and then nothing is placed: a cell the conversion cannot draw is never in the atlas. */
    const ensureConvertCapacity = (cells: number): boolean => {
        if (cells <= convertCapacity) return true;
        const capacity = Math.max(cells, convertCapacity * 2, CONVERT_FLOOR);
        const bytes = capacity * INSTANCE_BYTES;
        const gpuLease = host.allocator.gpu.reserve(bytes);
        if (!gpuLease) return false;
        const cpuLease = host.allocator.cpu.reserve(capacity * 12 * 4);
        if (!cpuLease) { host.allocator.gpu.release(gpuLease); return false; }
        let buffer: BufferHandle;
        try { buffer = device!.createBuffer(bytes, ['vertex', 'copy-dst'], gpuLease); }
        catch (error) { host.allocator.gpu.release(gpuLease); host.allocator.cpu.release(cpuLease); throw error; }
        if (convertBuffer) device!.destroy(convertBuffer);
        if (convertLease) host.allocator.gpu.release(convertLease);
        if (convertScratchLease) host.allocator.cpu.release(convertScratchLease);
        convertBuffer = buffer; convertLease = gpuLease; convertCapacity = capacity;
        convertScratch = new Float32Array(capacity * 12); convertScratchLease = cpuLease;
        return true;
    };
    /** Makes the staging texture `height` rows tall. Nothing may be pending in the old one: its cells would be lost. False when the grant
     * refuses it. */
    const createStage = (owner: GfxDevice, height: number): boolean => {
        const lease = host.allocator.gpu.reserve(STAGE_WIDTH * height * 4);
        if (!lease) return false;
        let texture: TextureHandle;
        try { texture = owner.createTexture(STAGE_WIDTH, height, 'rgba8', ['sample', 'copy-dst'], lease); }
        catch (error) { host.allocator.gpu.release(lease); throw error; }
        stage = { texture, lease, packer: new ShelfPacker(STAGE_WIDTH, height), height };
        armStageIdle();
        return true;
    };
    const clearStageTimer = (): void => {
        if (stageTimer !== null) clearTimeout(stageTimer);
        stageTimer = null;
    };
    const releaseStage = (): void => {
        if (!stage) return;
        clearStageTimer();
        device!.destroy(stage.texture);
        host.allocator.gpu.release(stage.lease);
        stage = null;
    };
    /** Arms the idle release: after STAGE_IDLE_MS with no conversion pending, the texture is destroyed from the timer. */
    const armStageIdle = (): void => {
        clearStageTimer();
        stageTimer = setTimeout(() => {
            stageTimer = null;
            // A cell admitted since the timer was armed is still pending: its conversion ends the idle period, so nothing is freed.
            if (pendingCount === 0) releaseStage();
        }, STAGE_IDLE_MS);
    };
    /** A place in the staging texture for a w × h cell. Null when this frame's cells fill it (the run waits for the conversion); 'denied'
     * when the grant refuses the texture. The texture doubles only when nothing is pending, so the frame's cells are never copied. */
    const stageSpot = (w: number, h: number): { x: number; y: number } | null | 'denied' => {
        if (!stage && !createStage(device!, STAGE_MIN_HEIGHT)) return 'denied';
        // With nothing pending no staged bitmap still needs its place. A spot a refused cell took and never filled is leaked until
        // a conversion resets the packer, and no conversion runs with nothing pending: so the shelves are reset here.
        if (pendingCount === 0) stage!.packer.reset();
        const spot = stage!.packer.place(w, h);
        if (spot) return spot;
        if (pendingCount > 0) return null;
        let height = stage!.height;
        while (height < STAGE_MAX_HEIGHT && height < h) height = Math.min(STAGE_MAX_HEIGHT, height * 2);
        while (height < STAGE_MAX_HEIGHT && height <= stage!.height) height = Math.min(STAGE_MAX_HEIGHT, height * 2);
        if (height <= stage!.height || height < h) return null;
        releaseStage();
        if (!createStage(device!, height)) return 'denied';
        return stage!.packer.place(w, h);
    };

    const WHITE: Rgba = [1, 1, 1, 1];

    /** One instance: its device rect, page uv rect and premultiplied colour, appended to the run in paint order. */
    const put = (mode: Mode, texture: TextureHandle, x: number, y: number, w: number, h: number,
        u0: number, v0: number, u1: number, v1: number, c: Rgba): boolean => {
        if (!reserveScratch((build.count + 1) * 12)) return false;
        const o = build.count * 12;
        scratch[o] = x; scratch[o + 1] = y; scratch[o + 2] = w; scratch[o + 3] = h;
        scratch[o + 4] = u0; scratch[o + 5] = v0; scratch[o + 6] = u1; scratch[o + 7] = v1;
        scratch[o + 8] = c[0] * c[3]; scratch[o + 9] = c[1] * c[3]; scratch[o + 10] = c[2] * c[3]; scratch[o + 11] = c[3];
        build.count++;
        const last = build.batchCount > 0 ? build.batches[build.batchCount - 1] : undefined;
        if (last && last.mode === mode && last.texture === texture) { last.count++; return true; }
        let next = build.batches[build.batchCount];
        if (next) { next.mode = mode; next.texture = texture; next.first = build.count - 1; next.count = 1; }
        else { next = { mode, texture, first: build.count - 1, count: 1 }; build.batches.push(next); }
        build.batchCount++;
        return true;
    };
    /** Grows the run's device bounds, which become its scissor. */
    const widen = (x0: number, y0: number, x1: number, y1: number): void => {
        build.x0 = Math.min(build.x0, x0); build.y0 = Math.min(build.y0, y0);
        build.x1 = Math.max(build.x1, x1); build.y1 = Math.max(build.y1, y1);
    };
    const denied = (): Stop => ({ status: 'denied', pool: 'cpu', bytes: (build.count + 1) * INSTANCE_BYTES });

    /** A solid rect in device px: analytic coverage in the shader, so its edges match the canvas's fill. False only on refusal. */
    const solidRect = (x0: number, y0: number, x1: number, y1: number, colourOf: Rgba, viewW: number, viewH: number): boolean => {
        if (!(x1 > x0 && y1 > y0) || x1 <= 0 || y1 <= 0 || x0 >= viewW || y0 >= viewH) return true;
        if (!put('mono', white!, x0, y0, x1 - x0, y1 - y0, SOLID_UV, SOLID_UV, SOLID_UV, SOLID_UV, colourOf)) return false;
        widen(x0, y0, x1, y1);
        return true;
    };

    /** A rect under a map with rotation or skew: the device parallelogram, one instance. Its shader supersamples the coverage
     * (the canvas fill's antialiasing), so a rotated node's backgrounds and underlines stay on the GPU. False only on refusal. */
    const parallelogram = (r: { x: number; y: number; w: number; h: number }, A: ArrayLike<number>, colourOf: Rgba, viewW: number, viewH: number): boolean => {
        // A negative extent fills the same rect as its positive one, so the origin moves to the low corner first.
        const rx = r.w < 0 ? r.x + r.w : r.x, rw = Math.abs(r.w);
        const ry = r.h < 0 ? r.y + r.h : r.y, rh = Math.abs(r.h);
        if (!(rw > 0 && rh > 0)) return true;
        const ox = A[0] * rx + A[2] * ry + A[4], oy = A[1] * rx + A[3] * ry + A[5];
        const e1x = A[0] * rw, e1y = A[1] * rw, e2x = A[2] * rh, e2y = A[3] * rh;
        const x0 = Math.min(ox, ox + e1x, ox + e2x, ox + e1x + e2x), x1 = Math.max(ox, ox + e1x, ox + e2x, ox + e1x + e2x);
        const y0 = Math.min(oy, oy + e1y, oy + e2y, oy + e1y + e2y), y1 = Math.max(oy, oy + e1y, oy + e2y, oy + e1y + e2y);
        if (x1 <= 0 || y1 <= 0 || x0 >= viewW || y0 >= viewH) return true;
        if (!put('mono', white!, ox, oy, e1x, e1y, PARALLELOGRAM_UV, e2x, e2y, 0, colourOf)) return false;
        widen(x0, y0, x1, y1);
        return true;
    };

    /** Rects of one item: the backgrounds before its glyphs, the decorations after. Axis-aligned maps are analytic solids;
     * rotated or skewed ones are parallelograms. */
    const rects = (list: readonly { x: number; y: number; w: number; h: number }[], colours: readonly Rgba[],
        A: ArrayLike<number>, viewW: number, viewH: number): Stop | null => {
        for (let i = 0; i < list.length; i++) {
            const colourOf = colours[i];
            if (!colourOf) return { status: 'unsupported', why: 'material' };
            const r = list[i];
            if (A[1] !== 0 || A[2] !== 0) {
                if (!parallelogram(r, A, colourOf, viewW, viewH)) return denied();
                continue;
            }
            const xa = A[0] * r.x + A[4], xb = A[0] * (r.x + r.w) + A[4];
            const ya = A[3] * r.y + A[5], yb = A[3] * (r.y + r.h) + A[5];
            if (!solidRect(Math.min(xa, xb), Math.min(ya, yb), Math.max(xa, xb), Math.max(ya, yb), colourOf, viewW, viewH)) return denied();
        }
        return null;
    };

    /** The scale of a glyph run's device map: its square root of |det|, so a uniform zoom is exactly its ratio. */
    const scaleOf = (req: MaskRequest): number => Math.sqrt(Math.abs(req.a * req.d - req.b * req.c));
    /** Fills `standProbe` with a stand-in identity: the same glyphs at any size, any epoch and any fraction. Null for a rotated map,
     * which has no stand-in: an axis-aligned quad of its mask would be wrong. */
    const standProbeOf = (req: MaskRequest, label: string, colourOf: Rgba | null): MaskIdentity | null => {
        if (req.b !== 0 || req.c !== 0 || req.a === 0 || req.d === 0) return null;
        fillIdentity(standProbe, req, 0, colourOf);
        standProbe.epoch = -1; standProbe.css = label;
        standProbe.a = Math.sign(req.a); standProbe.b = 0; standProbe.c = 0; standProbe.d = Math.sign(req.d);
        standProbe.fracX = 0; standProbe.fracY = 0;
        return standProbe;
    };
    /** Records a single-cell mask as the stand-in for its glyphs. A multi-cell mask is not one: its cells differ in scale. */
    const recordStandIn = (req: MaskRequest, label: string, colourOf: Rgba | null, atlas: TextAtlas, entry: AtlasEntry, cells: number, geometry: MaskGeometry): void => {
        if (cells !== 1) return;
        const key = standProbeOf(req, label, colourOf);
        if (!key) return;
        const existing = standIns.find(key);
        // A replaced record keeps the charge it already holds: the same identity holds the same bytes, so none is taken again.
        if (existing) standIns.delete(existing);
        else {
            if (standIns.size >= STANDIN_LIMIT) { standIns.clear(); standAccount.reset(); }
            // A record the pool will not charge is not kept, as the measure memo does: its cell is simply not a stand-in.
            if (!standAccount.charge(MEMO_ENTRY_BYTES + 2 * (key.css.length + key.text.length))) return;
        }
        const identity = copyIdentity(key);
        standIns.add({ identity, hash: identityHash(identity), atlas, entry, scale: scaleOf(req),
            originX: geometry.originX, originY: geometry.originY, w: geometry.w, h: geometry.h });
    };
    /** One stand-in candidate: the record for these glyphs, if its atlas still holds it, scaled to the request. Writes the slot. */
    const tryStandIn = (req: MaskRequest, label: string, colourOf: Rgba | null, anyRatio: boolean): boolean => {
        const key = standProbeOf(req, label, colourOf);
        if (!key) return false;
        const record = standIns.find(key);
        if (!record || !record.atlas.holds(record.entry)) return false;
        const ratio = scaleOf(req) / record.scale;
        // Motion may stretch a stand-in at most 2x either way; a face that is still loading takes any size, for the moment it is needed.
        if (!anyRatio && !(ratio >= 0.5 && ratio <= 2)) return false;
        auditCount(audit, 'text:standin');
        slot.entry = record.entry; slot.rgba = record.atlas === colour; slot.standIn = true;
        slot.x = req.x - ratio * record.originX; slot.y = req.y - ratio * record.originY;
        slot.w = ratio * record.w; slot.h = ratio * record.h;
        return true;
    };
    /** A stand-in of these glyphs. A run that cannot draw colour glyphs looks in the mono atlas first. */
    const standInFor = (req: MaskRequest, label: string, colourOf: Rgba, emoji: boolean, anyRatio: boolean): boolean => {
        if (!emoji && tryStandIn(req, label, null, anyRatio)) return true;
        return tryStandIn(req, label, colourOf, anyRatio);
    };

    /** A colour cell: the bitmap from the raster goes straight into the RGBA page, with no readback. The bitmap is closed here. */
    const rasterColour = (req: MaskRequest, geometry: MaskGeometry, cellIndex: number, colourOf: Rgba, frame: number, budget: FrameBudget, label: string): Stop | null => {
        const at = sliceCell(geometry, cellIndex, cell);
        const bytes = at.w * at.h * 4;
        if (!budget.claimUpload(bytes)) return { status: 'deferred' };
        // Rastered before it is placed: an entry the atlas holds must already have its texels, or a later draw would read nothing.
        const made = raster.rasteriseBitmap(req, geometry, cellIndex, colourOf);
        let placed: AtlasEntry | 'oversize' | 'denied';
        try {
            placed = colour!.place(fillIdentity(probe, req, cellIndex, colourOf), at.w, at.h, frame);
            if (placed === 'oversize') return { status: 'unsupported', why: 'oversize' };
            if (placed === 'denied') return { status: 'denied', pool: 'gpu', bytes };
            colour!.uploadBitmap(placed, made.bitmap);
        } finally { made.bitmap.close(); }
        auditCount(audit, 'text:mask-raster', 1, { px: at.w * at.h });
        auditCount(audit, 'upload:mask', 1, { bytes });
        recordStandIn(req, label, colourOf, colour!, placed, geometry.slices, geometry);
        slot.entry = placed; slot.rgba = true; slot.standIn = false;
        return null;
    };

    /** A mono cell: its bitmap is written into the staging texture, and the conversion puts its alpha into the R8 page at the end
     * of the frame. The page entry is placed now, so the frame's draws see it once the conversion has been encoded. */
    const stageMono = (req: MaskRequest, label: string, geometry: MaskGeometry, cellIndex: number, frame: number, budget: FrameBudget): Stop | null => {
        const at = sliceCell(geometry, cellIndex, cell);
        const bytes = at.w * at.h * 4;
        if (!budget.claimUpload(bytes)) return { status: 'deferred' };
        const spot = stageSpot(at.w, at.h);
        if (spot === 'denied') return { status: 'denied', pool: 'gpu', bytes };
        // A full staging texture is the frame's limit: the run waits for the next frame, which starts with the staging reset.
        if (!spot) { host.invalidate('text-stage-full'); return { status: 'deferred' }; }
        const staged = stage!;
        if (!ensureConvertCapacity(pendingCount + 1)) return { status: 'denied', pool: 'gpu', bytes };
        const made = raster.rasteriseBitmap(req, geometry, cellIndex, null);
        try {
            const placed = mono!.place(fillIdentity(probe, req, cellIndex, null), at.w, at.h, frame);
            if (placed === 'oversize') return { status: 'unsupported', why: 'oversize' };
            if (placed === 'denied') return { status: 'denied', pool: 'gpu', bytes: at.w * at.h };
            device!.writeTexture(staged.texture, { x: spot.x, y: spot.y, width: at.w, height: at.h },
                { source: made.bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
            let next = pending[pendingCount];
            if (next) { next.entry = placed; next.x = spot.x; next.y = spot.y; }
            else { next = { entry: placed, x: spot.x, y: spot.y }; pending.push(next); }
            pendingCount++;
            auditCount(audit, 'text:mask-raster', 1, { px: at.w * at.h });
            auditCount(audit, 'upload:mask', 1, { bytes });
            recordStandIn(req, label, null, mono!, placed, geometry.slices, geometry);
            slot.entry = placed; slot.rgba = false; slot.standIn = false;
            return null;
        } finally { made.bitmap.close(); }
    };

    /** One cell of a glyph mask: the exact hit, a stand-in during motion, or the raster and its upload. Writes the slot;
     * null when the slot is filled, a stop otherwise. A run whose text may draw colour glyphs is rastered in its ink colour;
     * every other run is coverage, decided from its text alone (needsColourMask), so no cell is read back to find out. */
    const cellEntry = (req: MaskRequest, label: string, geometry: MaskGeometry, cellIndex: number, colourOf: Rgba,
        frame: number, budget: FrameBudget, moving: boolean): Stop | null => {
        const emoji = needsColourMask(req.text);
        const exact = (emoji ? colour! : mono!).lookup(fillIdentity(probe, req, cellIndex, emoji ? colourOf : null), frame);
        if (exact) { slot.entry = exact; slot.rgba = emoji; slot.standIn = false; return null; }
        // Motion draws what exists: a missing exact cell is a stand-in, not a raster, until the view settles.
        if (moving && geometry.slices === 1 && standInFor(req, label, colourOf, emoji, false)) return null;
        if (budget.shouldYield()) return { status: 'deferred' };
        if (!ensureRasterLease()) return { status: 'denied', pool: 'cpu', bytes: MASK_CANVAS_BYTES };
        return emoji ? rasterColour(req, geometry, cellIndex, colourOf, frame, budget, label)
            : stageMono(req, label, geometry, cellIndex, frame, budget);
    };

    /** Draws the slot's cell as one quad, unless it lies outside the view. The pin is recorded for the run to take at admission. */
    const drawSlot = (colourOf: Rgba, viewW: number, viewH: number): Stop | null => {
        const e = slot.entry!;
        const x = slot.x, y = slot.y, w = slot.w, h = slot.h;
        if (x + w <= 0 || y + h <= 0 || x >= viewW || y >= viewH) return null;
        const u0 = e.x / ATLAS_PAGE, v0 = 1 - e.y / ATLAS_PAGE, u1 = (e.x + e.w) / ATLAS_PAGE, v1 = 1 - (e.y + e.h) / ATLAS_PAGE;
        // A colour run is tinted by nothing: its own colour is in the texels, so the instance carries white.
        if (!put(slot.rgba ? 'colour' : 'mono', e.page.texture, x, y, w, h, u0, v0, u1, v1, slot.rgba ? WHITE : colourOf)) return denied();
        widen(x, y, x + w, y + h);
        build.pinAtlas.push(slot.rgba ? colour! : mono!);
        build.pinEntry.push(e);
        return null;
    };

    /** A glyph fragment: each of its mask cells is one quad at the origin's whole pixel plus the cell's offset. A fragment whose
     * face is not loaded is never measured or rastered: it draws the stand-in of its glyphs if one exists, else the run waits. */
    const glyphs = (item: PaintTextItem, map: ArrayLike<number>, frame: number, viewW: number, viewH: number, budget: FrameBudget, moving: boolean): Stop | null => {
        let glyph = 0;
        for (const line of item.paint.lines) for (const fragment of line.fragments) {
            const colourOf = item.material.glyphs[glyph++];
            if (!colourOf) return { status: 'unsupported', why: 'material' };
            const face = item.faces.faces[fragment.face];
            if (!face) return { status: 'unsupported', why: 'face' };
            if (!fragment.text || !(face.size > 0)) continue;
            // The glyph's space: 64 px font units, scaled by size/64, then the item's device map (paint2d's translate · scale).
            const k = face.size / 64;
            const req = request;
            req.epoch = item.paint.fontEpoch; req.css = face.css; req.text = fragment.text; req.rtl = fragment.rtl; req.loaded = face.loaded;
            req.a = map[0] * k; req.b = map[1] * k; req.c = map[2] * k; req.d = map[3] * k;
            req.x = map[0] * fragment.x + map[2] * line.baseline + map[4];
            req.y = map[1] * fragment.x + map[3] * line.baseline + map[5];
            const label = faceLabel(face.key);
            const measured = raster.measure(req);
            if (measured.status === 'deferred') {
                // The face is still loading: its glyphs are not rastered in the fallback face. An earlier mask of them draws for
                // now; with none, the run waits, and the load's font epoch rebuilds the paint.
                if (!standInFor(req, label, colourOf, needsColourMask(req.text), true)) return { status: 'deferred' };
                const drawn = drawSlot(colourOf, viewW, viewH);
                if (drawn) return drawn;
                continue;
            }
            if (measured.status === 'empty') continue;
            if (measured.status !== 'ok') return { status: 'unsupported', why: measured.status === 'oversize' ? 'oversize' : measured.why };
            const geometry = measured.geometry;
            // A mask is a grid of cells, row-major; a one-cell mask is the whole mask.
            for (let cellIndex = 0; cellIndex < geometry.slices; cellIndex++) {
                const stop = cellEntry(req, label, geometry, cellIndex, colourOf, frame, budget, moving);
                if (stop) return stop;
                if (!slot.standIn) {
                    const at = sliceCell(geometry, cellIndex, cell);
                    slot.x = Math.floor(req.x) + geometry.left + at.x; slot.y = Math.floor(req.y) + geometry.top + at.y;
                    slot.w = at.w; slot.h = at.h;
                }
                const drawn = drawSlot(colourOf, viewW, viewH);
                if (drawn) return drawn;
            }
        }
        return null;
    };

    const item = (it: PaintTextItem, frame: number, viewW: number, viewH: number, scale: number, view: { camera: { x: number; y: number }; moving: boolean }, budget: FrameBudget): Stop | null => {
        // Routes never clip: the composer applies the item's clips around whatever this draws.
        const [a, b, c, d, e, f] = it.localToWorld;
        // The item's device map: its local-to-world, then the view's camera and pixel scale (deviceAffine without the origin rebase).
        const map = deviceMap;
        map[0] = scale * a; map[1] = scale * b; map[2] = scale * c; map[3] = scale * d;
        map[4] = scale * (e - view.camera.x); map[5] = scale * (f - view.camera.y);
        return rects(it.paint.backgrounds, it.material.backgrounds, map, viewW, viewH)
            ?? glyphs(it, map, frame, viewW, viewH, budget, view.moving)
            ?? rects(it.paint.decorations, it.material.decorations, map, viewW, viewH);
    };

    /** The page's run in this frame's conversion, found or added. The runs are few (a page each), so a scan is the cheap form. */
    const runOf = (page: AtlasPage): PageRun | null => {
        for (let r = 0; r < pageRunCount; r++) if (pageRuns[r].page === page) return pageRuns[r];
        return null;
    };
    const addRun = (page: AtlasPage): PageRun => {
        let run = pageRuns[pageRunCount];
        if (run) { run.page = page; run.first = 0; run.count = 0; run.fill = 0; }
        else { run = { page, first: 0, count: 0, fill: 0 }; pageRuns.push(run); }
        pageRunCount++;
        return run;
    };

    return {
        id: 'text',
        accepts(candidate: PaintItem): candidate is PaintTextItem { return candidate.kind === 'text'; },
        admit(items, view, blend, budget): Admission<PreparedRun> {
            const owner = host.device();
            if (owner !== device) { releaseGpu(); device = owner; }
            if (!owner) return { status: 'unsupported', why: 'no-device' };
            if (failed) return { status: 'unsupported', why: 'pipeline' };
            if (!ensurePipelines(owner)) return { status: 'deferred' };
            const objects = ensureDeviceObjects(owner);
            if (objects) return objects;
            const dpr = view.viewport.dpr;
            const viewW = Math.round(view.viewport.width * dpr), viewH = Math.round(view.viewport.height * dpr);
            const scale = view.camera.z * dpr;
            if (!ensureUniformData()) return { status: 'denied', pool: 'cpu', bytes: 16 };
            build.count = 0; build.batchCount = 0;
            build.pinAtlas.length = 0; build.pinEntry.length = 0;
            build.x0 = Infinity; build.y0 = Infinity; build.x1 = -Infinity; build.y1 = -Infinity;
            const frame = budget.frameId;
            for (const it of items) {
                const stop = item(it, frame, viewW, viewH, scale, view, budget);
                if (stop) return stop;
            }
            if (build.count === 0) return { status: 'empty' };
            const x0 = Math.max(0, Math.floor(build.x0)), y0 = Math.max(0, Math.floor(build.y0));
            const x1 = Math.min(viewW, Math.ceil(build.x1)), y1 = Math.min(viewH, Math.ceil(build.y1));
            if (x1 <= x0 || y1 <= y0) return { status: 'empty' };
            const bytes = build.count * INSTANCE_BYTES;
            if (!budget.claimUpload(bytes)) return { status: 'deferred' };
            const lease = host.allocator.gpu.reserve(bytes);
            if (!lease) return { status: 'denied', pool: 'gpu', bytes };
            let buffer: BufferHandle | null = null;
            try {
                buffer = owner.createBuffer(bytes, ['vertex', 'copy-dst'], lease);
                owner.writeBuffer(buffer, 0, scratch.subarray(0, build.count * 12));
                auditCount(audit, 'upload:vertex', 1, { bytes });
                auditCount(audit, 'geom:build');
            } catch (error) {
                if (buffer) owner.destroy(buffer);
                host.allocator.gpu.release(lease);
                throw error;
            }
            // The run keeps its own batches, commands and pins: the build's objects are reused by the next composition.
            if (!sampler) throw new Error('Text sampler missing');
            const scissor: RectI = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
            const batches: Batch[] = new Array<Batch>(build.batchCount);
            for (let i = 0; i < build.batchCount; i++) {
                const b = build.batches[i];
                const pipeline = pipelines[pipelineIndex(b.mode, blend)];
                if (!pipeline) throw new Error('Text pipeline missing');
                // The uniform slice is the frame's, written at each draw; the placeholder is never submitted.
                const uniform = { binding: 0, slice: NO_UNIFORM };
                const command: DrawCommand = { pipeline, bindings: { uniforms: [uniform],
                    textures: [{ binding: 0, texture: b.texture, sampler }] },
                    vertices: [{ buffer, offset: b.first * INSTANCE_BYTES, bytes: b.count * INSTANCE_BYTES }],
                    first: 0, count: 4, instances: b.count, scissor };
                batches[i] = { mode: b.mode, texture: b.texture, first: b.first, count: b.count, pipeline, uniform, command };
            }
            const pinAtlases = build.pinAtlas.slice(), pinEntries = build.pinEntry.slice();
            for (let i = 0; i < pinEntries.length; i++) pinAtlases[i].pin(pinEntries[i]);
            const run: TextRun = { route: 'text', blend, device: owner, buffer, bufferLease: lease,
                batches, pinAtlases, pinEntries, viewW, viewH, scissor, bytes };
            live.add(run);
            auditCount(audit, 'route:text');
            return { status: 'ready', value: run };
        },
        draw(pass: GpuPass, prepared: PreparedRun): void {
            const run = prepared as TextRun;
            if (!live.has(run) || device !== run.device || host.device() !== run.device) throw new Error('Stale text run');
            // The uniform block is packed into the encoder's ring at this call, so one leased scratch serves every run.
            const data = uniformData!;
            data[0] = run.viewW; data[1] = run.viewH; data[2] = 0; data[3] = 0;
            const uniforms = host.uniforms(data);
            for (const batch of run.batches) {
                batch.uniform.slice = uniforms;
                pass.draw(batch.command);
            }
        },
        encodeOffscreen(passes: OffscreenPasses): void {
            if (pendingCount === 0) return;
            clearStageTimer();
            const owner = device, staged = stage, pipeline = convertPipeline;
            if (!owner || !staged || !pipeline || !convertBuffer || !sampler || !mono) throw new Error('Text conversion without its objects');
            // Gather this frame's live cells per page, in page order, into the conversion buffer: one instance range per page.
            pageRunCount = 0;
            for (let i = 0; i < pendingCount; i++) {
                const p = pending[i];
                if (!mono.holds(p.entry)) continue;
                (runOf(p.entry.page) ?? addRun(p.entry.page)).count++;
            }
            let total = 0;
            for (let r = 0; r < pageRunCount; r++) { pageRuns[r].first = total; total += pageRuns[r].count; }
            for (let i = 0; i < pendingCount; i++) {
                const p = pending[i];
                if (!mono.holds(p.entry)) continue;
                const run = runOf(p.entry.page)!;
                const o = (run.first + run.fill) * 12;
                run.fill++;
                const e = p.entry;
                convertScratch[o] = e.x; convertScratch[o + 1] = e.y; convertScratch[o + 2] = e.w; convertScratch[o + 3] = e.h;
                convertScratch[o + 4] = p.x / ATLAS_PAGE; convertScratch[o + 5] = 1 - p.y / staged.height;
                convertScratch[o + 6] = (p.x + e.w) / ATLAS_PAGE; convertScratch[o + 7] = 1 - (p.y + e.h) / staged.height;
                convertScratch[o + 8] = 0; convertScratch[o + 9] = 0; convertScratch[o + 10] = 0; convertScratch[o + 11] = 0;
            }
            if (total > 0) owner.writeBuffer(convertBuffer, 0, convertScratch.subarray(0, total * 12));
            // One pass per R8 page that has cells this frame. Each pass loads the page (its other texels stay), and draws its cells.
            for (let r = 0; r < pageRunCount; r++) {
                const run = pageRuns[r];
                if (run.count === 0) continue;
                const target = run.page.target;
                if (!target) throw new Error('R8 text page without a conversion target');
                const viewport = { x: 0, y: 0, width: ATLAS_PAGE, height: ATLAS_PAGE };
                const gpuPass = passes.begin(target, viewport, { clear: null, stencil: false });
                gpuPass.draw({ pipeline, bindings: { uniforms: [], textures: [{ binding: 0, texture: staged.texture, sampler }] },
                    vertices: [{ buffer: convertBuffer, offset: run.first * INSTANCE_BYTES, bytes: run.count * INSTANCE_BYTES }],
                    first: 0, count: 4, instances: run.count, scissor: viewport });
                gpuPass.end();
            }
            // The staging texture is free again: its cells are on their pages. Its shelves reset, and so does the pending list.
            staged.packer.reset();
            pendingCount = 0; pageRunCount = 0;
            armStageIdle();
        },
        retire(prepared: PreparedRun): void { retireRun(prepared as TextRun); },
        release(): void { releaseGpu(); },
        evictTextures(bytes: number, frameId: number): number {
            // The staging texture goes first, and only when no conversion is pending in it: nothing it holds is drawn in this frame.
            const freedStage = stage && pendingCount === 0 && bytes > 0 ? stage.lease.bytes : 0;
            if (freedStage > 0) releaseStage();
            // Mono pages next: they hold most of the bytes. A page pinned or drawn this frame is never freed.
            const left = Math.max(0, bytes - freedStage);
            const freedMono = mono?.evict(left, frameId) ?? 0;
            const freed = freedStage + freedMono + (colour?.evict(Math.max(0, left - freedMono), frameId) ?? 0);
            // Under pressure the canvas goes too: it is the route's largest CPU holding, and the next raster creates it again.
            if (freed > 0) releaseRaster();
            return freed;
        },
        memory(): { gpuBytes: number; cpuBytes: number } {
            let gpuBytes = (mono?.bytes ?? 0) + (colour?.bytes ?? 0) + (whiteLease?.bytes ?? 0) + (stage?.lease.bytes ?? 0) + (convertLease?.bytes ?? 0);
            for (const run of live) gpuBytes += run.bytes;
            const cpuBytes = (rasterLease?.bytes ?? 0) + (scratchLease?.bytes ?? 0) + (uniformLease?.bytes ?? 0) +
                (convertScratchLease?.bytes ?? 0) + memoAccount.bytes + standAccount.bytes;
            return { gpuBytes, cpuBytes };
        },
    };
};
