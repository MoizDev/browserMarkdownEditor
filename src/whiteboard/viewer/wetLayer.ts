import type { ViewState } from '../../platform/types';
import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { FrameBudget, Layer, RenderToken } from '../../platform/render/types';
import { InkCoverageJob, InkOutlineJob } from '../ink/outline';
import { materializeCurveRange, type CurveGeometry } from '../ink/curve';
import type { SampleSequence } from '../ink/samples';
import { DOT_METRIC_PROVISIONAL, type InkDot, type InkWidth } from '../ink/width';
import type { BoardWetLayer } from '../input/attach';
import type { DryInkIdentity, WetInkHandover, WetInkSnapshot } from '../input/liveInk';
import type { Swatch } from '../model/styles';
import { colourCss, resolveSwatch, withOpacity, type PaintPalette } from '../render/colour';
import { HIGHLIGHT_OVERLAY_ALPHA, HIGHLIGHT_UNDERLAY_ALPHA } from '../render/material';
import type { PaintFrame } from '../render/paintStream';
import { appendPath2d } from '../render/reference/coverage2d';

// Provenance: wet/dry ink handover, bounded ink outline and C4 layer contracts;
// independently wired renderer, no third-party source.
const CHUNK = 256, TEMP_BYTES = 4 * 1024 * 1024, PATH_BLOCK = 256 * 1024;
type Bounds = { x: number; y: number; w: number; h: number };
type Prepared = { readonly snapshot: WetInkSnapshot; readonly path: Path2D; readonly origin: readonly [number, number]; readonly leases: ByteLease[]; readonly scale: number; readonly bounds: Bounds | null };
type Work = { snapshot: WetInkSnapshot; path: Path2D; origin: readonly [number, number]; leases: ByteLease[]; capacity: number; commands: number;
    temp: ByteLease | null; scan: number; dot: boolean; offset: number; prediction: boolean; geometry: CurveGeometry | null;
    coverage: InkCoverageJob | null; outline: InkOutlineJob | null; scale: number; bounds: Bounds | null };
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
function predictionSamples(g: CurveGeometry): SampleSequence {
    return { count: g.spanCount + 1,
        x: i => g.originX + g.cubics[i ? (i - 1) * 8 + 6 : 0],
        y: i => g.originY + g.cubics[i ? (i - 1) * 8 + 7 : 1],
        pressure: () => undefined, segmentKind: () => 'freehand' };
}
export function createBoardWetLayer(options: BoardWetOptions): BoardWetRenderer {
    let handover: WetInkHandover | null = null, disposed = false, generation = 0, dirty = false, denied = false;
    let owner: LayerHost | null = null, work: Work | null = null, reserved = 0, lastPrepareFrame: number | null = null;
    const hosts = new Set<LayerHost>(), prepared = new Map<number, Prepared>(), callbacks = new Set<() => void>();
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
        dirty = false; denied = false;
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
            commands: 0, temp: null, scan: 1, dot: true, offset: 0, prediction: false, geometry: null, coverage: null, outline: null, scale, bounds: null };
        return true;
    };
    const step = (): boolean => {
        const w = work!, publication = w.snapshot.curve, real = publication.samples;
        if (w.scan < real.count) {
            if (real.x(w.scan) !== real.x(0) || real.y(w.scan) !== real.y(0)) w.dot = false;
            w.scan++; return false;
        }
        if (w.outline) {
            if ((w.commands + w.outline.commandCount + 1) * 80 > w.capacity) {
                const lease = reserve(PATH_BLOCK); if (!lease) { denied = true; return false; }
                w.leases.push(lease); w.capacity += lease.bytes;
            }
            if (w.outline.step(1) === 'complete') {
                w.commands += w.outline.commandCount; w.outline = null; w.coverage = null; w.geometry = null;
                if (w.temp) { release(w.temp); w.temp = null; }
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
        prepared.set(w.snapshot.identity.gestureSequence, { snapshot: w.snapshot, path: w.path, origin: w.origin, leases: w.leases, scale: w.scale, bounds: w.bounds });
        work = null; return true;
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
            for (const [id, item] of prepared) if (!ids.has(id)) { dropPrepared(item); prepared.delete(id); }
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
                if (denied) break;
            }
        } catch (error) { dropWork(); denied = true; report(error); }
    };
    const make = (band: 'underlay' | 'content'): PlatformLayerDefinition => ({
        id: `board-wet-${band}`, group: 'document',
        create(host) {
            if (disposed) throw new Error('Wet layer disposed');
            hosts.add(host); owner ??= host;
            let ended = false;
            const layer: Layer = {
                prepare,
                drawGpu() { throw new Error('Wet ink requires the Canvas2D board backend'); },
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
                releaseGpu(reason) { if (reason === 'hidden' || reason === 'pressure') clear(); },
                memory() { return { gpuBytes: 0, cpuBytes: host === owner ? reserved : 0 }; },
                needsFrame() { return !ended && !disposed && !denied && (dirty || !!work); },
                dispose() { if (ended) return; ended = true; if (owner === host) { clear(); owner = null; } hosts.delete(host); hostLayers.delete(host); owner ??= hosts.values().next().value ?? null; },
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
            const extra = pending ? (work ? (work.temp ? 0 : TEMP_BYTES) + PATH_BLOCK : TEMP_BYTES + PATH_BLOCK) : 0;
            return { mandatoryBytes: reserved + extra, prefetchBytes: 0 };
        },
        critical: () => (handover?.forFrame(identity => visuallyCovered(options.readyFrame(), identity, options.token)) ?? [])
            .some(item => !prepared.has(item.identity.gestureSequence)),
        coverage: () => {
            const missing = (handover?.forFrame(identity => visuallyCovered(options.readyFrame(), identity, options.token)) ?? [])
                .some(item => !prepared.has(item.identity.gestureSequence));
            return { complete: !missing, sharp: !missing };
        },
    });
    const layers = Object.freeze({ underlay: make('underlay'), content: make('content') });
    return {
        layers,
        attach(value) { if (disposed) throw new Error('Wet layer disposed'); handover = value; invalidate(); return () => { if (handover === value) { handover = null; clear(); invalidate(); } }; },
        onInputFrame(callback) { callbacks.add(callback); return () => { callbacks.delete(callback); }; },
        invalidate,
        consumeInput() { if (disposed || !options.current()) return; for (const callback of callbacks) callback(); },
        presented(revision, token, frame) {
            if (disposed || !sameToken(token, options.token) || !frame || frame.sceneRevision !== revision || !sameToken(frame.token, token)) return;
            for (const item of handover?.forFrame(() => false) ?? []) if (item.dry && available(frame, item.dry, token)) handover?.acknowledgePresented(item.dry);
            invalidate();
        },
        clear,
        dispose() { if (disposed) return; clear(); disposed = true; callbacks.clear(); handover = null; },
    };
}
