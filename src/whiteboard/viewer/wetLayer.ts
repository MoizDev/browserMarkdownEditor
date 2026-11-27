import type { ViewState } from '../../platform/types';
import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import type { LayerCoverage, LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease, GfxDevice, GpuPass, TextureHandle } from '../../platform/render/gfx/api';
import { auditCount, renderAuditEnabled } from '../../platform/render/renderAudit';
import type { FrameBudget, FrameToken, Layer, RenderToken } from '../../platform/render/types';
import { InkCoverageJob, InkOutlineJob, type InkCoverage } from '../ink/outline';
import { materializeCurveRange, type CurveGeometry } from '../ink/curve';
import { DOT_METRIC_PROVISIONAL, type InkDot, type InkWidth } from '../ink/width';
import type { BoardWetLayer } from '../input/attach';
import type { DryInkIdentity, WetInkHandover, WetInkSnapshot } from '../input/liveInk';
import type { Swatch } from '../model/styles';
import { colourCss, resolveSwatch, withOpacity, type PaintPalette } from '../render/colour';
import { inkCoverageChunks } from '../render/paintStream';
import { HIGHLIGHT_OVERLAY_ALPHA, HIGHLIGHT_UNDERLAY_ALPHA, inkMaterial, type InkMaterial } from '../render/material';
import type { PaintSource, PaintInkItem, PaintClip } from '../render/paintStream';
import type { Admission, CreateInkRoutes, InkRouteFor, ItemRoute, PreparedRun, WithClips } from '../render/gpu/contracts';
import { awaitSizedCapacity, isBudgetRefusal } from '../render/budgetRefusal';
import { ArenaError } from '../../platform/render/resourceArena';
import { appendPath2d, path2d } from '../render/reference/coverage2d';

const CHUNK_PRIMITIVES = 4096;
const CHUNK = 256, FINAL_SPANS = 16, PATH_BLOCK = 256 * 1024;
const TEMP_BYTES = CHUNK * (8 * 8 + 1 + 2 * 8) + Math.ceil(CHUNK_PRIMITIVES * (6 + 3 + 4) * 8 * 3 / 2);
const TIP_UPLOAD_BYTES = 64 * 1024;
const WAIT_UPLOAD_BYTES = 64 * 1024;
type Bounds = { x: number; y: number; w: number; h: number };
type Prepared = { readonly snapshot: WetInkSnapshot; path: Path2D | null; readonly origin: readonly [number, number]; readonly leases: ByteLease[];
    readonly scale: number; readonly bounds: Bounds | null; readonly coverageChunks: readonly InkCoverage[]; readonly serial: number };
type Stable = { readonly nodeId: string; readonly scale: number; readonly origin: readonly [number, number]; spans: number;
    chunks: InkCoverage[]; bounds: Bounds | null; dot: boolean; scan: number; buffers: Set<ArrayBufferLike>; leases: ByteLease[];
    temp: ByteLease | null;
    style: InkWidth | null };
type Tail = { chunks: InkCoverage[]; bounds: Bounds | null; buffers: Set<ArrayBufferLike>; leases: ByteLease[] };
type Chunk = { readonly first: number; readonly count: number; readonly finalizing: boolean;
    coverage: InkCoverageJob | null; readonly leases: ByteLease[];
    retained: { coverage: InkCoverage; buffers: ArrayBufferLike[]; bytes: number } | null };
type Work = { snapshot: WetInkSnapshot; stable: Stable; scale: number; offset: number; tail: Tail; chunk: Chunk | null };
export interface WetGpuRoutes {
    readonly createInkRoutes: CreateInkRoutes;
    readonly inkRouteFor: InkRouteFor;
    readonly withClips: WithClips;
}
export interface BoardWetOptions {
    readonly token: RenderToken;
    readonly palette: () => PaintPalette;
    readonly readyFrame: () => PaintSource | null;
    readonly current: () => boolean;
    readonly exists: (identity: DryInkIdentity) => boolean;
    readonly invalidate: () => void;
    readonly onError: (error: unknown) => void;
    readonly gpuRoutes: WetGpuRoutes;
    readonly boardDrawnInk: () => ReadonlySet<string>;
}
export interface BoardWetRenderer extends BoardWetLayer {
    readonly layers: Readonly<{ underlay: PlatformLayerDefinition; content: PlatformLayerDefinition }>;
    consumeInput(): void;
    liveNodeIds(): ReadonlySet<string>;
    drawsLive(nodeId: string, band: WetBand, view: ViewState, canvas: boolean): boolean;
    presented(revision: number, token: RenderToken, frame?: PaintSource): void;
    clear(): void;
    dispose(): void;
}
function sameToken(a: RenderToken, b: RenderToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration && a.session === b.session;
}
function available(frame: PaintSource | null | undefined, identity: DryInkIdentity, token: RenderToken): boolean {
    return !!frame && sameToken(frame.token, token) && frame.sceneRevision >= identity.nodeRevision && frame.inkNodeIds.has(identity.nodeId);
}
function unionBounds(a: Bounds | null, next: Bounds): Bounds {
    if (!a) return { x: next.x, y: next.y, w: next.w, h: next.h };
    const x = Math.min(a.x, next.x), y = Math.min(a.y, next.y);
    return { x, y, w: Math.max(a.x + a.w, next.x + next.w) - x, h: Math.max(a.y + a.h, next.y + next.h) - y };
}
function retainedBuffers(coverage: InkCoverage, known: readonly ReadonlySet<ArrayBufferLike>[]): { buffers: ArrayBufferLike[]; bytes: number } {
    const unique = new Set<ArrayBufferLike>();
    const add = (view: ArrayBufferView) => { if (!known.some(set => set.has(view.buffer))) unique.add(view.buffer); };
    add(coverage.segments); add(coverage.discs); add(coverage.centreline); add(coverage.segmentRunStarts);
    const buffers = [...unique], bytes = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
    if (!Number.isSafeInteger(bytes)) throw new RangeError('Wet coverage accounting overflow');
    return { buffers, bytes };
}
class ImmutableIds implements ReadonlySet<string> {
    readonly [Symbol.toStringTag] = 'ImmutableIds';
    private readonly ids: Set<string>;
    constructor(values?: Iterable<string>) { this.ids = new Set(values); }
    get size(): number { return this.ids.size; }
    has(value: string): boolean { return this.ids.has(value); }
    entries(): SetIterator<[string, string]> { return this.ids.entries(); }
    keys(): SetIterator<string> { return this.ids.keys(); }
    values(): SetIterator<string> { return this.ids.values(); }
    [Symbol.iterator](): SetIterator<string> { return this.values(); }
    forEach(callback: (value: string, value2: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
        for (const value of this.ids) callback.call(thisArg, value, value, this);
    }
}
const EMPTY_LIVE_IDS: ReadonlySet<string> = new ImmutableIds();

const clipPaths = new Map<string, { readonly d: PaintClip['d']; readonly path: Path2D }>();
function clipPathFor(clip: PaintClip): Path2D {
    const held = clipPaths.get(clip.key);
    if (held && held.d === clip.d) return held.path;
    if (clipPaths.size >= 64) clipPaths.clear();
    const path = path2d(clip.d); clipPaths.set(clip.key, { d: clip.d, path });
    return path;
}
type WetBand = 'underlay' | 'content';
const BANDS: readonly WetBand[] = ['underlay', 'content'];
type InkRoutes = ReturnType<CreateInkRoutes>;
interface WetShown { readonly clips: readonly PaintClip[]; readonly draw: () => void; readonly dispose: () => void; readonly kept?: readonly InkCoverage[] }
interface WetRunSlot {
    readonly gesture: number;
    serial: number; scale: number; token: FrameToken;
    palette: PaintPalette | null; material: InkMaterial | null;
    item: PaintInkItem | null;
    state: 'pending' | 'ready' | 'empty' | 'denied';
    shown: WetShown | null;
    viewBound: boolean; viewKey: string;
    reported: boolean;
    waitBytes: number;
}
interface WetScrap { readonly device: GfxDevice; readonly texture: TextureHandle; readonly world: Bounds; readonly pw: number; readonly ph: number }
const runKey = (gesture: number, band: WetBand): number => gesture * 2 + (band === 'content' ? 1 : 0);
function isPending(pending: readonly WetInkSnapshot[], gesture: number): boolean {
    for (const item of pending) if (item.identity.gestureSequence === gesture) return true;
    return false;
}
interface Verdict { readonly complete: boolean; readonly sharp: boolean; readonly why: string }
const VERDICT_SHARP: Verdict = { complete: true, sharp: true, why: '' }, VERDICT_STALE: Verdict = { complete: true, sharp: false, why: '' };
const VERDICT_RING_DEFERRED: Verdict = { complete: false, sharp: false, why: 'uniform-deferred' };
const TIP_ALLOWANCE_MS = 3;
const VERDICT_UNSHOWN: Record<'no-slot' | 'token' | WetRunSlot['state'], Verdict> = {
    'no-slot': { complete: true, sharp: false, why: 'unshown:no-slot' }, token: { complete: true, sharp: false, why: 'unshown:token' },
    pending: { complete: true, sharp: false, why: 'unshown:pending' }, ready: { complete: true, sharp: false, why: 'unshown:ready' },
    empty: { complete: true, sharp: false, why: 'unshown:empty' }, denied: { complete: true, sharp: false, why: 'unshown:denied' },
};
const COVER_CANVAS2D: LayerCoverage = { complete: true, sharp: true };
function sameFrameToken(a: FrameToken, b: FrameToken): boolean {
    return sameToken(a, b) && a.viewLease === b.viewLease && a.deviceGeneration === b.deviceGeneration;
}
const keyBits = new Float64Array(1), keyWords = new Uint32Array(keyBits.buffer);
let keyA = 0, keyB = 0;
function keyStart(): void { keyA = 0x811c9dc5; keyB = 0x9747b28c; }
function keyInt(value: number): void {
    keyA = Math.imul(keyA ^ (value | 0), 0x01000193);
    keyB = Math.imul(keyB ^ (value | 0), 0x5bd1e995); keyB ^= keyB >>> 13;
}
function keyNumber(value: number): void { keyBits[0] = value; keyInt(keyWords[0]); keyInt(keyWords[1]); }
function keyString(value: string): void { keyInt(value.length); for (let i = 0; i < value.length; i++) keyInt(value.charCodeAt(i)); }
function keyEnd(): number { return (keyA >>> 0) * 0x200000 + ((keyB >>> 0) & 0x1fffff); }
const SLOT_STATES = { pending: 1, ready: 2, empty: 3, denied: 4 } as const;
function viewKeyOf(view: ViewState): string {
    return `${view.camera.x},${view.camera.y},${view.camera.z},${view.viewport.width},${view.viewport.height},${view.viewport.dpr}`;
}
function bandMaterial(snapshot: WetInkSnapshot, band: WetBand, palette: PaintPalette): InkMaterial | null {
    const highlight = snapshot.presentation.tool === 'highlighter';
    if (!highlight && band === 'underlay') return null;
    const pigment = resolveSwatch(palette, snapshot.presentation.color as Swatch, highlight ? 'highlight' : 'stroke');
    if (!pigment) return null;
    const bandAlpha = highlight ? (band === 'underlay' ? HIGHLIGHT_UNDERLAY_ALPHA : HIGHLIGHT_OVERLAY_ALPHA) : 1;
    return inkMaterial(pigment, bandAlpha * (snapshot.presentation.opacity ?? 1));
}
function worldBox(bounds: Bounds, m: readonly [number, number, number, number, number, number]): Bounds {
    const [a, c1, c2, d, e, f] = m;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let corner = 0; corner < 4; corner++) {
        const x = corner & 1 ? bounds.x + bounds.w : bounds.x, y = corner & 2 ? bounds.y + bounds.h : bounds.y;
        const wx = a * x + c2 * y + e, wy = c1 * x + d * y + f;
        minX = Math.min(minX, wx); maxX = Math.max(maxX, wx); minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
function scaleAt(view: ViewState, item: WetInkSnapshot): number {
    const m = item.presentation.localToWorld;
    return view.camera.z * view.viewport.dpr * Math.hypot(m[0], m[1], m[2], m[3]);
}
function viewWorld(view: ViewState): Bounds {
    return { x: view.camera.x, y: view.camera.y, w: view.viewport.width / view.camera.z, h: view.viewport.height / view.camera.z };
}
function offScreen(bounds: Bounds | null, m: readonly [number, number, number, number, number, number], view: ViewState): boolean {
    if (!bounds) return false;
    const box = worldBox(bounds, m), v = viewWorld(view);
    return box.x + box.w < v.x || box.x > v.x + v.w || box.y + box.h < v.y || box.y > v.y + v.h;
}

export function createBoardWetLayer(options: BoardWetOptions): BoardWetRenderer {
    const gpuRoutes = options.gpuRoutes;
    let handover: WetInkHandover | null = null, disposed = false, generation = 0, dirty = false, denied = false;
    let liveIds: ReadonlySet<string> = EMPTY_LIVE_IDS;
    let owner: LayerHost | null = null, work: Work | null = null, reserved = 0, lastPrepareFrame: number | null = null;
    const hosts = new Set<LayerHost>(), prepared = new Map<number, Prepared>(), callbacks = new Set<() => void>();
    let publicationVersion = 0;
    let inkRoutes: InkRoutes | null = null;
    const runs = new Map<number, WetRunSlot>();
    const drawCall: { pass: GpuPass | null; view: ViewState | null; host: LayerHost | null } = { pass: null, view: null, host: null };
    let ringDeferred = false;
    const ringRefused = (error: unknown): boolean => {
        if (!(error instanceof ArenaError) || error.code !== 'out-of-budget') return false;
        ringDeferred = true; auditCount('wet', 'uniform-deferred'); return true;
    };
    const hostLayers = new Map<LayerHost, Layer>();
    const report = (error: unknown) => {
        if (isBudgetRefusal(error)) { denied = true; awaitSizedCapacity(owner, invalidate, { pool: 'cpu', bytes: TEMP_BYTES + PATH_BLOCK }); return; }
        try { options.onError(error); } catch { /* reporting must not escape the scheduler */ }
    };
    const invalidate = () => { if (disposed) return; dirty = true; generation++; denied = false; options.invalidate(); for (const host of hosts) host.invalidate('wet-ink'); };
    const release = (lease: ByteLease) => { owner!.allocator.cpu.release(lease); reserved -= lease.bytes; };
    const stables = new Map<number, Stable>();
    const dropPrepared = (item: Prepared) => { for (const lease of item.leases) release(lease); };
    const dropStable = (gesture: number) => {
        const item = stables.get(gesture);
        if (!item) return;
        stables.delete(gesture);
        for (const lease of item.leases) release(lease);
        if (item.temp) release(item.temp);
    };
    const dropWork = () => {
        const item = work; work = null;
        dropPartial();
        if (!item) return;
        const chunk = item.chunk; item.chunk = null;
        if (chunk) {
            chunk.coverage?.cancel();
            for (const lease of chunk.leases) release(lease);
        }
        for (const lease of item.tail.leases) release(lease);
    };
    const reserve = (bytes: number): ByteLease | null => {
        const lease = owner?.allocator.cpu.reserve(bytes) ?? null;
        if (lease) reserved += lease.bytes;
        return lease;
    };
    const dropSlot = (key: number) => {
        const slot = runs.get(key);
        if (!slot) return;
        runs.delete(key);
        slot.shown?.dispose();
        slot.shown = null;
    };
    const releaseRoutes = () => {
        for (const [key] of [...runs]) dropSlot(key);
        if (inkRoutes) { inkRoutes.analytic.release(); inkRoutes.union.release(); inkRoutes = null; }
    };
    let partial: { owner: object; count: number; source: Prepared } | null = null;
    const dropPartial = (): void => {
        if (!partial) return;
        for (const lease of partial.source.leases) release(lease);
        partial = null;
    };
    const clear = () => {
        dropWork(); dropPartial(); for (const item of prepared.values()) dropPrepared(item); prepared.clear();
        for (const gesture of [...stables.keys()]) dropStable(gesture);
        releaseRoutes();
        dirty = false; denied = false; liveIds = EMPTY_LIVE_IDS;
    };
    const routesMemory = (): { gpuBytes: number; cpuBytes: number } => {
        if (!inkRoutes) return { gpuBytes: 0, cpuBytes: 0 };
        const analytic = inkRoutes.analytic.memory(), union = inkRoutes.union.memory();
        return { gpuBytes: analytic.gpuBytes + union.gpuBytes, cpuBytes: analytic.cpuBytes + union.cpuBytes };
    };
    const pathOf = (source: Prepared): Path2D | null => {
        if (source.path) return source.path;
        const path = new Path2D();
        let commands = 0;
        for (const coverage of source.coverageChunks) {
            const job = new InkOutlineJob(coverage, source.scale, command => appendPath2d(path, command, source.origin));
            while (job.step(1024) === 'pending') { /* bounded per chunk, as coverageOutline is */ }
            commands += job.commandCount;
        }
        const bytes = (commands + 1) * 80, lease = reserve(bytes);
        if (!lease) { denied = true; awaitSizedCapacity(owner, invalidate, { pool: 'cpu', bytes }); return null; }
        source.leases.push(lease); source.path = path;
        return path;
    };
    const partialOf = (snapshot: WetInkSnapshot): Prepared | null => {
        const w = work;
        if (!w || w.snapshot.identity.gestureSequence !== snapshot.identity.gestureSequence || w.snapshot.identity.nodeId !== snapshot.identity.nodeId) return null;
        const coverageChunks = [...w.stable.chunks, ...w.tail.chunks];
        if (!coverageChunks.length) return null;
        if (partial?.owner === w && partial.count === coverageChunks.length) return partial.source;
        dropPartial();
        const source: Prepared = { snapshot: w.snapshot, path: null, origin: w.stable.origin, leases: [], scale: w.scale,
            bounds: w.tail.bounds ? unionBounds(w.stable.bounds, w.tail.bounds) : w.stable.bounds, coverageChunks, serial: ++publicationVersion };
        partial = { owner: w, count: coverageChunks.length, source };
        return source;
    };
    const sourceOf = (snapshot: WetInkSnapshot): Prepared | null => {
        const done = prepared.get(snapshot.identity.gestureSequence);
        if (done && done.snapshot.identity.nodeId === snapshot.identity.nodeId) return done;
        return partialOf(snapshot);
    };
    const drawScrap = (pass: GpuPass, view: ViewState, host: LayerHost, scrap: WetScrap): void => {
        const cam = view.camera, scale = cam.z * view.viewport.dpr;
        host.drawTexturedQuad(pass, scrap.texture, { x: 0, y: 0, width: scrap.pw, height: scrap.ph },
            { x: (scrap.world.x - cam.x) * scale, y: (scrap.world.y - cam.y) * scale, width: scrap.pw, height: scrap.ph },
            { opacity: 1, sampling: 'linear', coverage: 'none' });
    };
    const admitScrap = (host: LayerHost, snapshot: WetInkSnapshot, source: Prepared, material: InkMaterial, why: string,
        view: ViewState, budget: FrameBudget): Admission<WetScrap> => {
        const device = host.device();
        if (!device || !source.bounds) return { status: 'empty' };
        const box = worldBox(source.bounds, snapshot.presentation.localToWorld), v = viewWorld(view);
        const x0 = Math.max(box.x, v.x), y0 = Math.max(box.y, v.y), x1 = Math.min(box.x + box.w, v.x + v.w), y1 = Math.min(box.y + box.h, v.y + v.h);
        if (!(x1 > x0 && y1 > y0)) return { status: 'empty' };
        const world: Bounds = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, scale = view.camera.z * view.viewport.dpr;
        const pw = Math.max(1, Math.ceil(world.w * scale)), ph = Math.max(1, Math.ceil(world.h * scale)), bytes = pw * ph * 4;
        const path = pathOf(source);
        if (!path) return { status: 'deferred' };
        const lease = host.allocator.gpu.reserve(bytes);
        if (!lease) return { status: 'denied', pool: 'gpu', bytes };
        const cpuLease = host.allocator.cpu.reserve(bytes);
        if (!cpuLease) { host.allocator.gpu.release(lease); return { status: 'denied', pool: 'cpu', bytes }; }
        if (!budget.claimUpload(bytes)) { host.allocator.gpu.release(lease); host.allocator.cpu.release(cpuLease); return { status: 'deferred' }; }
        let canvas: OffscreenCanvas | null = null, bitmap: ImageBitmap | null = null, texture: TextureHandle | null = null, attached = false;
        try {
            canvas = new OffscreenCanvas(pw, ph);
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('Offscreen 2D canvas unavailable');
            ctx.setTransform(scale, 0, 0, scale, -world.x * scale, -world.y * scale);
            const [a, b, c, d, e, f] = snapshot.presentation.localToWorld, [ox, oy] = source.origin;
            ctx.transform(a, b, c, d, e, f); ctx.translate(ox, oy);
            ctx.fillStyle = colourCss(material.color); ctx.fill(path, 'nonzero');
            auditCount('wet', `fallback:item-cpu:ink:${why}`, 1, { px: pw * ph });
            auditCount('wet', 'cpu-raster', 1, { px: pw * ph });
            bitmap = canvas.transferToImageBitmap();
            texture = device.createTexture(pw, ph, 'rgba8', ['sample', 'copy-dst'], lease); attached = true;
            device.writeTexture(texture, { x: 0, y: 0, width: pw, height: ph }, { source: bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
            const scrap: WetScrap = { device, texture, world, pw, ph };
            texture = null;
            return { status: 'ready', value: scrap };
        } catch (error) {
            if (isBudgetRefusal(error)) return { status: 'denied', pool: 'gpu', bytes };
            throw error;
        } finally {
            bitmap?.close();
            if (canvas) { canvas.width = 0; canvas.height = 0; }
            host.allocator.cpu.release(cpuLease);
            if (texture) device.destroy(texture);
            if (!attached) host.allocator.gpu.release(lease);
        }
    };
    const setShown = (slot: WetRunSlot, next: WetShown | null, state: WetRunSlot['state']): void => { slot.shown?.dispose(); slot.shown = next; slot.state = state; };
    const stamp = (key: number, gesture: number, current: WetRunSlot | undefined, source: Prepared, palette: PaintPalette,
        token: FrameToken, viewKey: string, material: InkMaterial | null, item: PaintInkItem | null): WetRunSlot => {
        const slot: WetRunSlot = current ?? { gesture, serial: 0, scale: 0, palette: null, material: null, item: null,
            token, state: 'pending', shown: null, viewBound: false, viewKey: '', reported: false, waitBytes: 0 };
        slot.serial = source.serial; slot.scale = source.scale; slot.palette = palette; slot.material = material; slot.item = item;
        slot.token = { ...token }; slot.viewBound = false; slot.viewKey = viewKey; slot.waitBytes = 0;
        runs.set(key, slot);
        return slot;
    };
    let tipFrame = -1, tipBytes = 0;
    const tipBudget = (budget: FrameBudget): FrameBudget => {
        if (tipFrame !== budget.frameId) { tipFrame = budget.frameId; tipBytes = 0; }
        return { ...budget, shouldYield: () => false, claimUpload: (bytes: number, kind?: 'media') => {
            if (budget.claimUpload(bytes, kind)) return true;
            if (kind === 'media' || tipBytes + bytes > TIP_UPLOAD_BYTES) return false;
            tipBytes += bytes; return true;
        } };
    };
    const admitRuns = (host: LayerHost, view: ViewState, budget: FrameBudget): void => {
        const routes = inkRoutes ??= gpuRoutes.createInkRoutes(host, 'board-wet');
        const palette = options.palette(), pending = handover?.pendingSnapshots() ?? [], viewKey = viewKeyOf(view);
        const audited = renderAuditEnabled(), tip = tipBudget(budget);
        for (const [key, slot] of runs) if (!isPending(pending, slot.gesture)) dropSlot(key);
        for (const snapshot of pending) {
            const gesture = snapshot.identity.gestureSequence, source = sourceOf(snapshot);
            if (!source) { if (audited) auditCount('wet', 'admit-skip:unprepared'); continue; }
            const shown = source.snapshot;
            for (const band of BANDS) {
                const key = runKey(gesture, band), current = runs.get(key);
                if (current && current.serial === source.serial && current.scale === source.scale && current.palette === palette
                    && sameFrameToken(current.token, budget.token) && (current.state === 'ready' || current.state === 'empty')
                    && (!current.viewBound || current.viewKey === viewKey)) { if (audited) auditCount('wet', 'admit-skip:fresh'); continue; }
                if (audited && current?.shown && budget.shouldYield()) auditCount('wet', 'admit-tip:yielded');
                if (current && current.state === 'pending' && current.waitBytes > 0 && current.serial === source.serial && current.palette === palette
                    && (budget.shouldYield() || budget.upload.remainingBytes < current.waitBytes)) { if (audited) auditCount('wet', 'admit-wait:meter'); continue; }
                const reuse = current && current.serial === source.serial && current.palette === palette ? current : null;
                const material = reuse ? reuse.material : bandMaterial(shown, band, palette);
                if (!material) {
                    setShown(stamp(key, gesture, current, source, palette, budget.token, viewKey, null, null), null, 'empty');
                    continue;
                }
                const item = reuse?.item ?? { kind: 'ink', key: `wet/${gesture}/${band}`, nodeId: shown.identity.nodeId,
                    geometryKey: `wet/${gesture}/${source.serial}`, localToWorld: shown.presentation.localToWorld,
                    clips: shown.presentation.clips ?? [], coverage: source.coverageChunks, material } satisfies PaintInkItem;
                const route = gpuRoutes.inkRouteFor(item) === 'ink-analytic' ? routes.analytic : routes.union;
                const before = audited ? route.memory().gpuBytes : 0;
                const meterBefore = budget.upload.remainingBytes;
                let admission: Admission<PreparedRun>;
                try { admission = route.admit([item], view, 'over', tip); }
                catch (error) { if (!ringRefused(error)) throw error; admission = { status: 'deferred' }; }
                const meterUsed = meterBefore - budget.upload.remainingBytes;
                if (audited) {
                    auditCount('wet', `admit:${admission.status}`, 1, { [route.id]: 1 });
                    const grown = route.memory().gpuBytes - before; if (grown > 0) auditCount('wet', 'upload:vertex', 1, { bytes: grown });
                }
                const slot = stamp(key, gesture, current, source, palette, budget.token, viewKey, material, item);
                switch (admission.status) {
                    case 'ready': {
                        const run = admission.value;
                        setShown(slot, { clips: item.clips, kept: inkCoverageChunks(item.coverage), draw: () => { if (drawCall.pass) route.draw(drawCall.pass, run); }, dispose: () => route.retire(run) }, 'ready');
                        break;
                    }
                    case 'empty': slot.viewBound = true; setShown(slot, null, 'empty'); break;
                    case 'deferred': slot.state = 'pending'; slot.waitBytes = Math.min(WAIT_UPLOAD_BYTES, Math.max(1, meterUsed)); break;
                    case 'denied': slot.state = 'denied'; denied = true; awaitSizedCapacity(host, invalidate, { pool: admission.pool, bytes: admission.bytes }); break;
                    case 'unsupported': {
                        if (!slot.reported) { slot.reported = true; report(new Error(`Wet ink route refused a stroke (${admission.why}); it is drawn through the CPU path`)); }
                        let scrap: ReturnType<typeof admitScrap>;
                        try { scrap = admitScrap(host, shown, source, material, admission.why, view, budget); }
                        catch (error) { slot.serial = -1; slot.state = 'pending'; throw error; }
                        if (scrap.status === 'ready') {
                            const value = scrap.value;
                            slot.viewBound = true;
                            setShown(slot, { clips: item.clips, dispose: () => value.device.destroy(value.texture),
                                draw: () => { if (drawCall.pass && drawCall.view && drawCall.host) drawScrap(drawCall.pass, drawCall.view, drawCall.host, value); } }, 'ready');
                        } else if (scrap.status === 'empty') { slot.viewBound = true; setShown(slot, null, 'empty'); }
                        else if (scrap.status === 'deferred') slot.state = 'pending';
                        else if (scrap.status === 'denied') { slot.state = 'denied'; denied = true; awaitSizedCapacity(host, invalidate, { pool: scrap.pool, bytes: scrap.bytes }); }
                        else slot.state = 'pending';
                        break;
                    }
                }
            }
        }
    };
    const runsPending = (): boolean => {
        const drawn = options.boardDrawnInk();
        for (const snapshot of handover?.pendingSnapshots() ?? []) {
            if (snapshot.dry && drawn.has(snapshot.identity.nodeId)) continue;
            const gesture = snapshot.identity.gestureSequence, source = sourceOf(snapshot);
            if (!source) continue;
            for (const band of BANDS) {
                const slot = runs.get(runKey(gesture, band));
                if (!slot || slot.state === 'pending' || slot.serial !== source.serial || slot.scale !== source.scale) return true;
            }
        }
        return false;
    };
    const routedCoverage = (token: FrameToken, view: ViewState): Verdict => {
        if (ringDeferred) { ringDeferred = false; return VERDICT_RING_DEFERRED; }
        const viewKey = viewKeyOf(view), drawn = options.boardDrawnInk();
        let sharp = true;
        for (const snapshot of handover?.pendingSnapshots() ?? []) {
            if (snapshot.dry && drawn.has(snapshot.identity.nodeId)) continue;
            const gesture = snapshot.identity.gestureSequence, source = sourceOf(snapshot);
            if (!source) continue;
            for (const band of BANDS) {
                const slot = runs.get(runKey(gesture, band));
                if (!slot) return VERDICT_UNSHOWN['no-slot'];
                if (!sameFrameToken(slot.token, token)) return VERDICT_UNSHOWN.token;
                if (!slot.shown && slot.state !== 'empty') return VERDICT_UNSHOWN[slot.state];
                const current = (slot.state === 'ready' || slot.state === 'empty') && slot.serial === source.serial && slot.scale === source.scale
                    && (!slot.viewBound || slot.viewKey === viewKey);
                if (!current) sharp = false;
            }
        }
        return sharp ? VERDICT_SHARP : VERDICT_STALE;
    };
    const drawRouted = (pass: GpuPass, view: ViewState, band: WetBand): void => {
        if (disposed || !options.current() || !inkRoutes || !owner) return;
        const host = owner;
        let drawn = 0;
        const boardDrawn = options.boardDrawnInk();
        drawCall.pass = pass; drawCall.view = view; drawCall.host = host;
        try {
            for (const snapshot of handover?.pendingSnapshots() ?? []) {
                if (snapshot.dry && boardDrawn.has(snapshot.identity.nodeId)) { if (renderAuditEnabled()) auditCount('wet', 'skip:board-drawn'); continue; }
                const gesture = snapshot.identity.gestureSequence, source = sourceOf(snapshot);
                if (!source || offScreen(source.bounds, source.snapshot.presentation.localToWorld, view)) continue;
                const shown = runs.get(runKey(gesture, band))?.shown;
                if (!shown) continue;
                let admitted: Admission<void>;
                try { admitted = gpuRoutes.withClips(pass, shown.clips, view, shown.draw); }
                catch (error) { if (!ringRefused(error)) throw error; continue; }
                if (admitted.status === 'ready') drawn++;
                else auditCount('wet', `clip:${admitted.status}`);
            }
        } finally { drawCall.pass = null; drawCall.view = null; drawCall.host = null; }
        if (drawn) auditCount('wet', 'draw');
    };
    const begin = (snapshot: WetInkSnapshot, view: ViewState): boolean => {
        const matrix = snapshot.presentation.localToWorld;
        const scale = Math.max(Number.MIN_VALUE, view.camera.z * view.viewport.dpr * Math.hypot(matrix[0], matrix[1], matrix[2], matrix[3]));
        const gesture = snapshot.identity.gestureSequence;
        let stable = stables.get(gesture);
        if (stable && (stable.nodeId !== snapshot.identity.nodeId || stable.scale !== scale
            || stable.spans > snapshot.curve.finalizedSpanCount)) { dropStable(gesture); stable = undefined; }
        if (!stable) {
            const samples = snapshot.curve.samples;
            stable = { nodeId: snapshot.identity.nodeId, scale, origin: [samples.x(0), samples.y(0)], spans: 0, chunks: [],
                bounds: null, dot: true, scan: 1, buffers: new Set(), leases: [], temp: null, style: null };
            stables.set(gesture, stable);
        }
        work = { snapshot, stable, scale, offset: stable.spans, chunk: null,
            tail: { chunks: [], bounds: null, buffers: new Set(), leases: [] } };
        return true;
    };
    const step = (): boolean => {
        const w = work!, publication = w.snapshot.curve, real = publication.samples, s = w.stable;
        if (s.scan < real.count) {
            if (real.x(s.scan) !== real.x(0) || real.y(s.scan) !== real.y(0)) s.dot = false;
            s.scan++; return false;
        }
        const c = w.chunk;
        if (c?.retained) {
            const retained = c.retained;
            const lease = retained.bytes ? reserve(retained.bytes) : null;
            if (retained.bytes && !lease) { denied = true; awaitSizedCapacity(owner, invalidate, { pool: 'cpu', bytes: retained.bytes }); return false; }
            if (lease) c.leases.push(lease);
            if (c.finalizing) {
                s.chunks.push(retained.coverage); s.spans = c.first + c.count;
                s.bounds = unionBounds(s.bounds, retained.coverage.boundsLocal);
                for (const buffer of retained.buffers) s.buffers.add(buffer);
                s.leases.push(...c.leases);
            } else {
                w.tail.chunks.push(retained.coverage);
                w.tail.bounds = unionBounds(w.tail.bounds, retained.coverage.boundsLocal);
                for (const buffer of retained.buffers) w.tail.buffers.add(buffer);
                w.tail.leases.push(...c.leases);
            }
            w.chunk = null;
            return false;
        }
        if (c?.coverage) {
            if (c.coverage.step(1) === 'complete') {
                const coverage = c.coverage.coverage;
                c.coverage = null;
                c.retained = { coverage, ...retainedBuffers(coverage, c.finalizing ? [s.buffers] : [s.buffers, w.tail.buffers]) };
            }
            return false;
        }
        // Only sealed real samples are drawn. A predicted tail (browser getPredictedEvents) was tried
        // and removed: measured, predicted tails were retracted on 7/186 frames and read as recoil.
        const spans = real.count - 1, offset = w.offset;
        if (offset < spans || (spans === 0 && offset === 0)) {
            const finalizing = spans > 0 && offset + FINAL_SPANS <= publication.finalizedSpanCount;
            const count = spans === 0 ? 0 : finalizing ? FINAL_SPANS : Math.min(CHUNK, spans - offset);
            const temp = s.temp ?? reserve(TEMP_BYTES); if (!temp) { denied = true; awaitSizedCapacity(owner, invalidate, { pool: 'cpu', bytes: TEMP_BYTES }); return false; }
            s.temp = temp;
            const geometry = materializeCurveRange(real, { firstSpan: offset, spanCount: count }, publication.parameters, publication.closure);
            w.offset = spans === 0 ? 1 : offset + count;
            const style: InkWidth = s.style ??= { width: w.snapshot.presentation.width, model: { id: 'uniform' }, pressure: 'none' };
            const dot: InkDot | null = offset === 0 && s.dot ? { x: real.x(0), y: real.y(0), radius: DOT_METRIC_PROVISIONAL.radius(style.width, style.width / 2, style.model) } : null;
            w.chunk = { first: offset, count, finalizing, leases: [], retained: null,
                coverage: new InkCoverageJob(real, geometry, style, { deviceScale: w.scale, dot, maxPrimitives: CHUNK_PRIMITIVES }) };
            if (!finalizing) auditCount('wet', 'tip-build');
            return false;
        }
        const gesture = w.snapshot.identity.gestureSequence;
        const prior = prepared.get(gesture);
        if (prior) dropPrepared(prior);
        dropPartial();
        prepared.set(gesture, { snapshot: w.snapshot, path: null, origin: s.origin, leases: w.tail.leases, scale: w.scale,
            bounds: w.tail.bounds ? unionBounds(s.bounds, w.tail.bounds) : s.bounds, coverageChunks: [...s.chunks, ...w.tail.chunks], serial: ++publicationVersion });
        work = null; return true;
    };
    const shownIds = new WeakMap<object, number>();
    let nextShownId = 0;
    const shownIdOf = (shown: object | null): number => {
        if (!shown) return 0;
        let id = shownIds.get(shown);
        if (id === undefined) shownIds.set(shown, id = ++nextShownId);
        return id;
    };
    const fingerprintOf = (view: ViewState, canvas: boolean): number => {
        const drawn = options.boardDrawnInk();
        keyStart();
        keyNumber(view.camera.x); keyNumber(view.camera.y); keyNumber(view.camera.z);
        keyNumber(view.viewport.width); keyNumber(view.viewport.height); keyNumber(view.viewport.dpr);
        keyInt(options.current() ? 1 : 0); keyInt(disposed ? 1 : 0);
        if (canvas) keyNumber(shownIdOf(options.palette()));
        for (const snapshot of handover?.pendingSnapshots() ?? []) {
            if (snapshot.dry && drawn.has(snapshot.identity.nodeId)) continue;
            const gesture = snapshot.identity.gestureSequence;
            keyNumber(gesture);
            if (canvas) keyNumber(sourceOf(snapshot)?.serial ?? -1);
            else { keyRun(runs.get(runKey(gesture, 'underlay'))); keyRun(runs.get(runKey(gesture, 'content'))); }
        }
        return keyEnd();
    };
    const canvasPaints = (snapshot: WetInkSnapshot, band: WetBand, drawn: ReadonlySet<string>): boolean => {
        if (snapshot.dry && drawn.has(snapshot.identity.nodeId)) return false;
        const isHighlight = snapshot.presentation.tool === 'highlighter';
        if (!isHighlight && band === 'underlay') return false;
        if (!sourceOf(snapshot)) return false;
        return !!resolveSwatch(options.palette(), snapshot.presentation.color as Swatch, isHighlight ? 'highlight' : 'stroke');
    };
    const keyRun = (slot: WetRunSlot | undefined): void => {
        if (!slot) { keyInt(-2); return; }
        keyInt(SLOT_STATES[slot.state]); keyNumber(slot.serial); keyNumber(slot.scale);
        if (slot.viewBound) keyString(slot.viewKey); else keyInt(-1);
        keyNumber(slot.token.viewLease); keyNumber(slot.token.deviceGeneration); keyNumber(shownIdOf(slot.shown));
    };
    const drawnKey: Partial<Record<WetBand, number>> = {};
    const drawnEmpty: Partial<Record<WetBand, boolean>> = {};
    const drawnCanvas: Partial<Record<WetBand, boolean>> = {};
    let frameAnswer = false;
    const prepareShared = (view: ViewState, budget: FrameBudget): boolean => {
        if (disposed || !owner || !options.current()) return false;
        if (lastPrepareFrame === budget.frameId) return frameAnswer;
        lastPrepareFrame = budget.frameId;
        inkRoutes?.beginFrame(budget.frameId);
        denied = false;
        try {
            for (const item of handover?.pendingSnapshots() ?? []) {
                if (item.dry && !options.exists(item.dry)) handover?.clear(item.identity);
            }
            const snapshots = handover?.pendingSnapshots() ?? [];
            for (const [id, item] of prepared) if (!isPending(snapshots, id)) { dropPrepared(item); prepared.delete(id); publicationVersion++; }
            for (const gesture of stables.keys()) if (!isPending(snapshots, gesture)) dropStable(gesture);
            if (work && (!snapshots.some(item => item.identity.gestureSequence === work!.snapshot.identity.gestureSequence
                && item.identity.nodeId === work!.snapshot.identity.nodeId) || work.scale < scaleAt(view, work.snapshot))) dropWork();
            const tipUntil = performance.now() + TIP_ALLOWANCE_MS;
            while (!budget.shouldYield() || (work !== null && performance.now() < tipUntil)) {
                if (!work) {
                    let next: WetInkSnapshot | null = null;
                    for (const item of snapshots) {
                        const old = prepared.get(item.identity.gestureSequence);
                        if (old?.snapshot !== item || old.scale < scaleAt(view, item)) { next = item; break; }
                    }
                    if (!next) { dirty = false; break; }
                    if (!begin(next, view)) { denied = true; break; }
                }
                step();
                if (denied || (work?.chunk?.retained && !work.chunk.finalizing)) break;
            }
        } catch (error) { dropWork(); denied = true; report(error); }
        let admitted = false;
        if (owner.device() && sameToken(options.token, budget.token)) {
            try { admitRuns(owner, view, budget); admitted = true; } catch (error) { report(error); }
        } else auditCount('wet', 'admit-skip:device-or-token');
        const caughtUp = (handover?.pendingSnapshots() ?? []).every(item => { const old = prepared.get(item.identity.gestureSequence); return old?.snapshot === item && old.scale >= scaleAt(view, item); });
        frameAnswer = caughtUp && work === null && admitted && !denied && routedCoverage(budget.token, view) === VERDICT_SHARP;
        return frameAnswer;
    };
    const bandHasInk = (band: WetBand): boolean => {
        for (const [key, slot] of runs) if (((key & 1) === 1) === (band === 'content') && slot.shown) return true;
        return false;
    };
    const canvasHasInk = (band: WetBand): boolean => {
        const drawn = options.boardDrawnInk();
        return (handover?.pendingSnapshots() ?? []).some(snapshot => canvasPaints(snapshot, band, drawn));
    };
    const hasInk = (band: WetBand, canvas: boolean): boolean => canvas ? canvasHasInk(band) : bandHasInk(band);
    const prepareBand = (band: WetBand) => (view: ViewState, budget: FrameBudget): boolean | undefined => {
        const shared = prepareShared(view, budget);
        const canvas = drawnCanvas[band] ?? !owner?.device();
        if (!hasInk(band, canvas) && drawnEmpty[band] === true) return false;
        const same = drawnKey[band] !== undefined && drawnKey[band] === fingerprintOf(view, canvas);
        if (renderAuditEnabled()) auditCount('wet', `answer:${band}:${same ? 'same' : 'fingerprint'}:${!shared ? 'gate' : 'shared'}:${drawnKey[band] === undefined ? 'undrawn' : 'drawn'}`);
        if (same) return false;
        if (!shared) return undefined;
        if (drawnKey[band] === undefined) return hasInk(band, canvas) ? undefined : false;
        return undefined;
    };
    const make = (band: WetBand): PlatformLayerDefinition => ({
        id: `board-wet-${band}`, group: 'document', liveInput: true,
        cpuEvict(layer, bytes) {
            if (!owner || hostLayers.get(owner) !== layer) return;
            const keep = new Set<InkCoverage>();
            for (const slot of runs.values()) for (const chunk of slot.shown?.kept ?? []) keep.add(chunk);
            const freed = inkRoutes?.evictCpu(bytes, keep) ?? 0;
            if (renderAuditEnabled()) auditCount('wet', 'reclaim:geometry', 1, { bytes: freed });
        },
        create(host) {
            if (disposed) throw new Error('Wet layer disposed');
            hosts.add(host); owner ??= host;
            let ended = false;
            const layer: Layer & { prepareFirst(): boolean } = {
                prepareFirst: () => !!owner?.device() && runsPending(),
                prepare: prepareBand(band),
                drawGpu(pass, view) { drawRouted(pass, view, band); drawnCanvas[band] = false; drawnKey[band] = fingerprintOf(view, false); drawnEmpty[band] = !bandHasInk(band); },
                draw2d(ctx, view) {
                    if (disposed || !options.current()) return;
                    drawnCanvas[band] = true; drawnKey[band] = fingerprintOf(view, true); drawnEmpty[band] = !canvasHasInk(band);
                    if (renderAuditEnabled()) auditCount('wet', 'draw:canvas2d');
                    const boardDrawn = options.boardDrawnInk();
                    const snapshots = handover?.pendingSnapshots() ?? [];
                    host.paintWorld(ctx, view, () => {
                        for (const snapshot of snapshots) {
                            if (snapshot.dry && boardDrawn.has(snapshot.identity.nodeId)) continue;
                            const item = sourceOf(snapshot);
                            if (!item) continue;
                            if (offScreen(item.bounds, snapshot.presentation.localToWorld, view)) continue;
                            const isHighlight = snapshot.presentation.tool === 'highlighter';
                            if (!isHighlight && band === 'underlay') continue;
                            const pigment = resolveSwatch(options.palette(), snapshot.presentation.color as Swatch, isHighlight ? 'highlight' : 'stroke');
                            if (!pigment) continue;
                            const alpha = (isHighlight ? (band === 'underlay' ? HIGHLIGHT_UNDERLAY_ALPHA : HIGHLIGHT_OVERLAY_ALPHA) : 1)
                                * (snapshot.presentation.opacity ?? 1);
                            ctx.save();
                            try {
                                const base = ctx.getTransform();
                                for (const clip of snapshot.presentation.clips ?? []) {
                                    ctx.setTransform(base); ctx.transform(...clip.localToWorld); ctx.clip(clipPathFor(clip), clip.fillRule);
                                }
                                ctx.setTransform(base);
                                const [a, b, c, d, e, f] = snapshot.presentation.localToWorld;
                                ctx.transform(a, b, c, d, e, f); ctx.translate(item.origin[0], item.origin[1]);
                                ctx.fillStyle = colourCss(withOpacity(pigment, alpha));
                                const path = pathOf(item);
                                if (path) ctx.fill(path, 'nonzero');
                            } finally { ctx.restore(); }
                        }
                    });
                },
                releaseGpu(reason) { if (reason === 'hidden' || reason === 'pressure') clear(); else releaseRoutes(); },
                evictGpu(bytes) {
                    if (bytes <= 0 || runs.size || work || !inkRoutes) return 0;
                    const freed = routesMemory().gpuBytes;
                    releaseRoutes();
                    auditCount('wet', 'evict:routes', 1, { bytes: freed });
                    return freed;
                },
                memory() {
                    const reporting = !!owner && hostLayers.get(owner) === layer;
                    const memory = reporting ? routesMemory() : undefined;
                    return { gpuBytes: memory?.gpuBytes ?? 0, cpuBytes: reporting ? reserved + (memory?.cpuBytes ?? 0) : 0 };
                },
                needsFrame() { return !ended && !disposed && !denied && (ringDeferred || dirty || !!work || (!!owner?.device() && runsPending())); },
                dispose() { if (ended) return; ended = true; if (owner === host) { clear(); owner = null; } hosts.delete(host); hostLayers.delete(host); owner ??= hosts.values().next().value ?? null; },
            };
            hostLayers.set(host, layer);
            return layer;
        },
        revision: () => generation,
        cpuWorkingSet: layer => {
            if (!owner || hostLayers.get(owner) !== layer) return { mandatoryBytes: 0, prefetchBytes: 0 };
            const snapshots = handover?.pendingSnapshots() ?? [];
            const pending = !!work || snapshots.some(item => prepared.get(item.identity.gestureSequence)?.snapshot !== item);
            const scratchHeld = snapshots.some(item => stables.get(item.identity.gestureSequence)?.temp) || !!work?.stable.temp;
            const extra = pending ? (scratchHeld ? 0 : TEMP_BYTES) + PATH_BLOCK + (work?.chunk?.retained?.bytes ?? 0) : 0;
            return { mandatoryBytes: reserved + extra + (owner.device() ? routesMemory().cpuBytes : 0), prefetchBytes: 0 };
        },
        critical: () => !!owner?.device() && runsPending(),
        coverage: (_layer, frame, backend): LayerCoverage => {
            if (backend === 'canvas2d') return COVER_CANVAS2D;
            const verdict = routedCoverage(frame.token, frame.view);
            if (renderAuditEnabled()) auditCount('wet', verdict.complete ? (verdict.sharp ? 'cover:sharp' : verdict.why ? `cover:stale:${verdict.why}` : 'cover:stale') : `cover:incomplete:${verdict.why}`);
            return verdict;
        },
    });
    const layers = Object.freeze({ underlay: make('underlay'), content: make('content') });
    return {
        layers,
        attach(value) { if (disposed) throw new Error('Wet layer disposed'); handover = value; value.onPublish(invalidate); invalidate(); return () => { if (handover === value) { value.onPublish(null); handover = null; clear(); invalidate(); } }; },
        onInputFrame(callback) { callbacks.add(callback); return () => { callbacks.delete(callback); }; },
        invalidate,
        consumeInput() { if (disposed || !options.current()) return; for (const callback of callbacks) callback(); },
        drawsLive(nodeId, band, view, canvas) {
            if (disposed || !options.current()) return false;
            const snapshot = (handover?.pendingSnapshots() ?? []).find(item => item.identity.nodeId === nodeId);
            if (!snapshot) return false;
            const source = sourceOf(snapshot);
            if (!source) return false;
            if (offScreen(source.bounds, snapshot.presentation.localToWorld, view)) return true;
            const isHighlight = snapshot.presentation.tool === 'highlighter';
            if (band === 'underlay' && !isHighlight) return true;
            if (snapshot.dry && options.boardDrawnInk().has(nodeId)) return false;
            if (!canvas) return !!runs.get(runKey(snapshot.identity.gestureSequence, band))?.shown;
            return !!resolveSwatch(options.palette(), snapshot.presentation.color as Swatch, isHighlight ? 'highlight' : 'stroke');
        },
        liveNodeIds() {
            if (disposed) return EMPTY_LIVE_IDS;
            const pending = handover?.pendingSnapshots() ?? [];
            let count = 0, same = true;
            for (const snapshot of pending) {
                if (!snapshot.dry) continue;
                count++;
                if (same && !liveIds.has(snapshot.dry.nodeId)) same = false;
            }
            if (same && count === liveIds.size) return liveIds;
            const next = new Set<string>();
            for (const snapshot of pending) if (snapshot.dry) next.add(snapshot.dry.nodeId);
            liveIds = next.size ? new ImmutableIds(next) : EMPTY_LIVE_IDS;
            return liveIds;
        },
        presented(revision, token, frame) {
            if (disposed || !sameToken(token, options.token) || !frame || frame.sceneRevision !== revision || !sameToken(frame.token, token)) return;
            let acknowledged = false;
            for (const item of handover?.pendingSnapshots() ?? []) {
                if (item.dry && available(frame, item.dry, token)) { handover?.acknowledgePresented(item.dry); acknowledged = true; }
            }
            // Only a handover that changed needs another frame. Invalidating on every presented frame made each frame ask
            // for the next: on a webgl2 PDF the board restarted its GPU plan every frame (245 in 6 s idle), never finished
            // one, stayed 'Updating…', and a later drag froze on a frame without the moved ink.
            if (acknowledged) invalidate();
        },
        clear,
        dispose() { if (disposed) return; clear(); disposed = true; callbacks.clear(); handover = null; },
    };
}
