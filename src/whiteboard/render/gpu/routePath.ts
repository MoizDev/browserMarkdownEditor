// The path route: every path item the board draws on the GPU, from geometry kept in item-local space.
// A copy of the adapter's path admission and draw (gpuPaintAdapter.ts admitPathItem, drawPathItem, deviceAffine,
// deviceClipRect), reworked so that a pan or a zoom inside one tolerance band triangulates nothing and uploads nothing:
// the triangles are keyed by content and band, and the device affine is a uniform of the coverage kit.
import type { Affine, PathCommand, ViewState } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { ClipToken, GpuPass, RectI } from '../../../platform/render/gfx/api';
import type { FrameBudget } from '../../../platform/render/types';
import { auditCount } from '../../../platform/render/renderAudit';
import { createPathCoverageKit, type PathCoverageAdmission, type PreparedPathCoverage } from '../../../platform/render/pathCoverage';
import { pathFillTriangles } from '../pathFillTriangles';
import { pathStrokeTriangles } from '../pathStrokeTriangles';
import type { PaintClip, PaintPathItem } from '../paintStream';
import type { Admission, Blend, CreatePathRoute, ItemRoute, PreparedRun, WithClips } from './contracts';

/** Device pixels of flattening error allowed for a stencil-covered path (design §5.1: ≤0.1 px). */
const FLATTEN_DEVICE_PX = 0.1;
/** Triangles kept per content and band, in CPU bytes. Past it the least recently used are dropped and rebuilt if drawn again;
 * a pan or zoom inside a band only ever touches what is on screen, so it never reaches the bound. */
const GEOMETRY_CACHE_BYTES = 16 * 2 ** 20;
const NO_TRIANGLES = new Float64Array(0);
const ORIGIN = Object.freeze({ x: 0, y: 0 });
const WHITE = Object.freeze([1, 1, 1, 1] as const);

type Origin = Readonly<{ x: number; y: number }>;
type Bounds = Readonly<{ x0: number; y0: number; x1: number; y1: number }>;
interface Shapes { readonly positive: Float64Array; readonly negative: Float64Array; readonly edges: number; readonly bounds: Bounds }
/** One triangle set in item-local space, origin-relative. Its arrays are the kit's shared-buffer keys: identity is the cache. */
interface Outline extends Shapes { readonly d: readonly PathCommand[]; readonly origin: Origin; readonly bytes: number }
interface LocalRect { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number }
interface Viewport { readonly width: number; readonly height: number }

/** One path item's admitted work, in draw order: clip masks, then the fill and stroke inside the pushed clips. */
interface PreparedPathItem { readonly clips: readonly PreparedPathCoverage[]; readonly rects: readonly RectI[];
    readonly fill: PreparedPathCoverage | null; readonly stroke: PreparedPathCoverage | null }
/** A run of path items sharing one blend, prepared for one view. */
interface PathRun extends PreparedRun { readonly route: 'path'; readonly items: readonly PreparedPathItem[] }
/** The composite blend a path run is drawn with: the kit's normal cover, or the multiply-slice modulate cover. */
type CoverBlend = 'normal' | 'modulate';
type Stop = { readonly status: 'empty' } | { readonly status: 'denied'; readonly bytes: number } | { readonly status: 'deferred' }
    | { readonly status: 'unsupported'; readonly why: string };
type ItemAdmission = { readonly status: 'ready'; readonly value: PreparedPathItem } | Stop;

/** Half-octave band of a device scale: band b holds scales in [2^(b/2), 2^((b+1)/2)). Geometry is flattened to the band's
 * upper scale, so its error is ≤ 0.1 device px at every scale the band holds (a finer scale only shrinks it). */
function bandOf(localToWorld: Affine, view: ViewState): number | null {
    const [a, b, c, d] = localToWorld;
    const scale = view.camera.z * view.viewport.dpr * Math.hypot(a, b, c, d);
    if (!(scale > 0) || !Number.isFinite(scale)) return null;
    return Math.floor(2 * Math.log2(scale));
}
function flattenTolerance(band: number): number {
    return FLATTEN_DEVICE_PX / Math.pow(2, (band + 1) / 2);
}

/** Lower-left corner of the path's control points: local coordinates are rebased here in double precision before any
 * single-precision upload (a conservative bound: control points included). */
function pathOrigin(commands: readonly PathCommand[]): Origin {
    let x = Infinity, y = Infinity;
    for (const command of commands) {
        if (command[0] === 'Z') continue;
        for (let i = 1; i + 1 < command.length; i += 2) {
            x = Math.min(x, command[i] as number); y = Math.min(y, command[i + 1] as number);
        }
    }
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : ORIGIN;
}

/** Local to device-pixel affine: the item's transform, the camera and the device scale applied once, with the origin rebase
 * folded in. Null when the transform or the view cannot place anything. */
function deviceAffine(localToWorld: Affine, origin: Origin, view: ViewState): Affine | null {
    const [a, b, c, d, e, f] = localToWorld;
    const scale = view.camera.z * view.viewport.dpr;
    if (!(Math.hypot(a, b, c, d) > 0) || !Number.isFinite(scale) || scale <= 0) return null;
    return [scale * a, scale * b, scale * c, scale * d,
        scale * (a * origin.x + c * origin.y + e - view.camera.x), scale * (b * origin.x + d * origin.y + f - view.camera.y)];
}

const localRects = new WeakMap<PaintClip, LocalRect | null>();
/** A clip that is an axis-aligned rectangle under a rotation-free transform, in its own local units; null for any other path.
 * Cached per clip: the device rectangle is then a few products per view. */
function clipLocalRect(clip: PaintClip): LocalRect | null {
    const known = localRects.get(clip);
    if (known !== undefined) return known;
    const found = rectangleOf(clip);
    localRects.set(clip, found);
    return found;
}
function rectangleOf(clip: PaintClip): LocalRect | null {
    const [a, b, c, d] = clip.localToWorld;
    if (b !== 0 || c !== 0 || !(a !== 0 && d !== 0) || clip.d.length < 4) return null;
    const points: [number, number][] = [];
    for (const command of clip.d) {
        if (command[0] === 'Z') continue;
        if (command[0] !== 'M' && command[0] !== 'L') return null;
        if (command[0] === 'M' && points.length) return null;
        points.push([command[1] as number, command[2] as number]);
    }
    if (points.length === 5 && points[4][0] === points[0][0] && points[4][1] === points[0][1]) points.pop();
    if (points.length !== 4) return null;
    const xs = new Set(points.map(point => point[0])), ys = new Set(points.map(point => point[1]));
    if (xs.size !== 2 || ys.size !== 2) return null;
    // Consecutive corners must share an x or a y, else the four points are a bow tie, not a rectangle.
    for (let i = 0; i < 4; i++) { const p = points[i], q = points[(i + 1) % 4]; if (p[0] !== q[0] && p[1] !== q[1]) return null; }
    const [x0, x1] = [...xs].sort((p, q) => p - q), [y0, y1] = [...ys].sort((p, q) => p - q);
    return { x0, x1, y0, y1 };
}

/** The clip's device rectangle for this view, or null when the clip is not a rectangle. A rectangle clip is the pass's scissor,
 * not a coverage mask: a notebook page's clip asked a 52 B/px MSAA mask larger than any target the pane grants, and every
 * paper item fell back to a CPU raster (measured: 330 fallbacks in one pan). Edges round to the nearest device pixel, as the
 * canvas2d path clip's half-covered edge column would read. */
function clipDeviceRect(clip: PaintClip, view: ViewState): RectI | null {
    const local = clipLocalRect(clip);
    if (!local) return null;
    const [a, , , d, e, f] = clip.localToWorld;
    const scale = view.camera.z * view.viewport.dpr;
    if (!(scale > 0) || !Number.isFinite(scale)) return null;
    const ax = scale * a * local.x0 + scale * (e - view.camera.x), bx = scale * a * local.x1 + scale * (e - view.camera.x);
    const ay = scale * d * local.y0 + scale * (f - view.camera.y), by = scale * d * local.y1 + scale * (f - view.camera.y);
    const rx0 = Math.round(Math.min(ax, bx)), ry0 = Math.round(Math.min(ay, by));
    return { x: rx0, y: ry0, width: Math.round(Math.max(ax, bx)) - rx0, height: Math.round(Math.max(ay, by)) - ry0 };
}

/** The clip stack of one draw. Draws do not nest, so one array serves every item and no draw allocates. */
const clipTokens: ClipToken[] = [];

export const createPathRoute: CreatePathRoute = (host: LayerHost, audit: string) => {
    const kit = createPathCoverageKit(host, () => auditCount(audit, 'kit:pipeline-failed'), audit);
    // Triangles by content and band, most recently used last. A hit needs the same command array: a content key never
    // serves another path's triangles.
    const outlines = new Map<string, Outline>();
    let outlineBytes = 0;
    const outlineFor = (key: string, d: readonly PathCommand[], band: number,
        build: (tolerance: number, origin: Origin) => Shapes | null): Outline | null => {
        const cached = outlines.get(key);
        if (cached && cached.d === d) {
            outlines.delete(key); outlines.set(key, cached);
            auditCount(audit, 'geom:hit');
            return cached;
        }
        const origin = pathOrigin(d);
        const shapes = build(flattenTolerance(band), origin);
        if (!shapes) return null;
        if (cached) { outlines.delete(key); outlineBytes -= cached.bytes; }
        auditCount(audit, 'geom:build');
        const bytes = shapes.positive.byteLength + shapes.negative.byteLength;
        const outline: Outline = { d, origin, positive: shapes.positive, negative: shapes.negative, edges: shapes.edges, bounds: shapes.bounds, bytes };
        outlines.set(key, outline); outlineBytes += bytes;
        for (const [oldKey, old] of outlines) {
            if (outlineBytes <= GEOMETRY_CACHE_BYTES || oldKey === key) break;
            outlines.delete(oldKey); outlineBytes -= old.bytes;
        }
        return outline;
    };

    /** Takes the kit's result into `acquired`, or says why not. */
    const take = (result: PathCoverageAdmission, acquired: PreparedPathCoverage[], bytes: number): PreparedPathCoverage | Stop => {
        if (result.status === 'ready') { acquired.push(result.value); return result.value; }
        if (result.status === 'denied') return { status: 'denied', bytes };
        if (result.status === 'deferred') return { status: 'deferred' };
        if (result.status === 'empty') return { status: 'empty' };
        return { status: 'unsupported', why: 'coverage kit' };
    };
    const isStop = (value: PreparedPathCoverage | Stop): value is Stop => 'status' in value;

    /** One path item: its clip masks, fill and stroke. Whatever it acquires goes into `acquired`; the caller retires it on any
     * stop. An item is 'empty' when nothing of it can show in this view. */
    const admitItem = (item: PaintPathItem, view: ViewState, viewport: Viewport, cover: CoverBlend, budget: FrameBudget,
        acquired: PreparedPathCoverage[]): ItemAdmission => {
        const clips: PreparedPathCoverage[] = [], rects: RectI[] = [];
        for (const clip of item.clips) {
            const rect = clipDeviceRect(clip, view);
            if (rect) {
                const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
                const x1 = Math.min(viewport.width, rect.x + rect.width), y1 = Math.min(viewport.height, rect.y + rect.height);
                if (x1 <= x0 || y1 <= y0) return { status: 'empty' };  // a clip that excludes the viewport hides the item
                rects.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
                continue;
            }
            const band = bandOf(clip.localToWorld, view);
            if (band === null) return { status: 'unsupported', why: 'clip transform' };
            const geometry = outlineFor(`clip|${clip.key}|${band}`, clip.d, band,
                (tolerance, origin) => pathFillTriangles(clip.d, { tolerance, origin: [origin.x, origin.y] }));
            const affine = geometry && deviceAffine(clip.localToWorld, geometry.origin, view);
            if (!geometry || !affine) return { status: 'unsupported', why: 'clip geometry' };
            const taken = take(kit.admit({ shapes: geometry, rule: clip.fillRule, affine, viewport, colour: WHITE, output: { kind: 'mask' } }, budget),
                acquired, geometry.bytes);
            if (isStop(taken)) return taken.status === 'empty' ? { status: 'empty' } : taken;
            clips.push(taken);
        }
        let fill: PreparedPathCoverage | null = null;
        if (item.material.fill) {
            const band = bandOf(item.localToWorld, view);
            if (band === null) return { status: 'unsupported', why: 'path transform' };
            const geometry = outlineFor(`fill|${item.geometryKey}|${band}`, item.d, band,
                (tolerance, origin) => pathFillTriangles(item.d, { tolerance, origin: [origin.x, origin.y] }));
            const affine = geometry && deviceAffine(item.localToWorld, geometry.origin, view);
            if (!geometry || !affine) return { status: 'unsupported', why: 'path geometry' };
            const taken = take(kit.admit({ shapes: geometry, rule: item.fillRule, affine, viewport, colour: item.material.fill,
                output: { kind: 'composite', blend: cover } }, budget), acquired, geometry.bytes);
            if (isStop(taken)) { if (taken.status !== 'empty') return taken; }
            else fill = taken;
        }
        let stroke: PreparedPathCoverage | null = null;
        const style = item.material.stroke;
        if (style && style.width > 0) {
            const band = bandOf(item.localToWorld, view);
            if (band === null) return { status: 'unsupported', why: 'path transform' };
            const dash = style.dash ? `${style.dash.phase}:${style.dash.array.join(',')}` : '';
            const geometry = outlineFor(`stroke|${item.geometryKey}|${band}|${style.width}|${style.cap}|${style.join}|${style.miterLimit}|${dash}`,
                item.d, band, (tolerance, origin) => {
                    const outline = pathStrokeTriangles(item.d, { width: style.width, cap: style.cap, join: style.join, miterLimit: style.miterLimit,
                        ...(style.dash ? { dash: style.dash } : {}), tolerance, origin: [origin.x, origin.y] });
                    return outline && { positive: outline.triangles, negative: NO_TRIANGLES, edges: 0, bounds: outline.bounds };
                });
            const affine = geometry && deviceAffine(item.localToWorld, geometry.origin, view);
            if (!geometry || !affine) return { status: 'unsupported', why: 'stroke geometry' };
            const taken = take(kit.admit({ shapes: geometry, rule: 'union', affine, viewport, colour: style.color,
                output: { kind: 'composite', blend: cover } }, budget), acquired, geometry.bytes);
            if (isStop(taken)) { if (taken.status !== 'empty') return taken; }
            else stroke = taken;
        }
        if (!fill && !stroke) return { status: 'empty' };
        return { status: 'ready', value: { clips, rects, fill, stroke } };
    };

    /** Draw order inside one item: clip masks render first, then the item's coverage inside the pushed clips. */
    const drawItem = (pass: GpuPass, item: PreparedPathItem): void => {
        for (const clip of item.clips) kit.drawMask(pass, clip);
        const base = clipTokens.length;
        try {
            for (const rect of item.rects) clipTokens.push(pass.pushClip(rect));
            for (const clip of item.clips) clipTokens.push(pass.pushClip(clip.clip!));
            if (item.fill) kit.draw(pass, item.fill);
            if (item.stroke) kit.draw(pass, item.stroke);
        } finally {
            for (let i = clipTokens.length - 1; i >= base; i--) pass.popClip(clipTokens[i]);
            clipTokens.length = base;
        }
    };

    const route: ItemRoute<PaintPathItem> = {
        id: 'path',
        accepts: (item): item is PaintPathItem => item.kind === 'path',
        admit(items, view, blend, budget): Admission<PreparedRun> {
            const cover: CoverBlend = blend === 'modulate' ? 'modulate' : 'normal';
            const viewport: Viewport = { width: Math.round(view.viewport.width * view.viewport.dpr), height: Math.round(view.viewport.height * view.viewport.dpr) };
            const acquired: PreparedPathCoverage[] = [], prepared: PreparedPathItem[] = [];
            for (const item of items) {
                const mark = acquired.length;
                const admission = admitItem(item, view, viewport, cover, budget, acquired);
                if (admission.status === 'ready') { prepared.push(admission.value); continue; }
                // What this item acquired is retired; an empty item is skipped, any other stop ends the run.
                for (let i = acquired.length - 1; i >= mark; i--) kit.retire(acquired[i]);
                acquired.length = mark;
                if (admission.status === 'empty') continue;
                for (const held of acquired) kit.retire(held);
                if (admission.status === 'denied') return { status: 'denied', pool: 'gpu', bytes: admission.bytes };
                if (admission.status === 'unsupported') return { status: 'unsupported', why: admission.why };
                return { status: admission.status };
            }
            if (!prepared.length) return { status: 'empty' };
            auditCount(audit, 'route:path', prepared.length);
            const run: PathRun = { route: 'path', blend, items: prepared };
            return { status: 'ready', value: run };
        },
        draw(pass: GpuPass, run: PreparedRun): void {
            if (run.route !== 'path') throw new Error('Path route drew a run of another route');
            for (const item of (run as PathRun).items) drawItem(pass, item);
        },
        retire(run: PreparedRun): void {
            if (run.route !== 'path') throw new Error('Path route retired a run of another route');
            for (const item of (run as PathRun).items) {
                for (const clip of item.clips) kit.retire(clip);
                if (item.fill) kit.retire(item.fill);
                if (item.stroke) kit.retire(item.stroke);
            }
        },
        release(): void {
            kit.release();
            outlines.clear(); outlineBytes = 0;
        },
        memory(): { gpuBytes: number; cpuBytes: number } {
            return { gpuBytes: kit.memory().gpuBytes, cpuBytes: outlineBytes };
        },
    };
    return route;
};

/** Draws `draw` under an item's clips, through the clip stack the path route uses. Rectangle clips are scissors. A clip that is
 * not a rectangle needs its coverage mask, which only an admission can make (the path route admits its own item's masks in
 * prepare); with the signature fixed, this returns 'unsupported' without drawing and the caller counts that fallback. */
export const withClips: WithClips = (pass, clips, view, draw) => {
    for (const clip of clips) if (!clipLocalRect(clip)) return { status: 'unsupported', why: 'clip mask not admitted' };
    const viewport = { width: Math.round(view.viewport.width * view.viewport.dpr), height: Math.round(view.viewport.height * view.viewport.dpr) };
    const base = clipTokens.length;
    try {
        for (const clip of clips) {
            const rect = clipDeviceRect(clip, view);
            const x0 = Math.max(0, rect!.x), y0 = Math.max(0, rect!.y);
            const x1 = Math.min(viewport.width, rect!.x + rect!.width), y1 = Math.min(viewport.height, rect!.y + rect!.height);
            if (x1 <= x0 || y1 <= y0) return { status: 'empty' };
            clipTokens.push(pass.pushClip({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }));
        }
        draw();
    } finally {
        for (let i = clipTokens.length - 1; i >= base; i--) pass.popClip(clipTokens[i]);
        clipTokens.length = base;
    }
    return { status: 'ready', value: undefined };
};
