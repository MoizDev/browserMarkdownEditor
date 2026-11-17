import type { Rgba } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { BufferHandle, ByteLease, GfxDevice, GpuPass, PipelineHandle, RectI, SamplerHandle, ShaderModule, TextureHandle } from '../../../platform/render/gfx/api';
import type { FrameBudget } from '../../../platform/render/types';
import { auditCount } from '../../../platform/render/renderAudit';
import type { PaintItem, PaintTextItem } from '../paintStream';
import { ATLAS_PAGE, TextAtlas, type AtlasEntry } from '../textAtlas';
import { MASK_CANVAS_BYTES, MEMO_ENTRY_BYTES, createCpuAccount, createMaskRaster, maskKey, type CpuAccount, type MaskGeometry, type MaskRequest, type MaskRaster } from './textMasks';
import type { Admission, Blend, CreateTextRoute, ItemRoute, PreparedRun } from './contracts';

/** The text route as the composer sees it. `evictTextures` is the governor's hook (h9): whole atlas pages, coldest first. */
export interface TextRoute extends ItemRoute<PaintTextItem> {
    evictTextures(bytes: number, frameId: number): number;
}

// The board's text route. A text run is drawn from exact-size run masks (textMasks.ts) that live on atlas pages
// (textAtlas.ts). Solid backgrounds and decorations are analytic-coverage rectangles in the same instance stream, so one
// run is one buffer and a few instanced draws, in paint order: backgrounds, glyph masks, decorations, per item.

/** Per instance: device rect (x, y, w, h), page uv rect (u0, v0, u1, v1; u0 = -1 marks a solid rect), premultiplied colour. */
const INSTANCE_BYTES = 48;
const SOLID_UV = -1;
const PARALLELOGRAM_UV = -2;
/** A new colour-glyph run is measured here; the set is cleared when full so a long session cannot grow it without bound. */
const COLOUR_RUN_LIMIT = 4096;
const MONO_PAGES = 8, COLOUR_PAGES = 2;
/** Stand-in records kept at once; cleared whole when full, as the measurement memo is. */
const STANDIN_LIMIT = 4096;
/** CPU pool chunk for the memos: one lease per 64 KB, so a memo's accounting is a handful of leases, not one per entry. */
const MEMO_CHUNK = 64 * 1024;
/** The instance scratch starts at this many floats (one quad is 12) and doubles; its lease is exact, so it is never over-reported. */
const SCRATCH_FLOOR = 12 * 64;

const ATTRIBUTES: ShaderModule['layout']['attributes'] = [
    { location: 0, bufferSlot: 0, offset: 0, stride: INSTANCE_BYTES, format: 'float32x4', step: 'instance' },
    { location: 1, bufferSlot: 0, offset: 16, stride: INSTANCE_BYTES, format: 'float32x4', step: 'instance' },
    { location: 2, bufferSlot: 0, offset: 32, stride: INSTANCE_BYTES, format: 'float32x4', step: 'instance' },
];

// The vertex stage is one expanded instance quad. A solid rect grows by a pixel so the fragment can compute its
// exact area coverage per pixel; a mask quad is exactly its whole-pixel rect, so its texels map 1:1.
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

type Mode = 'mono' | 'colour';
type Variant = `${Mode}-${Blend}`;
const VARIANTS: readonly Variant[] = ['mono-over', 'mono-modulate', 'colour-over', 'colour-modulate'];

function shaderFor(variant: Variant): ShaderModule {
    const mode = variant.startsWith('mono') ? 'mono' : 'colour';
    return { id: `board-text-${variant}`, revision: 1,
        layout: { uniforms: [{ binding: 0, byteSize: 16 }], textures: [{ binding: 0, format: mode === 'mono' ? 'r8' : 'rgba8' }], attributes: ATTRIBUTES },
        glsl: { vertex: VERTEX, fragment: HEADER + BODY[variant] } };
}

/** A run's quads, in paint order. Each batch is consecutive quads that share a pipeline and texture: one instanced draw. */
interface Batch { readonly mode: Mode; readonly texture: TextureHandle; readonly first: number; readonly count: number }
interface Pin { readonly atlas: TextAtlas; readonly entry: AtlasEntry }
/** An exact entry's draw, or a stand-in's: `rect` is the device rect a stand-in is drawn in, null for an exact entry. */
interface Found { readonly entry: AtlasEntry; readonly rgba: boolean; readonly rect: { x: number; y: number; w: number; h: number } | null }
/** A single-slice mask the index can stand in for, with the geometry it is scaled from. */
interface StandIn { readonly atlas: TextAtlas; readonly entry: AtlasEntry; readonly scale: number; readonly originX: number; readonly originY: number; readonly w: number; readonly h: number }
interface TextRun extends PreparedRun {
    readonly device: GfxDevice;
    readonly buffer: BufferHandle;
    readonly bufferLease: ByteLease;
    readonly batches: readonly Batch[];
    readonly pins: readonly Pin[];
    readonly viewW: number;
    readonly viewH: number;
    readonly scissor: RectI;
    readonly bytes: number;
}
type Stop = Exclude<Admission<PreparedRun>, { status: 'ready' }>;
/** The instances of one run under construction. Their floats live in the route's leased scratch, shared by every run. */
interface Build { count: number; batches: Batch[]; pins: Pin[]; x0: number; y0: number; x1: number; y1: number }

export const createTextRoute: CreateTextRoute = (host: LayerHost, audit: string): TextRoute => {
    // Every CPU byte the route holds is leased: the canvas, the instance and uniform scratch, and the two memos.
    const measureAccount: CpuAccount = createCpuAccount(host.allocator.cpu, MEMO_CHUNK);
    const colourAccount: CpuAccount = createCpuAccount(host.allocator.cpu, MEMO_CHUNK);
    const raster: MaskRaster = createMaskRaster(measureAccount);
    let rasterLease: ByteLease | null = null;
    let scratch: Float32Array<ArrayBuffer> = new Float32Array(0), scratchLease: ByteLease | null = null;
    let uniformData: Float32Array<ArrayBuffer> | null = null, uniformLease: ByteLease | null = null;
    let device: GfxDevice | null = null;
    let incarnation = 0;
    let pipelines = new Map<Variant, PipelineHandle>();
    let pipelinesPending = false, failed = false;
    let mono: TextAtlas | null = null, colour: TextAtlas | null = null;
    let white: TextureHandle | null = null, whiteLease: ByteLease | null = null, sampler: SamplerHandle | null = null;
    const colourRuns = new Set<string>();
    const colourRunBytes = (key: string): number => key.length * 2 + MEMO_ENTRY_BYTES;
    /** The font epoch the atlases were last filled under. A change retires the old faces' masks (their keys carry the old epoch). */
    let seenEpoch = -1;
    const live = new Set<TextRun>();

    const atlasHost = { reserve: (bytes: number) => host.allocator.gpu.reserve(bytes), release: (lease: ByteLease) => host.allocator.gpu.release(lease) };

    const retireRun = (run: TextRun): void => {
        if (!live.delete(run)) return;
        for (const pin of run.pins) pin.atlas.unpin(pin.entry);
        run.device.destroy(run.buffer);
        host.allocator.gpu.release(run.bufferLease);
    };
    /** Every GPU resource of the current device. Runs go first, so their pins drop before the atlases are disposed. */
    const releaseGpu = (): void => {
        incarnation++;
        for (const run of [...live]) retireRun(run);
        const owner = device;
        if (owner) {
            for (const pipeline of pipelines.values()) owner.destroy(pipeline);
            if (sampler) owner.destroy(sampler);
            if (white) owner.destroy(white);
        }
        mono?.dispose(); colour?.dispose();
        if (whiteLease) host.allocator.gpu.release(whiteLease);
        pipelines = new Map(); pipelinesPending = false; failed = false;
        mono = null; colour = null; white = null; whiteLease = null; sampler = null;
        // Stand-in records name the atlases this device just disposed: none may be drawn from again.
        standIns.clear();
        device = null;
    };

    /** Creates the four variants once per device. Until they land, a run waits: the composer retries on the wake. */
    const ensurePipelines = (owner: GfxDevice): boolean => {
        if (pipelines.size === VARIANTS.length) return true;
        if (pipelinesPending || failed) return false;
        const serial = incarnation;
        pipelinesPending = true;
        try {
            Promise.all(VARIANTS.map(variant => owner.createPipeline({ shader: shaderFor(variant), topology: 'triangle-strip',
                colorFormat: 'rgba8', samples: 1, blend: variant.endsWith('modulate') ? 'modulate' : 'source-over',
                alphaToCoverage: false, colorWrite: [true, true, true, true], stencil: { enabled: false } })))
                .then(made => {
                    if (serial !== incarnation || device !== owner) { for (const pipeline of made) owner.destroy(pipeline); return; }
                    made.forEach((pipeline, i) => pipelines.set(VARIANTS[i], pipeline));
                    pipelinesPending = false; host.invalidate('text-pipelines-ready');
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
    const WHITE: Rgba = [1, 1, 1, 1];

    /** One instance: its device rect, page uv rect and premultiplied colour, appended to the run in paint order. */
    const put = (build: Build, mode: Mode, texture: TextureHandle, x: number, y: number, w: number, h: number,
        u0: number, v0: number, u1: number, v1: number, c: Rgba): boolean => {
        if (!reserveScratch((build.count + 1) * 12)) return false;
        const o = build.count * 12;
        scratch[o] = x; scratch[o + 1] = y; scratch[o + 2] = w; scratch[o + 3] = h;
        scratch[o + 4] = u0; scratch[o + 5] = v0; scratch[o + 6] = u1; scratch[o + 7] = v1;
        scratch[o + 8] = c[0] * c[3]; scratch[o + 9] = c[1] * c[3]; scratch[o + 10] = c[2] * c[3]; scratch[o + 11] = c[3];
        build.count++;
        const last = build.batches[build.batches.length - 1];
        if (last && last.mode === mode && last.texture === texture) build.batches[build.batches.length - 1] = { mode, texture, first: last.first, count: last.count + 1 };
        else build.batches.push({ mode, texture, first: build.count - 1, count: 1 });
        return true;
    };
    /** Grows the run's device bounds, which become its scissor. */
    const widen = (build: Build, x0: number, y0: number, x1: number, y1: number): void => {
        build.x0 = Math.min(build.x0, x0); build.y0 = Math.min(build.y0, y0);
        build.x1 = Math.max(build.x1, x1); build.y1 = Math.max(build.y1, y1);
    };

    /** A solid rect in device px: analytic coverage in the shader, so its edges match the canvas's fill. False only on refusal. */
    const solidRect = (build: Build, x0: number, y0: number, x1: number, y1: number, colourOf: Rgba, viewW: number, viewH: number): boolean => {
        if (!(x1 > x0 && y1 > y0) || x1 <= 0 || y1 <= 0 || x0 >= viewW || y0 >= viewH) return true;
        if (!put(build, 'mono', white!, x0, y0, x1 - x0, y1 - y0, SOLID_UV, SOLID_UV, SOLID_UV, SOLID_UV, colourOf)) return false;
        widen(build, x0, y0, x1, y1);
        return true;
    };

    const denied = (build: Build): Stop => ({ status: 'denied', pool: 'cpu', bytes: (build.count + 1) * INSTANCE_BYTES });

    /** A rect under a map with rotation or skew: the device parallelogram, one instance. Its shader supersamples the coverage
     * (the canvas fill's antialiasing), so a rotated node's backgrounds and underlines stay on the GPU. False only on refusal. */
    const parallelogram = (build: Build, r: { x: number; y: number; w: number; h: number }, A: readonly number[], colourOf: Rgba, viewW: number, viewH: number): boolean => {
        // A negative extent fills the same rect as its positive one, so the origin moves to the low corner first.
        const rx = r.w < 0 ? r.x + r.w : r.x, rw = Math.abs(r.w);
        const ry = r.h < 0 ? r.y + r.h : r.y, rh = Math.abs(r.h);
        if (!(rw > 0 && rh > 0)) return true;
        const ox = A[0] * rx + A[2] * ry + A[4], oy = A[1] * rx + A[3] * ry + A[5];
        const e1x = A[0] * rw, e1y = A[1] * rw, e2x = A[2] * rh, e2y = A[3] * rh;
        const xs = [ox, ox + e1x, ox + e2x, ox + e1x + e2x], ys = [oy, oy + e1y, oy + e2y, oy + e1y + e2y];
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        if (x1 <= 0 || y1 <= 0 || x0 >= viewW || y0 >= viewH) return true;
        if (!put(build, 'mono', white!, ox, oy, e1x, e1y, PARALLELOGRAM_UV, e2x, e2y, 0, colourOf)) return false;
        widen(build, x0, y0, x1, y1);
        return true;
    };

    /** Rects of one item: the backgrounds before its glyphs, the decorations after. Axis-aligned maps are analytic solids;
     * rotated or skewed ones are parallelograms. */
    const rects = (build: Build, list: readonly { x: number; y: number; w: number; h: number }[], colours: readonly Rgba[],
        A: readonly number[], viewW: number, viewH: number): Stop | null => {
        for (let i = 0; i < list.length; i++) {
            const colourOf = colours[i];
            if (!colourOf) return { status: 'unsupported', why: 'material' };
            const r = list[i];
            if (A[1] !== 0 || A[2] !== 0) {
                if (!parallelogram(build, r, A, colourOf, viewW, viewH)) return denied(build);
                continue;
            }
            const xa = A[0] * r.x + A[4], xb = A[0] * (r.x + r.w) + A[4];
            const ya = A[3] * r.y + A[5], yb = A[3] * (r.y + r.h) + A[5];
            if (!solidRect(build, Math.min(xa, xb), Math.min(ya, yb), Math.max(xa, xb), Math.max(ya, yb), colourOf, viewW, viewH)) return denied(build);
        }
        return null;
    };

    /** The scale of a glyph run's device map: its square root of |det|, so a uniform zoom is exactly its ratio. */
    const scaleOf = (req: MaskRequest): number => Math.sqrt(Math.abs(req.a * req.d - req.b * req.c));
    /** The identity of a run ignoring its scale and position: a stand-in is the same glyphs at another size. Axis-aligned
     * maps only: a rotated mask drawn as an axis-aligned quad would be wrong, so a rotated run waits for its exact mask. */
    const standInKey = (req: MaskRequest, glyph: Rgba | null): string | null => {
        if (!(scaleOf(req) > 0) || req.b !== 0 || req.c !== 0) return null;
        return JSON.stringify([req.epoch, req.css, req.text, req.rtl, Math.sign(req.a), Math.sign(req.d), glyph]);
    };
    /** The latest single-slice mask placed for each identity, with the geometry a stand-in scales from. */
    const standIns = new Map<string, StandIn>();
    const recordStandIn = (req: MaskRequest, glyph: Rgba | null, atlas: TextAtlas, entry: AtlasEntry, geometry: MaskGeometry): void => {
        if (geometry.slices !== 1) return;
        const key = standInKey(req, glyph);
        if (!key) return;
        if (standIns.size >= STANDIN_LIMIT) standIns.clear();
        standIns.set(key, { atlas, entry, scale: scaleOf(req), originX: geometry.originX, originY: geometry.originY, w: geometry.w, h: geometry.h });
    };
    /** Motion only: the nearest existing mask of these glyphs, drawn scaled about the new origin. The ratio is bounded to 2×
     * either way (beyond that the stand-in is blurred); a stand-in the atlas has evicted is not used. Null when none fits. */
    const standInFor = (req: MaskRequest, glyph: Rgba, knownColour: boolean): Found | null => {
        const scale = scaleOf(req);
        const candidates = knownColour ? [standInKey(req, glyph)] : [standInKey(req, null), standInKey(req, glyph)];
        for (const key of candidates) {
            if (!key) continue;
            const record = standIns.get(key);
            if (!record || !record.atlas.holds(record.entry)) continue;
            const ratio = scale / record.scale;
            if (!(ratio >= 0.5 && ratio <= 2)) continue;
            auditCount(audit, 'text:standin');
            return { entry: record.entry, rgba: record.atlas === colour,
                rect: { x: req.x - ratio * record.originX, y: req.y - ratio * record.originY, w: ratio * record.w, h: ratio * record.h } };
        }
        return null;
    };

    /** One slice of a glyph mask: the atlas hit, or during motion a stand-in, or the raster and its upload. A stand-in
     * carries its own rect; an exact entry is drawn where its geometry puts it. Null when the run must wait. */
    const sliceEntry = (req: MaskRequest, geometry: MaskGeometry, slice: number, glyph: Rgba, frame: number, budget: FrameBudget, moving: boolean): Stop | Found => {
        const key = maskKey(req, geometry, slice, null);
        const knownColour = colourRuns.has(key);
        if (!knownColour) {
            const hit = mono!.lookup(key, frame);
            if (hit) return { entry: hit, rgba: false, rect: null };
        } else {
            const hit = colour!.lookup(maskKey(req, geometry, slice, glyph), frame);
            if (hit) return { entry: hit, rgba: true, rect: null };
        }
        // Motion draws what exists: a missing exact mask is a stand-in, not a raster, until the view settles.
        if (moving && geometry.slices === 1) {
            const standIn = standInFor(req, glyph, knownColour);
            if (standIn) return standIn;
        }
        if (budget.shouldYield()) return { status: 'deferred' };
        if (!ensureRasterLease()) return { status: 'denied', pool: 'cpu', bytes: MASK_CANVAS_BYTES };
        if (!knownColour) {
            const probe = raster.rasterise(req, geometry, slice, null);
            if (!probe.colourGlyphs) {
                if (!budget.claimUpload(probe.pixels.byteLength)) return { status: 'deferred' };
                auditCount(audit, 'text:mask-raster', 1, { px: probe.w * probe.h });
                const placed = mono!.place(maskKey(req, geometry, slice, null), req.css, probe.w, probe.h, frame);
                if (placed === 'oversize') return { status: 'unsupported', why: 'oversize' };
                if (placed === 'denied') return { status: 'denied', pool: 'gpu', bytes: probe.pixels.byteLength };
                mono!.upload(placed, probe.pixels, probe.w);
                auditCount(audit, 'upload:mask', 1, { bytes: probe.pixels.byteLength });
                recordStandIn(req, null, mono!, placed, geometry);
                return { entry: placed, rgba: false, rect: null };
            }
            if (colourRuns.size >= COLOUR_RUN_LIMIT) { colourRuns.clear(); colourAccount.reset(); }
            // A memo the pool refuses is not kept: the run is rastered as a probe again next time, which is correct, only slower.
            if (colourAccount.charge(colourRunBytes(key))) colourRuns.add(key);
        }
        const colourKey = maskKey(req, geometry, slice, glyph);
        // A colour entry can outlive its memo (the memo is cleared when full), so the atlas is asked before a raster.
        const present = colour!.lookup(colourKey, frame);
        if (present) return { entry: present, rgba: true, rect: null };
        const made = raster.rasterise(req, geometry, slice, glyph);
        if (!budget.claimUpload(made.pixels.byteLength)) return { status: 'deferred' };
        auditCount(audit, 'text:mask-raster', 1, { px: made.w * made.h });
        const placed = colour!.place(colourKey, req.css, made.w, made.h, frame);
        if (placed === 'oversize') return { status: 'unsupported', why: 'oversize' };
        if (placed === 'denied') return { status: 'denied', pool: 'gpu', bytes: made.pixels.byteLength };
        colour!.upload(placed, made.pixels, made.w * 4);
        auditCount(audit, 'upload:mask', 1, { bytes: made.pixels.byteLength });
        recordStandIn(req, glyph, colour!, placed, geometry);
        return { entry: placed, rgba: true, rect: null };
    };

    /** A glyph fragment: its mask slices, each drawn as one quad at the origin's whole pixel plus the mask's offset. */
    const glyphs = (build: Build, item: PaintTextItem, A: readonly number[], frame: number, viewW: number, viewH: number, budget: FrameBudget, moving: boolean): Stop | null => {
        let glyph = 0;
        for (const line of item.paint.lines) for (const fragment of line.fragments) {
            const colourOf = item.material.glyphs[glyph++];
            if (!colourOf) return { status: 'unsupported', why: 'material' };
            const face = item.faces.faces[fragment.face];
            if (!face) return { status: 'unsupported', why: 'face' };
            if (!fragment.text || !(face.size > 0)) continue;
            // The glyph's space: 64 px font units, scaled by size/64, then the item's device map (paint2d's translate · scale).
            const k = face.size / 64;
            const req: MaskRequest = { epoch: item.paint.fontEpoch, css: face.css, text: fragment.text, rtl: fragment.rtl,
                a: A[0] * k, b: A[1] * k, c: A[2] * k, d: A[3] * k,
                x: A[0] * fragment.x + A[2] * line.baseline + A[4], y: A[1] * fragment.x + A[3] * line.baseline + A[5] };
            const measured = raster.measure(req);
            if (measured.status === 'empty') continue;
            if (measured.status !== 'ok') return { status: 'unsupported', why: measured.status === 'oversize' ? 'oversize' : measured.why };
            const geometry = measured.geometry;
            for (let slice = 0; slice < geometry.slices; slice++) {
                const found = sliceEntry(req, geometry, slice, colourOf, frame, budget, moving);
                if ('status' in found) return found;
                let x: number, y: number, w: number, h: number;
                if (found.rect) ({ x, y, w, h } = found.rect);
                else {
                    const sliceX = slice * 1024;
                    x = Math.floor(req.x) + geometry.left + sliceX; y = Math.floor(req.y) + geometry.top;
                    w = Math.min(1024, geometry.w - sliceX); h = geometry.h;
                }
                const e = found.entry;
                // A slice outside the view draws nothing: it is neither uploaded nor pinned by this run.
                if (x + w <= 0 || y + h <= 0 || x >= viewW || y >= viewH) continue;
                const u0 = e.x / ATLAS_PAGE, v0 = 1 - e.y / ATLAS_PAGE, u1 = (e.x + e.w) / ATLAS_PAGE, v1 = 1 - (e.y + e.h) / ATLAS_PAGE;
                // A colour run is tinted by nothing: its own colour is in the texels, so the instance carries white.
                if (!put(build, found.rgba ? 'colour' : 'mono', e.page.texture, x, y, w, h, u0, v0, u1, v1, found.rgba ? WHITE : colourOf)) return denied(build);
                widen(build, x, y, x + w, y + h);
                build.pins.push({ atlas: found.rgba ? colour! : mono!, entry: e });
            }
        }
        return null;
    };

    /** A font change (fontEpoch) makes every mask key new: the old faces' entries retire now and free as their pins drop. The
     * tiles that showed the old glyphs are dirtied by the parts' takeChanges (h2), not here. */
    const noteEpoch = (it: PaintTextItem): void => {
        if (it.paint.fontEpoch === seenEpoch) return;
        for (const face of it.faces.faces) { mono?.retireFace(face.css); colour?.retireFace(face.css); }
        colourRuns.clear(); colourAccount.reset(); standIns.clear();
        seenEpoch = it.paint.fontEpoch;
    };

    const item = (build: Build, it: PaintTextItem, frame: number, viewW: number, viewH: number, scale: number, view: { camera: { x: number; y: number }; moving: boolean }, budget: FrameBudget): Stop | null => {
        // Routes never clip: the composer applies the item's clips around whatever this draws.
        const [a, b, c, d, e, f] = it.localToWorld;
        // The item's device map: its local-to-world, then the view's camera and pixel scale (deviceAffine without the origin rebase).
        const A = [scale * a, scale * b, scale * c, scale * d, scale * (e - view.camera.x), scale * (f - view.camera.y)];
        return rects(build, it.paint.backgrounds, it.material.backgrounds, A, viewW, viewH)
            ?? glyphs(build, it, A, frame, viewW, viewH, budget, view.moving)
            ?? rects(build, it.paint.decorations, it.material.decorations, A, viewW, viewH);
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
            const build: Build = { count: 0, batches: [], pins: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
            const frame = budget.frameId;
            for (const it of items) {
                noteEpoch(it);
                const stop = item(build, it, frame, viewW, viewH, scale, view, budget);
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
            for (const pin of build.pins) pin.atlas.pin(pin.entry);
            const run: TextRun = { route: 'text', blend, device: owner, buffer, bufferLease: lease,
                batches: build.batches, pins: build.pins, viewW, viewH, scissor: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, bytes };
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
            if (!sampler) throw new Error('Text sampler missing');
            for (const batch of run.batches) {
                const pipeline = pipelines.get(`${batch.mode}-${run.blend}`);
                if (!pipeline) throw new Error('Text pipeline missing');
                pass.draw({ pipeline, bindings: { uniforms: [{ binding: 0, slice: uniforms }],
                    textures: [{ binding: 0, texture: batch.texture, sampler }] },
                    vertices: [{ buffer: run.buffer, offset: batch.first * INSTANCE_BYTES, bytes: batch.count * INSTANCE_BYTES }],
                    first: 0, count: 4, instances: batch.count, scissor: run.scissor });
            }
        },
        retire(prepared: PreparedRun): void { retireRun(prepared as TextRun); },
        release(): void { releaseGpu(); },
        evictTextures(bytes: number, frameId: number): number {
            // Mono pages first: they hold most of the bytes. A page pinned or drawn this frame is never freed.
            const freed = mono?.evict(bytes, frameId) ?? 0;
            return freed + (colour?.evict(Math.max(0, bytes - freed), frameId) ?? 0);
        },
        memory(): { gpuBytes: number; cpuBytes: number } {
            let gpuBytes = (mono?.bytes ?? 0) + (colour?.bytes ?? 0) + (whiteLease?.bytes ?? 0);
            for (const run of live) gpuBytes += run.bytes;
            const cpuBytes = (rasterLease?.bytes ?? 0) + (scratchLease?.bytes ?? 0) + (uniformLease?.bytes ?? 0) +
                measureAccount.bytes + colourAccount.bytes;
            return { gpuBytes, cpuBytes };
        },
    };
};
