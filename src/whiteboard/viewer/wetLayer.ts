import type { ViewState } from '../../platform/types';
import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease, GpuPass } from '../../platform/render/gfx/api';
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
import type { CreateInkRoutes, InkRouteFor, ItemRoute, PreparedRun, WithClips } from '../render/gpu/contracts';
import { createGpuPaintAdapter } from '../render/gpuPaintAdapter';
import { bandItemsOf } from '../render/paintWindows';
import { preparedOfFrame, type CanvasPaintAdapter, type PreparedPaint2d } from '../render/reference/canvasPaintAdapter';
import { awaitCapacity, isBudgetRefusal } from '../render/budgetRefusal';
import { appendPath2d } from '../render/reference/coverage2d';

// Provenance: wet/dry ink handover, bounded ink outline and C4 layer contracts;
// independently wired renderer, no third-party source.
const CHUNK = 256, FINAL_SPANS = 16, TEMP_BYTES = 4 * 1024 * 1024, PATH_BLOCK = 256 * 1024;
type Bounds = { x: number; y: number; w: number; h: number };
type Prepared = { readonly snapshot: WetInkSnapshot; readonly path: Path2D; readonly origin: readonly [number, number]; readonly leases: ByteLease[]; readonly scale: number; readonly bounds: Bounds | null; readonly coverageChunks: readonly InkCoverage[]; readonly serial: number };
// The finalized prefix of one stroke. A span the curve has finalized (publication.finalizedSpanCount) keeps its
// coverage and outline for the stroke's life, so a growing stroke recomputes only its replaceable tail.
type Stable = { readonly nodeId: string; readonly scale: number; readonly origin: readonly [number, number]; spans: number;
    chunks: InkCoverage[]; path: Path2D; bounds: Bounds | null; dot: boolean; scan: number; buffers: Set<ArrayBufferLike>; leases: ByteLease[] };
type Tail = { chunks: InkCoverage[]; path: Path2D; bounds: Bounds | null; buffers: Set<ArrayBufferLike>; leases: ByteLease[] };
type Chunk = { readonly first: number; readonly count: number; readonly finalizing: boolean; readonly temp: ByteLease;
    coverage: InkCoverageJob | null; outline: InkOutlineJob | null; readonly path: Path2D; readonly leases: ByteLease[]; capacity: number;
    retained: { coverage: InkCoverage; buffers: ArrayBufferLike[]; bytes: number; outlined: boolean } | null };
type Work = { snapshot: WetInkSnapshot; stable: Stable; scale: number; offset: number; tail: Tail; chunk: Chunk | null };
/** The GPU routes that draw wet ink, injected: this file does not import the route modules. Absent, the layer keeps
 * the adapter path (the streaming tile raster) that the running app uses until the routes are wired in. */
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
    readonly gpuRoutes?: WetGpuRoutes;
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
function available(frame: PaintSource | null | undefined, identity: DryInkIdentity, token: RenderToken): boolean {
    return !!frame && sameToken(frame.token, token) && frame.sceneRevision >= identity.nodeRevision && frame.inkNodeIds.has(identity.nodeId);
}
function visuallyCovered(frame: PaintSource | null | undefined, identity: DryInkIdentity, token: RenderToken): boolean {
    return available(frame, identity, token) || !!frame && sameToken(frame.token, token)
        && frame.sceneRevision >= identity.nodeRevision && !!frame.occludedInkNodeIds?.has(identity.nodeId);
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
/** One stroke's GPU run for one band. `shown` is what is drawn; the rest says what the current publication needs. A
 * deferred or denied admission keeps drawing the last shown tip while coverage waits for the new one. */
interface WetRunSlot {
    readonly gesture: number;
    serial: number; scale: number; colour: string; token: FrameToken;
    state: 'pending' | 'ready' | 'empty' | 'denied' | 'unsupported';
    shown: { readonly route: ItemRoute<PaintInkItem>; readonly run: PreparedRun; readonly clips: readonly PaintClip[];
        readonly draw: () => void } | null;
}
const runKey = (gesture: number, band: WetBand): string => `${gesture}/${band}`;
function sameFrameToken(a: FrameToken, b: FrameToken): boolean {
    return sameToken(a, b) && a.viewLease === b.viewLease && a.deviceGeneration === b.deviceGeneration;
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
// The same test draw2d applies, without its corner array: the stroke's device box against the viewport.
function offScreen(bounds: Bounds | null, m: readonly [number, number, number, number, number, number], view: ViewState): boolean {
    if (!bounds) return false;
    const [a, c1, c2, d, e, f] = m;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let corner = 0; corner < 4; corner++) {
        const x = corner & 1 ? bounds.x + bounds.w : bounds.x, y = corner & 2 ? bounds.y + bounds.h : bounds.y;
        const wx = a * x + c2 * y + e, wy = c1 * x + d * y + f;
        minX = Math.min(minX, wx); maxX = Math.max(maxX, wx); minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
    }
    const cam = view.camera;
    return maxX < cam.x || minX > cam.x + view.viewport.width / cam.z || maxY < cam.y || minY > cam.y + view.viewport.height / cam.z;
}

export function createBoardWetLayer(options: BoardWetOptions): BoardWetRenderer {
    let handover: WetInkHandover | null = null, disposed = false, generation = 0, dirty = false, denied = false;
    let liveIds: ReadonlySet<string> = EMPTY_LIVE_IDS;
    let owner: LayerHost | null = null, work: Work | null = null, reserved = 0, lastPrepareFrame: number | null = null;
    const hosts = new Set<LayerHost>(), prepared = new Map<number, Prepared>(), callbacks = new Set<() => void>();
    let publicationVersion = 0, sourceVersion = -1, sourceGeneration = -1, paletteRevision = -1;
    let gpuPrepared: PreparedPaint2d | null = null, gpuToken: FrameToken | null = null;
    let gpu: ReturnType<typeof createGpuPaintAdapter> | null = null;
    // Routed wet ink (options.gpuRoutes): each stroke's chunks are drawn by the ink route the shared chooser picks.
    const routed = !!options.gpuRoutes;
    let inkRoutes: InkRoutes | null = null, drawPass: GpuPass | null = null;
    const runs = new Map<string, WetRunSlot>();
    const gpuReference: CanvasPaintAdapter = {
        prepare: () => {}, readyFrame: () => gpuPrepared?.sourceFrame ?? null, borrowPrepared: () => gpuPrepared, retainPrepared: () => null,
        draw2d: () => {}, release: () => {}, needsFrame: () => false,
        memory: () => ({ gpuBytes: 0, cpuBytes: 0 }), dispose: () => {},
    };
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
            chunk.coverage?.cancel(); chunk.outline?.cancel();
            release(chunk.temp);
            for (const lease of chunk.leases) release(lease);
        }
        for (const lease of item.tail.leases) release(lease);
    };
    const clear = () => {
        dropWork(); for (const item of prepared.values()) dropPrepared(item); prepared.clear();
        for (const gesture of [...stables.keys()]) dropStable(gesture);
        gpu?.release('pressure'); gpuPrepared = null; gpuToken = null; publicationVersion++;
        releaseRoutes();
        dirty = false; denied = false; liveIds = EMPTY_LIVE_IDS;
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
        if (slot.shown) { slot.shown.route.retire(slot.shown.run); slot.shown = null; }
    };
    const releaseRoutes = () => {
        for (const [key] of [...runs]) dropSlot(key);
        if (inkRoutes) { inkRoutes.analytic.release(); inkRoutes.union.release(); inkRoutes = null; }
    };
    const routesMemory = (): { gpuBytes: number; cpuBytes: number } => {
        if (!inkRoutes) return { gpuBytes: 0, cpuBytes: 0 };
        const analytic = inkRoutes.analytic.memory(), union = inkRoutes.union.memory();
        return { gpuBytes: analytic.gpuBytes + union.gpuBytes, cpuBytes: analytic.cpuBytes + union.cpuBytes };
    };
    // Admits every band of every pending stroke whose run is not current. Only the tip is new work: the route keys its
    // geometry by chunk, so the stable chunks of a stroke cost no tessellation and no upload here.
    const admitRuns = (host: LayerHost, view: ViewState, budget: FrameBudget): void => {
        const routes = inkRoutes ??= options.gpuRoutes!.createInkRoutes(host, 'board-wet');
        const palette = options.palette(), pending = handover?.forFrame(() => false) ?? [], live = new Set<number>();
        for (const snapshot of pending) live.add(snapshot.identity.gestureSequence);
        for (const [key, slot] of [...runs]) if (!live.has(slot.gesture)) dropSlot(key);
        for (const snapshot of pending) {
            const gesture = snapshot.identity.gestureSequence, source = prepared.get(gesture);
            if (!source || source.snapshot !== snapshot) continue;
            for (const band of BANDS) {
                const key = runKey(gesture, band), material = bandMaterial(snapshot, band, palette);
                if (!material) { dropSlot(key); continue; }
                const colour = material.color.join(','), current = runs.get(key);
                if (current && current.serial === source.serial && current.scale === source.scale && current.colour === colour
                    && sameFrameToken(current.token, budget.token) && (current.state === 'ready' || current.state === 'empty' || current.state === 'unsupported')) continue;
                if (budget.shouldYield()) return;
                const item: PaintInkItem = { kind: 'ink', key: `wet/${gesture}/${band}`, nodeId: snapshot.identity.nodeId,
                    geometryKey: `wet/${gesture}/${source.serial}`, localToWorld: snapshot.presentation.localToWorld,
                    clips: snapshot.presentation.clips ?? [], coverage: source.coverageChunks, material };
                const route = options.gpuRoutes!.inkRouteFor(item) === 'ink-analytic' ? routes.analytic : routes.union;
                const audited = renderAuditEnabled(), before = audited ? route.memory().gpuBytes : 0;
                const admission = route.admit([item], view, 'over', budget);
                if (audited) { const grown = route.memory().gpuBytes - before; if (grown > 0) auditCount('wet', 'upload:vertex', 1, { bytes: grown }); }
                const slot: WetRunSlot = current ?? { gesture, serial: 0, scale: 0, colour: '', token: budget.token, state: 'pending', shown: null };
                slot.serial = source.serial; slot.scale = source.scale; slot.colour = colour; slot.token = { ...budget.token };
                runs.set(key, slot);
                switch (admission.status) {
                    case 'ready': {
                        if (slot.shown) slot.shown.route.retire(slot.shown.run);
                        const run = admission.value, clips = item.clips;
                        slot.shown = { route, run, clips, draw: () => { if (drawPass) route.draw(drawPass, run); } };
                        slot.state = 'ready';
                        break;
                    }
                    case 'empty':
                        if (slot.shown) { slot.shown.route.retire(slot.shown.run); slot.shown = null; }
                        slot.state = 'empty';
                        break;
                    case 'deferred': slot.state = 'pending'; break;
                    case 'denied': slot.state = 'denied'; denied = true; awaitCapacity(host, invalidate); break;
                    case 'unsupported':
                        if (slot.shown) { slot.shown.route.retire(slot.shown.run); slot.shown = null; }
                        slot.state = 'unsupported';
                        report(new Error(`Wet ink route cannot draw a stroke: ${admission.why}`));
                        break;
                }
            }
        }
    };
    // True while some visible band still needs an admission for the current publication.
    const runsPending = (): boolean => {
        const palette = options.palette();
        for (const snapshot of handover?.forFrame(() => false) ?? []) {
            const gesture = snapshot.identity.gestureSequence, source = prepared.get(gesture);
            if (!source || source.snapshot !== snapshot) return true;
            for (const band of BANDS) {
                if (!bandMaterial(snapshot, band, palette)) continue;
                const slot = runs.get(runKey(gesture, band));
                if (!slot || slot.state === 'pending' || slot.serial !== source.serial || slot.scale !== source.scale) return true;
            }
        }
        return false;
    };
    // Coverage for the routed path: every band the frame needs is admitted for this publication and this device token.
    const routedCovered = (token: FrameToken): boolean => {
        const palette = options.palette(), frame = options.readyFrame();
        for (const snapshot of handover?.forFrame(identity => visuallyCovered(frame, identity, options.token)) ?? []) {
            const gesture = snapshot.identity.gestureSequence, source = prepared.get(gesture);
            for (const band of BANDS) {
                if (!bandMaterial(snapshot, band, palette)) continue;
                const slot = runs.get(runKey(gesture, band));
                if (!source || !slot || slot.state === 'pending' || slot.state === 'denied' || slot.serial !== source.serial
                    || slot.scale !== source.scale || !sameFrameToken(slot.token, token)) return false;
            }
        }
        return true;
    };
    const drawRouted = (pass: GpuPass, view: ViewState, band: WetBand): void => {
        if (disposed || !options.current() || !inkRoutes) return;
        const frame = options.readyFrame();
        let drawn = 0;
        drawPass = pass;
        try {
            for (const snapshot of handover?.forFrame(identity => visuallyCovered(frame, identity, options.token)) ?? []) {
                const gesture = snapshot.identity.gestureSequence, source = prepared.get(gesture);
                if (!source || source.snapshot !== snapshot || offScreen(source.bounds, snapshot.presentation.localToWorld, view)) continue;
                const shown = runs.get(runKey(gesture, band))?.shown;
                if (!shown) continue;
                // Clips are applied here and only here: the route draws the item's geometry, withClips its clips.
                const admitted = options.gpuRoutes!.withClips(pass, shown.clips, view, shown.draw);
                if (admitted.status === 'ready') drawn++;
                else auditCount('wet', `clip:${admitted.status}`);
            }
        } finally { drawPass = null; }
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
            stable = { nodeId: snapshot.identity.nodeId, scale, origin: [samples.x(0), samples.y(0)], spans: 0, chunks: [], path: new Path2D(),
                bounds: null, dot: true, scan: 1, buffers: new Set(), leases: [] };
            stables.set(gesture, stable);
        }
        work = { snapshot, stable, scale, offset: stable.spans, chunk: null,
            tail: { chunks: [], path: new Path2D(), bounds: null, buffers: new Set(), leases: [] } };
        return true;
    };
    const step = (): boolean => {
        const w = work!, publication = w.snapshot.curve, real = publication.samples, s = w.stable;
        if (s.scan < real.count) {
            if (real.x(s.scan) !== real.x(0) || real.y(s.scan) !== real.y(0)) s.dot = false;
            s.scan++; return false;
        }
        const c = w.chunk;
        if (c?.retained?.outlined) {
            const retained = c.retained;
            const lease = retained.bytes ? reserve(retained.bytes) : null;
            if (retained.bytes && !lease) { denied = true; return false; }
            if (lease) c.leases.push(lease);
            release(c.temp);
            if (c.finalizing) {
                const next = new Path2D(); next.addPath(s.path); next.addPath(c.path); s.path = next;
                s.chunks.push(retained.coverage); s.spans = c.first + c.count;
                s.bounds = unionBounds(s.bounds, retained.coverage.boundsLocal);
                for (const buffer of retained.buffers) s.buffers.add(buffer);
                s.leases.push(...c.leases);
            } else {
                w.tail.path.addPath(c.path); w.tail.chunks.push(retained.coverage);
                w.tail.bounds = unionBounds(w.tail.bounds, retained.coverage.boundsLocal);
                for (const buffer of retained.buffers) w.tail.buffers.add(buffer);
                w.tail.leases.push(...c.leases);
            }
            w.chunk = null;
            return false;
        }
        if (c?.outline) {
            const outline = c.outline;
            if ((outline.commandCount + 1) * 80 > c.capacity) {
                const bytes = Math.max(4096, (outline.commandCount + 1) * 80 - c.capacity);
                const lease = reserve(bytes); if (!lease) { denied = true; return false; }
                c.leases.push(lease); c.capacity += lease.bytes;
            }
            if (outline.step(1) === 'complete') { c.outline = null; c.retained!.outlined = true; }
            return false;
        }
        if (c?.coverage) {
            if (c.coverage.step(1) === 'complete') {
                const coverage = c.coverage.result;
                c.coverage = null;
                c.retained = { coverage, ...retainedBuffers(coverage, c.finalizing ? [s.buffers] : [s.buffers, w.tail.buffers]), outlined: false };
                c.outline = new InkOutlineJob(coverage, w.scale, command => appendPath2d(c.path, command, s.origin));
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
            w.chunk = { first: offset, count, finalizing, temp, path: new Path2D(), leases: [], capacity: 0, outline: null, retained: null,
                coverage: new InkCoverageJob(real, geometry, style, { deviceScale: w.scale, dot, maxPrimitives: 4096 }) };
            // A non-finalized chunk is the tip: rebuilt on every publication, so this counts the per-input tessellation.
            if (!finalizing) auditCount('wet', 'tip-build');
            return false;
        }
        const gesture = w.snapshot.identity.gestureSequence;
        const prior = prepared.get(gesture);
        if (prior) dropPrepared(prior);
        const path = new Path2D(); path.addPath(s.path); path.addPath(w.tail.path);
        prepared.set(gesture, { snapshot: w.snapshot, path, origin: s.origin, leases: w.tail.leases, scale: w.scale,
            bounds: w.tail.bounds ? unionBounds(s.bounds, w.tail.bounds) : s.bounds, coverageChunks: [...s.chunks, ...w.tail.chunks], serial: ++publicationVersion });
        work = null; return true;
    };
    const updateGpuSource = () => {
        const palette = options.palette();
        if (gpuPrepared && sourceVersion === publicationVersion && sourceGeneration === generation && paletteRevision === palette.revision) return;
        const underlay: PaintInkItem[] = [], content: PaintInkItem[] = [];
        const paths = new WeakMap<PaintInkItem, Prepared>();
        for (const snapshot of handover?.forFrame(() => false) ?? []) {
            const source = prepared.get(snapshot.identity.gestureSequence);
            if (!source || source.snapshot.identity.nodeId !== snapshot.identity.nodeId) continue;
            const highlight = snapshot.presentation.tool === 'highlighter';
            const pigment = resolveSwatch(palette, snapshot.presentation.color as Swatch, highlight ? 'highlight' : 'stroke');
            if (!pigment) continue;
            const emit = (band: 'underlay' | 'content', alpha: number) => {
                const item: PaintInkItem = { kind: 'ink', key: `wet/${snapshot.identity.gestureSequence}/${band}`,
                    nodeId: snapshot.identity.nodeId, geometryKey: `wet/${snapshot.identity.gestureSequence}/${source.serial}`,
                    localToWorld: snapshot.presentation.localToWorld, clips: [], coverage: source.coverageChunks,
                    material: { blend: 'normal', color: withOpacity(pigment, alpha) } };
                paths.set(item, source); (band === 'underlay' ? underlay : content).push(item);
            };
            if (highlight) emit('underlay', HIGHLIGHT_UNDERLAY_ALPHA);
            emit('content', highlight ? HIGHLIGHT_OVERLAY_ALPHA : 1);
        }
        const frame: PaintSource = { token: options.token, sceneRevision: generation, inkNodeIds: new Set(), underlay, content };
        gpuPrepared = preparedOfFrame(frame, {
            path: item => { const source = paths.get(item as PaintInkItem); if (!source) throw new Error('Wet GPU path unavailable'); return { path: source.path, origin: source.origin }; },
            clip: () => { throw new Error('Wet ink has no clips'); }, image: () => { throw new Error('Wet ink has no images'); },
        });
        sourceVersion = publicationVersion; sourceGeneration = generation; paletteRevision = palette.revision;
    };
    const prepare = (view: ViewState, budget: FrameBudget) => {
        if (disposed || !owner || !options.current() || lastPrepareFrame === budget.frameId) return;
        lastPrepareFrame = budget.frameId;
        // A denied reservation waits for a genuine scheduler wake, not another polling frame.
        denied = false;
        try {
            for (const item of handover?.forFrame(() => false) ?? []) {
                if (item.dry && !options.exists(item.dry)) handover?.clear(item.identity);
            }
            const snapshots = handover?.forFrame(() => false) ?? [];
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
                // A finalized span is not on the published path, so its outline does not gate this frame's publication:
                // only the tail chunk, which the next publication shows, yields here (measured: a per-finalize break was a hold every 16 samples).
                if (denied || (work?.chunk?.retained?.outlined && !work.chunk.finalizing)) break;
            }
        } catch (error) { dropWork(); denied = true; report(error); }
        if (owner.device() && sameToken(options.token, budget.token)) {
            try {
                if (routed) admitRuns(owner, view, budget);
                else {
                    gpu ??= createGpuPaintAdapter(gpuReference, owner, report, { streaming: true, audit: 'board-wet' });
                    updateGpuSource(); gpuToken = { ...budget.token }; gpu.prepare(view, budget);
                }
            } catch (error) { report(error); }
        }
    };
    const make = (band: 'underlay' | 'content'): PlatformLayerDefinition => ({
        id: `board-wet-${band}`, group: 'document', liveInput: true,
        create(host) {
            if (disposed) throw new Error('Wet layer disposed');
            hosts.add(host); owner ??= host;
            let ended = false;
            const layer: Layer = {
                prepare,
                drawGpu(pass, view) {
                    if (routed) { drawRouted(pass, view, band); return; }
                    if (disposed || !options.current() || !gpu) return;
                    const frame = options.readyFrame();
                    const visible = new Set((handover?.forFrame(identity => visuallyCovered(frame, identity, options.token)) ?? [])
                        .map(item => item.identity.nodeId));
                    const omit = new Set<string>();
                    const paint = gpu.readyPaint();
                    let drawn = 0;
                    if (paint) for (const item of bandItemsOf(paint.windows, band)) { if (!visible.has(item.nodeId)) omit.add(item.nodeId); else drawn++; }
                    if (drawn) auditCount('wet', 'draw');
                    gpu.drawGpu(pass, view, band, omit);
                },
                draw2d(ctx, view) {
                    if (disposed || !options.current()) return;
                    const frame = options.readyFrame(), snapshots = handover?.forFrame(identity => visuallyCovered(frame, identity, options.token)) ?? [];
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
                                ctx.fillStyle = colourCss(withOpacity(pigment, alpha)); ctx.fill(item.path, 'nonzero');
                            } finally { ctx.restore(); }
                        }
                    });
                },
                releaseGpu(reason) { gpu?.release(reason); gpuToken = null; if (reason === 'hidden' || reason === 'pressure') clear(); },
                memory() {
                    const memory = host === owner ? (routed ? routesMemory() : gpu?.memory()) : undefined;
                    return { gpuBytes: memory?.gpuBytes ?? 0, cpuBytes: host === owner ? reserved + (memory?.cpuBytes ?? 0) : 0 };
                },
                needsFrame() { return !ended && !disposed && !denied && (dirty || !!work || (!!owner?.device() && (routed ? runsPending() : !!gpu?.needsFrame()))); },
                dispose() { if (ended) return; ended = true; if (owner === host) { clear(); gpu?.dispose(); gpu = null; owner = null; } hosts.delete(host); hostLayers.delete(host); owner ??= hosts.values().next().value ?? null; },
            };
            hostLayers.set(host, layer);
            return layer;
        },
        revision: () => generation,
        cpuWorkingSet: layer => {
            if (!owner || hostLayers.get(owner) !== layer) return { mandatoryBytes: 0, prefetchBytes: 0 };
            const snapshots = handover?.forFrame(() => false) ?? [];
            const pending = !!work || snapshots.some(item => prepared.get(item.identity.gestureSequence)?.snapshot !== item);
            // Each band shares this one owner. Demand the NEXT bounded native-path/coverage
            // allocation before prepare, including a replacement while old wet pixels stay live.
            const extra = pending ? (work ? (work.chunk ? 0 : TEMP_BYTES) + PATH_BLOCK + (work.chunk?.retained?.bytes ?? 0) : TEMP_BYTES + PATH_BLOCK) : 0;
            return { mandatoryBytes: reserved + extra + (owner.device() ? (routed ? routesMemory().cpuBytes : gpu?.cpuWorkingSet().mandatoryBytes ?? 2 * 516 * 516 * 4) : 0), prefetchBytes: 0 };
        },
        // A live stroke whose GPU paint is still catching up is critical: the non-critical share of a frame is one
        // sliver, which took two frames per plan (measured: every other screencast frame held the same ink).
        // Only while ink is in flight: an idle wet adapter that still wanted a frame kept every frame critical, which
        // starves the other layers' upload share (measured: drawing pan 204 → 78 presents, notebook pan 38).
        critical: () => !!owner?.device() && (routed ? runsPending() : !!gpu?.needsFrame()) && (handover?.forFrame(() => false).length ?? 0) > 0 || (handover?.forFrame(identity => visuallyCovered(options.readyFrame(), identity, options.token)) ?? [])
            .some(item => !prepared.has(item.identity.gestureSequence)),
        coverage: (_layer, frame, backend) => {
            const missing = (handover?.forFrame(identity => visuallyCovered(options.readyFrame(), identity, options.token)) ?? [])
                .some(item => !prepared.has(item.identity.gestureSequence));
            if (missing) return { complete: false, sharp: false };
            if (backend === 'canvas2d') return { complete: true, sharp: true };
            if (routed) { const complete = routedCovered(frame.token); return { complete, sharp: complete }; }
            // The adapter presents the last completed paint and reports staleVersion until it catches up;
            // requiring the newest source here refused every frame of a live stroke.
            if (!gpu || !gpuToken || !sameToken(gpuToken, frame.token) || gpuToken.viewLease !== frame.token.viewLease ||
                gpuToken.deviceGeneration !== frame.token.deviceGeneration) return { complete: false, sharp: false };
            return gpu.coverage(frame.view);
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
            for (const snapshot of handover?.forFrame(() => false) ?? []) if (snapshot.dry) next.add(snapshot.dry.nodeId);
            let changed = next.size !== liveIds.size;
            if (!changed) for (const id of next) if (!liveIds.has(id)) { changed = true; break; }
            if (changed) liveIds = next.size ? new ImmutableIds(next) : EMPTY_LIVE_IDS;
            return liveIds;
        },
        presented(revision, token, frame) {
            if (disposed || !sameToken(token, options.token) || !frame || frame.sceneRevision !== revision || !sameToken(frame.token, token)) return;
            let acknowledged = false;
            for (const item of handover?.forFrame(() => false) ?? []) {
                if (item.dry && available(frame, item.dry, token)) { handover?.acknowledgePresented(item.dry); acknowledged = true; }
            }
            // Only a handover that changed needs another frame. Invalidating on every presented frame made each frame ask
            // for the next: on a webgl2 PDF the board restarted its GPU plan every frame (245 in 6 s idle), never finished
            // one, stayed 'Updating…', and a later drag froze on a frame without the moved ink.
            if (acknowledged) invalidate();
        },
        clear,
        dispose() { if (disposed) return; clear(); gpu?.dispose(); gpu = null; disposed = true; callbacks.clear(); handover = null; },
    };
}
