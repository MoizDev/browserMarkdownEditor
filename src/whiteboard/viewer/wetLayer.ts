import type { ViewState } from '../../platform/types';
import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import type { LayerHost } from '../../platform/render/compositor.types';
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
import { HIGHLIGHT_OVERLAY_ALPHA, HIGHLIGHT_UNDERLAY_ALPHA, inkMaterial, type InkMaterial } from '../render/material';
import type { PaintSource, PaintInkItem, PaintClip } from '../render/paintStream';
import type { Admission, CreateInkRoutes, InkRouteFor, ItemRoute, PreparedRun, WithClips } from '../render/gpu/contracts';
import { awaitCapacity, isBudgetRefusal } from '../render/budgetRefusal';
import { appendPath2d } from '../render/reference/coverage2d';

// Provenance: wet/dry ink handover, bounded ink outline and C4 layer contracts;
// independently wired renderer, no third-party source.
const CHUNK = 256, FINAL_SPANS = 16, TEMP_BYTES = 4 * 1024 * 1024, PATH_BLOCK = 256 * 1024;
type Bounds = { x: number; y: number; w: number; h: number };
type Prepared = { readonly snapshot: WetInkSnapshot; path: Path2D | null; readonly origin: readonly [number, number]; readonly leases: ByteLease[];
    readonly scale: number; readonly bounds: Bounds | null; readonly coverageChunks: readonly InkCoverage[]; readonly serial: number };
// The finalized prefix of one stroke. A span the curve has finalized (publication.finalizedSpanCount) keeps its coverage
// for the stroke's life, so a growing stroke tessellates only its replaceable tail.
type Stable = { readonly nodeId: string; readonly scale: number; readonly origin: readonly [number, number]; spans: number;
    chunks: InkCoverage[]; bounds: Bounds | null; dot: boolean; scan: number; buffers: Set<ArrayBufferLike>; leases: ByteLease[] };
type Tail = { chunks: InkCoverage[]; bounds: Bounds | null; buffers: Set<ArrayBufferLike>; leases: ByteLease[] };
type Chunk = { readonly first: number; readonly count: number; readonly finalizing: boolean; readonly temp: ByteLease;
    coverage: InkCoverageJob | null; readonly leases: ByteLease[];
    retained: { coverage: InkCoverage; buffers: ArrayBufferLike[]; bytes: number } | null };
type Work = { snapshot: WetInkSnapshot; stable: Stable; scale: number; offset: number; tail: Tail; chunk: Chunk | null };
/** The GPU routes that draw wet ink, injected by the board's input host (the route modules are not imported here). */
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
}
export interface BoardWetRenderer extends BoardWetLayer {
    readonly layers: Readonly<{ underlay: PlatformLayerDefinition; content: PlatformLayerDefinition }>;
    consumeInput(): void;
    liveNodeIds(): ReadonlySet<string>;
    presented(revision: number, token: RenderToken, frame?: PaintSource): void;
    clear(): void;
    dispose(): void;
}
function sameToken(a: RenderToken, b: RenderToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration && a.session === b.session;
}
/** The presented-frame test the acknowledgement uses: this token's frame holds the node at a current revision. */
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
    add(coverage.geometry.cubics); add(coverage.geometry.flags); add(coverage.radii);
    add(coverage.segments); add(coverage.discs); add(coverage.centreline);
    for (const map of coverage.arcMaps) { add(map.cubic); add(map.pieces); }
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
type WetBand = 'underlay' | 'content';
const BANDS: readonly WetBand[] = ['underlay', 'content'];
type InkRoutes = ReturnType<CreateInkRoutes>;
/** What a slot draws: a route's run, or the CPU scrap of a stroke the route refuses. */
interface WetShown { readonly clips: readonly PaintClip[]; readonly draw: () => void; readonly dispose: () => void }
/** One stroke's GPU run for one band. `shown` is what is drawn; the rest says what the current publication needs. A
 * deferred or denied admission keeps drawing the last shown tip while coverage waits for the new one. */
interface WetRunSlot {
    readonly gesture: number;
    serial: number; scale: number; colour: string; token: FrameToken;
    state: 'pending' | 'ready' | 'empty' | 'denied';
    shown: WetShown | null;
    /** The admission depends on the view (an empty result, or a CPU scrap): it is current for `viewKey` only. */
    viewBound: boolean; viewKey: string;
    /** The first refusal of this stroke is reported; a refusal is never reported per frame. */
    reported: boolean;
}
interface WetScrap { readonly device: GfxDevice; readonly texture: TextureHandle; readonly world: Bounds; readonly pw: number; readonly ph: number }
const runKey = (gesture: number, band: WetBand): string => `${gesture}/${band}`;
function sameFrameToken(a: FrameToken, b: FrameToken): boolean {
    return sameToken(a, b) && a.viewLease === b.viewLease && a.deviceGeneration === b.deviceGeneration;
}
function viewKeyOf(view: ViewState): string {
    return `${view.camera.x},${view.camera.y},${view.camera.z},${view.viewport.width},${view.viewport.height},${view.viewport.dpr}`;
}
// The same material the committed ink takes (inkMaterial / highlighterMaterials with the node's inherited opacity), so
// the wet stroke's colour at pen-up is the committed one. Null when the band draws nothing for this stroke.
function bandMaterial(snapshot: WetInkSnapshot, band: WetBand, palette: PaintPalette): InkMaterial | null {
    const highlight = snapshot.presentation.tool === 'highlighter';
    if (!highlight && band === 'underlay') return null;
    const pigment = resolveSwatch(palette, snapshot.presentation.color as Swatch, highlight ? 'highlight' : 'stroke');
    if (!pigment) return null;
    const bandAlpha = highlight ? (band === 'underlay' ? HIGHLIGHT_UNDERLAY_ALPHA : HIGHLIGHT_OVERLAY_ALPHA) : 1;
    return inkMaterial(pigment, bandAlpha * (snapshot.presentation.opacity ?? 1));
}
/** The axis-aligned world box of a local rect under a local-to-world affine. */
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
/** The part of the world the viewport shows. */
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
    const runs = new Map<string, WetRunSlot>();
    // Read only while drawRouted runs: one reused record, so a draw allocates nothing.
    const drawCall: { pass: GpuPass | null; view: ViewState | null; host: LayerHost | null } = { pass: null, view: null, host: null };
    const hostLayers = new Map<LayerHost, Layer>();
    const report = (error: unknown) => {
        if (isBudgetRefusal(error)) { denied = true; awaitCapacity(owner, invalidate); return; }
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
    };
    const dropWork = () => {
        const item = work; work = null;
        if (!item) return;
        const chunk = item.chunk; item.chunk = null;
        if (chunk) {
            chunk.coverage?.cancel();
            release(chunk.temp);
            for (const lease of chunk.leases) release(lease);
        }
        for (const lease of item.tail.leases) release(lease);
    };
    const reserve = (bytes: number): ByteLease | null => {
        const lease = owner?.allocator.cpu.reserve(bytes) ?? null;
        if (lease) reserved += lease.bytes;
        return lease;
    };
    const dropSlot = (key: string) => {
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
    const clear = () => {
        dropWork(); for (const item of prepared.values()) dropPrepared(item); prepared.clear();
        for (const gesture of [...stables.keys()]) dropStable(gesture);
        releaseRoutes();
        dirty = false; denied = false; liveIds = EMPTY_LIVE_IDS;
    };
    const routesMemory = (): { gpuBytes: number; cpuBytes: number } => {
        if (!inkRoutes) return { gpuBytes: 0, cpuBytes: 0 };
        const analytic = inkRoutes.analytic.memory(), union = inkRoutes.union.memory();
        return { gpuBytes: analytic.gpuBytes + union.gpuBytes, cpuBytes: analytic.cpuBytes + union.cpuBytes };
    };
    // The canvas2d outline of a stroke, built on first use: by draw2d, or by the CPU path for a refused stroke. It is not
    // built per tip, because the routes draw the chunks and an outline tessellated per input frame would be paid for nothing.
    const pathOf = (source: Prepared): Path2D | null => {
        if (source.path) return source.path;
        const path = new Path2D();
        let commands = 0;
        for (const coverage of source.coverageChunks) {
            const job = new InkOutlineJob(coverage, source.scale, command => appendPath2d(path, command, source.origin));
            while (job.step(1024) === 'pending') { /* bounded per chunk, as coverageOutline is */ }
            commands += job.commandCount;
        }
        const lease = reserve((commands + 1) * 80);
        if (!lease) { denied = true; awaitCapacity(owner, invalidate); return null; }
        source.leases.push(lease); source.path = path;
        return path;
    };
    const drawScrap = (pass: GpuPass, view: ViewState, host: LayerHost, scrap: WetScrap): void => {
        const cam = view.camera, scale = cam.z * view.viewport.dpr;
        host.drawTexturedQuad(pass, scrap.texture, { x: 0, y: 0, width: scrap.pw, height: scrap.ph },
            { x: (scrap.world.x - cam.x) * scale, y: (scrap.world.y - cam.y) * scale, width: scrap.pw, height: scrap.ph },
            { opacity: 1, sampling: 'linear', coverage: 'none' });
    };
    // The CPU path for a stroke the route refuses: the stroke's canvas2d fill, rastered once for the part of its bounds
    // in view and uploaded as one texture. The stroke is drawn, never dropped, and counted with its pixels.
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
        if (!path) return { status: 'denied', pool: 'cpu', bytes: 0 };
        const lease = host.allocator.gpu.reserve(bytes);
        if (!lease) return { status: 'denied', pool: 'gpu', bytes };
        if (!budget.claimUpload(bytes)) { host.allocator.gpu.release(lease); return { status: 'deferred' }; }
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
            bitmap = canvas.transferToImageBitmap();
            texture = device.createTexture(pw, ph, 'rgba8', ['sample', 'copy-dst'], lease); attached = true;
            device.writeTexture(texture, { x: 0, y: 0, width: pw, height: ph }, { source: bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
            const scrap: WetScrap = { device, texture, world, pw, ph };
            texture = null;
            return { status: 'ready', value: scrap };
        } finally {
            bitmap?.close();
            if (canvas) { canvas.width = 0; canvas.height = 0; }
            if (texture) device.destroy(texture);
            if (!attached) host.allocator.gpu.release(lease);
        }
    };
    // Admits every band of every pending stroke whose run is not current. A live stroke is one input ahead of its
    // tessellation, so the run admitted is the last completed publication of the node (the same match draw2d uses), and
    // the newest publication is admitted once it completes. Only the tip is new work: the route keys its geometry by chunk.
    const admitRuns = (host: LayerHost, view: ViewState, budget: FrameBudget): void => {
        const routes = inkRoutes ??= gpuRoutes.createInkRoutes(host, 'board-wet');
        const palette = options.palette(), pending = handover?.pendingSnapshots() ?? [], live = new Set<number>(), viewKey = viewKeyOf(view);
        for (const snapshot of pending) live.add(snapshot.identity.gestureSequence);
        for (const [key, slot] of [...runs]) if (!live.has(slot.gesture)) dropSlot(key);
        for (const snapshot of pending) {
            const gesture = snapshot.identity.gestureSequence, source = prepared.get(gesture);
            if (!source || source.snapshot.identity.nodeId !== snapshot.identity.nodeId) { auditCount('wet', 'admit-skip:unprepared'); continue; }
            const shown = source.snapshot;
            for (const band of BANDS) {
                const key = runKey(gesture, band), material = bandMaterial(shown, band, palette);
                if (!material) { dropSlot(key); continue; }
                const colour = material.color.join(','), current = runs.get(key);
                if (current && current.serial === source.serial && current.scale === source.scale && current.colour === colour
                    && sameFrameToken(current.token, budget.token) && (current.state === 'ready' || current.state === 'empty')
                    && (!current.viewBound || current.viewKey === viewKey)) { auditCount('wet', 'admit-skip:fresh'); continue; }
                // A band with nothing shown yet is admitted even past the frame's budget: the tessellation spent it, and a
                // stroke with no run is refused by coverage (measured: 41 yields left drawing frames incomplete).
                if (current?.shown && budget.shouldYield()) { auditCount('wet', 'admit-skip:yield'); return; }
                const item: PaintInkItem = { kind: 'ink', key: `wet/${gesture}/${band}`, nodeId: shown.identity.nodeId,
                    geometryKey: `wet/${gesture}/${source.serial}`, localToWorld: shown.presentation.localToWorld,
                    clips: shown.presentation.clips ?? [], coverage: source.coverageChunks, material };
                const route = gpuRoutes.inkRouteFor(item) === 'ink-analytic' ? routes.analytic : routes.union;
                const audited = renderAuditEnabled(), before = audited ? route.memory().gpuBytes : 0;
                const admission = route.admit([item], view, 'over', budget);
                auditCount('wet', `admit:${admission.status}`, 1, { [route.id]: 1 });
                if (audited) { const grown = route.memory().gpuBytes - before; if (grown > 0) auditCount('wet', 'upload:vertex', 1, { bytes: grown }); }
                const slot: WetRunSlot = current ?? { gesture, serial: 0, scale: 0, colour: '', token: budget.token, state: 'pending',
                    shown: null, viewBound: false, viewKey: '', reported: false };
                slot.serial = source.serial; slot.scale = source.scale; slot.colour = colour; slot.token = { ...budget.token };
                slot.viewBound = false; slot.viewKey = viewKey;
                runs.set(key, slot);
                // A replaced shown is disposed only when its successor is admitted: a deferred or denied admission keeps the last tip.
                const replace = (next: WetShown | null, state: WetRunSlot['state']) => { slot.shown?.dispose(); slot.shown = next; slot.state = state; };
                switch (admission.status) {
                    case 'ready': {
                        const run = admission.value, clips = item.clips;
                        replace({ clips, draw: () => { if (drawCall.pass) route.draw(drawCall.pass, run); }, dispose: () => route.retire(run) }, 'ready');
                        break;
                    }
                    case 'empty': slot.viewBound = true; replace(null, 'empty'); break;
                    case 'deferred': slot.state = 'pending'; break;
                    case 'denied': slot.state = 'denied'; denied = true; awaitCapacity(host, invalidate); break;
                    case 'unsupported': {
                        // The route refused the stroke: it is drawn through the CPU path, and the refusal is reported once.
                        if (!slot.reported) { slot.reported = true; report(new Error(`Wet ink route refused a stroke (${admission.why}); it is drawn through the CPU path`)); }
                        const scrap = admitScrap(host, shown, source, material, admission.why, view, budget);
                        if (scrap.status === 'ready') {
                            const value = scrap.value;
                            slot.viewBound = true;
                            replace({ clips: item.clips, dispose: () => value.device.destroy(value.texture),
                                draw: () => { if (drawCall.pass && drawCall.view && drawCall.host) drawScrap(drawCall.pass, drawCall.view, drawCall.host, value); } }, 'ready');
                        } else if (scrap.status === 'empty') { slot.viewBound = true; replace(null, 'empty'); }
                        else if (scrap.status === 'deferred') slot.state = 'pending';
                        else { slot.state = 'denied'; denied = true; awaitCapacity(host, invalidate); }
                        break;
                    }
                }
            }
        }
    };
    // True while some visible band still needs an admission for the current publication.
    const runsPending = (): boolean => {
        const palette = options.palette();
        for (const snapshot of handover?.pendingSnapshots() ?? []) {
            const gesture = snapshot.identity.gestureSequence, source = prepared.get(gesture);
            if (!source || source.snapshot.identity.nodeId !== snapshot.identity.nodeId) return true;
            for (const band of BANDS) {
                if (!bandMaterial(snapshot, band, palette)) continue;
                const slot = runs.get(runKey(gesture, band));
                if (!slot || slot.state === 'pending' || slot.serial !== source.serial || slot.scale !== source.scale) return true;
            }
        }
        return false;
    };
    // Coverage of the routed path. A band with an admitted run draws it, whichever publication that run is for, so the
    // frame is complete while the stroke grows (measured: a serial check refused 118 of 209 drawing frames, and a critical
    // layer's refusal refused the whole frame). Only a band with nothing admitted yet is incomplete. `sharp` says the
    // shown runs are the current publication's, for this token and view; a deferred or denied tip is not sharp.
    const routedCoverage = (token: FrameToken, view: ViewState): { complete: boolean; sharp: boolean; why: string } => {
        const palette = options.palette(), viewKey = viewKeyOf(view);
        let sharp = true;
        for (const snapshot of handover?.pendingSnapshots() ?? []) {
            const gesture = snapshot.identity.gestureSequence, source = prepared.get(gesture);
            if (!source) return { complete: false, sharp: false, why: 'unprepared' };
            for (const band of BANDS) {
                if (!bandMaterial(snapshot, band, palette)) continue;
                const slot = runs.get(runKey(gesture, band));
                if (!slot) return { complete: false, sharp: false, why: 'no-slot' };
                if (!sameFrameToken(slot.token, token)) return { complete: false, sharp: false, why: 'token' };
                if (!slot.shown && slot.state !== 'empty') return { complete: false, sharp: false, why: `no-shown-${slot.state}` };
                const current = (slot.state === 'ready' || slot.state === 'empty') && slot.serial === source.serial && slot.scale === source.scale
                    && (!slot.viewBound || slot.viewKey === viewKey);
                if (!current) sharp = false;
            }
        }
        return { complete: true, sharp, why: '' };
    };
    const drawRouted = (pass: GpuPass, view: ViewState, band: WetBand): void => {
        if (disposed || !options.current() || !inkRoutes || !owner) return;
        const host = owner;
        let drawn = 0;
        drawCall.pass = pass; drawCall.view = view; drawCall.host = host;
        try {
            for (const snapshot of handover?.pendingSnapshots() ?? []) {
                const gesture = snapshot.identity.gestureSequence, source = prepared.get(gesture);
                if (!source || source.snapshot.identity.nodeId !== snapshot.identity.nodeId
                    || offScreen(source.bounds, source.snapshot.presentation.localToWorld, view)) continue;
                const shown = runs.get(runKey(gesture, band))?.shown;
                if (!shown) continue;
                // Clips are applied here and only here: the route draws the item's geometry, withClips its clips.
                const admitted = gpuRoutes.withClips(pass, shown.clips, view, shown.draw);
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
        // Finalized geometry is specific to its device scale and node: any change starts the prefix again.
        if (stable && (stable.nodeId !== snapshot.identity.nodeId || stable.scale !== scale)) { dropStable(gesture); stable = undefined; }
        if (!stable) {
            const samples = snapshot.curve.samples;
            stable = { nodeId: snapshot.identity.nodeId, scale, origin: [samples.x(0), samples.y(0)], spans: 0, chunks: [],
                bounds: null, dot: true, scan: 1, buffers: new Set(), leases: [] };
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
            if (retained.bytes && !lease) { denied = true; return false; }
            if (lease) c.leases.push(lease);
            release(c.temp);
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
                const coverage = c.coverage.result;
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
            const temp = reserve(TEMP_BYTES); if (!temp) { denied = true; return false; }
            const geometry = materializeCurveRange(real, { firstSpan: offset, spanCount: count }, publication.parameters);
            w.offset = spans === 0 ? 1 : offset + count;
            const style: InkWidth = { width: w.snapshot.presentation.width, model: { id: 'uniform' }, pressure: 'none' };
            const dot: InkDot | null = offset === 0 && s.dot ? { x: real.x(0), y: real.y(0), radius: DOT_METRIC_PROVISIONAL.radius(style.width, style.width / 2, style.model) } : null;
            w.chunk = { first: offset, count, finalizing, temp, leases: [], retained: null,
                coverage: new InkCoverageJob(real, geometry, style, { deviceScale: w.scale, dot, maxPrimitives: 4096 }) };
            // A non-finalized chunk is the tip: rebuilt on every publication, so this counts the per-input tessellation.
            if (!finalizing) auditCount('wet', 'tip-build');
            return false;
        }
        const gesture = w.snapshot.identity.gestureSequence;
        const prior = prepared.get(gesture);
        if (prior) dropPrepared(prior);
        prepared.set(gesture, { snapshot: w.snapshot, path: null, origin: s.origin, leases: w.tail.leases, scale: w.scale,
            bounds: w.tail.bounds ? unionBounds(s.bounds, w.tail.bounds) : s.bounds, coverageChunks: [...s.chunks, ...w.tail.chunks], serial: ++publicationVersion });
        work = null; return true;
    };
    const prepare = (view: ViewState, budget: FrameBudget) => {
        if (disposed || !owner || !options.current() || lastPrepareFrame === budget.frameId) return;
        lastPrepareFrame = budget.frameId;
        // A denied reservation waits for a genuine scheduler wake, not another polling frame.
        denied = false;
        try {
            for (const item of handover?.pendingSnapshots() ?? []) {
                if (item.dry && !options.exists(item.dry)) handover?.clear(item.identity);
            }
            const snapshots = handover?.pendingSnapshots() ?? [];
            const ids = new Set(snapshots.map(item => item.identity.gestureSequence));
            for (const [id, item] of prepared) if (!ids.has(id)) { dropPrepared(item); prepared.delete(id); publicationVersion++; }
            for (const gesture of [...stables.keys()]) if (!ids.has(gesture)) dropStable(gesture);
            const scaleFor = (item: WetInkSnapshot) => { const m = item.presentation.localToWorld; return view.camera.z * view.viewport.dpr * Math.hypot(m[0], m[1], m[2], m[3]); };
            if (work && (!snapshots.some(item => item.identity.gestureSequence === work!.snapshot.identity.gestureSequence
                && item.identity.nodeId === work!.snapshot.identity.nodeId) || work.scale < scaleFor(work.snapshot))) dropWork();
            while (!budget.shouldYield()) {
                if (!work) {
                    const next = snapshots.find(item => { const old = prepared.get(item.identity.gestureSequence); return old?.snapshot !== item || old.scale < scaleFor(item); });
                    if (!next) { dirty = false; break; }
                    if (!begin(next, view)) { denied = true; break; }
                }
                step();
                // Publish the exact next admission to demand() before attempting it.
                // A finalized span is not on the published path, so it does not gate this frame's publication:
                // only the tail chunk, which the next publication shows, yields here (measured: a per-finalize break was a hold every 16 samples).
                if (denied || (work?.chunk?.retained && !work.chunk.finalizing)) break;
            }
        } catch (error) { dropWork(); denied = true; report(error); }
        if (owner.device() && sameToken(options.token, budget.token)) {
            try { admitRuns(owner, view, budget); } catch (error) { report(error); }
        } else auditCount('wet', 'admit-skip:device-or-token');
    };
    const make = (band: WetBand): PlatformLayerDefinition => ({
        id: `board-wet-${band}`, group: 'document', liveInput: true,
        create(host) {
            if (disposed) throw new Error('Wet layer disposed');
            hosts.add(host); owner ??= host;
            let ended = false;
            const layer: Layer = {
                prepare,
                drawGpu(pass, view) { drawRouted(pass, view, band); },
                draw2d(ctx, view) {
                    if (disposed || !options.current()) return;
                    const snapshots = handover?.pendingSnapshots() ?? [];
                    host.paintWorld(ctx, view, () => {
                        for (const snapshot of snapshots) {
                            const item = prepared.get(snapshot.identity.gestureSequence);
                            if (!item || item.snapshot.identity.nodeId !== snapshot.identity.nodeId) continue;
                            if (item.bounds) {
                                const b = item.bounds, [a, c1, c2, d, e, f] = snapshot.presentation.localToWorld;
                                const corners = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]];
                                const xs = corners.map(([x, y]) => a * x + c2 * y + e), ys = corners.map(([x, y]) => c1 * x + d * y + f);
                                const cam = view.camera;
                                if (Math.max(...xs) < cam.x || Math.min(...xs) > cam.x + view.viewport.width / cam.z
                                    || Math.max(...ys) < cam.y || Math.min(...ys) > cam.y + view.viewport.height / cam.z) continue;
                            }
                            const isHighlight = snapshot.presentation.tool === 'highlighter';
                            if (!isHighlight && band === 'underlay') continue;
                            const pigment = resolveSwatch(options.palette(), snapshot.presentation.color as Swatch, isHighlight ? 'highlight' : 'stroke');
                            if (!pigment) continue;
                            const alpha = isHighlight ? (band === 'underlay' ? HIGHLIGHT_UNDERLAY_ALPHA : HIGHLIGHT_OVERLAY_ALPHA) : 1;
                            ctx.save();
                            try {
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
                memory() {
                    const memory = host === owner ? routesMemory() : undefined;
                    return { gpuBytes: memory?.gpuBytes ?? 0, cpuBytes: host === owner ? reserved + (memory?.cpuBytes ?? 0) : 0 };
                },
                needsFrame() { return !ended && !disposed && !denied && (dirty || !!work || (!!owner?.device() && runsPending())); },
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
            // Each band shares this one owner. Demand the NEXT bounded native-path/coverage
            // allocation before prepare, including a replacement while old wet pixels stay live.
            const extra = pending ? (work ? (work.chunk ? 0 : TEMP_BYTES) + PATH_BLOCK + (work.chunk?.retained?.bytes ?? 0) : TEMP_BYTES + PATH_BLOCK) : 0;
            return { mandatoryBytes: reserved + extra + (owner.device() ? routesMemory().cpuBytes : 0), prefetchBytes: 0 };
        },
        // A live stroke whose GPU runs are still in flight is critical: the non-critical share of a frame is one sliver,
        // which took two frames per plan (measured: every other screencast frame held the same ink). Only while ink is in
        // flight: an idle layer that still wanted a frame kept every frame critical, which starves the other layers' upload
        // share (measured: drawing pan 204 → 78 presents, notebook pan 38).
        critical: () => (!!owner?.device() && runsPending()) || (handover?.pendingSnapshots() ?? [])
            .some(item => !prepared.has(item.identity.gestureSequence)),
        coverage: (_layer, frame, backend) => {
            const missing = (handover?.pendingSnapshots() ?? [])
                .some(item => !prepared.has(item.identity.gestureSequence));
            if (missing) { auditCount('wet', 'cover:incomplete:unprepared'); return { complete: false, sharp: false }; }
            if (backend === 'canvas2d') return { complete: true, sharp: true };
            const verdict = routedCoverage(frame.token, frame.view);
            auditCount('wet', verdict.complete ? (verdict.sharp ? 'cover:sharp' : 'cover:stale') : `cover:incomplete:${verdict.why}`);
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
        liveNodeIds() {
            if (disposed) return EMPTY_LIVE_IDS;
            const next = new Set<string>();
            for (const snapshot of handover?.pendingSnapshots() ?? []) if (snapshot.dry) next.add(snapshot.dry.nodeId);
            let changed = next.size !== liveIds.size;
            if (!changed) for (const id of next) if (!liveIds.has(id)) { changed = true; break; }
            if (changed) liveIds = next.size ? new ImmutableIds(next) : EMPTY_LIVE_IDS;
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
