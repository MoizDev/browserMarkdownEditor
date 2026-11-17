import type { PageGeometry, Rect, ViewState } from '../../platform/types';
import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import type { CompositorBackend, LayerCoverage, LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease, GpuPass } from '../../platform/render/gfx/api';
import { pageAt, type PageStack } from '../../platform/render/pageStack';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { FrameBudget, FrameToken, GpuReleaseReason, Layer, OffscreenPasses } from '../../platform/render/types';
import { boardPageStack } from '../model/pages';
import type { HostBlock } from '../model/doc';
import type { PaintPalette } from '../render/colour';
import type { PaintFrame, PaintPathItem } from '../render/paintStream';
import type { PaintBand } from '../render/material';
import { awaitCapacity, isBudgetRefusal } from '../render/budgetRefusal';
import { createGpuPaintAdapter } from '../render/gpuPaintAdapter';
import { preparedOfFrame, type CanvasPaintAdapter, type PreparedPaint2d } from '../render/reference/canvasPaintAdapter';
import { Path2dJob } from '../render/reference/coverage2d';
import { paintItem2d, type PaintResources2d, type PreparedPath2d } from '../render/reference/paint2d';
import { notebookBackdrop } from './notebookBackdrop';

/** The composer's offscreen encode (PLAN §3.3, wave 2). Today's adapter has none, so the layer's call is guarded: a no-op. */
type OffscreenEncoder = { encodeOffscreen?(passes: OffscreenPasses, view: ViewState, band: PaintBand): void };
export type NotebookHost = Extract<HostBlock, { kind: 'notebook' }>;
export interface NotebookPaperSnapshot {
    /** Changes whenever paper properties or page geometry change. */
    readonly revision: number;
    readonly host: Readonly<NotebookHost>;
    readonly pages: readonly PageGeometry[];
}
/** A page's identity while it is drawn: its rect, so a page that moved or resized is not yet drawn. */
const pageKey = (rect: Readonly<Rect>): string => `${rect.x},${rect.y},${rect.width},${rect.height}`;
export interface NotebookPaperLayerOptions {
    /** Return the same immutable snapshot until its revision changes. */
    readonly read: () => NotebookPaperSnapshot;
    readonly palette: () => PaintPalette;
    readonly onError: (error: unknown) => void;
}
type Prepared = { readonly item: PaintPathItem; readonly path: PreparedPath2d };
type Ready = { readonly revision: number; readonly stack: Readonly<PageStack>; readonly items: readonly Prepared[];
    readonly lease: ByteLease; token: FrameToken };
type Staging = { readonly snapshot: NotebookPaperSnapshot; readonly stack: Readonly<PageStack>; readonly lease: ByteLease;
    readonly items: Prepared[]; token: FrameToken; page: number; iterator: Generator<PaintPathItem> | null;
    job: { item: PaintPathItem; path: Path2dJob } | null };
function sameToken(a: FrameToken, b: FrameToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration
        && a.session === b.session && a.viewLease === b.viewLease && a.deviceGeneration === b.deviceGeneration;
}
function checkSnapshot(snapshot: NotebookPaperSnapshot): void {
    const paper = snapshot.host.paper;
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || snapshot.host.kind !== 'notebook'
        || !Number.isSafeInteger(paper.pageCount) || paper.pageCount < 1 || paper.pageCount > 500
        || snapshot.pages.length !== paper.pageCount || !Number.isFinite(paper.spacing) || paper.spacing < 8 || paper.spacing > 200
        || !['blank', 'lined', 'grid', 'dotted'].includes(paper.ruling)) throw new RangeError('Invalid notebook paper snapshot');
}
function workingBytes(snapshot: NotebookPaperSnapshot, stack: Readonly<PageStack>): number {
    const paper = snapshot.host.paper, box = stack.rects[0];
    if (!box) throw new RangeError('Notebook has no paper geometry');
    // Upper bound only, not another ruling algorithm: the shared paper generator
    // remains the authority for every actual line/dot coordinate and colour.
    const rows = Math.ceil(box.height / paper.spacing) + 2, columns = Math.ceil(box.width / paper.spacing) + 2;
    const commands = paper.ruling === 'dotted' ? rows * columns * 6 + 16
        : paper.ruling === 'grid' ? 2 * (rows + columns) + 16 : paper.ruling === 'lined' ? 2 * rows + 16 : 16;
    const bytes = commands * 80;
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Notebook paper working set overflows');
    return bytes;
}

class NotebookPaperLayer implements Layer {
    private ready: Ready | null = null;
    private staged: Staging | null = null;
    private desired: NotebookPaperSnapshot | null = null;
    private denied = false;
    private failedRevision: number | null = null;
    private disposed = false;
    private readonly paths = new WeakMap<PaintPathItem, PreparedPath2d>();
    private readonly resources: PaintResources2d = {
        path: item => { const path = this.paths.get(item as PaintPathItem); if (!path) throw new Error('Notebook paper path unavailable'); return path; },
        clip: () => { throw new Error('Notebook paper has no independent clips'); },
        image: () => { throw new Error('Notebook paper has no image resources'); },
    };
    private gpuPrepared: PreparedPaint2d | null = null;
    private gpuSource: { ready: Ready; first: number; last: number; token: FrameToken } | null = null;
    /** Pages whose paper has been drawn at least once since the GPU route was last released: the pages a board may claim opaque. */
    private readonly drawn = new Set<string>();
    private readonly gpuReference: CanvasPaintAdapter = {
        prepare: () => {}, readyFrame: () => this.gpuPrepared?.sourceFrame ?? null,
        borrowPrepared: () => this.gpuPrepared, retainPrepared: () => null, draw2d: () => {}, release: () => {},
        needsFrame: () => false, memory: () => ({ gpuBytes: 0, cpuBytes: 0 }), dispose: () => {},
    };
    private readonly gpu: ReturnType<typeof createGpuPaintAdapter>;
    constructor(private readonly host: LayerHost, private readonly options: NotebookPaperLayerOptions) {
        // The paper's own opaque world: its page rects, which the paper fills (notebookPaper.ts), exact for an inverted view.
        const gpuOptions = { audit: 'notebook-paper', opaqueWorld: () => this.drawnRects() };
        this.gpu = createGpuPaintAdapter(this.gpuReference, host, error => this.report(error), gpuOptions);
    }
    private report(error: unknown): void {
        if (isBudgetRefusal(error)) {
            this.denied = true;
            awaitCapacity(this.host, () => { this.denied = false; this.host.invalidate('notebook-paper-capacity'); });
            return;
        }
        try { this.options.onError(error); } catch { /* errors do not escape the layer scheduler */ }
    }
    private dropStaged(): void {
        const old = this.staged; this.staged = null;
        if (!old) return;
        try { old.job?.path.cancel(); old.iterator?.return(undefined); }
        finally { this.host.allocator.cpu.release(old.lease); }
    }
    private dropReady(): void {
        const old = this.ready; this.ready = null;
        if (old) this.host.allocator.cpu.release(old.lease);
    }
    private snapshot(): NotebookPaperSnapshot {
        const value = this.options.read(); checkSnapshot(value); return value;
    }
    private preparePaper(budget: FrameBudget): void {
        if (this.disposed) return;
        let attemptedRevision: number | null = null;
        try {
            const snapshot = this.options.read(); attemptedRevision = snapshot.revision; checkSnapshot(snapshot);
            if (this.desired?.revision !== snapshot.revision) {
                this.dropStaged(); this.desired = snapshot; this.denied = false; this.failedRevision = null;
            }
            if (this.ready?.revision === snapshot.revision) {
                this.ready.token = { ...budget.token }; return;
            }
            if (Object.is(this.failedRevision, snapshot.revision)) return;
            if (this.staged && !sameToken(this.staged.token, budget.token)) this.dropStaged();
            if (!this.staged) {
                const stack = boardPageStack(snapshot.host);
                if (!stack || stack.rects.length !== snapshot.pages.length) throw new RangeError('Invalid notebook page stack');
                const lease = this.host.allocator.cpu.reserve(workingBytes(snapshot, stack));
                if (!lease) { this.denied = true; return; }
                this.denied = false;
                this.staged = { snapshot, stack, lease, token: { ...budget.token }, items: [], page: 0, iterator: null, job: null };
            }
            const stage = this.staged;
            while (!budget.shouldYield()) {
                if (this.options.read().revision !== stage.snapshot.revision) { this.dropStaged(); return; }
                if (stage.page < stage.snapshot.pages.length) {
                    const index = stage.page++, page = stage.snapshot.pages[index], box = stage.stack.rects[index];
                    if (page.index !== index || page.width !== box.width || page.height !== box.height || page.rotate !== 0) {
                        throw new RangeError('Notebook page geometry does not match the canonical stack');
                    }
                    continue;
                }
                if (!stage.iterator) {
                    const box = stage.stack.rects[0];
                    stage.iterator = notebookBackdrop(stage.snapshot.host.paper, 0, { x: 0, y: 0, width: box.width, height: box.height });
                }
                if (stage.job) {
                    if (stage.job.path.step(1) === 'complete') {
                        const path = stage.job.path.result;
                        if (!path) throw new Error('Notebook paper path cancelled');
                        const prepared = { path, origin: stage.job.path.origin };
                        this.paths.set(stage.job.item, prepared); stage.items.push({ item: stage.job.item, path: prepared }); stage.job = null;
                    }
                    continue;
                }
                const next = stage.iterator.next();
                if (!next.done) { stage.job = { item: next.value, path: new Path2dJob(next.value.d) }; continue; }
                if (this.options.read().revision !== stage.snapshot.revision) { this.dropStaged(); return; }
                this.dropReady();
                this.ready = { revision: stage.snapshot.revision, stack: stage.stack, items: Object.freeze(stage.items), lease: stage.lease, token: stage.token };
                this.staged = null; this.host.invalidate('notebook-paper-ready'); return;
            }
        } catch (error) {
            this.failedRevision = attemptedRevision ?? this.desired?.revision ?? null;
            try { this.dropStaged(); } catch (cleanup) { this.report(cleanup); }
            this.report(error);
        }
    }
    prepare(view: ViewState, budget: FrameBudget): void {
        this.preparePaper(budget);
        if (this.disposed || !this.host.device()) return;
        try {
            this.prepareGpuSource(view, budget.token);
            this.gpu.prepare(view, budget);
        } catch (error) { this.report(error); }
    }
    private prepareGpuSource(view: ViewState, token: FrameToken): void {
        const ready = this.ready;
        if (!ready || !sameToken(ready.token, token) || !Number.isFinite(view.camera.z) || view.camera.z <= 0) {
            this.gpuPrepared = null; this.gpuSource = null; return;
        }
        const first = pageAt(ready.stack, view.camera.y);
        const last = pageAt(ready.stack, view.camera.y + view.viewport.height / view.camera.z);
        const previous = this.gpuSource;
        if (previous && previous.ready === ready && previous.first === first && previous.last === last && sameToken(previous.token, token)) return;
        const paths = new WeakMap<PaintPathItem, PreparedPath2d>();
        const clips = new Map<string, PreparedPath2d>();
        const items: PaintPathItem[] = [];
        for (let page = first; page <= last; page++) {
            const box = ready.stack.rects[page];
            const clipKey = `notebook-page/${page}/${box.x}/${box.y}/${box.width}/${box.height}`;
            const d: PaintPathItem['d'] = [['M', 0, 0], ['L', box.width, 0], ['L', box.width, box.height], ['L', 0, box.height], ['Z']];
            const clipPath = new Path2D(); clipPath.rect(0, 0, box.width, box.height);
            clips.set(clipKey, { path: clipPath, origin: [0, 0] });
            for (const source of ready.items) {
                const [a, b, c, d0, e, f] = source.item.localToWorld;
                const item: PaintPathItem = { ...source.item, key: `${source.item.key}/page/${page}`,
                    nodeId: `paper/${page}`, localToWorld: [a, b, c, d0, e + box.x, f + box.y],
                    clips: [...source.item.clips, { key: clipKey, d, fillRule: 'nonzero', localToWorld: [1, 0, 0, 1, box.x, box.y] }] };
                paths.set(item, source.path); items.push(item);
            }
        }
        const frame: PaintFrame = { token: { vaultEpoch: token.vaultEpoch, documentId: token.documentId,
            bytesGeneration: token.bytesGeneration, session: token.session }, sceneRevision: ready.revision,
        inkNodeIds: new Set(), underlay: [], content: items };
        this.gpuPrepared = preparedOfFrame(frame, {
            path: item => { const path = paths.get(item as PaintPathItem); if (!path) throw new Error('Notebook GPU path unavailable'); return path; },
            clip: key => { const clip = clips.get(key); if (!clip) throw new Error('Notebook GPU clip unavailable'); return clip; },
            image: () => { throw new Error('Notebook paper has no image resources'); },
        });
        this.gpuSource = { ready, first, last, token: { ...token } };
    }
    drawGpu(pass: GpuPass, view: ViewState): void {
        this.gpu.drawGpu(pass, view, 'content');
        // Drawn only when the adapter's ready tiles are the ones prepared for this paper (the coverage test below).
        const source = this.gpuSource;
        if (source && this.gpuPrepared && this.gpu.readyPaint() === this.gpuPrepared) {
            for (let page = source.first; page <= source.last; page++) this.drawn.add(pageKey(source.ready.stack.rects[page]));
        }
    }
    /** The current pages whose paper has been drawn at least once: the only pages a board may claim opaque (C1 readiness). */
    drawnRects(): readonly Rect[] {
        if (this.disposed || !this.ready) return [];
        return this.ready.stack.rects.filter(rect => this.drawn.has(pageKey(rect)));
    }
    /** Forwards the composer's offscreen encode; a no-op until the adapter has one (PLAN §3.3, wave 2). */
    encodeOffscreen(passes: OffscreenPasses, view: ViewState): void {
        const encoder = this.gpu as OffscreenEncoder;
        if (!this.disposed && typeof encoder.encodeOffscreen === 'function') encoder.encodeOffscreen(passes, view, 'content');
    }
    draw2d(ctx: CanvasRenderingContext2D, view: ViewState): void {
        const ready = this.ready;
        if (!ready || this.disposed) return;
        const { stack } = ready;
        if (!stack.rects.length || !Number.isFinite(view.camera.z) || view.camera.z <= 0) return;
        const viewport: Rect = { x: view.camera.x, y: view.camera.y,
            width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z };
        const first = pageAt(stack, viewport.y), last = pageAt(stack, viewport.y + viewport.height);
        this.host.paintWorld(ctx, view, () => {
            for (let i = first; i <= last; i++) {
                const box = stack.rects[i];
                if (box.x + box.width < viewport.x || box.x > viewport.x + viewport.width
                    || box.y + box.height < viewport.y || box.y > viewport.y + viewport.height) continue;
                ctx.save();
                try {
                    ctx.translate(box.x, box.y); ctx.beginPath(); ctx.rect(0, 0, box.width, box.height); ctx.clip();
                    for (const item of ready.items) paintItem2d(ctx, item.item, this.resources);
                } finally { ctx.restore(); }
                this.drawn.add(pageKey(box));
            }
        });
    }
    releaseGpu(reason: GpuReleaseReason): void {
        this.gpu.release(reason); this.gpuPrepared = null; this.gpuSource = null; this.drawn.clear();
        // Pressure takes GPU memory only. The CPU paths stay: dropping them made every pressure release a
        // full rebuild (measured: 788 rebuilds in one notebook stroke), and the rebuild asked for the same tiles again.
        if (reason === 'pressure') return;
        try { this.dropStaged(); } catch (error) { this.report(error); }
        try { this.dropReady(); } catch (error) { this.report(error); }
        this.desired = null; this.denied = false; this.failedRevision = null;
    }
    memory(): { gpuBytes: number; cpuBytes: number } {
        const gpu = this.gpu.memory();
        return { gpuBytes: gpu.gpuBytes, cpuBytes: gpu.cpuBytes + (this.ready?.lease.bytes ?? 0) + (this.staged?.lease.bytes ?? 0) };
    }
    needsFrame(): boolean {
        if (this.disposed || this.denied) return false;
        const revision = this.options.read().revision;
        return !Object.is(this.failedRevision, revision) && (this.staged !== null || this.ready?.revision !== revision ||
            (!!this.host.device() && !!this.gpuPrepared && this.gpu.needsFrame()));
    }
    dispose(): void { if (!this.disposed) { this.disposed = true; this.releaseGpu('hidden'); this.gpu.dispose(); } }
    currentRevision(): number { return this.snapshot().revision; }
    demand(): number {
        const snapshot = this.snapshot(), stack = boardPageStack(snapshot.host);
        if (!stack) throw new RangeError('Notebook page stack unavailable');
        return this.memory().cpuBytes + (this.host.device() ? this.gpu.cpuWorkingSet().mandatoryBytes : 0) +
            (this.ready?.revision === snapshot.revision || this.staged?.snapshot.revision === snapshot.revision ? 0 : workingBytes(snapshot, stack));
    }
    critical(): boolean { return !this.ready; }
    coverage(frame: ScheduledFrame, layer: Layer, backend: CompositorBackend): LayerCoverage {
        const ready = this.ready, requested = frame.layers.find(entry => entry.layer === layer)?.sceneRevision;
        if (!ready || !sameToken(ready.token, frame.token)) return { complete: false, sharp: false };
        const current = ready.revision === requested && ready.revision === this.options.read().revision;
        if (!current) return { complete: false, sharp: false, staleVersion: true };
        if (backend === 'canvas2d') return { complete: true, sharp: true };
        if (this.gpu.readyPaint() !== this.gpuPrepared) return { complete: false, sharp: false, staleVersion: true };
        return this.gpu.coverage(frame.view);
    }
}

/** The paper's definition, with the pages it has drawn (the board's opaque claim, C1). */
export interface NotebookPaperDefinition extends PlatformLayerDefinition {
    /** The current pages whose paper has been drawn at least once; none until this paper's layer exists. */
    drawnRects(): readonly Rect[];
}
/** Page/paper colour stays print-light, independently of the shell's palette. */
export function createNotebookPaperLayer(options: NotebookPaperLayerOptions): NotebookPaperDefinition {
    let live: NotebookPaperLayer | null = null;
    return {
        id: 'notebook-paper', group: 'document',
        create: host => { live = new NotebookPaperLayer(host, options); return live; },
        drawnRects: () => live?.drawnRects() ?? [],
        revision: layer => (layer as NotebookPaperLayer).currentRevision(),
        cpuWorkingSet: layer => ({ mandatoryBytes: (layer as NotebookPaperLayer).demand(), prefetchBytes: 0 }),
        critical: layer => (layer as NotebookPaperLayer).critical(),
        coverage: (layer, frame, backend) => (layer as NotebookPaperLayer).coverage(frame, layer, backend),
    };
}
