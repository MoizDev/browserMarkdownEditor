// The path route: every path item the board draws on the GPU, from triangles kept in item-local space.
// A copy of the adapter's path admission and draw (gpuPaintAdapter.ts admitPathItem, drawPathItem, deviceAffine,
// deviceClipRect), reworked so that a pan or a zoom inside one tolerance band triangulates nothing and uploads nothing.
// Triangles are keyed by the commands' content and a band; the device affine is a uniform of the coverage kit.
import type { Affine, PathCommand, ViewState } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { ByteLease, ClipToken, GpuPass, RectI } from '../../../platform/render/gfx/api';
import type { FrameBudget } from '../../../platform/render/types';
import { auditCount } from '../../../platform/render/renderAudit';
import { createPathCoverageKit, type PathCoverageAdmission, type PreparedPathCoverage } from '../../../platform/render/pathCoverage';
import { pathFillTriangles } from '../pathFillTriangles';
import { pathStrokeTriangles } from '../pathStrokeTriangles';
import type { PaintClip, PaintPathItem } from '../paintStream';
import type { Admission, CreatePathRoute, ItemRoute, PreparedRun, WithClips } from './contracts';

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
/** One triangle set in item-local space, origin-relative. Its arrays are the kit's shared-buffer keys: the cache holds them. */
/** Its CPU bytes are leased from the pane's CPU allocator (`lease`), so the governor sees them and can reclaim them. `null` only
 * for an outline built without a lease, which is never held in the cache. */
interface Outline extends Shapes { readonly origin: Origin; readonly bytes: number; readonly lease: ByteLease | null; usedFrame: number }
interface LocalRect { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number }
interface Viewport { readonly width: number; readonly height: number }
/** The composite blend a path run is drawn with: the kit's normal cover, or the multiply-slice modulate cover. */
type CoverBlend = 'normal' | 'modulate';
type Stop = { readonly status: 'empty' } | { readonly status: 'denied'; readonly bytes: number } | { readonly status: 'deferred' }
    | { readonly status: 'unsupported'; readonly why: string };

/** The clips of one item (or one list of clips), admitted for one view. Rectangle clips are scissors; the others are the coverage
 * masks admitted for them. Built by `admitClips`, drawn by `withPreparedClips`; `retire` frees the masks and is idempotent. */
export interface PreparedClips {
    readonly scissors: readonly RectI[];
    readonly masks: readonly PreparedPathCoverage[];
    /** Draws one of these masks, bound to the kit that admitted it. */
    readonly drawMask: (pass: GpuPass, mask: PreparedPathCoverage) => void;
    readonly retire: () => void;
}
/** Admits the clips of one draw for one view. Empty when a clip excludes the view (the caller hides what it clips). */
export type AdmitClips = (clips: readonly PaintClip[], view: ViewState, budget: FrameBudget) => Admission<PreparedClips>;

/** One path item's admitted work, in draw order: clip masks, then the fill and stroke inside the pushed clips. */
interface PreparedPathItem { readonly clips: PreparedClips; readonly fill: PreparedPathCoverage | null; readonly stroke: PreparedPathCoverage | null }
/** A run of path items sharing one blend, prepared for one view. */
interface PathRun extends PreparedRun { readonly route: 'path'; readonly items: readonly PreparedPathItem[] }
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

/** A content key for a command list: a 53-bit hash of its JSON plus its length, computed once per array. geometryKey names a
 * node revision (vectorGeometry.ts), not the commands, so the same commands in a new revision must be recognised here. */
const commandKeys = new WeakMap<readonly PathCommand[], string>();
function commandKey(d: readonly PathCommand[]): string {
    const known = commandKeys.get(d);
    if (known !== undefined) return known;
    const text = JSON.stringify(d);
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const key = `${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}:${text.length}`;
    commandKeys.set(d, key);
    return key;
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

/** The clip stack shared by every draw that pushes clips. Draws do not nest on one pass, and each restores the stack to its base. */
const clipTokens: ClipToken[] = [];

/** Draws `draw` under prepared clips: the masks are drawn first, then the scissors and mask clips are pushed around `draw`. */
export function withPreparedClips(pass: GpuPass, prepared: PreparedClips, draw: () => void): void {
    for (const mask of prepared.masks) prepared.drawMask(pass, mask);
    const base = clipTokens.length;
    try {
        for (const rect of prepared.scissors) clipTokens.push(pass.pushClip(rect));
        for (const mask of prepared.masks) clipTokens.push(pass.pushClip(mask.clip!));
        draw();
    } finally {
        for (let i = clipTokens.length - 1; i >= base; i--) pass.popClip(clipTokens[i]);
        clipTokens.length = base;
    }
}

/** Draws `draw` under an item's rectangle clips as scissors. A clip that is not a rectangle needs its coverage mask, which only
 * an admission makes; this route's `withPreparedClips` takes prepared masks. With the signature fixed, this returns 'unsupported'
 * without drawing for such a clip, and the caller counts that fallback. */
export const withClips: WithClips = (pass, clips, view, draw) => {
    for (const clip of clips) if (!clipLocalRect(clip)) return { status: 'unsupported', why: 'clip mask not admitted' };
    const viewport = { width: Math.round(view.viewport.width * view.viewport.dpr), height: Math.round(view.viewport.height * view.viewport.dpr) };
    const base = clipTokens.length;
    try {
        for (const clip of clips) {
            const rect = clipDeviceRect(clip, view)!;
            const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
            const x1 = Math.min(viewport.width, rect.x + rect.width), y1 = Math.min(viewport.height, rect.y + rect.height);
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

/** Prepared coverage and prepared clips carry no `status`; every stop does. */
const isStop = (value: object): value is Stop => 'status' in value;
function stopAdmission(stop: Stop): Admission<never> {
    if (stop.status === 'denied') return { status: 'denied', pool: 'gpu', bytes: stop.bytes };
    if (stop.status === 'unsupported') return { status: 'unsupported', why: stop.why };
    return { status: stop.status };
}
function viewportOf(view: ViewState): Viewport {
    return { width: Math.round(view.viewport.width * view.viewport.dpr), height: Math.round(view.viewport.height * view.viewport.dpr) };
}

/** The path route and its clip admission, sharing one coverage kit per host. `route` draws path items; `clips` admits clips for
 * any route's items; `coverage` is the kit itself (multi-set admission, draw, retire) for routes that draw their own triangles. */
export function createPath(host: LayerHost, audit: string): {
    readonly route: ItemRoute<PaintPathItem>;
    readonly admitClips: AdmitClips;
    readonly coverage: ReturnType<typeof createPathCoverageKit>;
    readonly beginFrame: (frame: number) => void;
    readonly evictCpu: (bytes: number) => number;
} {
    const kit = createPathCoverageKit(host, () => auditCount(audit, 'kit:pipeline-failed'), audit);
    // Triangles by content and band, most recently used last.
    const outlines = new Map<string, Outline>();
    let outlineBytes = 0, frame = 0;
    /** Drops outlines not used in the current frame, oldest first, until `bytes` are freed; releases their leases. Returns the
     * bytes freed. The governor's CPU evict and the cache's own bound both come here. */
    const reclaimOutlines = (bytes: number): number => {
        let freed = 0;
        for (const [key, old] of outlines) {
            if (freed >= bytes) break;
            if (old.usedFrame >= frame) continue;
            outlines.delete(key); outlineBytes -= old.bytes; freed += old.bytes;
            if (old.lease) host.allocator.cpu.release(old.lease);
        }
        return freed;
    };
    const outlineFor = (key: string, d: readonly PathCommand[], band: number,
        build: (tolerance: number, origin: Origin) => Shapes | null): Outline | null => {
        const cached = outlines.get(key);
        if (cached) {
            outlines.delete(key); outlines.set(key, cached); cached.usedFrame = frame;
            auditCount(audit, 'geom:hit');
            return cached;
        }
        const origin = pathOrigin(d);
        const shapes = build(flattenTolerance(band), origin);
        if (!shapes) return null;
        auditCount(audit, 'geom:build');
        const bytes = shapes.positive.byteLength + shapes.negative.byteLength;
        // Leased before it is held: a refused lease first reclaims unused outlines; if still refused the outline is used for
        // this admission only and not cached (counted), so the pane's CPU grant is never exceeded silently.
        let lease = host.allocator.cpu.reserve(bytes);
        if (!lease) { reclaimOutlines(bytes); lease = host.allocator.cpu.reserve(bytes); }
        const outline: Outline = { origin, positive: shapes.positive, negative: shapes.negative, edges: shapes.edges, bounds: shapes.bounds,
            bytes, lease, usedFrame: frame };
        if (!lease) { auditCount(audit, 'geom:refused'); return outline; }
        outlines.set(key, outline); outlineBytes += bytes;
        // The bound is soft: an outline used this frame is never reclaimed, so it is trimmed by what other frames left behind.
        if (outlineBytes > GEOMETRY_CACHE_BYTES) reclaimOutlines(outlineBytes - GEOMETRY_CACHE_BYTES);
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
    const makeClips = (scissors: RectI[], masks: PreparedPathCoverage[]): PreparedClips => ({
        scissors: Object.freeze(scissors),
        masks: Object.freeze(masks),
        drawMask: (pass, mask) => kit.drawMask(pass, mask),
        retire: () => { for (const mask of masks) kit.retire(mask); },
    });
    /** Admits a clip list. Masks it acquires go into `acquired`; the caller retires them on any stop. */
    const admitClipList = (clips: readonly PaintClip[], view: ViewState, viewport: Viewport, budget: FrameBudget,
        acquired: PreparedPathCoverage[]): PreparedClips | Stop => {
        const scissors: RectI[] = [], masks: PreparedPathCoverage[] = [];
        for (const clip of clips) {
            const rect = clipDeviceRect(clip, view);
            if (rect) {
                const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
                const x1 = Math.min(viewport.width, rect.x + rect.width), y1 = Math.min(viewport.height, rect.y + rect.height);
                if (x1 <= x0 || y1 <= y0) return { status: 'empty' };  // a clip that excludes the viewport hides what it clips
                scissors.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
                continue;
            }
            const band = bandOf(clip.localToWorld, view);
            if (band === null) return { status: 'unsupported', why: 'clip transform' };
            const key = `clip|${commandKey(clip.d)}|${band}`;
            const geometry = outlineFor(key, clip.d, band, (tolerance, origin) => pathFillTriangles(clip.d, { tolerance, origin: [origin.x, origin.y] }));
            const affine = geometry && deviceAffine(clip.localToWorld, geometry.origin, view);
            if (!geometry || !affine) return { status: 'unsupported', why: 'clip geometry' };
            const taken = take(kit.admit({ shapes: geometry, rule: clip.fillRule, affine, viewport, colour: WHITE, output: { kind: 'mask' } }, budget),
                acquired, geometry.bytes);
            if (isStop(taken)) return taken;
            masks.push(taken);
        }
        return makeClips(scissors, masks);
    };

    /** One path item: its clips, fill and stroke. Whatever it acquires goes into `acquired`; the caller retires it on any stop.
     * An item is 'empty' when nothing of it can show in this view. */
    const admitItem = (item: PaintPathItem, view: ViewState, viewport: Viewport, cover: CoverBlend, budget: FrameBudget,
        acquired: PreparedPathCoverage[]): ItemAdmission => {
        const clips = admitClipList(item.clips, view, viewport, budget, acquired);
        if (isStop(clips)) return clips;
        let fill: PreparedPathCoverage | null = null;
        if (item.material.fill) {
            const band = bandOf(item.localToWorld, view);
            if (band === null) return { status: 'unsupported', why: 'path transform' };
            const geometry = outlineFor(`fill|${commandKey(item.d)}|${band}`, item.d, band,
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
            const key = `stroke|${commandKey(item.d)}|${band}|${style.width}|${style.cap}|${style.join}|${style.miterLimit}|${dash}`;
            const geometry = outlineFor(key, item.d, band, (tolerance, origin) => {
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
        return { status: 'ready', value: { clips, fill, stroke } };
    };

    // One closure for every item: the pass and item of the draw in progress are held here, so a draw builds no closure.
    let drawPass: GpuPass | null = null, drawingItem: PreparedPathItem | null = null;
    const drawInside = (): void => {
        const pass = drawPass!, item = drawingItem!;
        if (item.fill) kit.draw(pass, item.fill);
        if (item.stroke) kit.draw(pass, item.stroke);
    };
    const drawItem = (pass: GpuPass, item: PreparedPathItem): void => {
        drawPass = pass; drawingItem = item;
        try { withPreparedClips(pass, item.clips, drawInside); }
        finally { drawPass = null; drawingItem = null; }
    };

    const route: ItemRoute<PaintPathItem> = {
        id: 'path',
        accepts: (item): item is PaintPathItem => item.kind === 'path',
        admit(items, view, blend, budget): Admission<PreparedRun> {
            const cover: CoverBlend = blend === 'modulate' ? 'modulate' : 'normal';
            const viewport = viewportOf(view);
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
                return stopAdmission(admission);
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
                item.clips.retire();
                if (item.fill) kit.retire(item.fill);
                if (item.stroke) kit.retire(item.stroke);
            }
        },
        release(): void {
            kit.release();
            for (const old of outlines.values()) if (old.lease) host.allocator.cpu.release(old.lease);
            outlines.clear(); outlineBytes = 0;
        },
        memory(): { gpuBytes: number; cpuBytes: number } {
            return { gpuBytes: kit.memory().gpuBytes, cpuBytes: outlineBytes };
        },
    };
    const admitClips: AdmitClips = (clips, view, budget) => {
        const acquired: PreparedPathCoverage[] = [];
        const result = admitClipList(clips, view, viewportOf(view), budget, acquired);
        if (isStop(result)) {
            for (const held of acquired) kit.retire(held);
            return stopAdmission(result);
        }
        return { status: 'ready', value: result };
    };
    return {
        route, admitClips, coverage: kit,
        /** Marks the frame for both caches: a triangle set or outline used in this frame is never reclaimed. Call once per frame. */
        beginFrame(next: number): void { frame = next; kit.beginFrame(next); },
        /** The governor's CPU reclaim for the outline cache: frees unused outlines oldest first and returns the bytes freed. */
        evictCpu(bytes: number): number { return reclaimOutlines(bytes); },
    };
}

export const createPathRoute: CreatePathRoute = (host, audit) => createPath(host, audit).route;
