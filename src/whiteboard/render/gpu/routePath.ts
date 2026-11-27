import type { Affine, PathCommand, Rgba, ViewState } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { ByteLease, ClipToken, GpuPass, RectI } from '../../../platform/render/gfx/api';
import type { FrameBudget } from '../../../platform/render/types';
import { auditCount, auditTape } from '../../../platform/render/renderAudit';
import { createPathCoverageKit, type PathCoverageAdmission, type PathCoverageShapes, type PreparedPathCoverage } from '../../../platform/render/pathCoverage';
import { PATH_FILL_MAX_EDGES, flattenContours, pathFillTriangles } from '../pathFillTriangles';
import { flattenPolylines, pathStrokeTriangles } from '../pathStrokeTriangles';
import { createAreaKit, type AreaAdmission, type AreaKit, type AreaPart, type PreparedArea } from '../../../platform/render/areaCoverage';
import { cutClipOf, cutContours, fillContours, strokeContours, type Contour, type CutClip } from './areaOutlines';
import { compose, inverse } from '../../geom/affine';
import { areaNestingExact } from '../inkAreaCells';
import type { AreaOutput } from '../../../platform/render/gfx/api';
import { ArenaError } from '../../../platform/render/resourceArena';
import type { PaintClip, PaintPathItem } from '../paintStream';
import type { Admission, CreatePathRoute, ItemRoute, PreparedRun, WithClips } from './contracts';

const FLATTEN_DEVICE_PX = 0.1;
const GEOMETRY_CACHE_BYTES = 16 * 2 ** 20;
const NO_TRIANGLES = new Float64Array(0);
const ORIGIN = Object.freeze({ x: 0, y: 0 });
const EMPTY_BOX = Object.freeze({ x0: 0, y0: 0, x1: 0, y1: 0 });
const WHITE = Object.freeze([1, 1, 1, 1] as const);
const GROUP_MAX_ITEMS = 512;
const GROUP_GAP_DEVICE_PX = 2;

type Origin = Readonly<{ x: number; y: number }>;
type Bounds = Readonly<{ x0: number; y0: number; x1: number; y1: number }>;
interface Shapes { readonly positive: Float64Array; readonly negative: Float64Array; readonly edges: number; readonly bounds: Bounds }
interface Outline extends Shapes { readonly origin: Origin; readonly bytes: number; usedFrame: number }
interface Refused { readonly refused: number }
interface LocalRect { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number }
interface Viewport { readonly width: number; readonly height: number }
type CoverBlend = 'normal' | 'modulate';
type Stop = { readonly status: 'empty' } | { readonly status: 'denied'; readonly bytes: number; readonly pool: 'cpu' | 'gpu' } | { readonly status: 'deferred' }
    | { readonly status: 'unsupported'; readonly why: string };

export interface PreparedClips {
    readonly scissors: readonly RectI[];
    readonly masks: readonly PreparedPathCoverage[];
    readonly drawMask: (pass: GpuPass, mask: PreparedPathCoverage) => void;
    readonly retire: () => void;
}
export type AdmitClips = (clips: readonly PaintClip[], view: ViewState, budget: FrameBudget) => Admission<PreparedClips>;

const AREA_FLATTEN_DEVICE_PX = 0.02;
const AREA_ZOOM_MAX_PX = 258 * 258;
const AREA_CACHE_BYTES = 8 * 2 ** 20;
interface AreaItem { readonly prepared: PreparedArea; readonly output: AreaOutput }
interface PreparedPathItem { readonly clips: PreparedClips; readonly fill: PreparedPathCoverage | null; readonly stroke: PreparedPathCoverage | null;
    readonly fillArea: AreaItem | null; readonly strokeArea: AreaItem | null }
type Acquired = PreparedPathCoverage | PreparedArea;
type AreaShape = { readonly kind: 'area'; readonly parts: readonly AreaPart[]; readonly bounds: RectI } | { readonly kind: 'coverage'; readonly why: string }
    | { readonly kind: 'empty' };
interface AreaOutline {
    readonly edges: Float32Array | null; readonly origin: Origin; readonly box: Bounds; readonly why: string | null; readonly bytes: number;
    readonly lease: ByteLease | null; usedFrame: number }
interface PathRun extends PreparedRun { readonly route: 'path'; readonly items: readonly PreparedPathItem[];
    readonly inexact: boolean }
type ItemAdmission = { readonly status: 'ready'; readonly value: PreparedPathItem } | Stop;

interface ItemCut { readonly key: string; readonly shape: CutClip }
const itemCuts = new WeakMap<PaintPathItem, ItemCut | null>();
function cutOf(item: PaintPathItem): ItemCut | null {
    const known = itemCuts.get(item);
    if (known !== undefined) return known;
    let cut: ItemCut | null = null;
    const style = item.material.stroke;
    if (item.clips.length === 1 && !item.material.fill && style && style.width > 0 && !style.dash) {
        const clip = item.clips[0];
        const local = inverse(item.localToWorld, 1e6);
        const toLocal = local && compose(local, clip.localToWorld);
        const shape = toLocal && cutClipOf(clip.d, clip.fillRule, toLocal);
        if (shape) cut = { key: `${clip.key}|${toLocal!.join(',')}`, shape };
    }
    itemCuts.set(item, cut);
    return cut;
}

function bandOf(localToWorld: Affine, view: ViewState): number | null {
    const [a, b, c, d] = localToWorld;
    const scale = view.camera.z * view.viewport.dpr * Math.hypot(a, b, c, d);
    if (!(scale > 0) || !Number.isFinite(scale)) return null;
    return Math.floor(2 * Math.log2(scale) + 1e-9);
}
function flattenTolerance(band: number): number {
    return FLATTEN_DEVICE_PX / Math.pow(2, (band + 1) / 2);
}

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

function deviceAffine(localToWorld: Affine, origin: Origin, view: ViewState): Affine | null {
    const [a, b, c, d, e, f] = localToWorld;
    const scale = view.camera.z * view.viewport.dpr;
    if (!(Math.hypot(a, b, c, d) > 0) || !Number.isFinite(scale) || scale <= 0) return null;
    return [scale * a, scale * b, scale * c, scale * d,
        scale * (a * origin.x + c * origin.y + e - view.camera.x), scale * (b * origin.x + d * origin.y + f - view.camera.y)];
}

const commandKeys = new WeakMap<readonly PathCommand[], string>();
function commandKey(d: readonly PathCommand[]): string {
    const known = commandKeys.get(d);
    if (known !== undefined) return known;
    const key = textKey(JSON.stringify(d));
    commandKeys.set(d, key);
    return key;
}
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

interface DeviceBox { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number }
function deviceBoxOf(item: PaintPathItem, view: ViewState): DeviceBox | null {
    const bounds = commandBounds(item.d);
    if (!bounds) return null;
    const [a, b, c, d, e, f] = item.localToWorld;
    const scale = view.camera.z * view.viewport.dpr;
    if (!(Math.hypot(a, b, c, d) > 0) || !Number.isFinite(scale) || scale <= 0) return null;
    const ax = scale * a * bounds.x0 + scale * (e - view.camera.x), bx = scale * a * bounds.x1 + scale * (e - view.camera.x);
    const ay = scale * d * bounds.y0 + scale * (f - view.camera.y), by = scale * d * bounds.y1 + scale * (f - view.camera.y);
    return { x0: Math.min(ax, bx), x1: Math.max(ax, bx), y0: Math.min(ay, by), y1: Math.max(ay, by) };
}
function groupable(item: PaintPathItem, cover: CoverBlend): boolean {
    const fill = item.material.fill;
    if (cover !== 'normal' || !fill || fill[3] !== 1 || item.material.stroke || item.clips.length) return false;
    const [a, b, c, d] = item.localToWorld;
    return b === 0 && c === 0 && a !== 0 && d !== 0;
}
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
function clipLocalRect(clip: PaintClip): LocalRect | null {
    const known = localRects.get(clip);
    if (known !== undefined) return known;
    const found = rectangleOf(clip);
    localRects.set(clip, found);
    return found;
}
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
    for (let i = 0; i < 4; i++) { const p = points[i], q = points[(i + 1) % 4]; if (p[0] !== q[0] && p[1] !== q[1]) return null; }
    const [x0, x1] = [...xs].sort((p, q) => p - q), [y0, y1] = [...ys].sort((p, q) => p - q);
    return { x0, x1, y0, y1 };
}

interface MutableRect { x: number; y: number; width: number; height: number }
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
function clipDeviceRect(clip: PaintClip, view: ViewState): RectI | null {
    const out: MutableRect = { x: 0, y: 0, width: 0, height: 0 };
    return writeClipDeviceRect(clip, view, out) ? out : null;
}

const clipTokens: ClipToken[] = [];

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

const isStop = (value: object): value is Stop => 'status' in value;
function stopAdmission(stop: Stop): Admission<never> {
    if (stop.status === 'denied') return { status: 'denied', pool: stop.pool, bytes: stop.bytes };
    if (stop.status === 'unsupported') return { status: 'unsupported', why: stop.why };
    return { status: stop.status };
}
function viewportOf(view: ViewState): Viewport {
    return { width: Math.round(view.viewport.width * view.viewport.dpr), height: Math.round(view.viewport.height * view.viewport.dpr) };
}

export function createPath(host: LayerHost, audit: string): {
    readonly route: ItemRoute<PaintPathItem>;
    readonly admitClips: AdmitClips;
    readonly coverage: ReturnType<typeof createPathCoverageKit>;
    readonly beginFrame: (frame: number) => void;
    readonly evictCpu: (bytes: number) => number;
    readonly evictAreas: (bytes: number, keepRecent?: boolean) => number;
} {
    // Triangles by content and band, most recently used last. An array's CPU lease lives while the cache or the kit holds the array:
    // the last holder to let go releases it, so the lease is never released over memory still alive, and no array is alive without one.
    const outlines = new Map<string, Outline>();
    const cachedArrays = new Set<Float64Array>();
    const leases = new Map<Float64Array, { readonly lease: ByteLease; readonly bytes: number }>();
    let outlineBytes = 0, leasedBytes = 0, frame = 0;
    const releaseLease = (array: Float64Array): number => {
        const held = leases.get(array);
        if (!held) return 0;
        leases.delete(array); leasedBytes -= held.bytes; host.allocator.cpu.release(held.lease);
        return held.bytes;
    };
    const kit = createPathCoverageKit(host, () => auditCount(audit, 'kit:pipeline-failed'), audit,
        array => { if (!cachedArrays.has(array)) releaseLease(array); });
    const areaKit: AreaKit = createAreaKit();
    areaKit.warm(host);
    let zooming = false, buildInexact = false;
    const dropFromCache = (key: string, old: Outline): number => {
        outlines.delete(key); cachedArrays.delete(old.positive); outlineBytes -= old.bytes;
        kit.forgetTriangles(old.positive);
        return kit.holds(old.positive) ? 0 : releaseLease(old.positive);
    };
    const reclaimLeases = (bytes: number): number => {
        let freed = 0;
        for (const [key, old] of outlines) {
            if (freed >= bytes) break;
            if (old.usedFrame >= frame || kit.holds(old.positive)) continue;
            freed += dropFromCache(key, old);
        }
        return freed;
    };
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
        if (outlineBytes > GEOMETRY_CACHE_BYTES) {
            for (const [oldKey, old] of outlines) {
                if (outlineBytes <= GEOMETRY_CACHE_BYTES) break;
                if (old.usedFrame < frame && oldKey !== key) dropFromCache(oldKey, old);
            }
        }
        return outline;
    };

    const take = (result: PathCoverageAdmission, acquired: Acquired[]): PreparedPathCoverage | Stop => {
        if (result.status === 'ready') { acquired.push(result.value); return result.value; }
        if (result.status === 'denied') return { status: 'denied', pool: result.pool, bytes: result.bytes };
        if (result.status === 'deferred') return { status: 'deferred' };
        if (result.status === 'empty') return { status: 'empty' };
        return { status: 'unsupported', why: 'coverage kit' };
    };
    const takeArea = (result: AreaAdmission, acquired: Acquired[]): PreparedArea | Stop => {
        if (result.status === 'ready') { acquired.push(result.value); return result.value; }
        if (result.status === 'denied') return { status: 'denied', pool: result.pool, bytes: result.bytes };
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
    const noClips = makeClips([], []);
    const admitGroup = (members: readonly PaintPathItem[], view: ViewState, viewport: Viewport, cover: CoverBlend, budget: FrameBudget,
        acquired: Acquired[]): ItemAdmission | null => {
        const lead = members[0];
        const band = bandOf(lead.localToWorld, view);
        if (band === null) return null;
        const areaSets: AreaOutline[] = [];
        for (const member of members) {
            const outline = areaContours(member, 'fill', band, null);
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
        if (result.status === 'unsupported') return null;
        const taken = take(result, acquired);
        if (isStop(taken)) return taken;
        auditCount(audit, 'route:path-group', members.length);
        return { status: 'ready', value: { clips: noClips, fill: taken, stroke: null, fillArea: null, strokeArea: null } };
    };

    const admitClipList = (clips: readonly PaintClip[], view: ViewState, viewport: Viewport, budget: FrameBudget,
        acquired: Acquired[]): PreparedClips | Stop => {
        if (!clips.length) return noClips;
        const scissors: RectI[] = [], masks: PreparedPathCoverage[] = [];
        for (const clip of clips) {
            const rect = clipDeviceRect(clip, view);
            if (rect) {
                const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
                const x1 = Math.min(viewport.width, rect.x + rect.width), y1 = Math.min(viewport.height, rect.y + rect.height);
                if (x1 <= x0 || y1 <= y0) return { status: 'empty' };
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
    const areaContours = (item: PaintPathItem, which: 'fill' | 'stroke', band: number, cut: ItemCut | null): AreaOutline | Refused => {
        const style = item.material.stroke;
        const key = which === 'fill' ? `${commandKey(item.d)}|${band}|${item.fillRule}`
            : `${commandKey(item.d)}|${band}|${style!.width}|${style!.cap}|${style!.join}|${style!.miterLimit}|${style!.dash ? 'dash' : ''}`;
        const full = cut ? `${which}|${key}|cut|${cut.key}` : `${which}|${key}`;
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
        if (!why && contours!.length && !areaNestingExact(contours!)) why = 'nesting';
        if (!why && cut) contours = cutContours(contours!, cut.shape);
        let outline: AreaOutline;
        if (why) outline = { edges: null, origin: ORIGIN, box: EMPTY_BOX, why, bytes: 0, lease: null, usedFrame: frame };
        else {
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
        const parts = outlines.map((outline, i): AreaPart => {
            const [A, B, C, D, E, F] = affines[i];
            return { edges: outline.edges!, affine: [A, B, C, D, E - x0, F - y0] };
        });
        return { kind: 'area', parts, bounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
    };
    const zoomCoverage = (shape: Extract<AreaShape, { kind: 'area' }>): boolean => {
        if (!zooming || shape.bounds.width * shape.bounds.height <= AREA_ZOOM_MAX_PX) return false;
        buildInexact = true; auditCount(audit, 'area:zoom-coverage'); auditTape(`${audit}:area:zoom-coverage`);
        return true;
    };
    const admitParts = (shape: Extract<AreaShape, { kind: 'area' }>, colour: Rgba, cover: CoverBlend, viewport: Viewport, budget: FrameBudget,
        acquired: Acquired[]): AreaItem | Stop | null => {
        const taken = takeArea(areaKit.admit(host, shape.parts, shape.bounds, budget, viewport), acquired);
        if (isStop(taken)) {
            if (taken.status === 'unsupported') { auditCount(audit, 'area:fallback:unsupported'); return null; }
            return taken;
        }
        return { prepared: taken, output: { kind: 'area', blend: cover, rgb: [colour[0], colour[1], colour[2]], alpha: colour[3] } };
    };
    const admitArea = (item: PaintPathItem, which: 'fill' | 'stroke', view: ViewState, viewport: Viewport, band: number, cover: CoverBlend,
        budget: FrameBudget, acquired: Acquired[], cut: ItemCut | null = null): AreaItem | Stop | null => {
        const outline = areaContours(item, which, band, cut);
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
    const admitItem = (item: PaintPathItem, view: ViewState, viewport: Viewport, cover: CoverBlend, budget: FrameBudget,
        acquired: Acquired[]): ItemAdmission => {
        const cut = cutOf(item);
        let stroke: PreparedPathCoverage | null = null, strokeArea: AreaItem | null = null;
        if (cut) {
            const band = bandOf(item.localToWorld, view);
            if (band === null) return { status: 'unsupported', why: 'path transform' };
            const area = admitArea(item, 'stroke', view, viewport, band, cover, budget, acquired, cut);
            if (area && isStop(area)) return area;
            if (area) {
                auditCount(audit, 'area:exact:cut');
                return { status: 'ready', value: { clips: noClips, fill: null, stroke: null, fillArea: null, strokeArea: area } };
            }
        }
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

    let drawPass: GpuPass | null = null, drawingItem: PreparedPathItem | null = null;
    let areaRefusedFrame = -1;
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
    const itemAreas: PreparedArea[] = [];
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
                areaRefused(error);
                j = items.length;
            } finally { areaKit.endBatch(pass); }
            if (j === i) { drawItemByArea(pass, items[i]); i++; continue; }
            for (let k = i; k < j; k++) drawItem(pass, items[k]);
            i = j;
        }
    };
    let drawHalf: 'both' | 'fill' | 'stroke' = 'both';
    const drawInside = (): void => {
        const pass = drawPass!, item = drawingItem!;
        if (drawHalf !== 'stroke') {
            if (item.fill) kit.draw(pass, item.fill);
            if (item.fillArea) drawArea(pass, item.fillArea);
        }
        if (drawHalf !== 'fill') {
            if (item.stroke) kit.draw(pass, item.stroke);
            if (item.strokeArea) drawArea(pass, item.strokeArea);
        }
    };
    const drawItemByArea = (pass: GpuPass, item: PreparedPathItem): void => {
        for (const half of ['fill', 'stroke'] as const) {
            const area = half === 'fill' ? item.fillArea : item.strokeArea;
            const plain = half === 'fill' ? item.fill : item.stroke;
            if (!area && !plain) continue;
            if (area) {
                areaKit.beginBatch(host);
                try { itemAreas.length = 0; itemAreas.push(area.prepared); areaKit.place(host, pass, itemAreas); }
                catch (error) { areaRefused(error); }
                finally { areaKit.endBatch(pass); }
            }
            drawHalf = half;
            try { drawItem(pass, item); } finally { drawHalf = 'both'; }
        }
        auditCount(audit, 'area:by-area');
    };
    const drawItem = (pass: GpuPass, item: PreparedPathItem): void => {
        drawPass = pass; drawingItem = item;
        try { withPreparedClips(pass, item.clips, drawInside); }
        finally { drawPass = null; drawingItem = null; }
    };

    const route: ItemRoute<PaintPathItem> & { drawRefusedThisFrame(): boolean; setZoom(value: boolean): void; exact(run: PreparedRun): boolean } = {
        id: 'path',
        setZoom(value: boolean): void { zooming = value; areaKit.warm(host); },
        exact(run: PreparedRun): boolean { return run.route !== 'path' || !(run as PathRun).inexact; },
        drawRefusedThisFrame: (): boolean => kit.drawRefusedThisFrame() || areaRefusedFrame === frame,
        accepts: (item): item is PaintPathItem => item.kind === 'path',
        admit(items, view, blend, budget): Admission<PreparedRun> {
            const cover: CoverBlend = blend === 'modulate' ? 'modulate' : 'normal';
            const viewport = viewportOf(view);
            const acquired: Acquired[] = [], prepared: PreparedPathItem[] = [];
            buildInexact = false;
            const group: PaintPathItem[] = [], boxes: DeviceBox[] = [];
            const stopWith = (stop: Stop): Admission<PreparedRun> => {
                for (const held of acquired) retireAcquired(held);
                return stopAdmission(stop);
            };
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
    const beginFrameBoth = (next: number): void => { frame = next; kit.beginFrame(next); areaKit.beginFrame(next); };
    return {
        route, admitClips, coverage: { ...kit, beginFrame: beginFrameBoth },
        beginFrame: beginFrameBoth,
        evictCpu(bytes: number): number { const freed = reclaimLeases(bytes); return freed < bytes ? freed + reclaimArea(bytes - freed) : freed; },
        evictAreas: (bytes: number, keepRecent = false): number => areaKit.evictIdle(bytes, keepRecent),
    };
}

export const createPathRoute: CreatePathRoute = (host, audit) => createPath(host, audit).route;
