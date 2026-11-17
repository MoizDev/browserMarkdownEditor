// The picture route: one quad per picture, sampled from the picture's own texture (imageTextures.ts). The shader does
// what the 2D canvas does to a picture: the crop, the invert, the opacity, and the antialiased edge of a rect that does
// not land on whole pixels (b39411ce, measured against the canvas2d control). Design: PLAN §4 gpu-h7, §3.2.
import type { ViewState } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { GfxDevice, GpuPass, PipelineHandle, RectI, SamplerHandle, ShaderModule, TextureHandle } from '../../../platform/render/gfx/api';
import { auditCount } from '../../../platform/render/renderAudit';
import type { FrameBudget } from '../../../platform/render/types';
import type { PaintImageItem } from '../paintStream';
import type { PaintResources2d } from '../reference/paint2d';
import type { Admission, Blend, CreateImageRoute, ItemRoute, PreparedRun } from './contracts';
import { createImageTextures, IMAGE_FILTER, type ImageTextures } from './imageTextures';
import type { PaintImageHold } from '../reference/canvasPaintAdapter';

/** The picture route as the composer sees it. `useResources` gives it the paint's image lookup for the revision being
 * composed: the ItemRoute contract has no place for it (see the report to gpu), so the composer binds it. */
export interface ImageRoute extends ItemRoute<PaintImageItem> {
    useResources(resources: PaintResources2d): void;
    /** Frees picture textures nobody holds, least recently used first; returns bytes freed. For the governor (h9). */
    evictTextures(bytes: number, frameId: number): number;
}

/** One draw: a picture's texture over its device rect, its uniforms packed for the shader below. */
interface ImageDraw {
    readonly texture: TextureHandle;
    readonly scissor: RectI;
    readonly uniforms: Float32Array;
}

interface ImageRun extends PreparedRun {
    readonly route: 'image';
    readonly blend: Blend;
    readonly device: GfxDevice;
    readonly calls: readonly ImageDraw[];
    /** Image keys whose textures this run holds; retire releases them once. */
    readonly holds: readonly string[];
    retired: boolean;
}

const UNIFORM_BYTES = 64;

/** Four vec4 uniforms, 16 floats: viewport (target px w, h, multiply flag), destination (device rect x0, y0, x1, y1), sourceRect (texel
 * rect u0, v0, u1, v1), params (texture w, h, opacity, invert). The quad covers whole device pixels; every edge pixel is
 * measured against the rect in the fragment, so the vertices need no antialiasing of their own. */
const IMAGE_SHADER: ShaderModule = {
    id: 'board-image-quad', revision: 1,
    layout: { uniforms: [{ binding: 0, byteSize: UNIFORM_BYTES }], textures: [{ binding: 0, format: 'rgba8' }], attributes: [] },
    glsl: {
        vertex: `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 {
    vec4 viewport;
    vec4 destination;
    vec4 sourceRect;
    vec4 params;
};
out vec2 pixel;
void main() {
    vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
    pixel = mix(floor(destination.xy), ceil(destination.zw), corner);
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
};
uniform sampler2D gfxTexture0;
in vec2 pixel;
layout(location=0) out vec4 gfxColour;
void main() {
    // The pixel's footprint is [pixel - 0.5, pixel + 0.5]. Its area inside the rect is the coverage; a corner takes the
    // smaller of its two edge coverages, not their product (b39411ce, the 0.55-scale corner).
    vec2 lo = max(pixel - 0.5, destination.xy);
    vec2 hi = min(pixel + 0.5, destination.zw);
    vec2 cover = clamp(hi - lo, 0.0, 1.0);
    float coverage = min(cover.x, cover.y);
    // The 2D canvas drops an edge pixel covered under a quarter; an interior pixel has coverage 1 and is never dropped.
    if (coverage < 0.25) discard;
    // The texel is the picture's linear mapping of the centre of the pixel's visible span: the mean of the texels it covers.
    vec2 centre = (lo + hi) * 0.5;
    vec2 texel = sourceRect.xy + (centre - destination.xy) / (destination.zw - destination.xy) * (sourceRect.zw - sourceRect.xy);
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

export function createImageRoute(host: LayerHost, audit: string): ImageRoute {
    const textures: ImageTextures = createImageTextures(host, audit);
    let resources: PaintResources2d | null = null;
    let device: GfxDevice | null = null, sampler: SamplerHandle | null = null;
    // One pipeline per blend: 'over' is premultiplied source-over; 'modulate' is the multiply slice's fixed-function dst · src.
    let overPipeline: PipelineHandle | null = null, modulatePipeline: PipelineHandle | null = null;
    let pending = 0, failed = false, incarnation = 0;
    // The paint's hold on picture bitmaps, when its resources carry one (the reference adapter's do; a dense plan's spread keeps it).
    let hold: PaintImageHold | null = null;
    // Pictures some item was refused for: their CPU draw needs the bitmap, so the bitmap is never released for them.
    const cpuKeys = new Set<string>();
    /** A run refused before its items were admitted: every picture of it is a CPU draw candidate. */
    const refuseAll = (items: readonly PaintImageItem[], admission: Exclude<Admission<PreparedRun>, { status: 'ready' }>): Admission<PreparedRun> => {
        let waiting = false;
        for (const item of items) {
            cpuKeys.add(item.imageKey);
            if (hold && hold.imageState(item.imageKey) !== 'ready') { hold.reacquireImage(item.imageKey); waiting = true; }
        }
        return waiting ? { status: 'deferred' } : admission;
    };

    const release = (): void => {
        incarnation++;
        textures.release();
        if (device) {
            if (overPipeline) device.destroy(overPipeline);
            if (modulatePipeline) device.destroy(modulatePipeline);
            if (sampler) device.destroy(sampler);
        }
        device = null; overPipeline = null; modulatePipeline = null; sampler = null; pending = 0; failed = false;
    };

    // Pipelines compile asynchronously; a run is admitted only once both exist. A generation change drops everything.
    const warm = (current: GfxDevice): void => {
        if (device !== current) { release(); device = current; }
        if (failed || pending > 0 || (overPipeline && modulatePipeline)) return;
        sampler ??= current.createSampler(IMAGE_FILTER);
        const serial = ++incarnation;
        const compile = (blend: Blend, onReady: (handle: PipelineHandle) => void) => {
            pending++;
            current.createPipeline({ shader: IMAGE_SHADER, topology: 'triangle-strip', colorFormat: 'rgba8', samples: 1,
                blend: blend === 'modulate' ? 'modulate' : 'source-over', alphaToCoverage: false,
                colorWrite: [true, true, true, true], stencil: { enabled: false } })
                .then(value => {
                    if (incarnation !== serial || device !== current) { current.destroy(value); return; }
                    pending--; onReady(value);
                    host.invalidate('image-pipeline-ready');
                }, () => {
                    if (incarnation !== serial) return;
                    pending--; failed = true;
                    auditCount(audit, 'image:pipeline-failed');
                    host.invalidate('image-pipeline-failed');
                });
        };
        if (!overPipeline) compile('over', handle => { overPipeline = handle; });
        if (!modulatePipeline) compile('modulate', handle => { modulatePipeline = handle; });
    };

    return {
        id: 'image',
        accepts(item): item is PaintImageItem { return item.kind === 'image'; },
        admit(items: readonly PaintImageItem[], view: ViewState, blend: Blend, budget: FrameBudget): Admission<PreparedRun> {
            const current = host.device();
            if (!current) return refuseAll(items, unsupported('no-device'));
            if (current.generation !== budget.token.deviceGeneration || host.generation !== budget.token.deviceGeneration) return { status: 'deferred' };
            if (!resources) throw new Error('The image route has no paint resources: useResources must run before admit');
            warm(current);
            if (failed) return refuseAll(items, unsupported('pipeline-failed'));
            if (!overPipeline || !modulatePipeline || !sampler) return { status: 'deferred' };
            const multiply = blend === 'modulate' ? 1 : 0;

            const scale = view.camera.z * view.viewport.dpr;
            const targetWidth = Math.round(view.viewport.width * view.viewport.dpr), targetHeight = Math.round(view.viewport.height * view.viewport.dpr);
            const calls: ImageDraw[] = [], holds: string[] = [];
            // All or nothing: a refused picture takes the whole run to the composer, so the holds taken so far are returned.
            const reject = (admission: Exclude<Admission<PreparedRun>, { status: 'ready' }>): Admission<PreparedRun> => {
                for (const key of holds) textures.unhold(key);
                return admission;
            };
            // A refusal is a CPU draw of the picture, and the CPU draws it from its bitmap: a released bitmap is asked for again
            // first, and the picture waits for it (deferred), so the CPU never meets a released one.
            const refuse = (key: string, admission: Exclude<Admission<PreparedRun>, { status: 'ready' }>): Admission<PreparedRun> => {
                cpuKeys.add(key);
                if (hold && hold.imageState(key) !== 'ready') { hold.reacquireImage(key); return reject({ status: 'deferred' }); }
                return reject(admission);
            };
            for (const item of items) {
                const { rect } = item;
                if (!(rect.width > 0 && rect.height > 0) || !(item.opacity > 0)) continue;
                const [a, b, c, d, e, f] = item.localToWorld;
                // Axis-aligned and unflipped: the device rect is the affine's scale and translation applied to the rect.
                if (b !== 0 || c !== 0 || !(a > 0) || !(d > 0)) return refuse(item.imageKey, unsupported('transform'));
                // Routes never clip (gpu's rule): the composer applies the item's clips around this draw.
                if (item.retainedTile) return refuse(item.imageKey, unsupported('retained'));
                const key = item.imageKey;
                const state = hold ? hold.imageState(key) : 'ready';
                if (hold && state !== 'ready' && textures.needsSource(key)) { hold.reacquireImage(key); return reject({ status: 'deferred' }); }
                const admitted = textures.acquire(key, state === 'ready' ? resources.image(key) : null, budget);
                if (admitted.status === 'empty') continue;
                if (admitted.status === 'unsupported') return refuse(key, admitted);
                if (admitted.status !== 'ready') return reject(admitted);
                holds.push(key);
                // The texture holds the pixels now, so the bitmap is no longer needed. A picture some item of it was refused
                // for stays held: its CPU draw needs the bitmap.
                if (hold && !cpuKeys.has(key) && hold.imageState(key) === 'ready') hold.releaseImage(key);
                const tex = admitted.value;

                const src = item.sourceRect ?? { x: 0, y: 0, width: tex.sourceWidth, height: tex.sourceHeight };
                if (!(src.width > 0 && src.height > 0) || src.x < 0 || src.y < 0 || src.x + src.width > tex.sourceWidth || src.y + src.height > tex.sourceHeight) {
                    return refuse(key, unsupported('crop'));
                }
                // The device rect of the picture, fractional: the shader measures the pixels it covers.
                const x0 = (e + a * rect.x - view.camera.x) * scale, y0 = (f + d * rect.y - view.camera.y) * scale;
                const x1 = x0 + a * rect.width * scale, y1 = y0 + d * rect.height * scale;
                const left = Math.max(0, Math.floor(x0)), top = Math.max(0, Math.floor(y0));
                const right = Math.min(targetWidth, Math.ceil(x1)), bottom = Math.min(targetHeight, Math.ceil(y1));
                if (right <= left || bottom <= top) continue;
                // The crop in source pixels, as texels of the texture (which is smaller only when the source was downscaled).
                const kx = tex.width / tex.sourceWidth, ky = tex.height / tex.sourceHeight;
                const uniforms = new Float32Array(UNIFORM_BYTES / 4);
                uniforms.set([targetWidth, targetHeight, multiply, 0, x0, y0, x1, y1,
                    src.x * kx, src.y * ky, (src.x + src.width) * kx, (src.y + src.height) * ky,
                    tex.width, tex.height, item.opacity, item.inverted ? 1 : 0]);
                calls.push({ texture: tex.texture, scissor: { x: left, y: top, width: right - left, height: bottom - top }, uniforms });
            }
            if (calls.length === 0) {
                for (const key of holds) textures.unhold(key);
                return { status: 'empty' };
            }
            const run: ImageRun = { route: 'image', blend, device: current, calls, holds, retired: false };
            return { status: 'ready', value: run };
        },
        draw(pass: GpuPass, run: PreparedRun): void {
            const own = run as ImageRun;
            const drawPipeline = own.blend === 'modulate' ? modulatePipeline : overPipeline, drawSampler = sampler;
            if (!drawPipeline || !drawSampler || device !== own.device || own.retired) throw new Error('Stale image run');
            for (const call of own.calls) {
                const slice = host.uniforms(call.uniforms);
                pass.draw({ pipeline: drawPipeline, vertices: [], first: 0, count: 4, instances: 1, scissor: call.scissor,
                    bindings: { uniforms: [{ binding: 0, slice }], textures: [{ binding: 0, texture: call.texture, sampler: drawSampler }] } });
            }
            auditCount(audit, 'route:image', own.calls.length);
        },
        retire(run: PreparedRun): void {
            const own = run as ImageRun;
            if (own.retired) return;
            own.retired = true;
            for (const key of own.holds) textures.unhold(key);
        },
        release,
        memory(): { gpuBytes: number; cpuBytes: number } { return textures.memory(); },
        useResources(next: PaintResources2d): void { resources = next; hold = imageHoldOf(next); },
        evictTextures(bytes: number, frameId: number): number { return textures.evict(bytes, frameId); },
    };
}

/** The paint's picture hold, when the resources carry one: a structural check, so a resources object without it simply keeps every bitmap. */
function imageHoldOf(resources: PaintResources2d): PaintImageHold | null {
    const candidate = resources as Partial<PaintImageHold>;
    return typeof candidate.imageState === 'function' && typeof candidate.releaseImage === 'function' && typeof candidate.reacquireImage === 'function'
        ? candidate as PaintImageHold : null;
}

/** The factory the contract names (contracts.ts CreateImageRoute): a compile-time check that the route matches it. */
export const imageRouteFactory: CreateImageRoute = createImageRoute;
