// The path route: every path item the board draws on the GPU, from triangles kept in item-local space.
// A copy of the adapter's path admission and draw (gpuPaintAdapter.ts admitPathItem, drawPathItem, deviceAffine,
// deviceClipRect), reworked so that a pan or a zoom inside one tolerance band triangulates nothing and uploads nothing.
// Triangles are keyed by the commands' content and a band; the device affine is a uniform of the coverage kit.
import type { Affine, PathCommand, Rgba, ViewState } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { ByteLease, ClipToken, GpuPass, RectI } from '../../../platform/render/gfx/api';
import type { FrameBudget } from '../../../platform/render/types';
import { auditCount, auditTape } from '../../../platform/render/renderAudit';
import { createPathCoverageKit, type PathCoverageAdmission, type PathCoverageShapes, type PreparedPathCoverage } from '../../../platform/render/pathCoverage';
import { PATH_FILL_MAX_EDGES, flattenContours, pathFillTriangles } from '../pathFillTriangles';
import { flattenPolylines, pathStrokeTriangles } from '../pathStrokeTriangles';
import { createAreaKit, type AreaAdmission, type AreaKit, type AreaPart, type PreparedArea } from '../../../platform/render/areaCoverage';
import { fillContours, strokeContours, type Contour } from './areaOutlines';
import { areaNestingExact } from '../inkAreaCells';
import type { AreaOutput } from '../../../platform/render/gfx/api';
import { ArenaError } from '../../../platform/render/resourceArena';
import type { PaintClip, PaintPathItem } from '../paintStream';
import type { Admission, CreatePathRoute, ItemRoute, PreparedRun, WithClips } from './contracts';

/** Device pixels of flattening error allowed for a stencil-covered path (design §5.1: ≤0.1 px). */
const FLATTEN_DEVICE_PX = 0.1;
/** Triangles kept per content and band, in CPU bytes. Past it the least recently used are dropped and rebuilt if drawn again;
 * a pan or zoom inside a band only ever touches what is on screen, so it never reaches the bound. */
const GEOMETRY_CACHE_BYTES = 16 * 2 ** 20;
const NO_TRIANGLES = new Float64Array(0);
const ORIGIN = Object.freeze({ x: 0, y: 0 });
const EMPTY_BOX = Object.freeze({ x0: 0, y0: 0, x1: 0, y1: 0 });
const WHITE = Object.freeze([1, 1, 1, 1] as const);
/** Most items one grouped coverage pass takes. A group is one admission with one set per member, so the bound keeps one
 * admission's set list and its per-tile buffer count bounded on a long run. */
const GROUP_MAX_ITEMS = 512;
/** Device pixels two grouped items' bounds must be apart. Closer, their anti-aliased edges share pixels, and one union coverage
 * over both differs from two composites along the shared edge (a seam). By reading: the notebook's ruling lines are 10+ px apart. */
const GROUP_GAP_DEVICE_PX = 2;

type Origin = Readonly<{ x: number; y: number }>;
type Bounds = Readonly<{ x0: number; y0: number; x1: number; y1: number }>;
interface Shapes { readonly positive: Float64Array; readonly negative: Float64Array; readonly edges: number; readonly bounds: Bounds }
/** One triangle set in item-local space, origin-relative. Its arrays are the kit's shared-buffer keys: the cache holds them. */
/** Its triangle arrays are CPU memory leased from the pane's CPU allocator; the lease lives while the cache or the coverage kit holds
 * the array (see createPath), so `bytes` is always accounted. */
interface Outline extends Shapes { readonly origin: Origin; readonly bytes: number; usedFrame: number }
/** An outline the CPU grant refused: its admission is denied on the CPU pool, and nothing is built or held for it. */
interface Refused { readonly refused: number }
interface LocalRect { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number }
interface Viewport { readonly width: number; readonly height: number }
/** The composite blend a path run is drawn with: the kit's normal cover, or the multiply-slice modulate cover. */
type CoverBlend = 'normal' | 'modulate';
type Stop = { readonly status: 'empty' } | { readonly status: 'denied'; readonly bytes: number; readonly pool: 'cpu' | 'gpu' } | { readonly status: 'deferred' }
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

/** Device pixels of flattening error allowed for a shape on the exact-area route. The cells are exact for the flattened outline,
 * so the chords are the route's only error: a chord's sagitta s loses about 2s/3 of a pixel it crosses, and at the coverage route's
 * 0.1 px that is up to ~17 levels, past the 8 the truth yardstick allows (FAULT-GPU.md). At 0.02 px it is ~3 levels, for about 2.2×
 * the points of a curve; the cells grow with the rows an edge crosses, not with its points, so the cost is the flattening alone,
 * done once per band (areaContours). */
const AREA_FLATTEN_DEVICE_PX = 0.02;
/** The largest device box (px) an area keeps on the exact-area route while a zoom is live: a quarter of a 516 px tile. */
const AREA_ZOOM_MAX_PX = 258 * 258;
/** Path-local contours kept per content and band for the exact-area route, in CPU bytes (the outline cache's rules). */
const AREA_CACHE_BYTES = 8 * 2 ** 20;
/** One path item's admitted work, in draw order: clip masks, then the fill and stroke inside the pushed clips. */
/** A fill or stroke admitted on the exact-area route, with the output it is composited with. */
interface AreaItem { readonly prepared: PreparedArea; readonly output: AreaOutput }
interface PreparedPathItem { readonly clips: PreparedClips; readonly fill: PreparedPathCoverage | null; readonly stroke: PreparedPathCoverage | null;
    readonly fillArea: AreaItem | null; readonly strokeArea: AreaItem | null }
/** Whatever an admission acquired from a kit: retired together when the admission stops. */
type Acquired = PreparedPathCoverage | PreparedArea;
/** A fill or stroke as cells of its band, or why the coverage route takes it instead (counted), or nothing to draw. */
type AreaShape = { readonly kind: 'area'; readonly parts: readonly AreaPart[]; readonly bounds: RectI } | { readonly kind: 'coverage'; readonly why: string }
    | { readonly kind: 'empty' };
/** A fill's or stroke's exact-area contours for one band, path-local, with their CPU lease; or, with null contours, why the
 * coverage route takes it (kept, so the refusal is decided once per band). */
interface AreaOutline {
    /** The contours as edges (x0, y0, x1, y1), path-local and relative to `origin` (float32 near the shape, not near the world origin);
     * null when the coverage route takes the shape, with `why`. */
    readonly edges: Float32Array | null; readonly origin: Origin; readonly box: Bounds; readonly why: string | null; readonly bytes: number;
    readonly lease: ByteLease | null; usedFrame: number }
/** A run of path items sharing one blend, prepared for one view. */
interface PathRun extends PreparedRun { readonly route: 'path'; readonly items: readonly PreparedPathItem[];
    /** Some item took the coverage route only because a zoom was live: the run's tile recomposes on exact area at rest. */
    readonly inexact: boolean }
type ItemAdmission = { readonly status: 'ready'; readonly value: PreparedPathItem } | Stop;

/** Half-octave band of a device scale: band b holds scales in [2^(b/2), 2^((b+1)/2)). Geometry is flattened to the band's
 * upper scale, so its error is ≤ 0.1 device px at every scale the band holds (a finer scale only shrinks it). */
function bandOf(localToWorld: Affine, view: ViewState): number | null {
    const [a, b, c, d] = localToWorld;
    const scale = view.camera.z * view.viewport.dpr * Math.hypot(a, b, c, d);
    if (!(scale > 0) || !Number.isFinite(scale)) return null;
    // The composer's ladderScale (tileComposer.ts) composes at powers of 2^(1/2), each exactly a band's lower edge, so one ladder
    // step opens one band and a zoom inside a band keeps its triangles. log2 of such a value can land an ulp below its integer,
    // and the floor would then put the same zoom in the band below, under its own cache key: the epsilon keeps it in its band
    // (by reading: a band split at a ladder step).
    return Math.floor(2 * Math.log2(scale) + 1e-9);
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
    const key = textKey(JSON.stringify(d));
    commandKeys.set(d, key);
    return key;
}
/** The 53-bit hash of a text and its length, as a short key. */
function textKey(text: string): string {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}:${text.length}`;
}

/** The commands' control-point bounds, in local units (a conservative bound, as pathOrigin's). Null when there are no points. */
const commandBoxes = new WeakMap<readonly PathCommand[], Bounds | null>();
function commandBounds(d: readonly PathCommand[]): Bounds | null {
    const known = commandBoxes.get(d);
    if (known !== undefined) return known;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const command of d) {
        if (command[0] === 'Z') continue;
        for (let i = 1; i + 1 < command.length; i += 2) {
            const x = command[i] as number, y = command[i + 1] as number;
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
    }
    const found = Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1) ? { x0, y0, x1, y1 } : null;
    commandBoxes.set(d, found);
    return found;
}

/** An item's device-pixel box, for an axis-aligned transform only (then the box of the control points is exact to order). */
interface DeviceBox { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number }
function deviceBoxOf(item: PaintPathItem, view: ViewState): DeviceBox | null {
    const bounds = commandBounds(item.d);
    if (!bounds) return null;
    // deviceAffine at the origin, without its array: this runs for every item of every group admission.
    const [a, b, c, d, e, f] = item.localToWorld;
    const scale = view.camera.z * view.viewport.dpr;
    if (!(Math.hypot(a, b, c, d) > 0) || !Number.isFinite(scale) || scale <= 0) return null;
    const ax = scale * a * bounds.x0 + scale * (e - view.camera.x), bx = scale * a * bounds.x1 + scale * (e - view.camera.x);
    const ay = scale * d * bounds.y0 + scale * (f - view.camera.y), by = scale * d * bounds.y1 + scale * (f - view.camera.y);
    return { x0: Math.min(ax, bx), x1: Math.max(ax, bx), y0: Math.min(ay, by), y1: Math.max(ay, by) };
}
/** Whether an item may join a coverage group: an opaque, unclipped, fill-only item under an axis-aligned transform. */
function groupable(item: PaintPathItem, cover: CoverBlend): boolean {
    const fill = item.material.fill;
    if (cover !== 'normal' || !fill || fill[3] !== 1 || item.material.stroke || item.clips.length) return false;
    const [a, b, c, d] = item.localToWorld;
    return b === 0 && c === 0 && a !== 0 && d !== 0;
}
/** Whether two items share what one coverage pass needs: colour, fill rule and transform. */
function sameGroupMaterial(a: PaintPathItem, b: PaintPathItem): boolean {
    const fa = a.material.fill!, fb = b.material.fill!;
    for (let i = 0; i < 4; i++) if (fa[i] !== fb[i]) return false;
    for (let i = 0; i < 6; i++) if (a.localToWorld[i] !== b.localToWorld[i]) return false;
    return a.fillRule === b.fillRule;
}
function separated(a: DeviceBox, b: DeviceBox): boolean {
    return a.x1 + GROUP_GAP_DEVICE_PX <= b.x0 || b.x1 + GROUP_GAP_DEVICE_PX <= a.x0 || a.y1 + GROUP_GAP_DEVICE_PX <= b.y0 || b.y1 + GROUP_GAP_DEVICE_PX <= a.y0;
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
/** Whether every clip is an axis-aligned rectangle, which the path route draws as a scissor: such a path item's clips need no
 * composer admission, live or at tile (the zoom-direct gate asks this before it draws a clipped page live). */
export function everyClipIsRectangle(clips: readonly PaintClip[]): boolean {
    for (const clip of clips) if (clipLocalRect(clip) === null) return false;
    return true;
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
/** A rectangle the caller owns and writes into: the shape the device's scissor takes, copied by the device when pushed. */
interface MutableRect { x: number; y: number; width: number; height: number }
/** Writes the clip's device rectangle for this view into `out`; false when the clip is not a rectangle or the view cannot place it. */
function writeClipDeviceRect(clip: PaintClip, view: ViewState, out: MutableRect): boolean {
    const local = clipLocalRect(clip);
    if (!local) return false;
    const [a, , , d, e, f] = clip.localToWorld;
    const scale = view.camera.z * view.viewport.dpr;
    if (!(scale > 0) || !Number.isFinite(scale)) return false;
    const ax = scale * a * local.x0 + scale * (e - view.camera.x), bx = scale * a * local.x1 + scale * (e - view.camera.x);
    const ay = scale * d * local.y0 + scale * (f - view.camera.y), by = scale * d * local.y1 + scale * (f - view.camera.y);
    const rx0 = Math.round(Math.min(ax, bx)), ry0 = Math.round(Math.min(ay, by));
    out.x = rx0; out.y = ry0; out.width = Math.round(Math.max(ax, bx)) - rx0; out.height = Math.round(Math.max(ay, by)) - ry0;
    return true;
}
/** The clip's device rectangle for this view, as a new object for the admission that keeps it. */
function clipDeviceRect(clip: PaintClip, view: ViewState): RectI | null {
    const out: MutableRect = { x: 0, y: 0, width: 0, height: 0 };
    return writeClipDeviceRect(clip, view, out) ? out : null;
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
/** The scissor a draw pushes. The device copies the rectangle it is given (webgl2Frame.ts rect), so one object serves every push
 * and a draw allocates none. */
const drawScissor: MutableRect = { x: 0, y: 0, width: 0, height: 0 };
const CLIP_UNSUPPORTED: Admission<void> = Object.freeze({ status: 'unsupported' as const, why: 'clip not a rectangle or view unplaceable' });
const CLIP_EMPTY: Admission<void> = Object.freeze({ status: 'empty' as const });
const CLIP_READY: Admission<void> = Object.freeze({ status: 'ready' as const, value: undefined });
export const withClips: WithClips = (pass, clips, view, draw) => {
    for (const clip of clips) if (!clipLocalRect(clip)) return CLIP_UNSUPPORTED;
    const width = Math.round(view.viewport.width * view.viewport.dpr), height = Math.round(view.viewport.height * view.viewport.dpr);
    const base = clipTokens.length;
    try {
        for (const clip of clips) {
            if (!writeClipDeviceRect(clip, view, drawScissor)) return CLIP_UNSUPPORTED;
            const x0 = Math.max(0, drawScissor.x), y0 = Math.max(0, drawScissor.y);
            const x1 = Math.min(width, drawScissor.x + drawScissor.width), y1 = Math.min(height, drawScissor.y + drawScissor.height);
            if (x1 <= x0 || y1 <= y0) return CLIP_EMPTY;
            drawScissor.x = x0; drawScissor.y = y0; drawScissor.width = x1 - x0; drawScissor.height = y1 - y0;
            clipTokens.push(pass.pushClip(drawScissor));
        }
        draw();
    } finally {
        for (let i = clipTokens.length - 1; i >= base; i--) pass.popClip(clipTokens[i]);
        clipTokens.length = base;
    }
    return CLIP_READY;
};

/** Prepared coverage and prepared clips carry no `status`; every stop does. */
const isStop = (value: object): value is Stop => 'status' in value;
function stopAdmission(stop: Stop): Admission<never> {
    if (stop.status === 'denied') return { status: 'denied', pool: stop.pool, bytes: stop.bytes };
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
    // Triangles by content and band, most recently used last. An array's CPU lease lives while the cache or the kit holds the array:
    // the last holder to let go releases it, so the lease is never released over memory still alive, and no array is alive without one.
    const outlines = new Map<string, Outline>();
    const cachedArrays = new Set<Float64Array>();
    const leases = new Map<Float64Array, { readonly lease: ByteLease; readonly bytes: number }>();
    let outlineBytes = 0, leasedBytes = 0, frame = 0;
    /** Releases the lease of an array nothing holds; returns the bytes given back to the CPU grant. */
    const releaseLease = (array: Float64Array): number => {
        const held = leases.get(array);
        if (!held) return 0;
        leases.delete(array); leasedBytes -= held.bytes; host.allocator.cpu.release(held.lease);
        return held.bytes;
    };
    const kit = createPathCoverageKit(host, () => auditCount(audit, 'kit:pipeline-failed'), audit,
        // The kit has let go of an array: its lease goes unless the cache still holds the array.
        array => { if (!cachedArrays.has(array)) releaseLease(array); });
    /** The exact-area kit of the same host: the fills and strokes whose contours the exact sum takes (see areaOutlines.ts). */
    const areaKit: AreaKit = createAreaKit();
    /** The composer's zoom flag (setZoom). A zoom recomposes every visible tile every frame, and exact area's fragments grow faster than
     * its box (each edge's strip runs to its region's side) while the coverage route's grow with the box. Measured, saturated zoom, GPU
     * ms per frame: 1,024 small shapes, exact area 6.2 against coverage 9.3-10.3; the notebook's page-sized paper, exact area 19-27
     * against coverage 14. So while zooming an area larger than AREA_ZOOM_MAX_PX takes the coverage route, and its tile recomposes on
     * exact area once the camera rests (as text's stand-ins do); a smaller one stays exact throughout. */
    let zooming = false, buildInexact = false;
    /** Takes an outline out of the cache. Its lease goes now unless the kit still holds the array; if it does, the kit's
     * release (onFreed) returns the lease. Returns the bytes given back now. */
    const dropFromCache = (key: string, old: Outline): number => {
        outlines.delete(key); cachedArrays.delete(old.positive); outlineBytes -= old.bytes;
        // The kit's packs of this outline (a group's pack, built from its triangles) go with it, unless a draw still reads them.
        kit.forgetTriangles(old.positive);
        return kit.holds(old.positive) ? 0 : releaseLease(old.positive);
    };
    /** Frees unused outlines the kit does not hold, oldest first, until `bytes` are given back to the CPU grant. */
    const reclaimLeases = (bytes: number): number => {
        let freed = 0;
        for (const [key, old] of outlines) {
            if (freed >= bytes) break;
            if (old.usedFrame >= frame || kit.holds(old.positive)) continue;
            freed += dropFromCache(key, old);
        }
        return freed;
    };
    /** Reserves `bytes` of CPU grant for an outline. A refusal reclaims what unused outlines hold, then tries once more. */
    const leaseBytes = (bytes: number): ByteLease | null => {
        let lease = host.allocator.cpu.reserve(bytes);
        if (!lease && reclaimLeases(bytes) > 0) lease = host.allocator.cpu.reserve(bytes);
        return lease;
    };
    const isRefused = (geometry: Outline | Refused | null): geometry is Refused => geometry !== null && 'refused' in geometry;
    const outlineFor = (key: string, d: readonly PathCommand[], band: number,
        build: (tolerance: number, origin: Origin) => Shapes | null): Outline | Refused | null => {
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
        const lease = leaseBytes(bytes);
        if (!lease) { auditCount(audit, 'geom:refused'); return { refused: bytes }; }
        leases.set(shapes.positive, { lease, bytes }); leasedBytes += bytes;
        const outline: Outline = { origin, positive: shapes.positive, negative: shapes.negative, edges: shapes.edges, bounds: shapes.bounds,
            bytes, usedFrame: frame };
        outlines.set(key, outline); cachedArrays.add(shapes.positive); outlineBytes += bytes;
        // The bound is soft: an outline used this frame is never dropped, so the cache is trimmed by what other frames left behind.
        if (outlineBytes > GEOMETRY_CACHE_BYTES) {
            for (const [oldKey, old] of outlines) {
                if (outlineBytes <= GEOMETRY_CACHE_BYTES) break;
                if (old.usedFrame < frame && oldKey !== key) dropFromCache(oldKey, old);
            }
        }
        return outline;
    };

    /** Takes the kit's result into `acquired`, or says why not. A denial is the kit's own: the pool and bytes it needs, so the caller
     * waits on the pool that frees them (a CPU staging copy or pack is not a GPU wait). */
    const take = (result: PathCoverageAdmission, acquired: Acquired[]): PreparedPathCoverage | Stop => {
        if (result.status === 'ready') { acquired.push(result.value); return result.value; }
        if (result.status === 'denied') return { status: 'denied', pool: result.pool, bytes: result.bytes };
        if (result.status === 'deferred') return { status: 'deferred' };
        if (result.status === 'empty') return { status: 'empty' };
        return { status: 'unsupported', why: 'coverage kit' };
    };
    /** The area kit's result, as `take` takes the coverage kit's. A deferral is discarded here: the next frame admits the shape again. */
    const takeArea = (result: AreaAdmission, acquired: Acquired[]): PreparedArea | Stop => {
        if (result.status === 'ready') { acquired.push(result.value); return result.value; }
        if (result.status === 'denied') return { status: 'denied', pool: result.pool, bytes: result.bytes };
        // A deferral keeps the uploaded pieces on the kit's edge set: the next frame resumes them.
        if (result.status === 'deferred') return { status: 'deferred' };
        if (result.status === 'empty') return { status: 'empty' };
        return { status: 'unsupported', why: result.why };
    };
    const retireAcquired = (held: Acquired): void => { if ('affines' in held) areaKit.retire(held); else kit.retire(held); };
    const makeClips = (scissors: RectI[], masks: PreparedPathCoverage[]): PreparedClips => ({
        scissors: Object.freeze(scissors),
        masks: Object.freeze(masks),
        drawMask: (pass, mask) => kit.drawMask(pass, mask),
        retire: () => { for (const mask of masks) kit.retire(mask); },
    });
    /** The clips of an item that has none: one frozen value, so a grouped item builds no clips. */
    const noClips = makeClips([], []);
    /** One coverage pass for a group of items that share colour, rule and transform, with disjoint device bounds: one admission
     * with one set per member. Each member keeps its own cached triangles, keyed by its content and band exactly as a lone item's
     * are, and the kit moves each set onto the group's origin by its shift, so nothing is copied into a merged set. Null when a
     * member's geometry cannot be built or the kit calls the group unsupported (a nonzero stencil over its edge bound): the caller
     * then admits the items one by one, which the same kit takes. */
    const admitGroup = (members: readonly PaintPathItem[], view: ViewState, viewport: Viewport, cover: CoverBlend, budget: FrameBudget,
        acquired: Acquired[]): ItemAdmission | null => {
        const lead = members[0];
        const band = bandOf(lead.localToWorld, view);
        if (band === null) return null;
        // On the exact-area route the group is one area: its members share a transform and their device boxes are apart, so the
        // sum of their contours is exact. One member the route refuses sends the whole group to the coverage pass below.
        const areaSets: AreaOutline[] = [];
        for (const member of members) {
            const outline = areaContours(member, 'fill', band);
            if ('refused' in outline) return { status: 'denied', bytes: outline.refused, pool: 'cpu' };
            if (!outline.edges) { auditCount(audit, `area:fallback:${outline.why}`); areaSets.length = 0; break; }
            if (outline.edges.length) areaSets.push(outline);
        }
        if (areaSets.length) {
            const shape = areaBox(areaSets, lead.localToWorld, view, viewport);
            if (shape.kind === 'empty') return { status: 'empty' };
            if (shape.kind === 'area' && !zoomCoverage(shape)) {
                const admitted = admitParts(shape, lead.material.fill!, cover, viewport, budget, acquired);
                if (admitted && isStop(admitted)) return admitted;
                if (admitted) {
                    auditCount(audit, 'route:path-group', members.length);
                    auditCount(audit, 'area:exact:group');
                    return { status: 'ready', value: { clips: noClips, fill: null, stroke: null, fillArea: admitted, strokeArea: null } };
                }
            } else if (shape.kind === 'coverage') auditCount(audit, `area:fallback:${shape.why}`);
        }
        const outlines: Outline[] = [];
        for (const member of members) {
            const geometry = outlineFor(`fill|${commandKey(member.d)}|${band}`, member.d, band,
                (tolerance, origin) => pathFillTriangles(member.d, { tolerance, origin: [origin.x, origin.y] }));
            if (isRefused(geometry)) return { status: 'denied', bytes: geometry.refused, pool: 'cpu' };
            if (!geometry) return null;
            outlines.push(geometry);
        }
        const groupOrigin = outlines[0].origin;
        const sets: PathCoverageShapes[] = outlines.map(outline => ({ positive: outline.positive, negative: outline.negative,
            edges: outline.edges, bounds: outline.bounds,
            shift: [outline.origin.x - groupOrigin.x, outline.origin.y - groupOrigin.y] as const }));
        const affine = deviceAffine(lead.localToWorld, groupOrigin, view);
        if (!affine) return { status: 'unsupported', why: 'path geometry' };
        const result = kit.admitSets({ sets, rule: lead.fillRule, affine, viewport, colour: lead.material.fill!,
            output: { kind: 'composite', blend: cover } }, budget);
        // The kit's 'unsupported' is the group's alone (its nonzero edge bound): null makes the caller admit the members one by one.
        if (result.status === 'unsupported') return null;
        const taken = take(result, acquired);
        if (isStop(taken)) return taken;
        auditCount(audit, 'route:path-group', members.length);
        return { status: 'ready', value: { clips: noClips, fill: taken, stroke: null, fillArea: null, strokeArea: null } };
    };

    /** Admits a clip list. Masks it acquires go into `acquired`; the caller retires them on any stop. */
    const admitClipList = (clips: readonly PaintClip[], view: ViewState, viewport: Viewport, budget: FrameBudget,
        acquired: Acquired[]): PreparedClips | Stop => {
        // Most items have no clip: they share the frozen empty clips, so an unclipped admission builds no arrays.
        if (!clips.length) return noClips;
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
            if (isRefused(geometry)) return { status: 'denied', bytes: geometry.refused, pool: 'cpu' };
            const affine = geometry && deviceAffine(clip.localToWorld, geometry.origin, view);
            if (!geometry || !affine) return { status: 'unsupported', why: 'clip geometry' };
            const taken = take(kit.admit({ shapes: geometry, rule: clip.fillRule, affine, viewport, colour: WHITE, output: { kind: 'mask' } }, budget),
                acquired);
            if (isStop(taken)) return taken;
            masks.push(taken);
        }
        return makeClips(scissors, masks);
    };

    /** A fill's or stroke's exact-area edges, by content and band, most recently used last; or why the coverage route takes it. The
     * flattening and both exactness checks (a simple contour, nesting of opposite signs only) run once per band: they are invariant
     * under the item's affine, and the kit transforms the edges on the GPU, so a pan or a zoom inside the band computes and uploads
     * nothing. A refusal is kept as well, so a refused shape is not flattened again on every frame it is composed. */
    const areaOutlines = new Map<string, AreaOutline>();
    let areaBytes = 0;
    const dropArea = (key: string, old: AreaOutline): number => {
        areaOutlines.delete(key);
        if (old.edges) areaKit.forget(old.edges);
        if (!old.lease) return 0;
        areaBytes -= old.bytes; host.allocator.cpu.release(old.lease);
        return old.bytes;
    };
    const reclaimArea = (bytes: number): number => {
        let freed = 0;
        for (const [key, old] of areaOutlines) {
            if (freed >= bytes) break;
            if (old.usedFrame < frame) freed += dropArea(key, old);
        }
        return freed;
    };
    const areaContours = (item: PaintPathItem, which: 'fill' | 'stroke', band: number): AreaOutline | Refused => {
        const style = item.material.stroke;
        const key = which === 'fill' ? `${commandKey(item.d)}|${band}|${item.fillRule}`
            : `${commandKey(item.d)}|${band}|${style!.width}|${style!.cap}|${style!.join}|${style!.miterLimit}|${style!.dash ? 'dash' : ''}`;
        const full = `${which}|${key}`;
        const cached = areaOutlines.get(full);
        if (cached) { areaOutlines.delete(full); areaOutlines.set(full, cached); cached.usedFrame = frame; return cached; }
        const tolerance = AREA_FLATTEN_DEVICE_PX / Math.pow(2, (band + 1) / 2);
        let contours: Contour[] | null = null, why: string | null = null;
        if (which === 'fill') {
            const subpaths = flattenContours(item.d, tolerance, PATH_FILL_MAX_EDGES);
            contours = subpaths && fillContours(subpaths);
        } else if (style!.dash) why = 'dash';
        else {
            const lines = flattenPolylines(item.d, tolerance);
            contours = lines && strokeContours(lines, { width: style!.width, cap: style!.cap, join: style!.join, miterLimit: style!.miterLimit }, tolerance);
        }
        if (!why && !contours) why = `${which}-outline`;
        // The exact sum needs contours that cross and touch nothing, and nest only with opposite signs (areaNestingExact).
        if (!why && contours!.length && !areaNestingExact(contours!)) why = 'nesting';
        let outline: AreaOutline;
        if (why) outline = { edges: null, origin: ORIGIN, box: EMPTY_BOX, why, bytes: 0, lease: null, usedFrame: frame };
        else {
            // The edges are rebased on the contours' lower-left corner in double precision before they become float32.
            let ox = Infinity, oy = Infinity, mx = -Infinity, my = -Infinity, count = 0;
            for (const contour of contours!) {
                count += contour.length >> 1;
                for (let i = 0; i < contour.length; i += 2) {
                    ox = Math.min(ox, contour[i]); mx = Math.max(mx, contour[i]); oy = Math.min(oy, contour[i + 1]); my = Math.max(my, contour[i + 1]);
                }
            }
            const edges = new Float32Array(4 * count);
            let at = 0;
            for (const contour of contours!) {
                const n = contour.length >> 1;
                for (let i = 0; i < n; i++) {
                    const j = (i + 1) % n;
                    edges[at++] = contour[2 * i] - ox; edges[at++] = contour[2 * i + 1] - oy; edges[at++] = contour[2 * j] - ox; edges[at++] = contour[2 * j + 1] - oy;
                }
            }
            const bytes = edges.byteLength;
            const lease = bytes ? leaseBytes(bytes) : null;
            if (bytes && !lease) { auditCount(audit, 'area:geom-refused'); return { refused: bytes }; }
            outline = { edges, origin: count ? { x: ox, y: oy } : ORIGIN, box: count ? { x0: 0, y0: 0, x1: mx - ox, y1: my - oy } : EMPTY_BOX,
                why: null, bytes, lease, usedFrame: frame };
            areaBytes += bytes;
        }
        areaOutlines.set(full, outline);
        auditCount(audit, 'area:geom-build');
        if (areaBytes > AREA_CACHE_BYTES) {
            for (const [oldKey, old] of areaOutlines) {
                if (areaBytes <= AREA_CACHE_BYTES) break;
                if (old.usedFrame < frame && oldKey !== full) dropArea(oldKey, old);
            }
        }
        return outline;
    };
    /** The parts of an area (outlines under one item transform) and the device box they cover, cut to the viewport (the kit's scratch
     * is viewport-sized; edges left of it count for every pixel to their right, those outside it otherwise draw nothing). Per
     * admission this is all a new view costs on the CPU: four corners per outline and an affine. */
    const areaBox = (outlines: readonly AreaOutline[], localToWorld: Affine, view: ViewState, viewport: Viewport): AreaShape => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const affines: Affine[] = [];
        for (const outline of outlines) {
            const affine = deviceAffine(localToWorld, outline.origin, view);
            if (!affine) return { kind: 'coverage', why: 'transform' };
            affines.push(affine);
            const [A, B, C, D, E, F] = affine, { x0, y0, x1, y1 } = outline.box;
            for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as const) {
                const X = A * x + C * y + E, Y = B * x + D * y + F;
                if (X < minX) minX = X;
                if (X > maxX) maxX = X;
                if (Y < minY) minY = Y;
                if (Y > maxY) maxY = Y;
            }
        }
        const x0 = Math.max(0, Math.floor(minX)), y0 = Math.max(0, Math.floor(minY));
        const x1 = Math.min(viewport.width, Math.ceil(maxX) + 1), y1 = Math.min(viewport.height, Math.ceil(maxY) + 1);
        if (!(x1 > x0 && y1 > y0)) return { kind: 'empty' };
        // Band-local: the box's corner is the scratch's origin.
        const parts = outlines.map((outline, i): AreaPart => {
            const [A, B, C, D, E, F] = affines[i];
            return { edges: outline.edges!, affine: [A, B, C, D, E - x0, F - y0] };
        });
        return { kind: 'area', parts, bounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
    };
    /** Whether a live zoom sends this area to the coverage route (counted; the run is then inexact and recomposes at rest). */
    const zoomCoverage = (shape: Extract<AreaShape, { kind: 'area' }>): boolean => {
        if (!zooming || shape.bounds.width * shape.bounds.height <= AREA_ZOOM_MAX_PX) return false;
        buildInexact = true; auditCount(audit, 'area:zoom-coverage'); auditTape(`${audit}:area:zoom-coverage`);
        return true;
    };
    /** Admits an area on the kit. Null when the kit cannot take it (no float targets: counted) and the coverage route must. */
    const admitParts = (shape: Extract<AreaShape, { kind: 'area' }>, colour: Rgba, cover: CoverBlend, viewport: Viewport, budget: FrameBudget,
        acquired: Acquired[]): AreaItem | Stop | null => {
        const taken = takeArea(areaKit.admit(host, shape.parts, shape.bounds, budget, viewport), acquired);
        if (isStop(taken)) {
            if (taken.status === 'unsupported') { auditCount(audit, 'area:fallback:unsupported'); return null; }
            return taken;
        }
        return { prepared: taken, output: { kind: 'area', blend: cover, rgb: [colour[0], colour[1], colour[2]], alpha: colour[3] } };
    };
    /** The exact-area route for one fill or stroke: its cells admitted on the area kit, or null when the coverage route takes it (the
     * reason is counted). A kit refusal stops the item as the coverage kit's does. */
    const admitArea = (item: PaintPathItem, which: 'fill' | 'stroke', view: ViewState, viewport: Viewport, band: number, cover: CoverBlend,
        budget: FrameBudget, acquired: Acquired[]): AreaItem | Stop | null => {
        const outline = areaContours(item, which, band);
        if ('refused' in outline) return { status: 'denied', pool: 'cpu', bytes: outline.refused };
        if (!outline.edges) { auditCount(audit, `area:fallback:${outline.why}`); return null; }
        if (!outline.edges.length) return { status: 'empty' };
        const shape = areaBox([outline], item.localToWorld, view, viewport);
        if (shape.kind === 'coverage') { auditCount(audit, `area:fallback:${shape.why}`); return null; }
        if (shape.kind === 'empty') return { status: 'empty' };
        if (zoomCoverage(shape)) return null;
        const colour = which === 'fill' ? item.material.fill! : item.material.stroke!.color;
        const admitted = admitParts(shape, colour, cover, viewport, budget, acquired);
        if (admitted && !isStop(admitted)) auditCount(audit, `area:exact:${which}`);
        return admitted;
    };
    /** One path item: its clips, fill and stroke. Whatever it acquires goes into `acquired`; the caller retires it on any stop.
     * An item is 'empty' when nothing of it can show in this view. A fill or stroke takes the exact-area route when its contours are
     * exact, and the coverage route otherwise (counted). */
    const admitItem = (item: PaintPathItem, view: ViewState, viewport: Viewport, cover: CoverBlend, budget: FrameBudget,
        acquired: Acquired[]): ItemAdmission => {
        const clips = admitClipList(item.clips, view, viewport, budget, acquired);
        if (isStop(clips)) return clips;
        let fill: PreparedPathCoverage | null = null, fillArea: AreaItem | null = null;
        if (item.material.fill) {
            const band = bandOf(item.localToWorld, view);
            if (band === null) return { status: 'unsupported', why: 'path transform' };
            const area = admitArea(item, 'fill', view, viewport, band, cover, budget, acquired);
            if (area && isStop(area)) { if (area.status !== 'empty') return area; }
            else if (area) fillArea = area;
            else {
                const geometry = outlineFor(`fill|${commandKey(item.d)}|${band}`, item.d, band,
                    (tolerance, origin) => pathFillTriangles(item.d, { tolerance, origin: [origin.x, origin.y] }));
                if (isRefused(geometry)) return { status: 'denied', bytes: geometry.refused, pool: 'cpu' };
                const affine = geometry && deviceAffine(item.localToWorld, geometry.origin, view);
                if (!geometry || !affine) return { status: 'unsupported', why: 'path geometry' };
                const taken = take(kit.admit({ shapes: geometry, rule: item.fillRule, affine, viewport, colour: item.material.fill,
                    output: { kind: 'composite', blend: cover } }, budget), acquired);
                if (isStop(taken)) { if (taken.status !== 'empty') return taken; }
                else fill = taken;
            }
        }
        let stroke: PreparedPathCoverage | null = null, strokeArea: AreaItem | null = null;
        const style = item.material.stroke;
        if (style && style.width > 0) {
            const band = bandOf(item.localToWorld, view);
            if (band === null) return { status: 'unsupported', why: 'path transform' };
            const area = admitArea(item, 'stroke', view, viewport, band, cover, budget, acquired);
            if (area && isStop(area)) { if (area.status !== 'empty') return area; }
            else if (area) strokeArea = area;
            else {
                const dash = style.dash ? `${style.dash.phase}:${style.dash.array.join(',')}` : '';
                const key = `stroke|${commandKey(item.d)}|${band}|${style.width}|${style.cap}|${style.join}|${style.miterLimit}|${dash}`;
                const geometry = outlineFor(key, item.d, band, (tolerance, origin) => {
                    const outline = pathStrokeTriangles(item.d, { width: style.width, cap: style.cap, join: style.join, miterLimit: style.miterLimit,
                        ...(style.dash ? { dash: style.dash } : {}), tolerance, origin: [origin.x, origin.y] });
                    return outline && { positive: outline.triangles, negative: NO_TRIANGLES, edges: 0, bounds: outline.bounds };
                });
                if (isRefused(geometry)) return { status: 'denied', bytes: geometry.refused, pool: 'cpu' };
                const affine = geometry && deviceAffine(item.localToWorld, geometry.origin, view);
                if (!geometry || !affine) return { status: 'unsupported', why: 'stroke geometry' };
                const taken = take(kit.admit({ shapes: geometry, rule: 'union', affine, viewport, colour: style.color,
                    output: { kind: 'composite', blend: cover } }, budget), acquired);
                if (isStop(taken)) { if (taken.status !== 'empty') return taken; }
                else stroke = taken;
            }
        }
        if (!fill && !stroke && !fillArea && !strokeArea) return { status: 'empty' };
        return { status: 'ready', value: { clips, fill, stroke, fillArea, strokeArea } };
    };

    // One closure for every item: the pass and item of the draw in progress are held here, so a draw builds no closure.
    let drawPass: GpuPass | null = null, drawingItem: PreparedPathItem | null = null;
    /** The frame whose area draw a uniform-ring refusal cost (-1: none). An area draw refused like a coverage draw: skipped, counted,
     * the next frame requested, and the frame reported incomplete through drawRefusedThisFrame. */
    let areaRefusedFrame = -1;
    /** One exact-area draw. Only the out-of-budget refusal is caught here; anything else propagates. */
    /** A uniform-ring refusal at an area's accumulation or composite: the area is skipped, counted, the next frame requested, and the
     * frame reported incomplete through drawRefusedThisFrame. Anything else propagates. */
    const areaRefused = (error: unknown): void => {
        if (!(error instanceof ArenaError) || error.code !== 'out-of-budget') throw error;
        areaRefusedFrame = frame;
        auditCount(audit, 'area:draw-refused');
        host.invalidate('path-coverage-refused');
    };
    const drawArea = (pass: GpuPass, area: AreaItem): void => {
        try { if (!areaKit.composite(pass, area.prepared, area.output)) { areaRefusedFrame = frame; auditCount(audit, 'area:not-placed'); } }
        catch (error) { areaRefused(error); }
    };
    /** One item's areas, for placing in a batch: reused per item. */
    const itemAreas: PreparedArea[] = [];
    /** Draws a run's items in paint order. Their areas are accumulated first, as many consecutive items' as the scratch holds, in one
     * pass (areaCoverage.ts); then those items draw, each area a composite from its region under the item's clips. */
    const drawRun = (pass: GpuPass, items: readonly PreparedPathItem[]): void => {
        let i = 0;
        while (i < items.length) {
            let j = i;
            areaKit.beginBatch(host);
            try {
                for (; j < items.length; j++) {
                    const item = items[j];
                    itemAreas.length = 0;
                    if (item.fillArea) itemAreas.push(item.fillArea.prepared);
                    if (item.strokeArea) itemAreas.push(item.strokeArea.prepared);
                    if (itemAreas.length && !areaKit.place(host, pass, itemAreas)) break;
                }
            } catch (error) {
                // A refused accumulation leaves the rest unplaced: they draw without their areas (counted), and the frame asks again.
                areaRefused(error);
                j = items.length;
            } finally { areaKit.endBatch(pass); }
            // The scratch is at least the viewport and an area is cut to it, so an empty batch always takes the first item; were it
            // ever not to, the item draws without its areas rather than stalling the run.
            if (j === i) j = i + 1;
            for (let k = i; k < j; k++) drawItem(pass, items[k]);
            i = j;
        }
    };
    const drawInside = (): void => {
        const pass = drawPass!, item = drawingItem!;
        if (item.fill) kit.draw(pass, item.fill);
        if (item.fillArea) drawArea(pass, item.fillArea);
        if (item.stroke) kit.draw(pass, item.stroke);
        if (item.strokeArea) drawArea(pass, item.strokeArea);
    };
    const drawItem = (pass: GpuPass, item: PreparedPathItem): void => {
        drawPass = pass; drawingItem = item;
        try { withPreparedClips(pass, item.clips, drawInside); }
        finally { drawPass = null; drawingItem = null; }
    };

    const route: ItemRoute<PaintPathItem> & { drawRefusedThisFrame(): boolean; setZoom(value: boolean): void; exact(run: PreparedRun): boolean } = {
        id: 'path',
        setZoom(value: boolean): void { zooming = value; },
        exact(run: PreparedRun): boolean { return run.route !== 'path' || !(run as PathRun).inexact; },
        // The kit caught a uniform-ring refusal at one of this frame's draws: the frame's coverage is incomplete there (gpu-h4's kit).
        drawRefusedThisFrame: (): boolean => kit.drawRefusedThisFrame() || areaRefusedFrame === frame,
        accepts: (item): item is PaintPathItem => item.kind === 'path',
        admit(items, view, blend, budget): Admission<PreparedRun> {
            const cover: CoverBlend = blend === 'modulate' ? 'modulate' : 'normal';
            const viewport = viewportOf(view);
            const acquired: Acquired[] = [], prepared: PreparedPathItem[] = [];
            buildInexact = false;
            // Consecutive items that can share a coverage pass wait in `group` (with their device boxes); the first item that cannot
            // join ends the group, so the draw order of every item is kept.
            const group: PaintPathItem[] = [], boxes: DeviceBox[] = [];
            const stopWith = (stop: Stop): Admission<PreparedRun> => {
                for (const held of acquired) retireAcquired(held);
                return stopAdmission(stop);
            };
            /** Places one admission: a ready item is prepared, an empty one is skipped and what it acquired retired, any other
             * stop is returned for the caller to end the run with. */
            const place = (admission: ItemAdmission, mark: number): Stop | null => {
                if (admission.status === 'ready') { prepared.push(admission.value); return null; }
                for (let i = acquired.length - 1; i >= mark; i--) retireAcquired(acquired[i]);
                acquired.length = mark;
                return admission.status === 'empty' ? null : admission;
            };
            const flush = (): Stop | null => {
                if (!group.length) return null;
                const members = group.splice(0);
                boxes.length = 0;
                const mark = acquired.length;
                if (members.length > 1) {
                    const grouped = admitGroup(members, view, viewport, cover, budget, acquired);
                    if (grouped) return place(grouped, mark);
                }
                for (const member of members) {
                    const itemMark = acquired.length;
                    const stopped = place(admitItem(member, view, viewport, cover, budget, acquired), itemMark);
                    if (stopped) return stopped;
                }
                return null;
            };
            for (const item of items) {
                const box = groupable(item, cover) ? deviceBoxOf(item, view) : null;
                if (box && (!group.length || (sameGroupMaterial(group[0], item) && boxes.every(other => separated(other, box))))) {
                    group.push(item); boxes.push(box);
                    if (group.length >= GROUP_MAX_ITEMS) { const ended = flush(); if (ended) return stopWith(ended); }
                    continue;
                }
                const ended = flush();
                if (ended) return stopWith(ended);
                const mark = acquired.length;
                const stopped = place(admitItem(item, view, viewport, cover, budget, acquired), mark);
                if (stopped) return stopWith(stopped);
            }
            const ended = flush();
            if (ended) return stopWith(ended);
            if (!prepared.length) return { status: 'empty' };
            auditCount(audit, 'route:path', prepared.length);
            const run: PathRun = { route: 'path', blend, items: prepared, inexact: buildInexact };
            return { status: 'ready', value: run };
        },
        draw(pass: GpuPass, run: PreparedRun): void {
            if (run.route !== 'path') throw new Error('Path route drew a run of another route');
            drawRun(pass, (run as PathRun).items);
        },
        retire(run: PreparedRun): void {
            if (run.route !== 'path') throw new Error('Path route retired a run of another route');
            for (const item of (run as PathRun).items) {
                item.clips.retire();
                if (item.fill) kit.retire(item.fill);
                if (item.stroke) kit.retire(item.stroke);
                if (item.fillArea) areaKit.retire(item.fillArea.prepared);
                if (item.strokeArea) areaKit.retire(item.strokeArea.prepared);
            }
        },
        release(): void {
            // The cache lets go first, so the kit's releases return every lease (a lease is kept while the cache holds its array).
            outlines.clear(); cachedArrays.clear(); outlineBytes = 0;
            for (const [key, old] of [...areaOutlines]) dropArea(key, old);
            kit.release();
            areaKit.release();
            for (const array of [...leases.keys()]) releaseLease(array);
        },
        memory(): { gpuBytes: number; cpuBytes: number } {
            // The kit's packs are CPU leases of its own (a group's packed triangles): they are the route's bytes too.
            const kitMemory = kit.memory();
            return { gpuBytes: kitMemory.gpuBytes + areaKit.memory().gpuBytes, cpuBytes: leasedBytes + kitMemory.cpuBytes };
        },
    };
    const admitClips: AdmitClips = (clips, view, budget) => {
        const acquired: Acquired[] = [];
        const result = admitClipList(clips, view, viewportOf(view), budget, acquired);
        if (isStop(result)) {
            for (const held of acquired) retireAcquired(held);
            return stopAdmission(result);
        }
        return { status: 'ready', value: result };
    };
    /** Marks the frame for both caches: a triangle set or outline used in this frame is never reclaimed. The adapter advances the
     * frame through `coverage` (it holds only the kit), so `coverage` advances this route's frame too: a route frame left at 0 gave
     * every outline usedFrame 0, and the outline cache never reclaimed one (review R1). */
    const beginFrameBoth = (next: number): void => { frame = next; kit.beginFrame(next); areaKit.beginFrame(next); };
    return {
        route, admitClips, coverage: { ...kit, beginFrame: beginFrameBoth },
        beginFrame: beginFrameBoth,
        /** The governor's CPU reclaim for the outline cache: frees unused outlines oldest first and returns the bytes freed. */
        evictCpu(bytes: number): number { const freed = reclaimLeases(bytes); return freed < bytes ? freed + reclaimArea(bytes - freed) : freed; },
    };
}

export const createPathRoute: CreatePathRoute = (host, audit) => createPath(host, audit).route;
