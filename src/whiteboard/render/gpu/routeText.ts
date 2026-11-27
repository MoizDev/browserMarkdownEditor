import type { Rgba } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { BufferHandle, ByteLease, DrawCommand, GfxDevice, GpuPass, PipelineHandle, RectI, SamplerHandle, ShaderModule, TextureHandle, UniformSlice } from '../../../platform/render/gfx/api';
import type { FrameBudget, OffscreenPasses } from '../../../platform/render/types';
import { auditCount } from '../../../platform/render/renderAudit';
import { isTileView } from '../../../platform/render/tileTarget';
import type { FontKey } from '../../text/fonts';
import { RENDER_CONSTANTS } from '../../../platform/render/constants';
import type { PaintItem, PaintTextItem } from '../paintStream';
import { ATLAS_PAGE, IdentityIndex, ShelfPacker, TextAtlas, type AtlasEntry, type AtlasPage, type Indexed } from '../textAtlas';
import { MEMO_ENTRY_BYTES, copyIdentity, createCpuAccount, createMaskRaster, fillIdentity, identityHash, needsColourMask,
    newIdentity, sliceCell, type CpuAccount, type MaskCell, type MaskGeometry, type MaskIdentity, type MaskRaster, type MaskRequest } from './textMasks';
import type { Admission, Blend, CreateTextRoute, ItemRoute, PreparedRun } from './contracts';

export interface TextRoute extends ItemRoute<PaintTextItem> {
    evictTextures(bytes: number, frameId: number): number;
    encodeOffscreen(passes: OffscreenPasses): void;
    setZoom(zooming: boolean): void;
    exact(prepared: PreparedRun): boolean;
}

const INSTANCE_BYTES = 48;
function refused(pool: 'gpu' | 'cpu', bytes: number): Stop {
    const floor = pool === 'gpu' ? RENDER_CONSTANTS.gpuGrantMinBytes : RENDER_CONSTANTS.cpuGrantMinBytes;
    return bytes > floor ? { status: 'unsupported', why: 'oversize' } : { status: 'denied', pool, bytes };
}
const NO_UNIFORM: UniformSlice = { buffer: null as unknown as BufferHandle, offset: 0, bytes: 0 };
const SOLID_UV = -1;
const PARALLELOGRAM_UV = -2;
const MONO_PAGES = 8, COLOUR_PAGES = 2;
const STANDIN_LIMIT = 4096;
const MEMO_CHUNK = 64 * 1024;
const SCRATCH_FLOOR = 12 * 64;
const CONVERT_FLOOR = 64;
const STAGE_WIDTH = ATLAS_PAGE, STAGE_MIN_HEIGHT = ATLAS_PAGE / 8, STAGE_MAX_HEIGHT = ATLAS_PAGE;
const STAGE_IDLE_MS = 5000;

const ATTRIBUTES: ShaderModule['layout']['attributes'] = [
    { location: 0, bufferSlot: 0, offset: 0, stride: INSTANCE_BYTES, format: 'float32x4', step: 'instance' },
    { location: 1, bufferSlot: 0, offset: 16, stride: INSTANCE_BYTES, format: 'float32x4', step: 'instance' },
    { location: 2, bufferSlot: 0, offset: 32, stride: INSTANCE_BYTES, format: 'float32x4', step: 'instance' },
];

const VERTEX = `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 { vec4 viewport; vec4 transform; };
layout(location=0) in vec4 rect;
layout(location=1) in vec4 uvRect;
layout(location=2) in vec4 instanceColour;
out vec2 pixel; out vec2 uv;
flat out vec4 edges; flat out vec4 colour; flat out float shape;
flat out vec2 origin; flat out vec2 axisU; flat out vec2 axisV;
void main() {
    // transform: the run's device space to this frame's, x the scale ratio and yz the offset (identity for a tile or a fresh run).
    // A parallelogram's second edge (uv.yz when uv.x = -2) scales with it; texture coordinates do not.
    vec4 instanceRect = vec4(rect.xy * transform.x + transform.yz, rect.zw * transform.x);
    vec4 instanceUv = vec4(uvRect.x, uvRect.yz * mix(1.0, transform.x, step(uvRect.x, -1.5)), uvRect.w);
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
const BODY: Record<'mono-over' | 'mono-modulate' | 'colour-over' | 'colour-modulate', string> = {
    'mono-over': `${COVERAGE}
void main() { gfxColour = colour * coverage(); }`,
    'mono-modulate': `${COVERAGE}
void main() { float m = coverage(); gfxColour = vec4(vec3(1.0) - m * colour.a + m * colour.rgb, 1.0); }`,
    'colour-over': `void main() { gfxColour = textureLod(gfxTexture0, uv, 0.0); }`,
    'colour-modulate': `void main() { vec4 t = textureLod(gfxTexture0, uv, 0.0); gfxColour = vec4(vec3(1.0) - t.a + t.rgb, 1.0); }`,
};

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
const VARIANTS: readonly Variant[] = ['mono-over', 'mono-modulate', 'colour-over', 'colour-modulate'];
function pipelineIndex(mode: Mode, blend: Blend): number { return (mode === 'mono' ? 0 : 2) + (blend === 'modulate' ? 1 : 0); }

function shaderFor(variant: Variant): ShaderModule {
    const mode = variant.startsWith('mono') ? 'mono' : 'colour';
    return { id: `board-text-${variant}`, revision: 1,
        layout: { uniforms: [{ binding: 0, byteSize: 32 }], textures: [{ binding: 0, format: mode === 'mono' ? 'r8' : 'rgba8' }], attributes: ATTRIBUTES },
        glsl: { vertex: VERTEX, fragment: HEADER + BODY[variant] } };
}
function convertShader(): ShaderModule {
    return { id: 'board-text-convert', revision: 1,
        layout: { uniforms: [], textures: [{ binding: 0, format: 'rgba8' }], attributes: ATTRIBUTES.slice(0, 2) },
        glsl: { vertex: CONVERT_VERTEX, fragment: CONVERT_FRAGMENT } };
}

const FAMILY_INDEX: Record<FontKey['family'], number> = { draw: 0, sans: 1, serif: 2, mono: 3 };
const FACE_LABELS: readonly string[] = Array.from({ length: 16 }, (_, i) => `face-${i}`);
function faceLabel(key: FontKey): string {
    return FACE_LABELS[FAMILY_INDEX[key.family] * 4 + (key.bold ? 2 : 0) + (key.italic ? 1 : 0)];
}

interface Batch { readonly mode: Mode; readonly texture: TextureHandle; readonly first: number; readonly count: number; readonly pipeline: PipelineHandle;
    readonly uniform: { binding: number; slice: UniformSlice }; readonly command: DrawCommand }
interface BuildBatch { mode: Mode; texture: TextureHandle; first: number; count: number }
interface StandIn extends Indexed { readonly atlas: TextAtlas; readonly entry: AtlasEntry; readonly scale: number; readonly originX: number; readonly originY: number; readonly w: number; readonly h: number }
interface Slot { entry: AtlasEntry | null; rgba: boolean; standIn: boolean; x: number; y: number; w: number; h: number }
interface PendingCell { entry: AtlasEntry; x: number; y: number }
interface PageRun { page: AtlasPage; first: number; count: number; fill: number; sample: AtlasEntry | null }
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
    readonly inexact: boolean;
    readonly liveItem: PaintTextItem | null;
    readonly refX: number; readonly refY: number; readonly refScale: number;
    readonly cull: RectI;
    readonly bounds: RectI;
    refs: number; used: number;
    curW: number; curH: number; k: number; ox: number; oy: number;
}
const LIVE_REUSE_MIN = 2 ** -0.5, LIVE_REUSE_MAX = 2 ** 0.5;
const LIVE_KEEP_MS = 100;
type Stop = Exclude<Admission<PreparedRun>, { status: 'ready' }>;
interface Build {
    count: number;
    batches: BuildBatch[];
    batchCount: number;
    pinAtlas: TextAtlas[];
    pinEntry: AtlasEntry[];
    x0: number; y0: number; x1: number; y1: number;
    inexact: boolean;
}
type Writable<T> = { -readonly [K in keyof T]: T[K] };

export const createTextRoute: CreateTextRoute = (host: LayerHost, audit: string): TextRoute => {
    const memoAccount: CpuAccount = createCpuAccount(host.allocator.cpu, MEMO_CHUNK);
    const standAccount: CpuAccount = createCpuAccount(host.allocator.cpu, MEMO_CHUNK);
    const raster: MaskRaster = createMaskRaster(memoAccount, audit);
    let scratch: Float32Array<ArrayBuffer> = new Float32Array(0), scratchLease: ByteLease | null = null;
    let uniformData: Float32Array<ArrayBuffer> | null = null, uniformLease: ByteLease | null = null;
    let device: GfxDevice | null = null;
    let incarnation = 0;
    let pipelines: (PipelineHandle | undefined)[] = [undefined, undefined, undefined, undefined];
    let convertPipeline: PipelineHandle | null = null;
    let pipelinesReady = false, pipelinesPending = false, failed = false;
    let mono: TextAtlas | null = null, colour: TextAtlas | null = null;
    let white: TextureHandle | null = null, whiteLease: ByteLease | null = null, sampler: SamplerHandle | null = null;
    let stage: { texture: TextureHandle; lease: ByteLease; packer: ShelfPacker; height: number } | null = null;
    let stageTimer: ReturnType<typeof setTimeout> | null = null;
    /** Set while a cell is being staged: the conversion buffer and the atlas page it reserves can make the governor call this route's
     * own evictTextures, which released the staging texture between its spot and its write (pendingCount was still 0), and the
     * write then failed invalid-resource and demoted the pane to canvas2d (textzoom kit, pinch zoom, about one run in two). */
    let stageHeld = false;
    let zooming = false;
    let convertBuffer: BufferHandle | null = null, convertLease: ByteLease | null = null, convertCapacity = 0;
    let convertScratch: Float32Array<ArrayBuffer> = new Float32Array(0), convertScratchLease: ByteLease | null = null;
    let convertStale = false;
    let converting = false;
    const pending: PendingCell[] = [];
    let pendingCount = 0;
    const pageRuns: PageRun[] = [];
    let pageRunCount = 0;
    const live = new Set<TextRun>();
    const liveCache = new Map<string, TextRun>();
    let liveTimer: ReturnType<typeof setTimeout> | null = null;
    let cullX0 = 0, cullY0 = 0, cullX1 = 0, cullY1 = 0;
    const standIns = new IdentityIndex<StandIn>();
    const probe = newIdentity(), standProbe = newIdentity();
    const request: Writable<MaskRequest> = { epoch: 0, css: '', text: '', rtl: false, loaded: false, a: 0, b: 0, c: 0, d: 0, x: 0, y: 0 };
    const deviceMap = new Float64Array(6);
    const slot: Slot = { entry: null, rgba: false, standIn: false, x: 0, y: 0, w: 0, h: 0 };
    const cell: MaskCell = { x: 0, y: 0, w: 0, h: 0 };
    const build: Build = { count: 0, batches: [], batchCount: 0, pinAtlas: [], pinEntry: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity,
        inexact: false };

    const atlasHost = { reserve: (bytes: number) => host.allocator.gpu.reserve(bytes), release: (lease: ByteLease) => host.allocator.gpu.release(lease) };

    const retireRun = (run: TextRun): void => {
        if (!live.delete(run)) return;
        for (let i = 0; i < run.pinEntries.length; i++) run.pinAtlases[i].unpin(run.pinEntries[i]);
        run.device.destroy(run.buffer);
    };
    const releaseRaster = (): void => {
        raster.release();
    };
    const sweepLive = (keepMs: number): boolean => {
        const now = performance.now();
        for (const [key, run] of liveCache) if (run.refs === 0 && now - run.used >= keepMs) { liveCache.delete(key); retireRun(run); }
        return liveCache.size > 0;
    };
    const armLiveSweep = (): void => {
        if (liveTimer !== null) return;
        liveTimer = setTimeout(() => { liveTimer = null; if (sweepLive(LIVE_KEEP_MS)) armLiveSweep(); }, LIVE_KEEP_MS);
    };
    const releaseGpu = (): void => {
        incarnation++;
        if (liveTimer !== null) { clearTimeout(liveTimer); liveTimer = null; }
        liveCache.clear();
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
        // The white texture, the staging texture and the conversion buffer were created on their leases: the device owns those
        // leases and returns them when the resources retire (or at loss, on abandon). Releasing them here too returned them
        // before the GPU had retired the resource.
        if (scratchLease) host.allocator.cpu.release(scratchLease);
        if (uniformLease) host.allocator.cpu.release(uniformLease);
        if (convertScratchLease) host.allocator.cpu.release(convertScratchLease);
        scratch = new Float32Array(0); scratchLease = null;
        uniformData = null; uniformLease = null;
        convertScratch = new Float32Array(0); convertScratchLease = null;
        pipelines = [undefined, undefined, undefined, undefined]; convertPipeline = null;
        pipelinesReady = false; pipelinesPending = false; failed = false;
        mono = null; colour = null; white = null; whiteLease = null; sampler = null;
        clearStageTimer(); stage = null; convertBuffer = null; convertLease = null; convertCapacity = 0; pendingCount = 0; pageRunCount = 0; converting = false;
        convertStale = false;
        // Stand-in records name the atlases this device just disposed: none may be drawn from again.
        standIns.clear(); standAccount.reset();
        releaseRaster();
        device = null;
    };

    const ensurePipelines = (owner: GfxDevice): boolean => {
        if (pipelinesReady) return true;
        if (pipelinesPending || failed) return false;
        const serial = incarnation;
        pipelinesPending = true;
        const created: Promise<PipelineHandle>[] = [];
        try {
            for (const variant of VARIANTS) created.push(owner.createPipeline({ shader: shaderFor(variant), topology: 'triangle-strip',
                colorFormat: 'rgba8', samples: 1, blend: variant.endsWith('modulate') ? 'modulate' : 'source-over',
                alphaToCoverage: false, colorWrite: [true, true, true, true], stencil: { enabled: false } }));
            created.push(owner.createPipeline({ shader: convertShader(), topology: 'triangle-strip', colorFormat: 'r8', samples: 1,
                blend: 'replace', alphaToCoverage: false, colorWrite: [true, true, true, true], stencil: { enabled: false } }));
            Promise.all(created).then(made => {
                if (serial !== incarnation || device !== owner) { for (const pipeline of made) owner.destroy(pipeline); return; }
                for (let i = 0; i < VARIANTS.length; i++) pipelines[i] = made[i];
                convertPipeline = made[VARIANTS.length];
                pipelinesReady = true; pipelinesPending = false; host.invalidate('text-pipelines-ready');
            }, () => {
                if (serial !== incarnation) return;
                pipelinesPending = false; failed = true; host.invalidate('text-pipelines-failed');
            });
        } catch {
            pipelinesPending = false; failed = true;
            void Promise.allSettled(created).then(results => {
                for (const result of results) if (result.status === 'fulfilled') owner.destroy(result.value);
            });
        }
        return false;
    };

    const ensureDeviceObjects = (owner: GfxDevice): Stop | null => {
        if (!mono) mono = new TextAtlas(owner, atlasHost, { format: 'r8', maxPages: MONO_PAGES, surface: audit });
        if (!colour) colour = new TextAtlas(owner, atlasHost, { format: 'rgba8', maxPages: COLOUR_PAGES, surface: audit });
        if (!sampler) sampler = owner.createSampler('linear');
        if (!white) {
            const lease = host.allocator.gpu.reserve(1);
            if (!lease) return refused('gpu', 1);
            try { white = owner.createTexture(1, 1, 'r8', ['sample', 'copy-dst'], lease); }
            catch (error) { host.allocator.gpu.release(lease); throw error; }
            whiteLease = lease;
            owner.writeTexture(white, { x: 0, y: 0, width: 1, height: 1 },
                { source: new Uint8Array([255]), rowBytes: 1, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
        }
        return null;
    };

    const ensureUniformData = (): boolean => {
        if (uniformData) return true;
        uniformLease = host.allocator.cpu.reserve(32);
        if (!uniformLease) return false;
        uniformData = new Float32Array(8);
        return true;
    };
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
        if (convertScratchLease) host.allocator.cpu.release(convertScratchLease);
        convertBuffer = buffer; convertLease = gpuLease; convertCapacity = capacity;
        convertScratch = new Float32Array(capacity * 12); convertScratchLease = cpuLease;
        return true;
    };
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
        stage = null;
    };
    const armStageIdle = (): void => {
        clearStageTimer();
        stageTimer = setTimeout(() => {
            stageTimer = null;
            if (pendingCount === 0) releaseStage();
        }, STAGE_IDLE_MS);
    };
    const stageSpot = (w: number, h: number): { x: number; y: number } | null | 'denied' => {
        if (!stage && !createStage(device!, STAGE_MIN_HEIGHT)) return 'denied';
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
    const widen = (x0: number, y0: number, x1: number, y1: number): void => {
        build.x0 = Math.min(build.x0, x0); build.y0 = Math.min(build.y0, y0);
        build.x1 = Math.max(build.x1, x1); build.y1 = Math.max(build.y1, y1);
    };
    const denied = (): Stop => refused('cpu', (build.count + 1) * INSTANCE_BYTES);

    const solidRect = (x0: number, y0: number, x1: number, y1: number, colourOf: Rgba, viewW: number, viewH: number): boolean => {
        if (!(x1 > x0 && y1 > y0) || x1 <= cullX0 || y1 <= cullY0 || x0 >= cullX1 || y0 >= cullY1) return true;
        if (!put('mono', white!, x0, y0, x1 - x0, y1 - y0, SOLID_UV, SOLID_UV, SOLID_UV, SOLID_UV, colourOf)) return false;
        widen(x0, y0, x1, y1);
        return true;
    };

    const parallelogram = (r: { x: number; y: number; w: number; h: number }, A: ArrayLike<number>, colourOf: Rgba, viewW: number, viewH: number): boolean => {
        const rx = r.w < 0 ? r.x + r.w : r.x, rw = Math.abs(r.w);
        const ry = r.h < 0 ? r.y + r.h : r.y, rh = Math.abs(r.h);
        if (!(rw > 0 && rh > 0)) return true;
        const ox = A[0] * rx + A[2] * ry + A[4], oy = A[1] * rx + A[3] * ry + A[5];
        const e1x = A[0] * rw, e1y = A[1] * rw, e2x = A[2] * rh, e2y = A[3] * rh;
        const x0 = Math.min(ox, ox + e1x, ox + e2x, ox + e1x + e2x), x1 = Math.max(ox, ox + e1x, ox + e2x, ox + e1x + e2x);
        const y0 = Math.min(oy, oy + e1y, oy + e2y, oy + e1y + e2y), y1 = Math.max(oy, oy + e1y, oy + e2y, oy + e1y + e2y);
        if (x1 <= cullX0 || y1 <= cullY0 || x0 >= cullX1 || y0 >= cullY1) return true;
        if (!put('mono', white!, ox, oy, e1x, e1y, PARALLELOGRAM_UV, e2x, e2y, 0, colourOf)) return false;
        widen(x0, y0, x1, y1);
        return true;
    };

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

    const scaleOf = (req: MaskRequest): number => Math.sqrt(Math.abs(req.a * req.d - req.b * req.c));
    const standProbeOf = (req: MaskRequest, label: string, colourOf: Rgba | null): MaskIdentity | null => {
        if (req.b !== 0 || req.c !== 0 || req.a === 0 || req.d === 0) return null;
        fillIdentity(standProbe, req, 0, colourOf);
        standProbe.epoch = -1; standProbe.css = label;
        standProbe.a = Math.sign(req.a); standProbe.b = 0; standProbe.c = 0; standProbe.d = Math.sign(req.d);
        standProbe.fracX = 0; standProbe.fracY = 0;
        return standProbe;
    };
    const recordStandIn = (req: MaskRequest, label: string, colourOf: Rgba | null, atlas: TextAtlas, entry: AtlasEntry, cells: number, geometry: MaskGeometry): void => {
        if (cells !== 1) return;
        const key = standProbeOf(req, label, colourOf);
        if (!key) return;
        const existing = standIns.find(key);
        if (existing) standIns.delete(existing);
        else {
            if (standIns.size >= STANDIN_LIMIT) { standIns.clear(); standAccount.reset(); }
            if (!standAccount.charge(MEMO_ENTRY_BYTES + 2 * (key.css.length + key.text.length))) return;
        }
        const identity = copyIdentity(key);
        standIns.add({ identity, hash: identityHash(identity), atlas, entry, scale: scaleOf(req),
            originX: geometry.originX, originY: geometry.originY, w: geometry.w, h: geometry.h });
    };
    const tryStandIn = (req: MaskRequest, label: string, colourOf: Rgba | null, anyRatio: boolean): boolean => {
        const key = standProbeOf(req, label, colourOf);
        if (!key) return false;
        const record = standIns.find(key);
        if (!record || !record.atlas.holds(record.entry)) return false;
        const ratio = scaleOf(req) / record.scale;
        if (!anyRatio && !(ratio >= 0.5 && ratio <= 2)) return false;
        auditCount(audit, 'text:standin');
        slot.entry = record.entry; slot.rgba = record.atlas === colour; slot.standIn = true;
        slot.x = req.x - ratio * record.originX; slot.y = req.y - ratio * record.originY;
        slot.w = ratio * record.w; slot.h = ratio * record.h;
        return true;
    };
    const standInFor = (req: MaskRequest, label: string, colourOf: Rgba, emoji: boolean, anyRatio: boolean): boolean => {
        if (!emoji && tryStandIn(req, label, null, anyRatio)) return true;
        return tryStandIn(req, label, colourOf, anyRatio);
    };

    const rasterColour = (req: MaskRequest, geometry: MaskGeometry, cellIndex: number, colourOf: Rgba, frame: number, budget: FrameBudget, label: string): Stop | null => {
        const at = sliceCell(geometry, cellIndex, cell);
        const bytes = at.w * at.h * 4;
        const rasterLease = host.allocator.cpu.reserve(bytes);
        auditCount(audit, `text:raster:bucket:${2 ** Math.ceil(Math.log2(Math.max(1, bytes)))}`);
        if (!rasterLease) return refused('cpu', bytes);
        try {
            if (!budget.claimUpload(bytes)) return { status: 'deferred' };
            // Rastered before it is placed: an entry the atlas holds must already have its texels, or a later draw would read nothing.
            const made = raster.rasteriseBitmap(req, geometry, cellIndex, colourOf);
            let placed: ReturnType<TextAtlas['place']>;
            try {
                placed = colour!.place(fillIdentity(probe, req, cellIndex, colourOf), at.w, at.h, frame);
                if (placed === 'oversize') return { status: 'unsupported', why: 'oversize' };
                if ('denied' in placed) return refused('gpu', placed.denied);
                colour!.uploadBitmap(placed, made.bitmap);
            } finally { made.bitmap.close(); }
            auditCount(audit, 'text:mask-raster', 1, { px: at.w * at.h });
            auditCount(audit, 'upload:mask', 1, { bytes });
            recordStandIn(req, label, colourOf, colour!, placed, geometry.slices, geometry);
            slot.entry = placed; slot.rgba = true; slot.standIn = false;
            return null;
        } finally { host.allocator.cpu.release(rasterLease); }
    };

    const stageMono = (req: MaskRequest, label: string, geometry: MaskGeometry, cellIndex: number, frame: number, budget: FrameBudget): Stop | null => {
        stageHeld = true;
        try { return stageMonoHeld(req, label, geometry, cellIndex, frame, budget); } finally { stageHeld = false; }
    };
    const stageMonoHeld = (req: MaskRequest, label: string, geometry: MaskGeometry, cellIndex: number, frame: number, budget: FrameBudget): Stop | null => {
        const at = sliceCell(geometry, cellIndex, cell);
        const bytes = at.w * at.h * 4;
        const spot = stageSpot(at.w, at.h);
        if (spot === 'denied') return refused('gpu', bytes);
        if (!spot) { host.invalidate('text-stage-full'); return { status: 'deferred' }; }
        if (!ensureConvertCapacity(pendingCount + 1)) return refused('gpu', bytes);
        const rasterLease = host.allocator.cpu.reserve(bytes);
        auditCount(audit, `text:raster:bucket:${2 ** Math.ceil(Math.log2(Math.max(1, bytes)))}`);
        if (!rasterLease) return refused('cpu', bytes);
        try {
            if (!budget.claimUpload(bytes)) return { status: 'deferred' };
            const staged = stage!;
            const made = raster.rasteriseBitmap(req, geometry, cellIndex, null);
            try {
                const placed = mono!.place(fillIdentity(probe, req, cellIndex, null), at.w, at.h, frame);
                if (placed === 'oversize') return { status: 'unsupported', why: 'oversize' };
                if ('denied' in placed) return refused('gpu', placed.denied);
                device!.writeTexture(staged.texture, { x: spot.x, y: spot.y, width: at.w, height: at.h },
                    { source: made.bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
                let next = pending[pendingCount];
                if (next) { next.entry = placed; next.x = spot.x; next.y = spot.y; }
                else { next = { entry: placed, x: spot.x, y: spot.y }; pending.push(next); }
                pendingCount++;
                convertStale = true;
                auditCount(audit, 'text:mask-raster', 1, { px: at.w * at.h });
                auditCount(audit, 'upload:mask', 1, { bytes });
                recordStandIn(req, label, null, mono!, placed, geometry.slices, geometry);
                slot.entry = placed; slot.rgba = false; slot.standIn = false;
                return null;
            } finally { made.bitmap.close(); }
        } finally { host.allocator.cpu.release(rasterLease); }
    };

    const cellEntry = (req: MaskRequest, label: string, geometry: MaskGeometry, cellIndex: number, colourOf: Rgba,
        frame: number, budget: FrameBudget, moving: boolean): Stop | null => {
        const emoji = needsColourMask(req.text);
        const exact = (emoji ? colour! : mono!).lookup(fillIdentity(probe, req, cellIndex, emoji ? colourOf : null), frame);
        if (exact) { slot.entry = exact; slot.rgba = emoji; slot.standIn = false; return null; }
        if (zooming) {
            if (!standInFor(req, label, colourOf, emoji, true)) return { status: 'deferred' };
            auditCount(audit, 'text:mask:zoom-scaled');
            return null;
        }
        if (moving && geometry.slices === 1 && standInFor(req, label, colourOf, emoji, false)) return null;
        if (budget.shouldYield()) return { status: 'deferred' };
        return emoji ? rasterColour(req, geometry, cellIndex, colourOf, frame, budget, label)
            : stageMono(req, label, geometry, cellIndex, frame, budget);
    };

    const drawSlot = (colourOf: Rgba, viewW: number, viewH: number, recomposes: boolean): Stop | null => {
        const e = slot.entry!;
        const x = slot.x, y = slot.y, w = slot.w, h = slot.h;
        if (x + w <= cullX0 || y + h <= cullY0 || x >= cullX1 || y >= cullY1) return null;
        const u0 = e.x / ATLAS_PAGE, v0 = 1 - e.y / ATLAS_PAGE, u1 = (e.x + e.w) / ATLAS_PAGE, v1 = 1 - (e.y + e.h) / ATLAS_PAGE;
        if (!put(slot.rgba ? 'colour' : 'mono', e.page.texture, x, y, w, h, u0, v0, u1, v1, slot.rgba ? WHITE : colourOf)) return denied();
        widen(x, y, x + w, y + h);
        if (slot.standIn && recomposes) build.inexact = true;
        build.pinAtlas.push(slot.rgba ? colour! : mono!);
        build.pinEntry.push(e);
        return null;
    };

    const glyphs = (item: PaintTextItem, map: ArrayLike<number>, frame: number, viewW: number, viewH: number, budget: FrameBudget, moving: boolean): Stop | null => {
        let glyph = 0;
        for (const line of item.paint.lines) for (const fragment of line.fragments) {
            const colourOf = item.material.glyphs[glyph++];
            if (!colourOf) return { status: 'unsupported', why: 'material' };
            const face = item.faces.faces[fragment.face];
            if (!face) return { status: 'unsupported', why: 'face' };
            if (!fragment.text || !(face.size > 0)) continue;
            const k = face.size / 64;
            const req = request;
            req.epoch = item.paint.fontEpoch; req.css = face.css; req.text = fragment.text; req.rtl = fragment.rtl; req.loaded = face.loaded;
            req.a = map[0] * k; req.b = map[1] * k; req.c = map[2] * k; req.d = map[3] * k;
            req.x = map[0] * fragment.x + map[2] * line.baseline + map[4];
            req.y = map[1] * fragment.x + map[3] * line.baseline + map[5];
            const label = faceLabel(face.key);
            const measured = raster.measure(req);
            if (measured.status === 'deferred') {
                if (!standInFor(req, label, colourOf, needsColourMask(req.text), true)) return { status: 'deferred' };
                const drawn = drawSlot(colourOf, viewW, viewH, false);
                if (drawn) return drawn;
                continue;
            }
            if (measured.status === 'empty') continue;
            if (measured.status !== 'ok') return { status: 'unsupported', why: measured.status === 'oversize' ? 'oversize' : measured.why };
            const geometry = measured.geometry;
            for (let cellIndex = 0; cellIndex < geometry.slices; cellIndex++) {
                const stop = cellEntry(req, label, geometry, cellIndex, colourOf, frame, budget, moving);
                if (stop) return stop;
                if (!slot.standIn) {
                    const at = sliceCell(geometry, cellIndex, cell);
                    slot.x = Math.floor(req.x) + geometry.left + at.x; slot.y = Math.floor(req.y) + geometry.top + at.y;
                    slot.w = at.w; slot.h = at.h;
                }
                const drawn = drawSlot(colourOf, viewW, viewH, true);
                if (drawn) return drawn;
            }
        }
        return null;
    };

    const item = (it: PaintTextItem, frame: number, viewW: number, viewH: number, scale: number, view: { camera: { x: number; y: number }; moving: boolean }, budget: FrameBudget): Stop | null => {
        const [a, b, c, d, e, f] = it.localToWorld;
        const map = deviceMap;
        map[0] = scale * a; map[1] = scale * b; map[2] = scale * c; map[3] = scale * d;
        map[4] = scale * (e - view.camera.x); map[5] = scale * (f - view.camera.y);
        return rects(it.paint.backgrounds, it.material.backgrounds, map, viewW, viewH)
            ?? glyphs(it, map, frame, viewW, viewH, budget, view.moving)
            ?? rects(it.paint.decorations, it.material.decorations, map, viewW, viewH);
    };

    const runOf = (page: AtlasPage): PageRun | null => {
        for (let r = 0; r < pageRunCount; r++) if (pageRuns[r].page === page) return pageRuns[r];
        return null;
    };
    const addRun = (page: AtlasPage): PageRun => {
        let run = pageRuns[pageRunCount];
        if (run) { run.page = page; run.first = 0; run.count = 0; run.fill = 0; run.sample = null; }
        else { run = { page, first: 0, count: 0, fill: 0, sample: null }; pageRuns.push(run); }
        pageRunCount++;
        return run;
    };

    const reusable = (run: TextRun, owner: GfxDevice, blend: Blend, view: { camera: { x: number; y: number }; moving: boolean },
        viewW: number, viewH: number, scale: number): boolean => {
        if (!live.has(run) || run.device !== owner || run.blend !== blend) return false;
        const k = scale / run.refScale;
        if (!(k >= LIVE_REUSE_MIN && k <= LIVE_REUSE_MAX)) return false;
        let ox = (run.refX - view.camera.x) * scale, oy = (run.refY - view.camera.y) * scale;
        const c = run.cull;
        if (-ox / k < c.x || -oy / k < c.y || (viewW - ox) / k > c.x + c.width || (viewH - oy) / k > c.y + c.height) return false;
        if (k === 1) {
            const rx = Math.round(ox), ry = Math.round(oy);
            if (!zooming && !view.moving && (run.inexact || Math.abs(ox - rx) > 1e-6 || Math.abs(oy - ry) > 1e-6)) return false;
            ox = rx; oy = ry;
        } else if (!zooming && !view.moving) return false;
        run.k = k; run.ox = ox; run.oy = oy; run.curW = viewW; run.curH = viewH;
        return true;
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
            const liveItem = items.length === 1 && !isTileView(view) ? items[0] : null;
            if (liveItem) {
                const cached = liveCache.get(liveItem.key);
                if (cached && cached.liveItem === liveItem && reusable(cached, owner, blend, view, viewW, viewH, scale)) {
                    cached.refs++; cached.used = performance.now();
                    auditCount(audit, 'text:live-reuse');
                    return { status: 'ready', value: cached };
                }
            }
            if (!ensureUniformData()) return refused('cpu', 32);
            const margin = liveItem ? 1 : 0;
            cullX0 = -margin * viewW; cullY0 = -margin * viewH; cullX1 = (1 + margin) * viewW; cullY1 = (1 + margin) * viewH;
            build.count = 0; build.batchCount = 0; build.inexact = false;
            build.pinAtlas.length = 0; build.pinEntry.length = 0;
            build.x0 = Infinity; build.y0 = Infinity; build.x1 = -Infinity; build.y1 = -Infinity;
            const frame = budget.frameId;
            for (const it of items) {
                const stop = item(it, frame, viewW, viewH, scale, view, budget);
                if (stop) return stop;
            }
            if (build.count === 0) return { status: 'empty' };
            const x0 = Math.max(cullX0, Math.floor(build.x0)), y0 = Math.max(cullY0, Math.floor(build.y0));
            const x1 = Math.min(cullX1, Math.ceil(build.x1)), y1 = Math.min(cullY1, Math.ceil(build.y1));
            if (x1 <= x0 || y1 <= y0) return { status: 'empty' };
            const bounds: RectI = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
            const bytes = build.count * INSTANCE_BYTES;
            if (!sampler) throw new Error('Text sampler missing');
            for (let i = 0; i < build.batchCount; i++) {
                if (!pipelines[pipelineIndex(build.batches[i].mode, blend)]) throw new Error('Text pipeline missing');
            }
            if (!budget.claimUpload(bytes)) return { status: 'deferred' };
            const lease = host.allocator.gpu.reserve(bytes);
            if (!lease) return refused('gpu', bytes);
            let buffer: BufferHandle | null = null;
            try {
                buffer = owner.createBuffer(bytes, ['vertex', 'copy-dst'], lease);
                owner.writeBuffer(buffer, 0, scratch.subarray(0, build.count * 12));
                auditCount(audit, 'upload:vertex', 1, { bytes });
                auditCount(audit, 'geom:build');
            } catch (error) {
                if (buffer) owner.destroy(buffer);
                else host.allocator.gpu.release(lease);
                throw error;
            }
            const scissor: RectI = { x: Math.max(0, x0), y: Math.max(0, y0), width: Math.max(0, Math.min(viewW, x1) - Math.max(0, x0)),
                height: Math.max(0, Math.min(viewH, y1) - Math.max(0, y0)) };
            const batches: Batch[] = new Array<Batch>(build.batchCount);
            for (let i = 0; i < build.batchCount; i++) {
                const b = build.batches[i];
                const pipeline = pipelines[pipelineIndex(b.mode, blend)]!;
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
                batches, pinAtlases, pinEntries, viewW, viewH, scissor, bytes, inexact: build.inexact,
                liveItem, refX: view.camera.x, refY: view.camera.y, refScale: scale,
                cull: { x: cullX0, y: cullY0, width: cullX1 - cullX0, height: cullY1 - cullY0 }, bounds,
                refs: 1, used: performance.now(), curW: viewW, curH: viewH, k: 1, ox: 0, oy: 0 };
            live.add(run);
            if (liveItem) {
                const old = liveCache.get(liveItem.key);
                liveCache.set(liveItem.key, run);
                if (old && old !== run && old.refs === 0) retireRun(old);
            }
            auditCount(audit, 'route:text');
            return { status: 'ready', value: run };
        },
        draw(pass: GpuPass, prepared: PreparedRun): void {
            const run = prepared as TextRun;
            if (!live.has(run) || device !== run.device || host.device() !== run.device) {
                auditCount(audit, 'text:stale-run-skipped');
                return;
            }
            const data = uniformData!;
            data[0] = run.curW; data[1] = run.curH; data[2] = 0; data[3] = 0;
            data[4] = run.k; data[5] = run.ox; data[6] = run.oy; data[7] = 0;
            if (run.liveItem) {
                const b = run.bounds, sc = run.scissor as Writable<RectI>;
                const x0 = Math.max(0, Math.floor(b.x * run.k + run.ox)), y0 = Math.max(0, Math.floor(b.y * run.k + run.oy));
                const x1 = Math.min(run.curW, Math.ceil((b.x + b.width) * run.k + run.ox)), y1 = Math.min(run.curH, Math.ceil((b.y + b.height) * run.k + run.oy));
                if (x1 <= x0 || y1 <= y0) return;
                sc.x = x0; sc.y = y0; sc.width = x1 - x0; sc.height = y1 - y0;
            }
            const uniforms = host.uniforms(data);
            for (const batch of run.batches) {
                batch.uniform.slice = uniforms;
                pass.draw(batch.command);
            }
        },
        uploadPrepared(): void {
            if (!convertStale) return;
            convertStale = false;
            pageRunCount = 0;
            if (pendingCount === 0) return;
            const owner = device, staged = stage;
            if (!owner || !staged || !convertBuffer || !mono) throw new Error('Text conversion without its objects');
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
                run.sample ??= p.entry;
                const e = p.entry;
                convertScratch[o] = e.x; convertScratch[o + 1] = e.y; convertScratch[o + 2] = e.w; convertScratch[o + 3] = e.h;
                convertScratch[o + 4] = p.x / ATLAS_PAGE; convertScratch[o + 5] = 1 - p.y / staged.height;
                convertScratch[o + 6] = (p.x + e.w) / ATLAS_PAGE; convertScratch[o + 7] = 1 - (p.y + e.h) / staged.height;
                convertScratch[o + 8] = 0; convertScratch[o + 9] = 0; convertScratch[o + 10] = 0; convertScratch[o + 11] = 0;
            }
            if (total > 0) owner.writeBuffer(convertBuffer, 0, convertScratch.subarray(0, total * 12));
        },
        encodeOffscreen(passes: OffscreenPasses): void {
            if (pendingCount === 0) return;
            if (convertStale) throw new Error('Text conversion staged after its upload');
            clearStageTimer();
            const staged = stage, pipeline = convertPipeline;
            if (!staged || !pipeline || !convertBuffer || !sampler || !mono) throw new Error('Text conversion without its objects');
            for (let r = 0; r < pageRunCount; r++) {
                const run = pageRuns[r];
                if (run.count === 0 || !run.sample || !mono.holds(run.sample)) continue;
                const target = run.page.target;
                if (!target) throw new Error('R8 text page without a conversion target');
                const viewport = { x: 0, y: 0, width: ATLAS_PAGE, height: ATLAS_PAGE };
                const gpuPass = passes.begin(target, viewport, { clear: null, orClear: [0, 0, 0, 0], stencil: false });
                gpuPass.draw({ pipeline, bindings: { uniforms: [], textures: [{ binding: 0, texture: staged.texture, sampler }] },
                    vertices: [{ buffer: convertBuffer, offset: run.first * INSTANCE_BYTES, bytes: run.count * INSTANCE_BYTES }],
                    first: 0, count: 4, instances: run.count, scissor: viewport });
                gpuPass.end();
            }
            converting = true;
        },
        offscreenSettled(submitted: boolean): void {
            if (!converting) return;
            converting = false;
            if (!submitted) { auditCount(audit, 'text:convert-discarded'); return; }
            stage?.packer.reset();
            pendingCount = 0; pageRunCount = 0;
            armStageIdle();
        },
        retire(prepared: PreparedRun): void {
            const run = prepared as TextRun;
            if (run.refs > 0) run.refs--;
            if (run.refs > 0) return;
            if (run.liveItem && liveCache.get(run.liveItem.key) === run) { armLiveSweep(); return; }
            retireRun(run);
        },
        release(): void { releaseGpu(); },
        setZoom(value: boolean): void {
            zooming = value;
            if (liveCache.size) sweepLive(LIVE_KEEP_MS);
        },
        exact(prepared: PreparedRun): boolean { const run = prepared as TextRun; return !run.inexact && run.k === 1; },
        evictTextures(bytes: number, frameId: number): number {
            if (bytes > 0 && liveCache.size) sweepLive(0);
            const freedStage = stage && pendingCount === 0 && !stageHeld && bytes > 0 ? stage.lease.bytes : 0;
            if (freedStage > 0) releaseStage();
            const left = Math.max(0, bytes - freedStage);
            const freedMono = mono?.evict(left, frameId) ?? 0;
            const freed = freedStage + freedMono + (colour?.evict(Math.max(0, left - freedMono), frameId) ?? 0);
            if (freed > 0) releaseRaster();
            return freed;
        },
        memory(): { gpuBytes: number; cpuBytes: number } {
            let gpuBytes = (mono?.bytes ?? 0) + (colour?.bytes ?? 0) + (whiteLease?.bytes ?? 0) + (stage?.lease.bytes ?? 0) + (convertLease?.bytes ?? 0);
            for (const run of live) gpuBytes += run.bytes;
            const cpuBytes = (scratchLease?.bytes ?? 0) + (uniformLease?.bytes ?? 0) +
                (convertScratchLease?.bytes ?? 0) + memoAccount.bytes + standAccount.bytes;
            return { gpuBytes, cpuBytes };
        },
    };
};
