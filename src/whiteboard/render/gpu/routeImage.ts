// The picture route: one quad per picture, sampled from the picture's own texture (imageTextures.ts). The shader does
// what the 2D canvas does to a picture: the crop, the invert, the opacity, and the antialiased edge of a rect that does
// not land on whole pixels (b39411ce, measured against the canvas2d control). Design: PLAN §4 gpu-h7, §3.2.
import type { Rect, ViewState } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import { isTileView } from '../../../platform/render/tileTarget';
import type { ByteLease, DrawableImage, DrawCommand, GfxDevice, GpuPass, PipelineHandle, RectI, SamplerHandle, ShaderModule, TextureHandle } from '../../../platform/render/gfx/api';
import { auditCount, PerDeviceMap } from '../../../platform/render/renderAudit';
import type { FrameBudget } from '../../../platform/render/types';
import type { PaintImageItem } from '../paintStream';
import type { PaintResources2d } from '../reference/paint2d';
import type { Admission, Blend, CreateImageRoute, ItemRoute, PreparedRun } from './contracts';
import { createImageTextures, IMAGE_FILTER, type ImageTexture, type ImageTextures } from './imageTextures';
import { VIDEO_FRAME_PREFIX } from '../../media/videoFrames';
import type { PaintImageHold } from '../reference/canvasPaintAdapter';
import { planPictureTiles, type PictureTileItem } from '../../media/tilePlan';
import { parseMediaTileKey } from '../../media/mips';
import { pictureLevelRefused } from '../../media/levelFloor';

/** The picture route as the composer sees it. `useResources` gives it the paint's image lookup for the revision being
 * composed: the ItemRoute contract has no place for it (see the report to gpu), so the composer binds it. */
export interface ImageRoute extends ItemRoute<PaintImageItem> {
    useResources(resources: PaintResources2d): void;
    /** Advances the uploads of finer tiles admit left out (once per frame, before the admits; tileComposer PictureRoute). */
    pump(budget: FrameBudget): void;
    /** The pane's screen this frame (tileComposer PictureRoute): a picture's finer tiles take their byte share from it. */
    setScreen(world: Rect | null): void;
    /** The finer picture tiles a run left out while their decode may still come; null when none. */
    waits(run: PreparedRun): readonly string[] | null;
    /** True while any of these tiles may still come (in flight, or skipped by this snapshot). */
    waiting(keys: readonly string[]): boolean;
    /** Frees picture textures nobody holds, least recently used first; returns bytes freed. For the governor (h9). */
    evictTextures(bytes: number, frameId: number): number;
    /** True when this device holds the picture's texture and no item of it is drawn on the CPU: its bitmap need not be decoded. */
    textureHeld(key: string): boolean;
}

/** One draw: a picture's texture over its device rect, its uniforms packed for the shader below. A pooled record, rewritten by
 * each admission that takes it: live parts (a playing video, a held picture during a drag) are admitted every frame, and each made
 * its own uniform block, texture binding, scissor and arrays (frame-path review). Its uniform block is leased with the CPU pool. */
interface ImageDraw {
    texture: TextureHandle | null;
    readonly scissor: { x: number; y: number; width: number; height: number };
    readonly uniforms: Float32Array<ArrayBuffer>;
    readonly lease: ByteLease;
}
/** A run's draws and holds, pooled with its arrays; the run handle itself is made per admission, so a retired one stays refused. */
/** `waits`: the finer picture tiles the run left out because their decode may still come (the composer recomposes once it has). */
interface RunBody { readonly calls: ImageDraw[]; readonly holds: string[]; readonly waits: string[] }
/** The vertex list of every picture draw: the quad comes from the vertex index, so there is nothing to bind. */
const NO_VERTICES: readonly never[] = [];

interface ImageRun extends PreparedRun {
    readonly route: 'image';
    readonly blend: Blend;
    readonly device: GfxDevice;
    /** Its draws and the image keys whose textures it holds; retire releases them once and returns the body (null after). */
    body: RunBody | null;
}

const UNIFORM_BYTES = 96;
/** The placeholder's 1×1 texture, charged at a small floor (it is a real allocation, however small). */
const BLANK_BYTES = 64;
/** Finer tile keys remembered as drawn (drawnTiles), a few dozen per large picture: past it the oldest is forgotten, and a live
 * draw that meets that tile again writes it whole on its first upload (firstPaint) instead of over the frame's allowance. */
const DRAWN_TILES_MAX = 4096;

/** Six vec4 uniforms, 24 floats: viewport (target px w, h, multiply flag, mode), destination, sourceRect (texel rect u0, v0, u1, v1),
 * params (texture w, h, opacity, invert), linear and offset. Three modes:
 * - 0, a picture whose affine is axis-aligned and unflipped (nearly every one): destination is its device rect x0, y0, x1, y1; the
 *   quad covers whole device pixels and every edge pixel is measured against the rect in the fragment, so the vertices need no
 *   antialiasing of their own. linear and offset are unused.
 * - 1, a placeholder (a picture the painter holds nothing for) samples no texture: destination is the box grown by half its frame,
 *   sourceRect the picture's own device rect and params.x half the frame's width.
 * - 2, any other affine (a rotation, a flip, a skew): destination is the rect in the item's LOCAL units, linear the local-to-device
 *   matrix (a, b, c, d: device = a·x + c·y, b·x + d·y) and offset its translation and the local pad (x, y) that grows the quad by a
 *   device pixel each side. The fragment measures its pixel's distance to each edge in device pixels, so the edge is antialiased as
 *   canvas2d antialiases a transformed drawImage, and samples the texel at its local point. Before it, such a picture went to the
 *   composer's CPU raster, which cannot draw a live part, so a rotated picture was missing while dragged and at most zooms. */
const IMAGE_SHADER: ShaderModule = {
    id: 'board-image-quad', revision: 3,
    layout: { uniforms: [{ binding: 0, byteSize: UNIFORM_BYTES }], textures: [{ binding: 0, format: 'rgba8' }], attributes: [] },
    glsl: {
        vertex: `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 {
    vec4 viewport;
    vec4 destination;
    vec4 sourceRect;
    vec4 params;
    vec4 linear;
    vec4 offset;
};
out vec2 pixel;
out vec2 local;
void main() {
    vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
    if (viewport.w > 1.5) {
        local = mix(destination.xy - offset.zw, destination.zw + offset.zw, corner);
        pixel = vec2(linear.x * local.x + linear.z * local.y, linear.y * local.x + linear.w * local.y) + offset.xy;
    } else {
        local = vec2(0.0);
        pixel = mix(floor(destination.xy), ceil(destination.zw), corner);
    }
    vec2 unit = pixel / viewport.xy;
    gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
}`,
        fragment: `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 {
    vec4 viewport;
    vec4 destination;
    vec4 sourceRect;
    vec4 params;
    vec4 linear;
    vec4 offset;
};
uniform sampler2D gfxTexture0;
in vec2 pixel;
in vec2 local;
layout(location=0) out vec4 gfxColour;
float inside(vec4 r) {
    vec2 c = clamp(min(pixel + 0.5, r.zw) - max(pixel - 0.5, r.xy), 0.0, 1.0);
    return c.x * c.y;
}
void main() {
    if (viewport.w > 0.5 && viewport.w < 1.5) {
        // canvas2d's placeholder (paint2d): a grey fill at 0.18 over the box and a grey frame at 0.7 centred on its edge, as exact
        // areas of the pixel: inside the inner box fill only, in the frame inside the box frame over fill, outside it frame only.
        float outer = inside(destination), box = inside(sourceRect);
        float core = inside(vec4(sourceRect.xy + params.x, sourceRect.zw - params.x));
        float alpha = core * 0.18 + (box - core) * (0.7 + 0.18 * 0.3) + (outer - box) * 0.7;
        float grey = 128.0 / 255.0;
        gfxColour = viewport.z > 0.5 ? vec4(vec3(1.0 - alpha * (1.0 - grey)), 1.0) : vec4(vec3(grey * alpha), alpha);
        return;
    }
    float coverage;
    vec2 unitPoint;
    if (viewport.w > 1.5) {
        // A local edge x = x0 runs along the device column (c, d): a point's device distance from it is its local distance times
        // |det| / |(c, d)|, and likewise for the y edges with (a, b). Each edge's coverage is the pixel's span across it, and a
        // corner takes the smaller of the two, as mode 0 does.
        float det = abs(linear.x * linear.w - linear.y * linear.z);
        vec2 perUnit = vec2(det / length(linear.zw), det / length(linear.xy));
        vec2 away = min(local - destination.xy, destination.zw - local) * perUnit;
        vec2 cover = clamp(away + 0.5, 0.0, 1.0);
        coverage = min(cover.x, cover.y);
        if (coverage <= 0.0) discard;
        unitPoint = clamp((local - destination.xy) / (destination.zw - destination.xy), 0.0, 1.0);
    } else {
        // The pixel's footprint is [pixel - 0.5, pixel + 0.5]. Its area inside the rect is the coverage; a corner takes the
        // smaller of its two edge coverages, not their product (b39411ce, the 0.55-scale corner).
        vec2 lo = max(pixel - 0.5, destination.xy);
        vec2 hi = min(pixel + 0.5, destination.zw);
        vec2 cover = clamp(hi - lo, 0.0, 1.0);
        coverage = min(cover.x, cover.y);
        // The 2D canvas drops an edge pixel covered under a quarter; an interior pixel has coverage 1 and is never dropped.
        if (coverage < 0.25) discard;
        // The texel is the picture's linear mapping of the centre of the pixel's visible span: the mean of the texels it covers.
        vec2 centre = (lo + hi) * 0.5;
        unitPoint = (centre - destination.xy) / (destination.zw - destination.xy);
    }
    vec2 texel = sourceRect.xy + unitPoint * (sourceRect.zw - sourceRect.xy);
    vec4 p = texture(gfxTexture0, vec2(texel.x / params.x, 1.0 - texel.y / params.y));
    if (params.w > 0.5 && p.a > 0.0) {
        // CSS invert(1) then hue-rotate(180deg) on the unpremultiplied colour. The hue matrix's rows sum to 1, so the
        // pair is exactly 1 - M·c.
        vec3 c = p.rgb / p.a;
        vec3 r = vec3(dot(vec3(-0.574, 1.430, 0.144), c), dot(vec3(0.426, 0.430, 0.144), c), dot(vec3(0.426, 1.430, -0.856), c));
        p = vec4(clamp(1.0 - r, 0.0, 1.0) * p.a, p.a);
    }
    float alpha = p.a * params.z * coverage;
    if (viewport.z > 0.5) {
        // A multiply slice: the blend is dst · src (rgb ZERO, SRC_COLOR), so the picture's source is 1 - a·(1 - c),
        // the canvas's multiply of c over white by its effective alpha a (c unpremultiplied).
        vec3 c = p.a > 0.0 ? p.rgb / p.a : vec3(0.0);
        gfxColour = vec4(1.0 - alpha * (1.0 - c), 1.0);
    } else {
        gfxColour = p * (params.z * coverage);
    }
}`,
    },
};

const unsupported = (why: string) => ({ status: 'unsupported' as const, why });

/** A device's picture pipelines and sampler, shared by every image route on it: the board's, and the drag preview's, which is made
 * when a drag starts. Compiled per route, the preview's first admission of a dragged picture waited for its own compile (the board's
 * were ready on the same device): a frame without the picture at every drag start. Kept while any route on the device uses them. */
interface DevicePipelines {
    over: PipelineHandle | null;
    modulate: PipelineHandle | null;
    readonly sampler: SamplerHandle;
    users: number;
    pending: number;
    failed: boolean;
    /** Each user's wake, called when a compile settles: any of them may be waiting for it. */
    readonly wakes: Set<(why: string) => void>;
}
// Keyed on the device behind a layer's audit view (PerDeviceMap): with the audit on, every layer host compiled its own set, which the
// product (one set per device) never does.
const devicePipelines = new PerDeviceMap<GfxDevice, DevicePipelines>();

export function createImageRoute(host: LayerHost, audit: string): ImageRoute {
    const textures: ImageTextures = createImageTextures(host, audit);
    let resources: PaintResources2d | null = null;
    let device: GfxDevice | null = null;
    // One pipeline per blend: 'over' is premultiplied source-over; 'modulate' is the multiply slice's fixed-function dst · src. The
    // device's, shared with its other image routes (DevicePipelines); null until this route first meets the device.
    let shared: DevicePipelines | null = null;
    const wake = (why: string): void => host.invalidate(why);
    // The paint's hold on picture bitmaps, when its resources carry one (the reference adapter's do; a dense plan's spread keeps it).
    let hold: PaintImageHold | null = null;
    // Pictures some item of THIS frame was refused for: their CPU draw needs the bitmap, so it is not released this frame.
    // Scoped to the frame: a picture refused once and then gone from the board kept its bitmap held for the whole session.
    const cpuKeys = new Set<string>();
    let cpuFrame = -1;
    // The pane's screen and an eighth of it each side (services.ts pictureTileWorld, canvas2d's picture world): the world whose tiles
    // set a picture's byte share, whatever tile is being composed. Null until the composer names it.
    let screen: Rect | null = null;
    // Finer tiles left out while their texture is written (admit); pump advances them each frame until they are up.
    const uploading = new Set<string>();
    // Finer tiles drawn from their texture at least once since the device came up, oldest first: only such a tile can be in a composed
    // tile beneath a live draw. Bounded (DRAWN_TILES_MAX, the oldest dropped), as a key here only decides an upload's pace.
    const drawnTiles = new Set<string>();
    const screenRing: Rect = { x: 0, y: 0, width: 0, height: 0 };
    // The pools: draw records and run bodies a retired run returned, taken again by the next admission. Never shrunk but on release.
    const freeDraws: ImageDraw[] = [], freeBodies: RunBody[] = [];
    const takeDraw = (): ImageDraw | null => {
        const pooled = freeDraws.pop();
        if (pooled) return pooled;
        const lease = host.allocator.cpu.reserve(UNIFORM_BYTES);
        if (!lease) return null;
        return { texture: null, scissor: { x: 0, y: 0, width: 0, height: 0 }, uniforms: new Float32Array(UNIFORM_BYTES / 4), lease };
    };
    const returnBody = (body: RunBody): void => {
        for (const call of body.calls) { call.texture = null; freeDraws.push(call); }
        body.calls.length = 0; body.holds.length = 0; body.waits.length = 0;
        freeBodies.push(body);
    };
    // The draw's one command, rewritten per picture: draw copies what it records, and uniformsInto rewrites the slice in place.
    const textureBinding: { binding: number; texture: TextureHandle; sampler: SamplerHandle } = { binding: 0, texture: null as unknown as TextureHandle, sampler: null as unknown as SamplerHandle };
    const uniformBinding: { binding: number; slice: ReturnType<LayerHost['uniforms']> } = { binding: 0, slice: null as unknown as ReturnType<LayerHost['uniforms']> };
    const command: { -readonly [K in keyof DrawCommand]: DrawCommand[K] } = { pipeline: null as unknown as PipelineHandle, vertices: NO_VERTICES, first: 0, count: 4, instances: 1,
        scissor: { x: 0, y: 0, width: 0, height: 0 }, bindings: { uniforms: [uniformBinding], textures: [textureBinding] } };
    /** A run refused before its items were admitted: every picture of it is a CPU draw candidate. */
    const refuseAll = (items: readonly PaintImageItem[], admission: Exclude<Admission<PreparedRun>, { status: 'ready' }>): Admission<PreparedRun> => {
        let waiting = false;
        for (const item of items) {
            cpuKeys.add(item.imageKey);
            if (hold && hold.imageState(item.imageKey) !== 'ready') { hold.reacquireImage(item.imageKey); waiting = true; }
        }
        return waiting ? { status: 'deferred' } : admission;
    };

    // A 1×1 texture bound by placeholder draws, whose shader branch samples nothing: a draw binds a texture whatever it reads.
    let blank: { readonly texture: TextureHandle; readonly lease: ByteLease } | null = null;
    const blankTexture = (current: GfxDevice): TextureHandle | null => {
        if (blank) return blank.texture;
        const lease = host.allocator.gpu.reserve(BLANK_BYTES);
        if (!lease) return null;
        try { blank = { texture: current.createTexture(1, 1, 'rgba8', ['sample'], lease), lease }; }
        catch (error) { host.allocator.gpu.release(lease); throw error; }
        return blank.texture;
    };
    const release = (): void => {
        cpuKeys.clear(); cpuFrame = -1; uploading.clear(); drawnTiles.clear();
        if (blank && device) { device.destroy(blank.texture); host.allocator.gpu.release(blank.lease); }
        blank = null;
        textures.release();
        for (const call of freeDraws) host.allocator.cpu.release(call.lease);
        freeDraws.length = 0; freeBodies.length = 0;
        const own = shared, owner = device;
        shared = null;
        if (own && owner) {
            own.wakes.delete(wake);
            // The last route on the device takes the pipelines and sampler with it; a compile still in flight is destroyed on arrival.
            if (--own.users === 0) {
                devicePipelines.delete(owner);
                if (own.over) owner.destroy(own.over);
                if (own.modulate) owner.destroy(own.modulate);
                owner.destroy(own.sampler);
                own.over = null; own.modulate = null;
            }
        }
        device = null;
    };

    // Pipelines compile asynchronously; a run is admitted only once both exist. A generation change drops everything.
    const warm = (current: GfxDevice): DevicePipelines => {
        if (device !== current) { release(); device = current; }
        if (shared) return shared;
        let entry = devicePipelines.get(current);
        if (!entry) {
            entry = { over: null, modulate: null, sampler: current.createSampler(IMAGE_FILTER), users: 0, pending: 0, failed: false, wakes: new Set() };
            devicePipelines.set(current, entry);
        }
        entry.users++; entry.wakes.add(wake); shared = entry;
        if (entry.failed || entry.pending > 0 || (entry.over && entry.modulate)) return entry;
        const target = entry;
        const compile = (blend: Blend, onReady: (handle: PipelineHandle) => void) => {
            target.pending++;
            current.createPipeline({ shader: IMAGE_SHADER, topology: 'triangle-strip', colorFormat: 'rgba8', samples: 1,
                blend: blend === 'modulate' ? 'modulate' : 'source-over', alphaToCoverage: false,
                colorWrite: [true, true, true, true], stencil: { enabled: false } })
                .then(value => {
                    target.pending--;
                    // Every user left (or the device was released) while it compiled: nobody will draw with it.
                    if (target.users === 0) { current.destroy(value); return; }
                    onReady(value);
                    for (const notify of target.wakes) notify('image-pipeline-ready');
                }, () => {
                    target.pending--; target.failed = true;
                    auditCount(audit, 'image:pipeline-failed');
                    for (const notify of target.wakes) notify('image-pipeline-failed');
                });
        };
        if (!entry.over) compile('over', handle => { target.over = handle; });
        if (!entry.modulate) compile('modulate', handle => { target.modulate = handle; });
        return entry;
    };

    return {
        id: 'image',
        accepts(item): item is PaintImageItem { return item.kind === 'image'; },
        admit(items: readonly PaintImageItem[], view: ViewState, blend: Blend, budget: FrameBudget): Admission<PreparedRun> {
            if (budget.frameId !== cpuFrame) { cpuKeys.clear(); cpuFrame = budget.frameId; }
            const current = host.device();
            if (!current) return refuseAll(items, unsupported('no-device'));
            if (current.generation !== budget.token.deviceGeneration || host.generation !== budget.token.deviceGeneration) return { status: 'deferred' };
            if (!resources) throw new Error('The image route has no paint resources: useResources must run before admit');
            const paint = resources;
            const pipes = warm(current);
            if (pipes.failed) return refuseAll(items, unsupported('pipeline-failed'));
            if (!pipes.over || !pipes.modulate) return { status: 'deferred' };
            const multiply = blend === 'modulate' ? 1 : 0;

            const scale = view.camera.z * view.viewport.dpr;
            const targetWidth = Math.round(view.viewport.width * view.viewport.dpr), targetHeight = Math.round(view.viewport.height * view.viewport.dpr);
            const body = freeBodies.pop() ?? { calls: [], holds: [], waits: [] };
            const { calls, holds, waits } = body;
            // All or nothing: a refused picture takes the whole run to the composer, so the holds taken so far are returned.
            const reject = (admission: Exclude<Admission<PreparedRun>, { status: 'ready' }>): Admission<PreparedRun> => {
                for (const key of holds) textures.unhold(key);
                returnBody(body);
                return admission;
            };
            // A refusal is a CPU draw of the picture, and the CPU draws it from its bitmap: a released bitmap is asked for again
            // first, and the picture waits for it (deferred), so the CPU never meets a released one.
            const refuse = (key: string, admission: Exclude<Admission<PreparedRun>, { status: 'ready' }>): Admission<PreparedRun> => {
                cpuKeys.add(key);
                if (hold && hold.imageState(key) !== 'ready') { hold.reacquireImage(key); return reject({ status: 'deferred' }); }
                return reject(admission);
            };
            /** canvas2d's placeholder for a picture held as nothing: the box where it sits and a hairline frame, drawn without the
             * picture's opacity or invert (paint2d). The frame is a 400th of the box's larger side, centred on its edge. */
            const placeholder = (item: PaintImageItem, onDevice: GfxDevice): 'drawn' | 'outside' | 'denied' | 'no-draw' => {
                const [a, , , d, e, f] = item.localToWorld, rect = item.rect;
                const x0 = (e + a * rect.x - view.camera.x) * scale, y0 = (f + d * rect.y - view.camera.y) * scale;
                const x1 = x0 + a * rect.width * scale, y1 = y0 + d * rect.height * scale;
                const half = Math.max(x1 - x0, y1 - y0) / 800;
                const left = Math.max(0, Math.floor(x0 - half)), top = Math.max(0, Math.floor(y0 - half));
                const right = Math.min(targetWidth, Math.ceil(x1 + half)), bottom = Math.min(targetHeight, Math.ceil(y1 + half));
                if (right <= left || bottom <= top) return 'outside';
                const texture = blankTexture(onDevice);
                if (!texture) return 'denied';
                const call = takeDraw();
                if (!call) return 'no-draw';
                calls.push(call);
                const u = call.uniforms;
                u[0] = targetWidth; u[1] = targetHeight; u[2] = multiply; u[3] = 1;
                u[4] = x0 - half; u[5] = y0 - half; u[6] = x1 + half; u[7] = y1 + half;
                u[8] = x0; u[9] = y0; u[10] = x1; u[11] = y1;
                u[12] = half; u[13] = 0; u[14] = 1; u[15] = 0;
                call.texture = texture;
                call.scissor.x = left; call.scissor.y = top; call.scissor.width = right - left; call.scissor.height = bottom - top;
                auditCount(audit, 'image:placeholder');
                return 'drawn';
            };
            /** One picture drawn: the item's own (`tile` absent), or a finer tile the route planned over it. Null when it drew or was
             * left out; else the admission the run ends with. */
            const place = (item: PaintImageItem, tile: PictureTileItem | null): Admission<PreparedRun> | null => {
                const rect = tile ? tile.rect : item.rect, key = tile ? tile.key : item.imageKey;
                const [a, b, c, d, e, f] = item.localToWorld;
                // Axis-aligned and unflipped: the device rect is the affine's scale and translation applied to the rect (mode 0).
                const axis = b === 0 && c === 0 && a > 0 && d > 0;
                // A video node is one live picture: its key is stable and its lease names the frame it shows now. The node's
                // texture is the picture, re-uploaded only when that version moves; the frame is the registry's, never released here.
                const video = key.startsWith(VIDEO_FRAME_PREFIX);
                let admitted: Admission<ImageTexture>;
                if (video) {
                    const fact = hold ? hold.imageFact(key) : null;
                    if (hold && !fact) { hold.reacquireImage(key); return reject({ status: 'deferred' }); }
                    if (!fact) return refuse(key, unsupported('video-without-hold'));
                    const source = paint.image(key);
                    // Null: the painter holds no picture for the key (a broken or memory-skipped picture, canvasPaintAdapter).
                    if (!source || !isDrawable(source)) return refuse(key, unsupported('video-source'));
                    admitted = textures.acquireVideo(key, { version: fact.version, source, width: fact.width, height: fact.height }, budget);
                } else {
                    const state = hold ? hold.imageState(key) : 'ready';
                    if (tile && state !== 'ready' && textures.needsSource(key)) {
                        // A finer tile still decoding (or skipped for memory this snapshot) is left out, the item under it shows, and
                        // the composer recomposes this tile once the decode has settled (waits). Holding the run for it held the
                        // picture's whole tile, stand-in and all, for every decode.
                        hold?.reacquireImage(key);
                        if (hold?.imageWaiting(key)) waits.push(key);
                        auditCount(audit, 'image:tile:waiting');
                        return null;
                    }
                    if (state !== 'ready' && hold?.imageBroken(key)) {
                        // The painter will never hold this picture (its bytes could not be decoded), so asking again changes nothing:
                        // waiting for it left a hole for good, and held every picture of the run with it. A texture it drew before still
                        // draws; else a tile over the picture's stand-in is left out (the stand-in shows), and a whole picture gets
                        // canvas2d's placeholder. A picture skipped for memory keeps waiting: the next snapshot asks for it again (and
                        // a refused tile level is planned coarser), so a placeholder composed into its tile would stay there.
                        const kept = textures.acquire(key, null, budget);
                        if (kept.status === 'ready') admitted = kept;
                        else if (tile || item.underlaid) { auditCount(audit, 'image:underlaid-absent'); return null; }
                        // The placeholder here is axis-aligned; a transformed one is canvas2d's own, in the item's frame (paint2d), which
                        // the CPU raster paints with no bitmap. Rejected, not refused: a refusal would wait for a bitmap that never comes.
                        else if (!axis) return reject(unsupported('transform-placeholder'));
                        else {
                            const placed = placeholder(item, current);
                            if (placed === 'denied') return reject({ status: 'denied', pool: 'gpu', bytes: BLANK_BYTES });
                            if (placed === 'no-draw') return reject({ status: 'denied', pool: 'cpu', bytes: UNIFORM_BYTES });
                            return null;
                        }
                    } else {
                        if (hold && state !== 'ready' && textures.needsSource(key)) { hold.reacquireImage(key); return reject({ status: 'deferred' }); }
                        // Written whole on its first upload: the picture itself (not a finer tile over its stand-in, nor an underlaid
                        // one), since nothing shows without it; and in a live draw a finer tile never drawn, since a live run is drawn
                        // all or none, so its upload held the whole picture back. An inserted picture is drawn live over the positions it
                        // made dirty, and its finer tiles' uploads share the frame's allowance with the paper's and the page's (measured,
                        // a 4000x3000 insert at DPR 2: notebook 1124 vs canvas2d 1006 ms, PDF 1012 vs 844; written whole, notebook 957
                        // vs 945). A tile drawn before keeps the allowance: the composed tiles beneath the live draw show it meanwhile.
                        const firstPaint = tile ? !isTileView(view) && !drawnTiles.has(key) : !item.underlaid;
                        admitted = textures.acquire(key, state === 'ready' ? paint.image(key) : null, budget, firstPaint);
                    }
                }
                if (admitted.status === 'empty') return null;
                if (admitted.status === 'unsupported') return refuse(key, admitted);
                if (admitted.status !== 'ready') {
                    // A composed tile leaves a finer tile whose texture is still being written out: the picture under it draws now,
                    // and the route finishes the upload itself (pump), after which the composer recomposes the tile once (waits).
                    // Deferring the run for it held the whole picture back, stand-in and all, until every finer tile was up (measured,
                    // a 4000x3000 insert at DPR 2: the picture showed 170 ms after its stand-in's texture, 1054 ms vs canvas2d's 972).
                    // A live draw (a selected picture over its own composed tiles) still defers: drawn now it laid the stand-in over
                    // the sharp tiles beneath it until its own textures were up (the 8000x6000 grid flat in 2 of 4 runs), whereas
                    // dropped for the frame it lets those tiles show. Its first textures are written whole (firstPaint, above).
                    if (tile && admitted.status === 'deferred' && isTileView(view) && hold?.imageState(key) === 'ready') {
                        uploading.add(key); waits.push(key);
                        auditCount(audit, 'image:tile:upload-wait');
                        return null;
                    }
                    // The GPU pool refused a finer tile: the next plan of the picture at this zoom takes a coarser level, as the CPU
                    // pool's refusal does (canvasPaintAdapter), so the picture sharpens as far as the GPU pool allows.
                    if (tile && admitted.status === 'denied' && admitted.pool === 'gpu') {
                        const parsed = parseMediaTileKey(key);
                        if (pictureLevelRefused(parsed.id, parsed.level)) auditCount(audit, 'image:tile:level-refused');
                    }
                    return reject(admitted);
                }
                holds.push(key);
                if (tile && !drawnTiles.has(key)) {
                    drawnTiles.add(key);
                    if (drawnTiles.size > DRAWN_TILES_MAX) drawnTiles.delete(drawnTiles.values().next().value!);
                }
                // The texture holds the pixels now, so the bitmap is no longer needed. A picture some item of it was refused
                // for stays held: its CPU draw needs the bitmap.
                if (!video && hold && !cpuKeys.has(key) && hold.imageState(key) === 'ready') hold.releaseImage(key);
                const tex = admitted.value;

                const src = (tile ? tile.sourceRect : item.sourceRect) ?? { x: 0, y: 0, width: tex.sourceWidth, height: tex.sourceHeight };
                if (!(src.width > 0 && src.height > 0) || src.x < 0 || src.y < 0 || src.x + src.width > tex.sourceWidth || src.y + src.height > tex.sourceHeight) {
                    return refuse(key, unsupported('crop'));
                }
                // The device rect of the picture, fractional: the shader measures the pixels it covers. A transformed picture's
                // scissor is its quad's device box, grown by the pixel of pad its edge antialiasing covers (mode 2).
                const la = a * scale, lb = b * scale, lc = c * scale, ld = d * scale;
                const tx = (e - view.camera.x) * scale, ty = (f - view.camera.y) * scale;
                const padX = axis ? 0 : 1 / Math.hypot(la, lb), padY = axis ? 0 : 1 / Math.hypot(lc, ld);
                let x0: number, y0: number, x1: number, y1: number;
                if (axis) {
                    x0 = tx + la * rect.x; y0 = ty + ld * rect.y; x1 = x0 + la * rect.width; y1 = y0 + ld * rect.height;
                } else {
                    if (!Number.isFinite(padX) || !Number.isFinite(padY)) return null;
                    x0 = y0 = Infinity; x1 = y1 = -Infinity;
                    for (const lx of [rect.x - padX, rect.x + rect.width + padX]) for (const ly of [rect.y - padY, rect.y + rect.height + padY]) {
                        const px = tx + la * lx + lc * ly, py = ty + lb * lx + ld * ly;
                        x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
                    }
                }
                const left = Math.max(0, Math.floor(x0)), top = Math.max(0, Math.floor(y0));
                const right = Math.min(targetWidth, Math.ceil(x1)), bottom = Math.min(targetHeight, Math.ceil(y1));
                if (right <= left || bottom <= top) return null;
                // The crop in source pixels, as texels of the texture (which is smaller only when the source was downscaled).
                const kx = tex.width / tex.sourceWidth, ky = tex.height / tex.sourceHeight;
                const call = takeDraw();
                if (!call) return reject({ status: 'denied', pool: 'cpu', bytes: UNIFORM_BYTES });
                calls.push(call);
                const u = call.uniforms;
                u[0] = targetWidth; u[1] = targetHeight; u[2] = multiply; u[3] = axis ? 0 : 2;
                if (axis) { u[4] = x0; u[5] = y0; u[6] = x1; u[7] = y1; }
                else { u[4] = rect.x; u[5] = rect.y; u[6] = rect.x + rect.width; u[7] = rect.y + rect.height; }
                u[16] = la; u[17] = lb; u[18] = lc; u[19] = ld; u[20] = tx; u[21] = ty; u[22] = padX; u[23] = padY;
                u[8] = src.x * kx; u[9] = src.y * ky; u[10] = (src.x + src.width) * kx; u[11] = (src.y + src.height) * ky;
                u[12] = tex.width; u[13] = tex.height; u[14] = item.opacity; u[15] = item.inverted ? 1 : 0;
                call.texture = tex.texture;
                call.scissor.x = left; call.scissor.y = top; call.scissor.width = right - left; call.scissor.height = bottom - top;
                return null;
            };
            for (const item of items) {
                const { rect } = item;
                if (!(rect.width > 0 && rect.height > 0) || !(item.opacity > 0)) continue;
                const [a, b, c, d] = item.localToWorld;
                // Any invertible affine is drawn here (mode 2 for any other than axis-aligned); a degenerate one draws nothing.
                if (!(Math.abs(a * d - b * c) > 0) || ![a, b, c, d, item.localToWorld[4], item.localToWorld[5]].every(Number.isFinite)) continue;
                // Routes never clip (gpu's rule): the composer applies the item's clips around this draw.
                if (item.retainedTile) return refuse(item.imageKey, unsupported('retained'));
                // The stream's own finer tiles (planned for its request's world, which a pan inside it outlives) are left to the
                // picture's item, which plans this view's tiles itself (below): an underlaid tile always follows its stand-in.
                if (item.underlaid && hold) { auditCount(audit, 'image:underlaid-replanned'); continue; }
                const ended = place(item, null);
                if (ended) return ended;
                const facts = item.picture;
                if (!facts || !hold) continue;
                // The picture's finer tiles for this view (a composed tile's world, or the pane's for a live draw), planned as canvas2d
                // plans its screen: the same function, level, byte share (the screen's) and tile keys, so both share one residency.
                const world: Rect = { x: view.camera.x, y: view.camera.y, width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z };
                const planned = planPictureTiles(facts.box, facts.media, item.localToWorld, { deviceScale: scale, world,
                    ...(screen ? { shareWorld: screen } : {}) }, facts.crop);
                if (!planned) continue;
                for (const tile of planned) {
                    // Only tiles finer than the item itself: the plan's own stand-in is this item or coarser.
                    if (parseMediaTileKey(tile.key).level >= facts.level) continue;
                    const tileEnded = place(item, tile);
                    if (tileEnded) return tileEnded;
                }
            }
            if (calls.length === 0) {
                for (const key of holds) textures.unhold(key);
                returnBody(body);
                return { status: 'empty' };
            }
            const run: ImageRun = { route: 'image', blend, device: current, body };
            return { status: 'ready', value: run };
        },
        draw(pass: GpuPass, run: PreparedRun): void {
            const own = run as ImageRun;
            const drawPipeline = own.blend === 'modulate' ? shared?.modulate : shared?.over, drawSampler = shared?.sampler;
            const body = own.body;
            if (!drawPipeline || !drawSampler || device !== own.device || !body) throw new Error('Stale image run');
            // The route's one command, rewritten per draw: draw copies what it records, and uniformsInto rewrites the uniform slice
            // in place, so a run of N pictures takes one uniform slice and allocates no command.
            const head = body.calls[0];
            if (!head) return;
            const cmd = command;
            cmd.pipeline = drawPipeline;
            uniformBinding.slice = host.uniforms(head.uniforms);
            textureBinding.sampler = drawSampler;
            for (const call of body.calls) {
                if (call !== head) host.uniformsInto(call.uniforms, uniformBinding.slice);
                textureBinding.texture = call.texture!;
                cmd.scissor = call.scissor;
                pass.draw(cmd);
            }
            auditCount(audit, 'route:image', body.calls.length);
        },
        retire(run: PreparedRun): void {
            const own = run as ImageRun;
            const body = own.body;
            if (!body) return;
            own.body = null;
            for (const key of body.holds) textures.unhold(key);
            returnBody(body);
        },
        // The composer's release also lets go of the paint's resources, which reach its whole prepared paint (every stroke's geometry):
        // its next prepare hands them over again. Kept, they held a hidden 10,060-stroke drawing's geometry (measured, heap snapshot of
        // the hidden pane). Not in `release` itself, which a new device runs from inside useResources.
        release(): void { release(); resources = null; hold = null; },
        memory(): { gpuBytes: number; cpuBytes: number } { return textures.memory(); },
        useResources(next: PaintResources2d): void {
            resources = next; hold = imageHoldOf(next);
            // The pipelines compile before the first picture is admitted: compiled at its first admission (the frame its decode
            // lands, on a board that had none), they held an inserted picture back two to three frames behind canvas2d (measured, a
            // 4000x3000 insert at DPR 2: image-pipeline-ready 42 ms after the decode's frame). Shared by the device's image routes.
            const current = host.device();
            if (current && current.generation === host.generation) warm(current);
        },
        pump(budget: FrameBudget): void {
            if (!uploading.size) return;
            const current = host.device(), paint = resources, own = hold;
            if (!current || !paint || !own || current.generation !== budget.token.deviceGeneration || host.generation !== budget.token.deviceGeneration) return;
            for (const key of uploading) {
                // A tile whose bitmap went before its upload finished (a CPU trim, a new snapshot) is asked for again now: its landing
                // invalidates, and the composer's wait for it (awaitingDecode) starts the upload again. Left to the next compose that
                // plans it, at rest none came: a drawing shown again after a tab switch kept its picture's stand-in for good (measured,
                // a 4000x3000 picture at DPR 2: 5 tile uploads started, 2 finished, one CPU trim of the board's pictures between).
                if (own.imageState(key) !== 'ready') { uploading.delete(key); own.reacquireImage(key); auditCount(audit, 'image:tile:upload-lost'); continue; }
                const admitted = textures.acquire(key, paint.image(key), budget);
                if (admitted.status === 'deferred') continue;
                uploading.delete(key);
                if (admitted.status === 'ready') {
                    textures.unhold(key);
                    if (!cpuKeys.has(key)) own.releaseImage(key);
                    auditCount(audit, 'image:tile:upload-done');
                }
            }
            // An upload in progress is work done each frame, not a wait: it asks for the next one until it is up.
            if (uploading.size) host.invalidate('image-tile-upload');
        },
        setScreen(world: Rect | null): void {
            if (!world) { screen = null; return; }
            // Copied into the route's own rect: the composer rewrites the one it names every frame.
            const mx = world.width / 8, my = world.height / 8;
            screenRing.x = world.x - mx; screenRing.y = world.y - my; screenRing.width = world.width + 2 * mx; screenRing.height = world.height + 2 * my;
            screen = screenRing;
        },
        waits(run: PreparedRun): readonly string[] | null {
            const body = (run as ImageRun).body;
            return body && body.waits.length ? body.waits : null;
        },
        waiting(keys: readonly string[]): boolean {
            // No hold (no resources this paint) cannot tell: still waiting, or the entry would recompose on its stand-in for nothing.
            const current = hold;
            if (current === null) return true;
            // A key whose decode landed after its tile composed has no texture yet: its upload starts here (pump), so the tile
            // recomposes once, when its textures are up. Answered ready instead, the recompose found the texture still waiting on
            // the frame's upload allowance and recomposed again after it (gpu-f1: 16 recomposes for 27 waits, a dropped 8000x6000).
            // Only a start asks for a frame here: pump asks for the rest while its uploads progress.
            let waits = false, started = false;
            for (const key of keys) {
                if (uploading.has(key) || current.imageWaiting(key)) waits = true;
                else if (current.imageState(key) === 'ready' && textures.needsSource(key)) { uploading.add(key); waits = started = true; auditCount(audit, 'image:tile:upload-start'); }
            }
            if (started) host.invalidate('image-tile-upload');
            return waits;
        },
        evictTextures(bytes: number, frameId: number): number { return textures.evict(bytes, frameId); },
        // A video's texture is one frame of a picture that moves: its frame is always read. A key some item of which the CPU route
        // draws needs its bitmap (the route keeps those held).
        textureHeld(key: string): boolean { return !key.startsWith(VIDEO_FRAME_PREFIX) && !cpuKeys.has(key) && !textures.needsSource(key); },
    };
}

/** The paint's picture hold, when the resources carry one: a structural check, so a resources object without it simply keeps every bitmap. */
function imageHoldOf(resources: PaintResources2d): PaintImageHold | null {
    const candidate = resources as Partial<PaintImageHold>;
    return typeof candidate.imageState === 'function' && typeof candidate.releaseImage === 'function' && typeof candidate.reacquireImage === 'function'
        && typeof candidate.imageFact === 'function' && typeof candidate.imageBroken === 'function' && typeof candidate.imageWaiting === 'function'
        ? candidate as PaintImageHold : null;
}

/** A source the device reads directly: a bitmap, or a video frame. */
function isDrawable(source: CanvasImageSource): source is DrawableImage {
    return (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) || (typeof VideoFrame !== 'undefined' && source instanceof VideoFrame);
}

/** The factory the contract names (contracts.ts CreateImageRoute): a compile-time check that the route matches it. */
export const imageRouteFactory: CreateImageRoute = createImageRoute;
