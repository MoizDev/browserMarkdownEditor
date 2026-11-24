import type { PageGeometry, Rect, ViewState } from '../../platform/types';
import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import type { CompositorBackend, LayerCoverage, LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease, GpuPass } from '../../platform/render/gfx/api';
import { pageAt, type PageStack } from '../../platform/render/pageStack';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { FrameBudget, FrameToken, GpuReleaseReason, Layer, OffscreenPasses } from '../../platform/render/types';
import { auditCount, auditDrawn } from '../../platform/render/renderAudit';
import { boardPageStack } from '../model/pages';
import type { HostBlock } from '../model/doc';
import type { PaintPalette } from '../render/colour';
import type { PaintFrame, PaintPathItem } from '../render/paintStream';
import type { PaintBand } from '../render/material';
import { awaitSizedCapacity, isBudgetRefusal, type SizedCapacityWait } from '../render/budgetRefusal';
import { withFirstUnit } from '../render/firstUnit';
import { createGpuPaintAdapter } from '../render/gpuPaintAdapter';
import { preparedOfFrame, type CanvasPaintAdapter, type PreparedPaint2d } from '../render/reference/canvasPaintAdapter';
import { Path2dJob } from '../render/reference/coverage2d';
import { paintItem2d, type PaintResources2d, type PreparedPath2d } from '../render/reference/paint2d';
import { notebookBackdrop } from './notebookBackdrop';
import { createProceduralPaper, type ProceduralPaper } from './proceduralPaper';
import { FULL_REGION_CHANGES, type RegionChanges } from '../scene/boundsVersions';

/** The composer's offscreen encode (PLAN §3.3, wave 2). Today's adapter has none, so the layer's call is guarded: a no-op. */
type OffscreenEncoder = { encodeOffscreen?(passes: OffscreenPasses, view: ViewState, band: PaintBand): void; offscreenSettled?(submitted: boolean): void };
/** The adapter's GPU eviction (h2); typeof-guarded until impl/gpu's `Layer.evictGpu` lands on this branch. */
type GpuEvicting = { evictGpu?(bytes: number, frameId: number): number };
type GpuProtecting = { protectFrame?(frameId: number, view: ViewState): void };
export type NotebookHost = Extract<HostBlock, { kind: 'notebook' }>;
export interface NotebookPaperSnapshot {
    /** Changes whenever paper properties or page geometry change. */
    readonly revision: number;
    readonly host: Readonly<NotebookHost>;
    readonly pages: readonly PageGeometry[];
}
const NO_RECTS: readonly Rect[] = Object.freeze([]);
const NO_CHANGES: RegionChanges = Object.freeze({ full: false, regions: NO_RECTS });
/** Path commands appended per staging step. One command per step put a budget check between every two commands, and a frame
 * whose budget is spent admits one step (withFirstUnit): a dotted template of thousands of commands then took thousands of frames
 * under saturated input. A Path2D append is a few tens of nanoseconds, so a step of this many stays well under a millisecond. */
const PATH_STEP = 256;
/** Whether two papers draw the same page template: everything the template depends on but the page count (notebookBackdrop). */
function sameTemplate(a: Readonly<NotebookHost['paper']>, b: Readonly<NotebookHost['paper']>): boolean {
    return a.size === b.size && a.orientation === b.orientation && a.ruling === b.ruling && a.spacing === b.spacing && a.margin === b.margin;
}
/** Pages a paper keeps items for before it is replaced: by reading, a dotted page is about a thousand items, so this bounds a scroll. */
const PAGE_CACHE_LIMIT = 48;
/** A page's GPU paint: the template's items moved to the page, each clipped to it. Built once per ready paper. */
type PagePaint = { readonly items: readonly PaintPathItem[] };
type GpuPaper = { readonly ready: Ready; fresh: boolean; readonly pages: Map<number, PagePaint>;
    readonly paths: WeakMap<PaintPathItem, PreparedPath2d>; readonly clips: Map<string, PreparedPath2d>; readonly resources: PaintResources2d };
export interface NotebookPaperLayerOptions {
    /** Return the same immutable snapshot until its revision changes. */
    readonly read: () => NotebookPaperSnapshot;
    readonly palette: () => PaintPalette;
    readonly onError: (error: unknown) => void;
}
type Prepared = { readonly item: PaintPathItem; readonly path: PreparedPath2d };
type Ready = { readonly revision: number; readonly paper: Readonly<NotebookHost['paper']>; readonly stack: Readonly<PageStack>;
    readonly items: readonly Prepared[]; readonly lease: ByteLease; token: FrameToken };
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

function checkPage(snapshot: NotebookPaperSnapshot, stack: Readonly<PageStack>, index: number): void {
    const page = snapshot.pages[index], box = stack.rects[index];
    if (page.index !== index || page.width !== box.width || page.height !== box.height || page.rotate !== 0) {
        throw new RangeError('Notebook page geometry does not match the canonical stack');
    }
}
/** A page's paint, built on first use. Its items are the paper's template moved to the page, with the page's clip. */
function paperPage(paper: GpuPaper, page: number): PagePaint {
    const known = paper.pages.get(page);
    if (known) return known;
    const box = paper.ready.stack.rects[page];
    const clipKey = `notebook-page/${page}/${box.x}/${box.y}/${box.width}/${box.height}`;
    const d: PaintPathItem['d'] = [['M', 0, 0], ['L', box.width, 0], ['L', box.width, box.height], ['L', 0, box.height], ['Z']];
    const clipPath = new Path2D(); clipPath.rect(0, 0, box.width, box.height);
    paper.clips.set(clipKey, { path: clipPath, origin: [0, 0] });
    const items = paper.ready.items.map(source => {
        const [a, b, c, d0, e, f] = source.item.localToWorld;
        const item: PaintPathItem = { ...source.item, key: `${source.item.key}/page/${page}`,
            nodeId: `paper/${page}`, localToWorld: [a, b, c, d0, e + box.x, f + box.y],
            clips: [...source.item.clips, { key: clipKey, d, fillRule: 'nonzero', localToWorld: [1, 0, 0, 1, box.x, box.y] }] };
        paper.paths.set(item, source.path);
        return item;
    });
    const built: PagePaint = { items: Object.freeze(items) };
    paper.pages.set(page, built);
    return built;
}
/** The revision a frame asks this layer for; a loop, since this runs every frame and `find` would allocate a closure. */
function requestedRevision(frame: ScheduledFrame, layer: Layer): number | undefined {
    for (const entry of frame.layers) if (entry.layer === layer) return entry.sceneRevision;
    return undefined;
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
    private gpuSource: { ready: Ready; first: number; last: number; padFirst: number; padLast: number; token: FrameToken } | null = null;
    private gpuPaper: GpuPaper | null = null;
    private gpuGeneration = 0;
    /** Stack rects whose paper has been drawn at least once since the GPU route was last released: the pages a board may
     * claim opaque. By identity: a layout change makes new rect objects, so the claim resets with the layout. */
    private drawn = new WeakSet<Rect>();
    /** Whether any page has been drawn since the GPU route was last released. Unlike `drawn` (this revision's rects), it
     * survives a new revision: the previous pictures are what stands in while the new ones compose. */
    private drawnOnce = false;
    /** What the last canvas2d draw drew from: the ready paper, the view and the revision the paper read (see prepare). */
    private drawn2d: { ready: Ready | null; x: number; y: number; z: number; w: number; h: number; dpr: number; revision: number } | null = null;
    private claim: { readonly ready: Ready; readonly rects: readonly Rect[] } | null = null;
    private readonly gpuReference: CanvasPaintAdapter = {
        prepare: () => {}, readyFrame: () => this.gpuPrepared?.sourceFrame ?? null,
        borrowPrepared: () => this.gpuPrepared, retainPrepared: () => null, draw2d: () => {}, drawable2d: () => false,
        reacquireReleased: () => 0, release: () => {},
        needsFrame: () => false, memory: () => ({ gpuBytes: 0, cpuBytes: 0 }), dispose: () => {},
    };
    private readonly gpu: ReturnType<typeof createGpuPaintAdapter>;
    /** Lined, grid and blank paper on the GPU: one procedural pass per frame instead of composed tiles (proceduralPaper.ts). */
    private readonly procedural: ProceduralPaper;
    private proceduralOn = false;
    /** What the last procedural picture was drawn for: the same view and paper is the same picture. */
    private proceduralKey: { ready: Ready; x: number; y: number; z: number; w: number; h: number; dpr: number } | null = null;
    constructor(private readonly host: LayerHost, private readonly options: NotebookPaperLayerOptions) {
        this.procedural = createProceduralPaper(host);
        // The paper's own opaque world: its page rects, which the paper fills (notebookPaper.ts), exact for an inverted view.
        // The paper's lines draw the same pixels live and from tiles (measured: its settle-to-tile switch presented identical pictures,
        // 19 a zoom phase), so its composer goes back to its tiles at rest without drawing the paper live through a drag or a stroke.
        const gpuOptions = { audit: 'notebook-paper', opaqueWorld: () => this.drawnPageRects(), liveMatchesTiles: true };
        this.gpu = createGpuPaintAdapter(this.gpuReference, host, error => this.report(error), gpuOptions);
    }
    /** The paper's CPU working set for its current snapshot: the size a refused staging waits for. */
    private workingWait(): SizedCapacityWait | undefined {
        const snapshot = this.desired, stack = snapshot && boardPageStack(snapshot.host);
        return snapshot && stack ? { pool: 'cpu', bytes: workingBytes(snapshot, stack) } : undefined;
    }
    /** A refusal waits once, sized, and wakes the layer when it fits. Without a size a refusal is an error, not a silent wait. */
    private deny(wait: SizedCapacityWait): void {
        // needsFrame is false while denied and prepare can run again each frame: one waiter per denial, or they pile up.
        if (this.denied) return;
        this.denied = true;
        awaitSizedCapacity(this.host, () => { this.denied = false; this.host.invalidate('notebook-paper-capacity'); }, wait);
    }
    private report(error: unknown, wait: SizedCapacityWait | undefined = this.workingWait()): void {
        if (isBudgetRefusal(error) && wait) { this.deny(wait); return; }
        // A device-path error belongs to the pane's GPU error channel; budget refusals and canvas2d keep onError.
        try { if (this.host.device() && !isBudgetRefusal(error)) this.host.reportGpuError(error); else this.options.onError(error); }
        catch { /* errors do not escape the layer scheduler */ }
    }
    private dropStaged(): void {
        const old = this.staged; this.staged = null;
        if (!old) return;
        try { old.job?.path.cancel(); old.iterator?.return(undefined); }
        finally { this.host.allocator.cpu.release(old.lease); }
    }
    private dropReady(): void {
        const old = this.ready; this.ready = null; this.gpuPaper = null;
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
                this.adoptPageCount(snapshot);
            }
            if (this.ready?.revision === snapshot.revision) {
                if (!sameToken(this.ready.token, budget.token)) this.ready.token = { ...budget.token };
                return;
            }
            if (Object.is(this.failedRevision, snapshot.revision)) return;
            if (this.staged && !sameToken(this.staged.token, budget.token)) this.dropStaged();
            if (!this.staged) {
                const stack = boardPageStack(snapshot.host);
                if (!stack || stack.rects.length !== snapshot.pages.length) throw new RangeError('Invalid notebook page stack');
                const lease = this.host.allocator.cpu.reserve(workingBytes(snapshot, stack));
                if (!lease) { this.deny({ pool: 'cpu', bytes: workingBytes(snapshot, stack) }); return; }
                this.denied = false;
                this.staged = { snapshot, stack, lease, token: { ...budget.token }, items: [], page: 0, iterator: null, job: null };
            }
            const stage = this.staged;
            while (!budget.shouldYield()) {
                if (this.options.read().revision !== stage.snapshot.revision) { this.dropStaged(); return; }
                if (stage.page < stage.snapshot.pages.length) { checkPage(stage.snapshot, stage.stack, stage.page++); continue; }
                if (!stage.iterator) {
                    const box = stage.stack.rects[0];
                    stage.iterator = notebookBackdrop(stage.snapshot.host.paper, 0, { x: 0, y: 0, width: box.width, height: box.height });
                }
                if (stage.job) {
                    if (stage.job.path.step(PATH_STEP) === 'complete') {
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
                this.ready = { revision: stage.snapshot.revision, paper: stage.snapshot.host.paper, stack: stage.stack,
                    items: Object.freeze(stage.items), lease: stage.lease, token: stage.token };
                this.staged = null; this.host.invalidate('notebook-paper-ready'); return;
            }
        } catch (error) {
            this.failedRevision = attemptedRevision ?? this.desired?.revision ?? null;
            try { this.dropStaged(); } catch (cleanup) { this.report(cleanup); }
            this.report(error);
        }
    }
    /** A new revision that only adds or removes pages keeps the ready template: every page draws the same items, moved to it
     * (paperPage), and the working set is per page box, which is unchanged. Re-staging it held the paper not current for as
     * long as the template took to stage, so adding a page left every frame incomplete under input. */
    private adoptPageCount(snapshot: NotebookPaperSnapshot): void {
        const ready = this.ready;
        if (!ready || !sameTemplate(ready.paper, snapshot.host.paper)) return;
        const stack = boardPageStack(snapshot.host);
        if (!stack || stack.rects.length !== snapshot.pages.length || stack.rects[0]?.width !== ready.stack.rects[0]?.width
            || stack.rects[0]?.height !== ready.stack.rects[0]?.height) return;
        for (let index = 0; index < snapshot.pages.length; index++) checkPage(snapshot, stack, index);
        this.ready = { ...ready, revision: snapshot.revision, paper: snapshot.host.paper, stack };
        this.gpuPaper = null; this.claim = null;
        this.host.invalidate('notebook-paper-ready');
    }
    // Changed when the paper's ready template, its GPU source or its composer's picture moved this frame. It answered changed on
    // every frame, so a frame whose picture was the last one could never be skipped: on the notebook 61 of 123 draw-phase presents
    // and 49 of 97 saturated were the same pixels as the one before (canvas2d 6 and 1; the drawing 11). canvas2d keeps answering
    // changed: its paper is drawn by draw2d, which proves nothing about its picture.
    prepare(view: ViewState, budget: FrameBudget): boolean {
        const readyBefore = this.ready;
        // One page step is always admitted: under a zero slice the staging never advances, and needsFrame keeps asking.
        this.preparePaper(withFirstUnit(budget));
        if (this.disposed) return true;
        // canvas2d: the paper draws the same picture from the same ready paper at the same view. Answered changed on every frame, it
        // kept a notebook pane presenting whatever else had nothing new (round 8: prepare-changed:notebook-paper on 178 of 178 pan
        // frames; after a drag the board's own unchanged frames still presented). A new revision or a camera or geometry change
        // presents anyway (the pane compares those itself).
        if (!this.host.device()) {
            const last = this.drawn2d, cam = view.camera, vp = view.viewport;
            return !last || last.ready !== this.ready || last.x !== cam.x || last.y !== cam.y || last.z !== cam.z || last.w !== vp.width
                || last.h !== vp.height || last.dpr !== vp.dpr || last.revision !== this.options.read().revision;
        }
        if (this.prepareProcedural(view, budget.token)) {
            const key = this.proceduralKey, ready = this.ready!, cam = view.camera, vp = view.viewport;
            const same = !!key && key.ready === ready && key.x === cam.x && key.y === cam.y && key.z === cam.z && key.w === vp.width && key.h === vp.height && key.dpr === vp.dpr;
            if (!same) this.proceduralKey = { ready, x: cam.x, y: cam.y, z: cam.z, w: vp.width, h: vp.height, dpr: vp.dpr };
            return !same || this.ready !== readyBefore;
        }
        const sourceBefore = this.gpuPrepared;
        let changed = true;
        try {
            this.prepareGpuSource(view, budget.token);
            changed = this.gpu.prepare(view, budget);
        } catch (error) { this.report(error); return true; }
        return changed || this.ready !== readyBefore || this.gpuPrepared !== sourceBefore;
    }
    /** Whether this frame's paper is the procedural pass. Entering it releases the composed tiles (they are not drawn again until
     * the paper leaves it); a paper it cannot draw, or a pipeline still compiling, keeps the composed route (counted by reason). */
    private prepareProcedural(_view: ViewState, token: FrameToken): boolean {
        const ready = this.ready;
        let on = false;
        if (ready && sameToken(ready.token, token)) {
            const refusal = this.procedural.refusal(ready.paper, ready.stack);
            if (refusal) auditCount('notebook-paper', `procedural:off:${refusal}`);
            else if (!this.procedural.ready()) auditCount('notebook-paper', 'procedural:off:pipeline');
            else on = true;
        }
        if (on && !this.proceduralOn) {
            this.gpu.release('pressure'); this.gpuPrepared = null; this.gpuSource = null; this.proceduralKey = null;
        }
        if (!on && this.proceduralOn) this.proceduralKey = null;
        this.proceduralOn = on;
        return on;
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
        // One page either side of the viewport: a tile at the viewport edge samples its neighbour's gutter.
        const padFirst = Math.max(0, first - 1), padLast = Math.min(ready.stack.rects.length - 1, last + 1);
        const paper = this.gpuPaperFor(ready);
        const fresh = paper.fresh; paper.fresh = false;
        const items: PaintPathItem[] = [];
        for (let page = padFirst; page <= padLast; page++) for (const item of paperPage(paper, page).items) items.push(item);
        // The composer's revision for this frame: each rebuild is one. It learns the pages newly in view from the rebuild before
        // it, and must recompose everything when the paper itself is new (a new ready revision, or a cache reset).
        const from = this.gpuGeneration, to = from + 1; this.gpuGeneration = to;
        const added: Rect[] = [];
        if (!fresh && previous) for (let page = padFirst; page <= padLast; page++) if (page < previous.padFirst || page > previous.padLast) added.push(ready.stack.rects[page]);
        const changes: RegionChanges = fresh || !previous ? FULL_REGION_CHANGES : { full: false, regions: added };
        const frame: PaintFrame = { token: { vaultEpoch: token.vaultEpoch, documentId: token.documentId,
            bytesGeneration: token.bytesGeneration, session: token.session }, sceneRevision: to,
        inkNodeIds: new Set(), underlay: [], content: items,
        regionChangesSince: since => since === to ? NO_CHANGES : since === from ? changes : FULL_REGION_CHANGES };
        this.gpuPrepared = preparedOfFrame(frame, paper.resources);
        this.gpuSource = { ready, first, last, padFirst, padLast, token: { ...token } };
    }
    /** The GPU paint of one ready paper: its pages' items are built once, and shared by every frame that shows them. */
    private gpuPaperFor(ready: Ready): GpuPaper {
        const current = this.gpuPaper;
        // A cache that has grown past its page limit is replaced (fresh), so a long scroll of a large dotted notebook
        // cannot hold every page it has shown. The old paper keeps its own resources for the prepared frames that use it.
        if (current?.ready === ready && current.pages.size < PAGE_CACHE_LIMIT) return current;
        const paths = new WeakMap<PaintPathItem, PreparedPath2d>(), clips = new Map<string, PreparedPath2d>();
        const paper: GpuPaper = { ready, fresh: true, pages: new Map(), paths, clips, resources: {
            path: item => { const path = paths.get(item as PaintPathItem); if (!path) throw new Error('Notebook GPU path unavailable'); return path; },
            clip: key => { const clip = clips.get(key); if (!clip) throw new Error('Notebook GPU clip unavailable'); return clip; },
            image: () => { throw new Error('Notebook paper has no image resources'); },
        } };
        this.gpuPaper = paper;
        return paper;
    }
    drawGpu(pass: GpuPass, view: ViewState): void {
        // A GPU picture replaces the last canvas2d one: back on canvas2d, the first frame draws again.
        this.drawn2d = null;
        const ready = this.ready;
        if (this.proceduralOn && ready) {
            const pages = this.procedural.draw(pass, view, ready.paper, ready.stack);
            if (pages) for (let page = pages[0]; page <= pages[1]; page++) this.markDrawn(ready.stack.rects[page]);
            return;
        }
        this.gpu.drawGpu(pass, view, 'content');
        // Drawn only when the adapter's ready tiles are the ones prepared for this paper (the coverage test below).
        const source = this.gpuSource;
        if (source && this.gpuPrepared && this.gpu.readyPaint() === this.gpuPrepared) {
            for (let page = source.first; page <= source.last; page++) this.markDrawn(source.ready.stack.rects[page]);
        }
    }
    /** The current pages whose paper has been drawn at least once: the only pages a board may claim opaque (C1 readiness). */
    drawnPageRects(): readonly Rect[] {
        const ready = this.ready;
        if (this.disposed || !ready) return NO_RECTS;
        if (this.claim?.ready !== ready) this.claim = { ready, rects: ready.stack.rects.filter(rect => this.drawn.has(rect)) };
        return this.claim.rects;
    }
    private markDrawn(rect: Rect): void {
        this.drawnOnce = true;
        if (this.drawn.has(rect)) return;
        this.drawn.add(rect); this.claim = null;
    }
    /** The paper's own adapter reports its mandatory GPU bytes for the viewport (h2's gpuMandatoryBytes; none until it lands). */
    gpuWorkingSetBytes(viewport: Readonly<{ width: number; height: number }>): number {
        if (this.disposed) return 0;
        return (this.gpu as { gpuMandatoryBytes?(viewport: Readonly<{ width: number; height: number }>): number }).gpuMandatoryBytes?.(viewport) ?? 0;
    }
    /** Forwards the composer's offscreen encode; a no-op until the adapter has one (PLAN §3.3, wave 2). */
    /** The governor's trim: frees the adapter's GPU tiles not used this frame, and returns the bytes freed. */
    /** The governor's trim. The paper's reclaimable residency is its free list (released targets, charged until trimmed) and its
     * stale or off-view tiles. A trim asks for a few bytes, but the pool needs headroom: a small grant freed one target and left
     * a board's next admission refused, which froze the pane (measured: the paper held 28 targets, 29.8 MB, for 9 visible
     * positions). So the paper gives back everything the adapter can release this frame, and returns the real bytes. The
     * adapter's tiers keep what is drawn now. */
    evictGpu(bytes: number, frameId: number): number {
        const adapter = this.gpu as GpuEvicting;
        if (this.disposed || typeof adapter.evictGpu !== 'function') return 0;
        return adapter.evictGpu(Math.max(bytes, this.gpu.memory().gpuBytes), frameId);
    }
    protectFrame(frameId: number, view: ViewState): void {
        const adapter = this.gpu as GpuProtecting;
        if (!this.disposed && typeof adapter.protectFrame === 'function') adapter.protectFrame(frameId, view);
    }
    encodeOffscreen(passes: OffscreenPasses, view: ViewState): void {
        const encoder = this.gpu as OffscreenEncoder;
        if (!this.disposed && typeof encoder.encodeOffscreen === 'function') encoder.encodeOffscreen(passes, view, 'content');
    }
    offscreenSettled(submitted: boolean): void {
        const encoder = this.gpu as OffscreenEncoder;
        if (!this.disposed && typeof encoder.offscreenSettled === 'function') encoder.offscreenSettled(submitted);
    }
    draw2d(ctx: CanvasRenderingContext2D, view: ViewState): void {
        const ready = this.ready, cam = view.camera, vp = view.viewport;
        this.drawn2d = { ready, x: cam.x, y: cam.y, z: cam.z, w: vp.width, h: vp.height, dpr: vp.dpr, revision: this.options.read().revision };
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
                this.markDrawn(box);
            }
        });
    }
    releaseGpu(reason: GpuReleaseReason): void {
        this.gpu.release(reason);
        // The pipeline is device state: a pressure release keeps it (it holds no budgeted bytes); any other release drops it.
        if (reason !== 'pressure') { this.procedural.release(); this.proceduralOn = false; this.proceduralKey = null; } this.gpuPrepared = null; this.gpuSource = null; this.drawn = new WeakSet(); this.drawnOnce = false; this.claim = null; this.drawn2d = null;
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
            (!this.proceduralOn && !!this.host.device() && !!this.gpuPrepared && this.gpu.needsFrame()));
    }
    dispose(): void { if (!this.disposed) { this.disposed = true; this.releaseGpu('hidden'); this.gpu.dispose(); } }
    currentRevision(): number { return this.snapshot().revision; }
    demand(): number {
        const snapshot = this.snapshot(), stack = boardPageStack(snapshot.host);
        if (!stack) throw new RangeError('Notebook page stack unavailable');
        return this.memory().cpuBytes + (this.host.device() ? this.gpu.cpuWorkingSet().mandatoryBytes : 0) +
            (this.ready?.revision === snapshot.revision || this.staged?.snapshot.revision === snapshot.revision ? 0 : workingBytes(snapshot, stack));
    }
    /** Critical only while the paper has drawn no page at all: a stand-in (any drawn page) lets a pan that exposes pages faster
     * than they compose present what there is, instead of refusing every frame (the 0-presents class, measured on large boards). */
    critical(): boolean { return !this.drawnOnce; }
    coverage(frame: ScheduledFrame, layer: Layer, backend: CompositorBackend): LayerCoverage {
        const result = this.coverageNow(frame, layer, backend);
        // What the paper draws besides the current picture, for the present audit: pages drawn before are stand-ins; none drawn is a hole.
        if (!result.complete || !result.sharp) auditDrawn(!result.complete && !this.drawnOnce ? 'hole' : 'stand-in', 1, 'geometry', !result.complete ? 'paper-incomplete' : 'paper-unsharp');
        return result;
    }
    private coverageNow(frame: ScheduledFrame, layer: Layer, backend: CompositorBackend): LayerCoverage {
        const ready = this.ready, requested = requestedRevision(frame, layer);
        if (!ready || !sameToken(ready.token, frame.token)) return { complete: false, sharp: false };
        const current = ready.revision === requested && ready.revision === this.options.read().revision;
        if (!current) return { complete: false, sharp: false, staleVersion: true };
        if (backend === 'canvas2d') return { complete: true, sharp: true };
        // The procedural pass draws every visible page exactly in this frame: nothing composes, nothing stands in.
        if (this.proceduralOn) return { complete: true, sharp: true };
        if (this.gpu.readyPaint() !== this.gpuPrepared) return { complete: false, sharp: false, staleVersion: true };
        return this.gpu.coverage(frame.view);
    }
}

/** The paper's definition, with the pages it has drawn (the board's opaque claim, C1). */
export interface NotebookPaperDefinition extends PlatformLayerDefinition {
    /** The current pages whose paper has been drawn at least once; none until this paper's layer exists. */
    drawnPageRects(): readonly Rect[];
}
/** Page/paper colour stays print-light, independently of the shell's palette. */
export function createNotebookPaperLayer(options: NotebookPaperLayerOptions): NotebookPaperDefinition {
    let live: NotebookPaperLayer | null = null;
    return {
        id: 'notebook-paper', group: 'document',
        create: host => { live = new NotebookPaperLayer(host, options); return live; },
        drawnPageRects: () => live?.drawnPageRects() ?? [],
        revision: layer => (layer as NotebookPaperLayer).currentRevision(),
        cpuWorkingSet: layer => ({ mandatoryBytes: (layer as NotebookPaperLayer).demand(), prefetchBytes: 0 }),
        // A spread until the platform type carries gpuWorkingSet (h9). The paper owns its adapter, so it reports it once.
        ...{ gpuWorkingSet: (layer: Layer, viewport: Readonly<{ width: number; height: number }>) =>
            ({ mandatoryBytes: (layer as NotebookPaperLayer).gpuWorkingSetBytes(viewport) }) },
        critical: layer => (layer as NotebookPaperLayer).critical(),
        coverage: (layer, frame, backend) => (layer as NotebookPaperLayer).coverage(frame, layer, backend),
    };
}
