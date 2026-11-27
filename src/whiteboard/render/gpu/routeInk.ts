import type { Affine, ViewState } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { AreaOutput, ByteLease, GpuPass, RectI } from '../../../platform/render/gfx/api';
import { createAreaKit, type AreaAdmission, type AreaPart, type PreparedArea } from '../../../platform/render/areaCoverage';
import { ArenaError } from '../../../platform/render/resourceArena';
import type { InkCoverage } from '../../ink/outline';
import { unionOutline } from '../../ink/unionOutline';
import type { FrameBudget } from '../../../platform/render/types';
import { createPathCoverageKit, type PathCoverageAdmission, type PreparedPathCoverage } from '../../../platform/render/pathCoverage';
import { auditCount, renderAuditEnabled } from '../../../platform/render/renderAudit';
import { inkCoverageChunks, type PaintInkItem, type PaintItem } from '../paintStream';
import type { Rgba } from '../../../platform/types';
import { analyticCapsule } from '../analyticInk';
import { AnalyticInkRun, createAnalyticInkRuns } from '../analyticInkBatch';
import { createInkGeometry, inkToleranceBand } from '../inkGeometry';
import type { Admission, Blend, CreateInkRoutes, InkRouteFor, ItemRoute, PreparedRun } from './contracts';

export const inkRouteFor: InkRouteFor = (item: PaintInkItem) => analyticCapsule(item) ? 'ink-analytic' : 'ink-union';

type UnionEntry = { readonly kind: 'area'; readonly prepared: PreparedArea }
    | { readonly kind: 'grid'; readonly prepared: PreparedPathCoverage; readonly paint: { colour: Rgba } };
class UnionInkRun implements PreparedRun {
    readonly route = 'ink-union' as const;
    constructor(readonly blend: Blend, readonly entries: readonly UnionEntry[], readonly items: readonly PaintInkItem[], readonly inexact = false) {}
}

const AREA_FLATTEN_DEVICE_PX = 0.02;
const AREA_CACHE_BYTES = 8 * 2 ** 20;
interface InkArea { readonly band: number; readonly edges: Float32Array | null; readonly why: string | null;
    readonly origin: { readonly x: number; readonly y: number }; readonly box: { readonly x1: number; readonly y1: number };
    readonly bytes: number; readonly lease: ByteLease | null;
    used: number }

function strokeOutline(chunks: readonly InkCoverage[], tolerance: number): ReturnType<typeof unionOutline> {
    let segCount = 0, discCount = 0;
    for (const chunk of chunks) { segCount += chunk.segments.length; discCount += chunk.discs.length; }
    const segments = new Float64Array(segCount), discs = new Float64Array(discCount);
    const runStarts: number[] = [];
    let closed = false, rows = 0, so = 0, dO = 0, px = 0, py = 0, pr = -1;
    for (const chunk of chunks) {
        if (chunk.closed) closed = true;
        segments.set(chunk.segments, so); discs.set(chunk.discs, dO);
        const n = chunk.segments.length / 6;
        const continues = pr >= 0 && n > 0 && Math.abs(px - chunk.segments[0]) + Math.abs(py - chunk.segments[1]) <= 1e-9;
        for (let j = 0; j < chunk.segmentRunStarts.length; j++) if (!(j === 0 && continues)) runStarts.push(rows + chunk.segmentRunStarts[j]);
        if (n) { const last = chunk.segments.length - 6; px = chunk.segments[last + 3]; py = chunk.segments[last + 4]; pr = chunk.segments[last + 5]; }
        rows += n; so += chunk.segments.length; dO += chunk.discs.length;
    }
    return unionOutline(segments, discs, runStarts, closed, tolerance);
}

function pixels(view: ViewState): { width: number; height: number } {
    return { width: Math.round(view.viewport.width * view.viewport.dpr), height: Math.round(view.viewport.height * view.viewport.dpr) };
}
function affineAt(localToWorld: Affine, origin: Readonly<{ x: number; y: number }>, view: ViewState): Affine {
    const [a, b, c, d, e, f] = localToWorld;
    const s = view.camera.z * view.viewport.dpr;
    return [s * a, s * b, s * c, s * d, s * (a * origin.x + c * origin.y + e - view.camera.x), s * (b * origin.x + d * origin.y + f - view.camera.y)];
}

export const createInkRoutes: CreateInkRoutes = (host: LayerHost, audit: string) => {
    const runs = createAnalyticInkRuns(host, audit);
    const kit = createPathCoverageKit(host, () => auditCount(audit, 'error:coverage-kit'));
    const geometry = createInkGeometry(host.allocator.cpu, audit);

    const analytic: ItemRoute<PaintInkItem> = {
        id: 'ink-analytic',
        accepts: (item: PaintItem): item is PaintInkItem => item.kind === 'ink' && inkRouteFor(item) === 'ink-analytic',
        admit(items, view, blend, budget) {
            if (blend !== 'over') return { status: 'unsupported', why: 'analytic-multiply' };
            return runs.admit(items, view, budget);
        },
        draw(pass: GpuPass, run: PreparedRun): void {
            if (!(run instanceof AnalyticInkRun)) throw new Error('Not an analytic ink run');
            runs.draw(pass, run);
        },
        retire(run: PreparedRun): void { if (run instanceof AnalyticInkRun) runs.retire(run); },
        release(): void { runs.release(); },
        memory: () => runs.memory(),
    };

    const areaKit = createAreaKit();
    areaKit.warm(host);
    const areas = new Map<object, InkArea>();
    const previous = new Map<object, InkArea>();
    let areaBytes = 0, areaFrame = -1, areaPrevious = -1;
    const pinned = new Set<object>();
    const freeArea = (old: InkArea): number => {
        if (old.edges) areaKit.forget(old.edges);
        if (!old.lease) return 0;
        areaBytes -= old.bytes; host.allocator.cpu.release(old.lease);
        return old.bytes;
    };
    const dropArea = (key: object, old: InkArea): number => { areas.delete(key); return freeArea(old); };
    const dropPrevious = (key: object): number => {
        const old = previous.get(key);
        if (!old) return 0;
        previous.delete(key);
        return freeArea(old);
    };
    /** Drops the least recently used outlines no admission in progress holds. `keepRecent` (the size limit's trim) also keeps what this
     * frame or the route's previous one used: a deferred admission resumes next frame from the outlines it built, and dropped at the
     * limit they were built again, so a view whose outlines passed it rebuilt them every frame and its tile never finished (measured,
     * the 10,000-stroke old board after a zoom reset on WebGL2: ~105 outlines rebuilt and ~1,330 admitted per frame, at every vsync for
     * good). A refused CPU lease reclaims recent ones too: memory comes first, and the bytes kept are the pool's leases either way. */
    const reclaimAreas = (bytes: number, keepRecent = false): number => {
        let freed = 0;
        for (const key of [...previous.keys()]) { if (freed >= bytes) break; if (!pinned.has(key)) freed += dropPrevious(key); }
        for (const [key, old] of areas) {
            if (freed >= bytes) break;
            if (!pinned.has(key) && !(keepRecent && old.used >= areaPrevious)) freed += dropArea(key, old);
        }
        return freed;
    };
    const areaOf = (item: PaintInkItem, band: number, moving: boolean): InkArea | { refused: number } => {
        const key = item.coverage, cached = areas.get(key);
        if (cached && (cached.band === band || (moving && cached.band > band && cached.band <= band * 2))) {
            if (cached.band !== band) auditCount(audit, 'ink:area:band-held');
            areas.delete(key); areas.set(key, cached); pinned.add(key); cached.used = areaFrame; return cached;
        }
        if (cached) { areas.delete(key); dropPrevious(key); if (cached.edges?.length) previous.set(key, cached); else freeArea(cached); }
        const chunks = inkCoverageChunks(item.coverage);
        const outline = chunks.length ? strokeOutline(chunks, AREA_FLATTEN_DEVICE_PX / band) : { edges: new Float64Array(0), why: null };
        let area: InkArea;
        if (!outline.edges) area = { band, edges: null, why: outline.why, origin: { x: 0, y: 0 }, box: { x1: 0, y1: 0 }, bytes: 0, lease: null, used: areaFrame };
        else {
            const source = outline.edges;
            let ox = Infinity, oy = Infinity, mx = -Infinity, my = -Infinity;
            for (let i = 0; i < source.length; i += 2) {
                ox = Math.min(ox, source[i]); mx = Math.max(mx, source[i]); oy = Math.min(oy, source[i + 1]); my = Math.max(my, source[i + 1]);
            }
            const edges = new Float32Array(source.length);
            for (let i = 0; i < source.length; i += 2) { edges[i] = source[i] - ox; edges[i + 1] = source[i + 1] - oy; }
            const bytes = edges.byteLength, any = source.length > 0;
            let lease = bytes ? host.allocator.cpu.reserve(bytes) : null;
            if (bytes && !lease && reclaimAreas(bytes) > 0) lease = host.allocator.cpu.reserve(bytes);
            if (bytes && !lease) { auditCount(audit, 'ink:area:geom-refused'); return { refused: bytes }; }
            area = { band, edges, why: null, origin: any ? { x: ox, y: oy } : { x: 0, y: 0 }, box: any ? { x1: mx - ox, y1: my - oy } : { x1: 0, y1: 0 }, bytes, lease, used: areaFrame };
            areaBytes += bytes;
        }
        areas.set(key, area); pinned.add(key);
        auditCount(audit, 'ink:area:geom-build');
        if (areaBytes > AREA_CACHE_BYTES) reclaimAreas(areaBytes - AREA_CACHE_BYTES, true);
        return area;
    };
    const part: AreaPart[] = [{ edges: new Float32Array(0), affine: [1, 0, 0, 1, 0, 0] }];
    const admitOutline = (item: PaintInkItem, area: InkArea & { readonly edges: Float32Array }, view: ViewState, budget: FrameBudget): 'empty' | AreaAdmission => {
        const viewport = pixels(view);
        const [A, B, C, D, E, F] = affineAt(item.localToWorld, area.origin, view);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of [[0, 0], [area.box.x1, 0], [0, area.box.y1], [area.box.x1, area.box.y1]] as const) {
            const X = A * x + C * y + E, Y = B * x + D * y + F;
            if (X < minX) minX = X; if (X > maxX) maxX = X; if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
        }
        const x0 = Math.max(0, Math.floor(minX)), y0 = Math.max(0, Math.floor(minY));
        const x1 = Math.min(viewport.width, Math.ceil(maxX) + 1), y1 = Math.min(viewport.height, Math.ceil(maxY) + 1);
        if (!(x1 > x0 && y1 > y0)) return 'empty';
        const bounds: RectI = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        part[0] = { edges: area.edges, affine: [A, B, C, D, E - x0, F - y0] };
        return areaKit.admit(host, part, bounds, budget, viewport);
    };
    let heldBand = false;
    const admitArea = (item: PaintInkItem, view: ViewState, band: number, budget: FrameBudget):
        PreparedArea | 'grid' | 'empty' | Admission<PreparedRun> => {
        const area = areaOf(item, band, view.moving);
        if ('refused' in area) return { status: 'denied', pool: 'cpu', bytes: area.refused };
        if (!area.edges) { auditCount(audit, `ink:area:fallback:${area.why}`); return 'grid'; }
        if (!area.edges.length) return 'empty';
        let result = admitOutline(item, area as InkArea & { readonly edges: Float32Array }, view, budget);
        if (result === 'empty') return 'empty';
        if (result.status === 'deferred' && view.moving) {
            const old = previous.get(item.coverage);
            if (old?.edges?.length) {
                const held = admitOutline(item, old as InkArea & { readonly edges: Float32Array }, view, budget);
                if (held === 'empty') return 'empty';
                if (held.status === 'ready') { auditCount(audit, 'ink:area:band-stand-in'); heldBand = true; result = held; }
            }
        } else if (result.status === 'ready') dropPrevious(item.coverage);
        if (result.status === 'ready') { auditCount(audit, 'ink:area:exact'); return result.value; }
        if (result.status === 'empty') return 'empty';
        if (result.status === 'unsupported') { auditCount(audit, 'ink:area:fallback:unsupported'); return 'grid'; }
        if (result.status === 'denied') return { status: 'denied', pool: result.pool, bytes: result.bytes };
        return { status: 'deferred' };
    };
    const retireEntry = (entry: UnionEntry): void => { if (entry.kind === 'area') areaKit.retire(entry.prepared); else kit.retire(entry.prepared); };
    const areaOutput: { kind: 'area'; blend: AreaOutput['blend']; rgb: [number, number, number]; alpha: number } = { kind: 'area', blend: 'normal', rgb: [0, 0, 0], alpha: 1 };
    const one: PreparedArea[] = [];
    const beginFrame = (frame: number): void => {
        if (frame === areaFrame) return;
        areaPrevious = areaFrame; areaFrame = frame; kit.beginFrame(frame); areaKit.beginFrame(frame);
    };
    let areaRefusedFrame = -1;
    const areaRefused = (error: unknown): void => {
        if (!(error instanceof ArenaError) || error.code !== 'out-of-budget') throw error;
        areaRefusedFrame = areaFrame;
        auditCount(audit, 'ink:area:draw-refused');
        host.invalidate('ink-area-refused');
    };

    const pendingRuns = new Map<readonly PaintInkItem[], { readonly view: ViewState; readonly blend: Blend; readonly entries: UnionEntry[];
        readonly admittedItems: PaintInkItem[]; readonly next: number; readonly inexact: boolean }>();
    const abandon = (items: readonly PaintItem[]): void => {
        const pend = pendingRuns.get(items as readonly PaintInkItem[]);
        if (!pend) return;
        pendingRuns.delete(items as readonly PaintInkItem[]);
        for (const entry of pend.entries) retireEntry(entry);
    };
    const union: ItemRoute<PaintInkItem> & { drawRefusedThisFrame(): boolean; exact(run: PreparedRun): boolean } = {
        id: 'ink-union',
        abandon,
        exact: (run: PreparedRun): boolean => !(run instanceof UnionInkRun) || !run.inexact,
        drawRefusedThisFrame: (): boolean => kit.drawRefusedThisFrame() || areaRefusedFrame === areaFrame,
        accepts: (item: PaintItem): item is PaintInkItem => item.kind === 'ink' && inkRouteFor(item) === 'ink-union',
        admit(items, view, blend, budget): Admission<PreparedRun> {
            beginFrame(budget.frameId);
            // A run deferred part way resumes at the stroke it stopped at, with the strokes it had admitted (the same run: its items, view and
            // blend). Started over, a run whose strokes did not all fit one frame's upload allowance spent each frame re-admitting its first
            // strokes and never reached its last: a slow GPU's frames left one tile deferred at every vsync for good (measured, the
            // 5,642-stroke board zoomed to 1745% and back to fit with the GPU slowed: 'Updating…' for 90 s, 182 frames per 10 s).
            let resumed = pendingRuns.get(items);
            if (resumed) { pendingRuns.delete(items); if (resumed.view !== view || resumed.blend !== blend) { for (const entry of resumed.entries) retireEntry(entry); resumed = undefined; } }
            heldBand = resumed?.inexact ?? false;
            const modulate = blend === 'modulate';
            const entries: UnionEntry[] = resumed?.entries ?? [], admittedItems: PaintInkItem[] = resumed?.admittedItems ?? [];
            const retireAll = (): void => { for (const entry of entries) retireEntry(entry); };
            const deferAt = (next: number): Admission<PreparedRun> => {
                if (entries.length) pendingRuns.set(items, { view, blend, entries, admittedItems, next, inexact: heldBand });
                auditCount(audit, 'ink:union:deferred-at', 1);
                return { status: 'deferred' };
            };
            try {
                for (let index = resumed?.next ?? 0; index < items.length; index++) {
                    const item = items[index];
                    if (item.material.blend !== (modulate ? 'multiply' : 'normal')) { retireAll(); return { status: 'unsupported', why: 'blend-mismatch' }; }
                    const [a, b, c, d] = item.localToWorld;
                    const deviceScale = view.camera.z * view.viewport.dpr * Math.hypot(a, b, c, d);
                    if (!(deviceScale > 0) || !Number.isFinite(deviceScale)) { retireAll(); return { status: 'unsupported', why: 'scale' }; }
                    const band = inkToleranceBand(deviceScale);
                    const timed = renderAuditEnabled() ? performance.now() : 0;
                    const area = admitArea(item, view, band, budget);
                    if (timed) { auditCount(audit, 'ink:area-calls'); auditCount(audit, 'ink:area-hundredths-ms', Math.round((performance.now() - timed) * 100)); }
                    if (area === 'empty') continue;
                    if (area !== 'grid') {
                        if ('status' in area) { if (area.status === 'deferred') return deferAt(index); retireAll(); return area; }
                        entries.push({ kind: 'area', prepared: area }); admittedItems.push(item);
                        continue;
                    }
                    const started = renderAuditEnabled() ? performance.now() : 0;
                    const stroke = geometry.strokeSets(item, band);
                    if (started) { auditCount(audit, 'ink:strokesets-calls'); auditCount(audit, 'ink:strokesets-hundredths-ms', Math.round((performance.now() - started) * 100)); }
                    if (stroke && 'denied' in stroke) { retireAll(); return { status: 'denied', pool: 'cpu', bytes: stroke.denied }; }
                    if (!stroke) { retireAll(); return { status: 'unsupported', why: 'outline-refused' }; }
                    const result: PathCoverageAdmission = kit.admitSets({
                        sets: stroke.shapes, rule: 'union', affine: affineAt(item.localToWorld, stroke.origin, view), viewport: pixels(view),
                        colour: item.material.color, output: { kind: 'composite', blend: modulate ? 'modulate' : 'normal' },
                        sampling: 'grid4',
                    }, budget);
                    if (result.status === 'ready') { entries.push({ kind: 'grid', prepared: result.value, paint: { colour: item.material.color } }); admittedItems.push(item); }
                    else if (result.status === 'deferred') return deferAt(index);
                    else if (result.status !== 'empty') {
                        retireAll();
                        if (result.status === 'denied') {
                            let bytes = 0;
                            for (const set of stroke.sets) bytes += set.triangles.length * 4;
                            return { status: 'denied', pool: 'gpu', bytes };
                        }
                        return { status: 'unsupported', why: 'coverage-kit' };
                    }
                }
            } finally { pinned.clear(); }
            if (!entries.length) return { status: 'empty' };
            return { status: 'ready', value: new UnionInkRun(blend, entries, admittedItems, heldBand) };
        },
        draw(pass: GpuPass, run: PreparedRun): void {
            if (!(run instanceof UnionInkRun)) throw new Error('Not a union ink run');
            const entries = run.entries, n = entries.length;
            areaOutput.blend = run.blend === 'modulate' ? 'modulate' : 'normal';
            let i = 0;
            while (i < n) {
                let j = i;
                areaKit.beginBatch(host);
                try {
                    for (; j < n; j++) {
                        const entry = entries[j];
                        if (entry.kind !== 'area') continue;
                        one[0] = entry.prepared;
                        if (!areaKit.place(host, pass, one)) break;
                    }
                } catch (error) {
                    areaRefused(error);
                    j = n;
                } finally { areaKit.endBatch(pass); }
                if (j === i) j = i + 1;
                for (let k = i; k < j; k++) {
                    const entry = entries[k], colour = run.items[k].material.color;
                    if (entry.kind === 'area') {
                        areaOutput.rgb[0] = colour[0]; areaOutput.rgb[1] = colour[1]; areaOutput.rgb[2] = colour[2]; areaOutput.alpha = colour[3];
                        try { if (!areaKit.composite(pass, entry.prepared, areaOutput)) { areaRefusedFrame = areaFrame; auditCount(audit, 'ink:area:not-placed'); } }
                        catch (error) { areaRefused(error); }
                    } else { entry.paint.colour = colour; kit.draw(pass, entry.prepared, entry.paint); }
                }
                i = j;
            }
        },
        retire(run: PreparedRun): void {
            if (run instanceof UnionInkRun) for (const entry of run.entries) retireEntry(entry);
        },
        release(): void {
            for (const items of [...pendingRuns.keys()]) abandon(items);
            kit.release(); geometry.release();
            for (const key of [...previous.keys()]) dropPrevious(key);
            for (const [key, old] of [...areas]) dropArea(key, old);
            areaKit.release();
        },
        memory: () => {
            const kitBytes = kit.memory();
            return { gpuBytes: kitBytes.gpuBytes + areaKit.memory().gpuBytes, cpuBytes: geometry.memory().cpuBytes + kitBytes.cpuBytes + areaBytes };
        },
    };

    const evictGpu = (bytes: number, keepRecent = false): number => {
        const freed = kit.evict(bytes);
        return freed < bytes ? freed + areaKit.evictIdle(bytes - freed, keepRecent) : freed;
    };
    return { analytic, union, beginFrame, evictGpu, evictCpu: (bytes, keep) => { const freed = geometry.evictIdle(bytes, keep); return freed < bytes ? freed + reclaimAreas(bytes - freed) : freed; } };
};
