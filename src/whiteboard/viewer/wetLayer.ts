import type { ViewState } from '../../platform/types';
import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { FrameBudget, FrameToken, Layer, RenderToken } from '../../platform/render/types';
import { InkCoverageJob, InkOutlineJob, type InkCoverage } from '../ink/outline';
import { materializeCurveRange, type CurveGeometry } from '../ink/curve';
import type { SampleSequence } from '../ink/samples';
import { DOT_METRIC_PROVISIONAL, type InkDot, type InkWidth } from '../ink/width';
import type { BoardWetLayer } from '../input/attach';
import type { DryInkIdentity, WetInkHandover, WetInkSnapshot } from '../input/liveInk';
import type { Swatch } from '../model/styles';
import { colourCss, resolveSwatch, withOpacity, type PaintPalette } from '../render/colour';
import { HIGHLIGHT_OVERLAY_ALPHA, HIGHLIGHT_UNDERLAY_ALPHA } from '../render/material';
import type { PaintFrame, PaintInkItem } from '../render/paintStream';
import { createGpuPaintAdapter } from '../render/gpuPaintAdapter';
import type { CanvasPaintAdapter, PreparedPaint2d } from '../render/reference/canvasPaintAdapter';
import { appendPath2d } from '../render/reference/coverage2d';

// Provenance: wet/dry ink handover, bounded ink outline and C4 layer contracts;
// independently wired renderer, no third-party source.
const CHUNK = 256, TEMP_BYTES = 4 * 1024 * 1024, PATH_BLOCK = 256 * 1024;
type Bounds = { x: number; y: number; w: number; h: number };
type Prepared = { readonly snapshot: WetInkSnapshot; readonly path: Path2D; readonly origin: readonly [number, number]; readonly leases: ByteLease[]; readonly scale: number; readonly bounds: Bounds | null; readonly coverageChunks: readonly InkCoverage[]; readonly serial: number };
type Work = { snapshot: WetInkSnapshot; path: Path2D; origin: readonly [number, number]; leases: ByteLease[]; capacity: number; commands: number;
    temp: ByteLease | null; scan: number; dot: boolean; offset: number; prediction: boolean; geometry: CurveGeometry | null;
    coverage: InkCoverageJob | null; outline: InkOutlineJob | null; scale: number; bounds: Bounds | null; coverageChunks: InkCoverage[];
    buffers: Set<ArrayBufferLike>; retained: { coverage: InkCoverage; buffers: ArrayBufferLike[]; bytes: number; outlined: boolean } | null };
export interface BoardWetOptions {
    readonly token: RenderToken;
    readonly palette: () => PaintPalette;
    readonly readyFrame: () => PaintFrame | null;
    readonly current: () => boolean;
    readonly exists: (identity: DryInkIdentity) => boolean;
    readonly invalidate: () => void;
    readonly onError: (error: unknown) => void;
}
export interface BoardWetRenderer extends BoardWetLayer {
    readonly layers: Readonly<{ underlay: PlatformLayerDefinition; content: PlatformLayerDefinition }>;
    consumeInput(): void;
    liveNodeIds(): ReadonlySet<string>;
    presented(revision: number, token: RenderToken, frame?: PaintFrame): void;
    clear(): void;
    dispose(): void;
}
function sameToken(a: RenderToken, b: RenderToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration && a.session === b.session;
}
function available(frame: PaintFrame | null | undefined, identity: DryInkIdentity, token: RenderToken): boolean {
    return !!frame && sameToken(frame.token, token) && frame.sceneRevision >= identity.nodeRevision && frame.inkNodeIds.has(identity.nodeId);
}
function visuallyCovered(frame: PaintFrame | null | undefined, identity: DryInkIdentity, token: RenderToken): boolean {
    return available(frame, identity, token) || !!frame && sameToken(frame.token, token)
        && frame.sceneRevision >= identity.nodeRevision && !!frame.occludedInkNodeIds?.has(identity.nodeId);
}
function retainedBuffers(coverage: InkCoverage, known: ReadonlySet<ArrayBufferLike>): { buffers: ArrayBufferLike[]; bytes: number } {
    const unique = new Set<ArrayBufferLike>();
    const add = (view: ArrayBufferView) => { if (!known.has(view.buffer)) unique.add(view.buffer); };
    add(coverage.geometry.cubics); add(coverage.geometry.flags); add(coverage.radii);
    add(coverage.segments); add(coverage.discs); add(coverage.centreline);
    for (const map of coverage.arcMaps) { add(map.cubic); add(map.pieces); }
    const buffers = [...unique], bytes = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
    if (!Number.isSafeInteger(bytes)) throw new RangeError('Wet coverage accounting overflow');
    return { buffers, bytes };
}
function predictionSamples(g: CurveGeometry): SampleSequence {
    return { count: g.spanCount + 1,
        x: i => g.originX + g.cubics[i ? (i - 1) * 8 + 6 : 0],
        y: i => g.originY + g.cubics[i ? (i - 1) * 8 + 7 : 1],
        pressure: () => undefined, segmentKind: () => 'freehand' };
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

export function createBoardWetLayer(options: BoardWetOptions): BoardWetRenderer {
    let handover: WetInkHandover | null = null, disposed = false, generation = 0, dirty = false, denied = false;
    let liveIds: ReadonlySet<string> = EMPTY_LIVE_IDS;
    let owner: LayerHost | null = null, work: Work | null = null, reserved = 0, lastPrepareFrame: number | null = null;
    const hosts = new Set<LayerHost>(), prepared = new Map<number, Prepared>(), callbacks = new Set<() => void>();
    let publicationVersion = 0, sourceVersion = -1, sourceGeneration = -1, paletteRevision = -1;
    let gpuPrepared: PreparedPaint2d | null = null, gpuToken: FrameToken | null = null;
    let gpu: ReturnType<typeof createGpuPaintAdapter> | null = null;
    const gpuReference: CanvasPaintAdapter = {
        prepare: () => {}, readyFrame: () => gpuPrepared?.frame ?? null, borrowPrepared: () => gpuPrepared,
        draw2d: () => {}, release: () => {}, needsFrame: () => false,
        memory: () => ({ gpuBytes: 0, cpuBytes: 0 }), dispose: () => {},
    };
    const hostLayers = new Map<LayerHost, Layer>();
    const report = (error: unknown) => { try { options.onError(error); } catch { /* reporting must not escape the scheduler */ } };
    const invalidate = () => { if (disposed) return; dirty = true; generation++; denied = false; options.invalidate(); for (const host of hosts) host.invalidate('wet-ink'); };
    const release = (lease: ByteLease) => { owner!.allocator.cpu.release(lease); reserved -= lease.bytes; };
    const dropPrepared = (item: Prepared) => { for (const lease of item.leases) release(lease); };
    const dropWork = () => {
        const item = work; work = null;
        if (!item) return;
        item.coverage?.cancel(); item.outline?.cancel();
        if (item.temp) release(item.temp);
        for (const lease of item.leases) release(lease);
    };
    const clear = () => {
        dropWork(); for (const item of prepared.values()) dropPrepared(item); prepared.clear();
        gpu?.release('pressure'); gpuPrepared = null; gpuToken = null; publicationVersion++;
        dirty = false; denied = false; liveIds = EMPTY_LIVE_IDS;
    };
    const reserve = (bytes: number): ByteLease | null => {
        const lease = owner?.allocator.cpu.reserve(bytes) ?? null;
        if (lease) reserved += lease.bytes;
        return lease;
    };
    const begin = (snapshot: WetInkSnapshot, view: ViewState): boolean => {
        const base = reserve(PATH_BLOCK); if (!base) return false;
        const matrix = snapshot.presentation.localToWorld;
        const scale = Math.max(Number.MIN_VALUE, view.camera.z * view.viewport.dpr * Math.hypot(matrix[0], matrix[1], matrix[2], matrix[3]));
        const samples = snapshot.curve.samples;
        work = { snapshot, path: new Path2D(), origin: [samples.x(0), samples.y(0)], leases: [base], capacity: base.bytes,
            commands: 0, temp: null, scan: 1, dot: true, offset: 0, prediction: false, geometry: null, coverage: null, outline: null, scale, bounds: null, coverageChunks: [], buffers: new Set(), retained: null };
        return true;
    };
    const step = (): boolean => {
        const w = work!, publication = w.snapshot.curve, real = publication.samples;
        if (w.scan < real.count) {
            if (real.x(w.scan) !== real.x(0) || real.y(w.scan) !== real.y(0)) w.dot = false;
            w.scan++; return false;
        }
        if (w.retained?.outlined) {
            const retained = w.retained;
            const lease = retained.bytes ? reserve(retained.bytes) : null;
            if (retained.bytes && !lease) { denied = true; return false; }
            if (lease) w.leases.push(lease);
            for (const buffer of retained.buffers) w.buffers.add(buffer);
            w.coverageChunks.push(retained.coverage);
            if (w.temp) { release(w.temp); w.temp = null; }
            w.retained = null; w.coverage = null; w.geometry = null;
            return false;
        }
        if (w.outline) {
            if ((w.commands + w.outline.commandCount + 1) * 80 > w.capacity) {
                const lease = reserve(PATH_BLOCK); if (!lease) { denied = true; return false; }
                w.leases.push(lease); w.capacity += lease.bytes;
            }
            if (w.outline.step(1) === 'complete') {
                w.commands += w.outline.commandCount; w.outline = null; w.retained!.outlined = true;
            }
            return false;
        }
        if (w.coverage) {
            if (w.coverage.step(1) === 'complete') {
                const coverage = w.coverage.result, path = w.path, origin = w.origin, next = coverage.boundsLocal;
                if (!w.bounds) w.bounds = { ...next };
                else {
                    const x = Math.min(w.bounds.x, next.x), y = Math.min(w.bounds.y, next.y);
                    w.bounds = { x, y, w: Math.max(w.bounds.x + w.bounds.w, next.x + next.w) - x,
                        h: Math.max(w.bounds.y + w.bounds.h, next.y + next.h) - y };
                }
                w.retained = { coverage, ...retainedBuffers(coverage, w.buffers), outlined: false };
                w.outline = new InkOutlineJob(coverage, w.scale, command => appendPath2d(path, command, origin));
            }
            return false;
        }
        const spans = real.count - 1;
        if (!w.prediction && (w.offset < spans || (spans === 0 && w.offset === 0))) {
            const count = Math.min(CHUNK, spans - w.offset), first = w.offset;
            const temp = reserve(TEMP_BYTES); if (!temp) { denied = true; return false; } w.temp = temp;
            const geometry = materializeCurveRange(real, { firstSpan: first, spanCount: count }, publication.parameters);
            w.offset = spans === 0 ? 1 : first + count;
            const style: InkWidth = { width: w.snapshot.presentation.width, model: { id: 'uniform' }, pressure: 'none' };
            const dot: InkDot | null = w.dot ? { x: real.x(0), y: real.y(0), radius: DOT_METRIC_PROVISIONAL.radius(style.width, style.width / 2, style.model) } : null;
            w.geometry = geometry;
            w.coverage = new InkCoverageJob(real, geometry, style, { deviceScale: w.scale, dot: first === 0 ? dot : null, maxPrimitives: 4096 });
            return false;
        }
        if (!w.prediction) {
            w.prediction = true;
            const geometry = publication.prediction?.geometry;
            if (geometry?.spanCount) {
                const temp = reserve(TEMP_BYTES); if (!temp) { w.prediction = false; denied = true; return false; } w.temp = temp;
                w.geometry = geometry;
                w.coverage = new InkCoverageJob(predictionSamples(geometry), geometry,
                    { width: w.snapshot.presentation.width, model: { id: 'uniform' }, pressure: 'none' },
                    { deviceScale: w.scale, dot: null, maxPrimitives: 4096 });
                return false;
            }
        }
        const prior = prepared.get(w.snapshot.identity.gestureSequence);
        if (prior) dropPrepared(prior);
        prepared.set(w.snapshot.identity.gestureSequence, { snapshot: w.snapshot, path: w.path, origin: w.origin, leases: w.leases, scale: w.scale, bounds: w.bounds, coverageChunks: w.coverageChunks, serial: ++publicationVersion });
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
        const frame: PaintFrame = { token: options.token, sceneRevision: generation, inkNodeIds: new Set(), underlay, content };
        gpuPrepared = { frame, resources: {
            path: item => { const source = paths.get(item as PaintInkItem); if (!source) throw new Error('Wet GPU path unavailable'); return { path: source.path, origin: source.origin }; },
            clip: () => { throw new Error('Wet ink has no clips'); }, image: () => { throw new Error('Wet ink has no images'); },
        } };
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
                if (denied || work?.retained?.outlined) break;
            }
        } catch (error) { dropWork(); denied = true; report(error); }
        if (owner.device() && sameToken(options.token, budget.token)) {
            try {
                gpu ??= createGpuPaintAdapter(gpuReference, owner, report);
                updateGpuSource(); gpuToken = { ...budget.token }; gpu.prepare(view, budget);
            } catch (error) { report(error); }
        }
    };
    const make = (band: 'underlay' | 'content'): PlatformLayerDefinition => ({
        id: `board-wet-${band}`, group: 'document',
        create(host) {
            if (disposed) throw new Error('Wet layer disposed');
            hosts.add(host); owner ??= host;
            let ended = false;
            const layer: Layer = {
                prepare,
                drawGpu(pass, view) {
                    if (disposed || !options.current() || !gpu) return;
                    const frame = options.readyFrame();
                    const visible = new Set((handover?.forFrame(identity => visuallyCovered(frame, identity, options.token)) ?? [])
                        .map(item => item.identity.nodeId));
                    const omit = new Set<string>();
                    for (const item of gpu.readyFrame()?.[band] ?? []) if (!visible.has(item.nodeId)) omit.add(item.nodeId);
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
                    const memory = host === owner ? gpu?.memory() : undefined;
                    return { gpuBytes: memory?.gpuBytes ?? 0, cpuBytes: host === owner ? reserved + (memory?.cpuBytes ?? 0) : 0 };
                },
                needsFrame() { return !ended && !disposed && !denied && (dirty || !!work || (!!owner?.device() && !!gpu?.needsFrame())); },
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
            const extra = pending ? (work ? (work.temp ? 0 : TEMP_BYTES) + PATH_BLOCK + (work.retained?.bytes ?? 0) : TEMP_BYTES + PATH_BLOCK) : 0;
            return { mandatoryBytes: reserved + extra + (owner.device() ? (gpu?.cpuWorkingSet().mandatoryBytes ?? 2 * 516 * 516 * 4) : 0), prefetchBytes: 0 };
        },
        critical: () => (handover?.forFrame(identity => visuallyCovered(options.readyFrame(), identity, options.token)) ?? [])
            .some(item => !prepared.has(item.identity.gestureSequence)),
        coverage: (_layer, frame, backend) => {
            const missing = (handover?.forFrame(identity => visuallyCovered(options.readyFrame(), identity, options.token)) ?? [])
                .some(item => !prepared.has(item.identity.gestureSequence));
            if (missing) return { complete: false, sharp: false };
            if (backend === 'canvas2d') return { complete: true, sharp: true };
            if (!gpu || !gpuToken || !sameToken(gpuToken, frame.token) || gpuToken.viewLease !== frame.token.viewLease ||
                gpuToken.deviceGeneration !== frame.token.deviceGeneration || gpu.readyFrame() !== gpuPrepared?.frame) return { complete: false, sharp: false };
            return gpu.coverage(frame.view);
        },
    });
    const layers = Object.freeze({ underlay: make('underlay'), content: make('content') });
    return {
        layers,
        attach(value) { if (disposed) throw new Error('Wet layer disposed'); handover = value; invalidate(); return () => { if (handover === value) { handover = null; clear(); invalidate(); } }; },
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
            for (const item of handover?.forFrame(() => false) ?? []) if (item.dry && available(frame, item.dry, token)) handover?.acknowledgePresented(item.dry);
            invalidate();
        },
        clear,
        dispose() { if (disposed) return; clear(); gpu?.dispose(); gpu = null; disposed = true; callbacks.clear(); handover = null; },
    };
}
