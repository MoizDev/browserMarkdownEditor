import type { PageGeometry, Rect, ViewState } from '../../platform/types';
import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import type { LayerCoverage, LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease } from '../../platform/render/gfx/api';
import { pageAt, type PageStack } from '../../platform/render/pageStack';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { FrameBudget, FrameToken, GpuReleaseReason, Layer } from '../../platform/render/types';
import { boardPageStack } from '../model/pages';
import type { HostBlock } from '../model/doc';
import type { PaintPalette } from '../render/colour';
import type { PaintPathItem } from '../render/paintStream';
import { Path2dJob } from '../render/reference/coverage2d';
import { paintItem2d, type PaintResources2d, type PreparedPath2d } from '../render/reference/paint2d';
import { notebookBackdrop } from './notebookBackdrop';

export type NotebookHost = Extract<HostBlock, { kind: 'notebook' }>;
export interface NotebookPaperSnapshot {
    /** Changes whenever paper properties or page geometry change. */
    readonly revision: number;
    readonly host: Readonly<NotebookHost>;
    readonly pages: readonly PageGeometry[];
}
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
    constructor(private readonly host: LayerHost, private readonly options: NotebookPaperLayerOptions) {}
    private report(error: unknown): void { try { this.options.onError(error); } catch { /* errors do not escape the layer scheduler */ } }
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
    prepare(_view: ViewState, budget: FrameBudget): void {
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
    drawGpu(): void { throw new Error('Notebook paper layer is Canvas2D-only'); }
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
            }
        });
    }
    releaseGpu(_reason: GpuReleaseReason): void {
        try { this.dropStaged(); } catch (error) { this.report(error); }
        try { this.dropReady(); } catch (error) { this.report(error); }
        this.desired = null; this.denied = false; this.failedRevision = null;
    }
    memory(): { gpuBytes: number; cpuBytes: number } { return { gpuBytes: 0, cpuBytes: (this.ready?.lease.bytes ?? 0) + (this.staged?.lease.bytes ?? 0) }; }
    needsFrame(): boolean {
        if (this.disposed || this.denied) return false;
        const revision = this.options.read().revision;
        return !Object.is(this.failedRevision, revision) && (this.staged !== null || this.ready?.revision !== revision);
    }
    dispose(): void { if (!this.disposed) { this.disposed = true; this.releaseGpu('hidden'); } }
    currentRevision(): number { return this.snapshot().revision; }
    demand(): number {
        const snapshot = this.snapshot(), stack = boardPageStack(snapshot.host);
        if (!stack) throw new RangeError('Notebook page stack unavailable');
        return this.memory().cpuBytes + (this.ready?.revision === snapshot.revision || this.staged?.snapshot.revision === snapshot.revision ? 0 : workingBytes(snapshot, stack));
    }
    critical(): boolean { return !this.ready; }
    coverage(frame: ScheduledFrame, layer: Layer): LayerCoverage {
        const ready = this.ready, requested = frame.layers.find(entry => entry.layer === layer)?.sceneRevision;
        if (!ready || !sameToken(ready.token, frame.token)) return { complete: false, sharp: false };
        const current = ready.revision === requested && ready.revision === this.options.read().revision;
        return current ? { complete: true, sharp: true } : { complete: false, sharp: false, staleVersion: true };
    }
}

/** Page/paper colour stays print-light, independently of the shell's palette. */
export function createNotebookPaperLayer(options: NotebookPaperLayerOptions): PlatformLayerDefinition {
    return {
        id: 'notebook-paper', group: 'document',
        create: host => new NotebookPaperLayer(host, options),
        revision: layer => (layer as NotebookPaperLayer).currentRevision(),
        cpuWorkingSet: layer => ({ mandatoryBytes: (layer as NotebookPaperLayer).demand(), prefetchBytes: 0 }),
        critical: layer => (layer as NotebookPaperLayer).critical(),
        coverage: (layer, frame) => (layer as NotebookPaperLayer).coverage(frame, layer),
    };
}
