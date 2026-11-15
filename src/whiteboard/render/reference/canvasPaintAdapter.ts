import type { PathCommand, ViewState } from '../../../platform/types';
import type { FrameBudget, GpuReleaseReason } from '../../../platform/render/types';
import type { PaintBand } from '../material';
import type { PaintItem, PaintSource } from '../paintStream';
import { filterWindows, rootOf, windowsOfSource, type PaintRoot, type PaintWindow } from '../paintWindows';
import type { PaintImageLease, PaintLayerResources } from '../resources';
import { InkCoverageUnionPath2dJob, Path2dJob } from './coverage2d';
import type { PathOrigin2d } from './coverage2d';
import { paintItem2d } from './paint2d';
import type { PaintResources2d, PreparedPath2d } from './paint2d';

export interface CanvasPaintAdapter {
    prepare(view: ViewState, budget: FrameBudget): void;
    /** The complete shared frame actually available to both band wrappers. */
    readyFrame(): PaintSource | null;
    /** Borrow is valid only until the next prepare, release or dispose. */
    borrowPrepared(): PreparedPaint2d | null;
    /** Physical retention for asynchronous fact work: the returned prepared resources, their image
     * leases and (for dense plans) their bitmaps stay alive until release, even after the adapter has
     * moved on. Null when nothing is presented. */
    retainPrepared(): PreparedRetain | null;
    draw2d(ctx: CanvasRenderingContext2D, view: ViewState, band: PaintBand, omitNodes?: ReadonlySet<string>): void;
    release(reason: GpuReleaseReason): void;
    needsFrame(): boolean;
    memory(): { gpuBytes: number; cpuBytes: number };
    dispose(): void;
}

/** A prepared paint: its canonical source, the root metadata, and the ordered bounded windows consumers iterate.
 * The object is the identity of one published version: a consumer compares it, never its windows. */
export interface PreparedPaint2d {
    /** Canonical source whose pin and presentation acknowledgement own this paint. */
    readonly sourceFrame: PaintSource;
    /** Token, revision and sets of the source, without items. */
    readonly root: PaintRoot;
    /** Every underlay window, then every content window; each holds at most PAINT_WINDOW_ITEMS items. */
    readonly windows: readonly PaintWindow[];
    /** A derived stand-in can be complete without carrying full requested detail. */
    readonly sharp?: boolean;
    readonly resources: PaintResources2d;
}

/** A prepared paint of a whole canonical frame, for layers that prepare their own frames directly. */
export function preparedOfFrame(frame: PaintSource, resources: PaintResources2d, sharp?: boolean): PreparedPaint2d {
    return { sourceFrame: frame, root: rootOf(frame), windows: windowsOfSource(frame), resources, ...(sharp === undefined ? {} : { sharp }) };
}

export interface PreparedRetain {
    readonly prepared: PreparedPaint2d;
    /** A further borrow of the same resources, taken only while this one is open; null once released. */
    retain(): PreparedRetain | null;
    release(): void;
}

export type PaintProjection2d = (ctx: CanvasRenderingContext2D, view: ViewState, paint: () => void) => void;

type PathJob = Path2dJob | InkCoverageUnionPath2dJob;
type Snapshot = {
    frame: PaintSource;
    scale: number;
    // The source windows and the cursor into them: window, then item within it.
    windows: readonly PaintWindow[];
    window: number;
    finished: boolean;
    index: number;
    clipIndex: number;
    paths: WeakMap<PaintItem, PreparedPath2d>;
    clips: Map<string, PreparedPath2d>;
    geometry: Map<string, { prepared: PreparedPath2d; bytes: number }>;
    images: Map<string, PaintImageLease | null>;
    /** Built once, on first borrow, so every borrow of this snapshot is the same identity. */
    prepared: PreparedPaint2d | null;
    /** Open retainPrepared borrows; a release that arrives meanwhile is applied when the last one ends. */
    borrows: number;
    closing: boolean;
    abort: AbortController;
    pending: number;
    failure: unknown;
    failed: boolean;
    complete: boolean;
    disposed: boolean;
    bytes: number;
    job: { path: PathJob; key: string; item?: PaintItem; clip?: string } | null;
};

function pathOrigin(commands: readonly PathCommand[]): PathOrigin2d {
    const first = commands[0];
    return first && first[0] !== 'Z' ? [first[1], first[2]] : [0, 0];
}

function scaleFor(item: PaintItem, scale: number): number {
    const [a, b, c, d] = item.localToWorld;
    // Frobenius norm bounds the greatest stretch, so cap error never exceeds its device budget.
    return Math.max(Number.MIN_VALUE, scale * Math.hypot(a, b, c, d));
}

function sameToken(a: PaintSource, b: PaintSource): boolean {
    const x = a.token, y = b.token;
    return x.vaultEpoch === y.vaultEpoch && x.documentId === y.documentId
        && x.bytesGeneration === y.bytesGeneration && x.session === y.session;
}

function releaseSnapshot(s: Snapshot): void {
    if (s.disposed) return;
    if (s.borrows) { s.closing = true; return; }
    finishSnapshot(s);
}

function finishSnapshot(s: Snapshot): void {
    if (s.disposed) return;
    s.disposed = true;
    s.abort.abort();
    s.job?.path.cancel();
    s.job = null;
    for (const image of s.images.values()) image?.release();
    s.images.clear();
    s.geometry.clear();
    s.clips.clear();
}

/** Both bands share a snapshot and become visible together, never by separate commits. */
export function createCanvasPaintAdapter(
    resources: PaintLayerResources, project: PaintProjection2d, onError: (error: unknown) => void,
    /** Items this adapter prepares; an excluded item is skipped in place, so a frame never needs a filtered copy. */
    include?: (item: PaintItem) => boolean,
): CanvasPaintAdapter {
    let staged: Snapshot | null = null, presented: Snapshot | null = null;
    // Snapshots kept alive only by retainPrepared borrows: their memory is still held and counted.
    const borrowed = new Set<Snapshot>();
    let disposed = false;
    let lastFrameId: number | null = null;

    function start(frame: PaintSource, scale: number): Snapshot {
        return { frame, scale, windows: windowsOfSource(frame), window: 0, finished: false, index: 0, clipIndex: 0, paths: new WeakMap(), prepared: null,
            clips: new Map(), geometry: new Map(), images: new Map(), borrows: 0, closing: false, abort: new AbortController(),
            pending: 0, failed: false, failure: undefined, complete: false, disposed: false, bytes: 0, job: null };
    }
    function requestImage(s: Snapshot, key: string): void {
        if (s.images.has(key)) return;
        s.images.set(key, null);
        s.pending++;
        let promise: Promise<PaintImageLease>;
        try { promise = resources.images.acquire(key, s.frame.token, s.abort.signal); }
        catch (error) { s.pending--; s.failed = true; s.failure = error; releaseSnapshot(s); onError(error); return; }
        promise.then(lease => {
            if (s.disposed || s.abort.signal.aborted || !resources.frames.isCurrent(s.frame)) {
                lease.release();
            } else {
                s.images.set(key, lease);
                s.bytes += lease.cpuBytes;
            }
            s.pending--;
            resources.invalidate();
        }, error => {
            s.pending--;
            if (!s.disposed && !s.abort.signal.aborted) { s.failed = true; s.failure = error; releaseSnapshot(s); onError(error); }
            resources.invalidate();
        });
    }
    function step(s: Snapshot): void {
        if (s.job) {
            const job = s.job;
            const status = job.path.step(1);
            if (status === 'complete') {
                const path = job.path.result!;
                const prepared = { path, origin: job.path.origin };
                const bytes = job.path.commandCount * 32;
                s.geometry.set(job.key, { prepared, bytes });
                if (job.item) s.paths.set(job.item, prepared);
                if (job.clip !== undefined) s.clips.set(job.clip, prepared);
                s.bytes += bytes;
                s.job = null;
            }
            return;
        }
        const win = s.windows[s.window];
        if (!win) { s.finished = true; if (!s.pending) s.complete = true; return; }
        if (s.index >= win.items.length) { s.window++; s.index = 0; return; }
        const item = win.items[s.index];
        if (include && !include(item)) { s.index++; s.clipIndex = 0; return; }
        if (s.clipIndex < item.clips.length) {
            const clip = item.clips[s.clipIndex++];
            if (!s.clips.has(clip.key)) {
                const key = `clip:${clip.key}`;
                const cached = s.geometry.get(key);
                if (cached) s.clips.set(clip.key, cached.prepared);
                else s.job = { key, clip: clip.key, path: new Path2dJob(clip.d, pathOrigin(clip.d)) };
            }
            return;
        }
        if (item.kind === 'image') {
            requestImage(s, item.imageKey);
        } else if (item.kind !== 'text') {
            const itemScale = scaleFor(item, s.scale);
            const key = `${item.kind}:${item.geometryKey}:${item.kind === 'ink' ? itemScale : ''}`;
            const cached = s.geometry.get(key) ?? (presented && sameToken(s.frame, presented.frame) ? presented.geometry.get(key) : undefined);
            if (cached) {
                if (!s.geometry.has(key)) { s.geometry.set(key, cached); s.bytes += cached.bytes; }
                s.paths.set(item, cached.prepared);
            } else {
                const path = item.kind === 'ink'
                    ? new InkCoverageUnionPath2dJob(item.coverage, itemScale)
                    : new Path2dJob(item.d, pathOrigin(item.d));
                s.job = { key, item, path };
            }
        }
        s.index++;
        s.clipIndex = 0;
    }
    function preparedOf(s: Snapshot): PreparedPaint2d {
        s.prepared ??= { sourceFrame: s.frame, root: rootOf(s.frame), windows: filterWindows(s.windows, include), resources: {
            path: item => { const path = s.paths.get(item); if (!path) throw new Error('Missing prepared path'); return path; },
            clip: key => { const path = s.clips.get(key); if (!path) throw new Error('Missing prepared clip'); return path; },
            image: key => { const image = s.images.get(key); if (!image) throw new Error('Missing prepared image'); return image.source; },
        } };
        return s.prepared;
    }
    function borrowPrepared(): PreparedPaint2d | null {
        const s = presented;
        if (disposed || !s || s.closing) return null;
        return preparedOf(s);
    }
    // A borrow pins the snapshot's resources until its own release; a further borrow comes only from an open one.
    function borrowSnapshot(s: Snapshot): PreparedRetain {
        s.borrows++; borrowed.add(s);
        let open = true;
        return { prepared: preparedOf(s), retain: () => open ? borrowSnapshot(s) : null, release() {
            if (!open) return;
            open = false;
            if (--s.borrows === 0) { borrowed.delete(s); if (s.closing) finishSnapshot(s); }
        } };
    }
    return {
        prepare(view, budget) {
            if (disposed || budget.frameId === lastFrameId) return;
            lastFrameId = budget.frameId;
            const frame = resources.frames.readFrame();
            const scale = view.camera.z * view.viewport.dpr;
            if (!frame || !resources.frames.isCurrent(frame) || !Number.isFinite(scale) || scale <= 0) {
                if (staged) { releaseSnapshot(staged); staged = null; }
                return;
            }
            if (presented && !sameToken(presented.frame, frame)) { releaseSnapshot(presented); presented = null; }
            if (staged && (staged.frame !== frame || staged.scale !== scale)) { releaseSnapshot(staged); staged = null; }
            if (!staged && (!presented || presented.frame !== frame || presented.scale !== scale)) staged = start(frame, scale);
            const s = staged;
            if (!s || s.complete || s.failed) return;
            try {
                while (!budget.shouldYield() && !s.complete && !s.failed) {
                    if (!resources.frames.isCurrent(frame)) { releaseSnapshot(s); staged = null; break; }
                    if (!s.job && s.finished && s.pending) break;
                    step(s);
                }
                if (s.complete && resources.frames.isCurrent(s.frame)) {
                    if (presented) releaseSnapshot(presented);
                    presented = s; staged = null;
                }
            } catch (error) { s.failed = true; s.failure = error; releaseSnapshot(s); onError(error); }
        },
        readyFrame() { return disposed ? null : presented?.frame ?? null; },
        borrowPrepared,
        retainPrepared() {
            const s = presented;
            if (disposed || !s || s.closing) return null;
            return borrowSnapshot(s);
        },
        draw2d(ctx, view, band, omitNodes) {
            const prepared = borrowPrepared();
            if (!prepared) return;
            project(ctx, view, () => {
                for (const window of prepared.windows) {
                    if (window.band !== band) continue;
                    for (const item of window.items) if (!omitNodes?.has(item.nodeId)) paintItem2d(ctx, item, prepared.resources);
                }
            });
        },
        release(reason) {
            if (reason === 'context-lost') return;
            if (staged) releaseSnapshot(staged);
            if (presented) releaseSnapshot(presented);
            staged = null; presented = null;
        },
        needsFrame() {
            if (disposed) return false;
            const frame = resources.frames.readFrame();
            if (!frame || !resources.frames.isCurrent(frame)) return false;
            if (staged && staged.frame === frame) return !staged.complete && !staged.failed && !(!staged.job && staged.finished && staged.pending > 0);
            return !presented || presented.frame !== frame;
        },
        memory() {
            let cpuBytes = (staged?.bytes ?? 0) + (presented?.bytes ?? 0);
            for (const s of borrowed) if (s !== presented) cpuBytes += s.bytes;
            return { gpuBytes: 0, cpuBytes };
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            if (staged) releaseSnapshot(staged);
            if (presented) releaseSnapshot(presented);
            staged = null; presented = null;
        },
    };
}
