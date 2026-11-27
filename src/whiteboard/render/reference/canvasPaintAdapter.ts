import type { PathCommand, ViewState } from '../../../platform/types';
import { pictureLevelRefused } from '../../media/levelFloor';
import { isTransientPictureFailure } from '../../media/transientFailure';
import { isMediaTileKey, parseMediaTileKey } from '../../media/mips';
import type { FrameBudget, GpuReleaseReason } from '../../../platform/render/types';
import type { PaintBand } from '../material';
import type { PaintItem, PaintSource } from '../paintStream';
import { filterWindows, refBytesOf, rootOf, windowsOfSource, type PaintRoot, type PaintWindow } from '../paintWindows';
import type { PaintImageLease, PaintLayerResources } from '../resources';
import { InkCoverageUnionPath2dJob, Path2dJob } from './coverage2d';
import type { PathOrigin2d } from './coverage2d';
import { paintItem2d } from './paint2d';
import type { PaintResources2d, PreparedPath2d } from './paint2d';

export interface CanvasPaintAdapter {
    prepare(view: ViewState, budget: FrameBudget, vectors?: boolean): void;
    readyFrame(): PaintSource | null;
    outlined?(): boolean;
    building?(): boolean;
    /** Borrow is valid only until the next prepare, release or dispose. */
    borrowPrepared(): PreparedPaint2d | null;
    retainPrepared(): PreparedRetain | null;
    draw2d(ctx: CanvasRenderingContext2D, view: ViewState, band: PaintBand, omitNodes?: ReadonlySet<string>): void;
    drawable2d(): boolean;
    reacquireReleased(): number;
    release(reason: GpuReleaseReason): void;
    needsFrame(): boolean;
    memory(): { gpuBytes: number; cpuBytes: number };
    dispose(): void;
}

export interface PreparedPaint2d {
    readonly sourceFrame: PaintSource;
    readonly root: PaintRoot;
    readonly windows: readonly PaintWindow[];
    readonly sharp?: boolean;
    readonly resources: PaintResources2d;
}

export function preparedOfFrame(frame: PaintSource, resources: PaintResources2d, sharp?: boolean): PreparedPaint2d {
    return { sourceFrame: frame, root: rootOf(frame), windows: windowsOfSource(frame), resources, ...(sharp === undefined ? {} : { sharp }) };
}

export interface PaintImageHold {
    imageState(key: string): 'ready' | 'released' | 'absent';
    releaseImage(key: string): boolean;
    imageFact(key: string): { readonly width: number; readonly height: number; readonly version: number } | null;
    reacquireImage(key: string): void;
    imageBroken(key: string): boolean;
    imageWaiting(key: string): boolean;
}

export interface PreparedRetain {
    readonly prepared: PreparedPaint2d;
    retain(): PreparedRetain | null;
    release(): void;
}

export type PaintProjection2d = (ctx: CanvasRenderingContext2D, view: ViewState, paint: () => void) => void;

type PathJob = Path2dJob | InkCoverageUnionPath2dJob;
type GeometryEntry = { prepared: PreparedPath2d; bytes: number };
const GEOMETRY_CACHE_BYTES = 8 * 1024 * 1024;
type Snapshot = {
    frame: PaintSource;
    scale: number;
    vectors: boolean;
    windows: readonly PaintWindow[];
    window: number;
    finished: boolean;
    index: number;
    clipIndex: number;
    paths: WeakMap<PaintItem, PreparedPath2d>;
    clips: Map<string, PreparedPath2d>;
    geometry: Map<string, { prepared: PreparedPath2d; bytes: number }>;
    images: Map<string, PaintImageLease | null>;
    released: Set<string>;
    drawn: Set<string>;
    skipped: Set<string>;
    prepared: PreparedPaint2d | null;
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

const RETRY_SKIPPED_MS = 400;

export function createCanvasPaintAdapter(
    resources: PaintLayerResources, project: PaintProjection2d, onError: (error: unknown) => void,
    include?: (item: PaintItem) => boolean,
): CanvasPaintAdapter {
    let staged: Snapshot | null = null, presented: Snapshot | null = null;
    const broken = new Set<string>();
    let retryAt = 0;
    const geometryCache = new Map<string, GeometryEntry>();
    let geometryCacheBytes = 0;
    const cacheGet = (key: string): GeometryEntry | undefined => {
        const entry = geometryCache.get(key);
        if (entry) { geometryCache.delete(key); geometryCache.set(key, entry); }
        return entry;
    };
    const cacheSet = (key: string, entry: GeometryEntry): void => {
        const old = geometryCache.get(key);
        if (old) geometryCacheBytes -= old.bytes;
        geometryCache.delete(key); geometryCache.set(key, entry); geometryCacheBytes += entry.bytes;
        while (geometryCacheBytes > GEOMETRY_CACHE_BYTES && geometryCache.size > 1) {
            const oldest = geometryCache.keys().next().value!;
            geometryCacheBytes -= geometryCache.get(oldest)!.bytes; geometryCache.delete(oldest);
        }
    };
    const borrowed = new Set<Snapshot>();
    let disposed = false;
    let lastFrameId: number | null = null;

    function start(frame: PaintSource, scale: number, vectors: boolean): Snapshot {
        const windows = windowsOfSource(frame);
        return { frame, scale, vectors, windows, window: 0, finished: false, index: 0, clipIndex: 0, paths: new WeakMap(), prepared: null,
            clips: new Map(), geometry: new Map(), images: new Map(), released: new Set(), drawn: new Set(), skipped: new Set(), borrows: 0, closing: false, abort: new AbortController(),
            pending: 0, failed: false, failure: undefined, complete: false, disposed: false,
            bytes: frame.liveOnly ? 0 : refBytesOf(windows), job: null };
    }
    const shares = new WeakMap<PaintImageLease, { readonly lease: PaintImageLease; count: number }>();
    function shareHandle(root: { readonly lease: PaintImageLease; count: number }): PaintImageLease {
        let open = true;
        const handle: PaintImageLease = { source: root.lease.source, width: root.lease.width, height: root.lease.height, cpuBytes: root.lease.cpuBytes,
            release() { if (!open) return; open = false; if (--root.count === 0) root.lease.release(); } };
        shares.set(handle, root);
        return handle;
    }
    const counted = (lease: PaintImageLease): PaintImageLease =>
        (lease as { readonly version?: unknown }).version === undefined ? shareHandle({ lease, count: 1 }) : lease;
    function requestImage(s: Snapshot, key: string): void {
        if (s.images.has(key) || broken.has(key) || s.skipped.has(key)) return;
        if (resources.textureHeld?.(key)) { s.released.add(key); return; }
        fetchImage(s, key);
    }
    function fetchImage(s: Snapshot, key: string): void {
        if (s.images.has(key) || broken.has(key) || s.skipped.has(key)) return;
        const held = presented && presented !== s && presented.frame === s.frame ? presented.images.get(key) : null;
        const root = held ? shares.get(held) : undefined;
        if (root) {
            root.count++;
            const lease = shareHandle(root);
            s.images.set(key, lease); s.bytes += lease.cpuBytes;
            return;
        }
        s.images.set(key, null);
        s.pending++;
        let promise: Promise<PaintImageLease>;
        try { promise = resources.images.acquire(key, s.frame.token, s.abort.signal); }
        catch (error) { s.pending--; s.failed = true; s.failure = error; releaseSnapshot(s); onError(error); return; }
        promise.then(lease => {
            if (s.disposed || s.abort.signal.aborted || !resources.frames.isCurrent(s.frame)) {
                lease.release();
            } else {
                const kept = counted(lease);
                s.images.set(key, kept);
                s.bytes += kept.cpuBytes;
            }
            s.pending--;
            resources.invalidate();
        }, error => {
            s.pending--;
            if (!s.disposed && !s.abort.signal.aborted) {
                const transient = isTransientPictureFailure(error);
                if (transient) s.skipped.add(key); else broken.add(key);
                if (error instanceof Error && /memory/i.test(error.message) && isMediaTileKey(key)) {
                    const tile = parseMediaTileKey(key);
                    if (pictureLevelRefused(tile.id, tile.level)) resources.replan?.();
                }
                s.images.delete(key);
            }
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
                const entry = { prepared, bytes };
                s.geometry.set(job.key, entry);
                cacheSet(job.key, entry);
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
            s.drawn.add(item.imageKey);
            requestImage(s, item.imageKey);
        } else if (item.kind !== 'text' && s.vectors) {
            const itemScale = scaleFor(item, s.scale);
            // One geometry serves several items (a figure's outline and its marks; a highlight's two bands), so
            // the item's own key is part of the identity: sharing by geometry alone paints the first path again.
            const key = `${item.kind}:${item.geometryKey}:${item.key}:${item.kind === 'ink' ? itemScale : ''}`;
            const cached = s.geometry.get(key) ?? (presented && sameToken(s.frame, presented.frame) ? presented.geometry.get(key) : undefined)
                ?? cacheGet(key);
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
    function imageHold(s: Snapshot): PaintImageHold {
        return {
            imageState(key) { return s.images.get(key) ? 'ready' : s.released.has(key) ? 'released' : 'absent'; },
            imageFact(key) {
                const lease = s.images.get(key);
                if (!lease) return null;
                const version = (lease as { readonly version?: unknown }).version;
                return { width: lease.width, height: lease.height, version: typeof version === 'number' ? version : 0 };
            },
            releaseImage(key) {
                const lease = s.images.get(key);
                if (!lease) return false;
                s.images.delete(key); s.released.add(key); s.bytes -= lease.cpuBytes;
                lease.release();
                return true;
            },
            imageBroken(key) { return broken.has(key); },
            imageWaiting(key) { return s.images.get(key) === null || s.skipped.has(key); },
            reacquireImage(key) {
                if (s.disposed || s.abort.signal.aborted || s.images.has(key)) return;
                s.released.delete(key);
                fetchImage(s, key);
            },
        };
    }
    function preparedOf(s: Snapshot): PreparedPaint2d {
        const windows = filterWindows(s.windows, include);
        if (windows !== s.windows) s.bytes += refBytesOf(windows);
        s.prepared ??= { sourceFrame: s.frame, root: rootOf(s.frame), windows, resources: {
            path: item => { const path = s.paths.get(item); if (!path) throw new Error('Missing prepared path'); return path; },
            clip: key => { const path = s.clips.get(key); if (!path) throw new Error('Missing prepared clip'); return path; },
            image: key => {
                if (broken.has(key) || s.skipped.has(key)) return null;
                const image = s.images.get(key);
                if (image) return image.source;
                throw new Error(s.released.has(key) ? 'Released prepared image' : 'Missing prepared image');
            },
            ...imageHold(s),
        } };
        return s.prepared;
    }
    function holdsDrawn(): boolean {
        const s = presented;
        if (disposed || !s || s.closing || !s.vectors) return false;
        for (const key of s.drawn) if (s.released.has(key) || s.images.get(key) === null) return false;
        return true;
    }
    function borrowPrepared(): PreparedPaint2d | null {
        const s = presented;
        if (disposed || !s || s.closing) return null;
        return preparedOf(s);
    }
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
        prepare(view, budget, vectors = true) {
            if (disposed || budget.frameId === lastFrameId) return;
            lastFrameId = budget.frameId;
            const frame = resources.frames.readFrame();
            const scale = view.camera.z * view.viewport.dpr;
            if (!frame || !resources.frames.isCurrent(frame) || !Number.isFinite(scale) || scale <= 0) {
                if (staged) { releaseSnapshot(staged); staged = null; }
                return;
            }
            if (presented && !sameToken(presented.frame, frame)) { releaseSnapshot(presented); presented = null; }
            if (staged && (staged.frame !== frame || staged.scale !== scale || (vectors && !staged.vectors) || (!vectors && staged.vectors))) {
                releaseSnapshot(staged); staged = null;
            }
            const retry = !staged && !!presented && presented.frame === frame && presented.scale === scale && presented.skipped.size > 0;
            if (retry && performance.now() < retryAt) { resources.wakeAt?.(retryAt); return; }
            const shed = !vectors && !!presented && presented.vectors;
            if (!staged && (retry || shed || !presented || presented.frame !== frame || presented.scale !== scale || (vectors && !presented.vectors))) {
                staged = start(frame, scale, vectors);
            }
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
                    if (!s.vectors && geometryCache.size) { geometryCache.clear(); geometryCacheBytes = 0; }
                    if (s.skipped.size) { retryAt = performance.now() + RETRY_SKIPPED_MS; resources.wakeAt?.(retryAt); }
                }
            } catch (error) { s.failed = true; s.failure = error; releaseSnapshot(s); onError(error); }
        },
        readyFrame() { return disposed ? null : presented?.frame ?? null; },
        outlined() { return !disposed && !!presented?.vectors; },
        building() { const frame = resources.frames.readFrame(); return !disposed && !!staged && staged.frame === frame && !staged.complete && !staged.failed; },
        borrowPrepared,
        retainPrepared() {
            const s = presented;
            if (disposed || !s || s.closing) return null;
            return borrowSnapshot(s);
        },
        drawable2d: holdsDrawn,
        reacquireReleased() {
            const s = presented;
            if (disposed || !s || s.closing || !s.released.size) return 0;
            let asked = 0;
            for (const key of s.drawn) if (s.released.delete(key)) { fetchImage(s, key); asked++; }
            return asked;
        },
        draw2d(ctx, view, band, omitNodes) {
            // A picture released to the GPU threw out of paintItem2d and failed the pane ('Could not continue: Released prepared
            // image'): the scheduler unregistered it and the board stayed 'Updating' for good. Its caller reports such a paint incomplete.
            if (!holdsDrawn()) return;
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
            staged = null; presented = null; geometryCache.clear(); geometryCacheBytes = 0;
        },
        needsFrame() {
            if (disposed) return false;
            const frame = resources.frames.readFrame();
            if (!frame || !resources.frames.isCurrent(frame)) return false;
            if (staged && staged.frame === frame) return !staged.complete && !staged.failed && !(!staged.job && staged.finished && staged.pending > 0);
            return !presented || presented.frame !== frame || (presented.skipped.size > 0 && performance.now() >= retryAt);
        },
        memory() {
            let cpuBytes = (staged?.bytes ?? 0) + (presented?.bytes ?? 0);
            for (const s of borrowed) if (s !== presented) cpuBytes += s.bytes;
            const held = new Set<GeometryEntry>();
            for (const snapshot of [staged, presented, ...borrowed]) if (snapshot) for (const entry of snapshot.geometry.values()) held.add(entry);
            for (const entry of geometryCache.values()) if (!held.has(entry)) cpuBytes += entry.bytes;
            return { gpuBytes: 0, cpuBytes };
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            if (staged) releaseSnapshot(staged);
            if (presented) releaseSnapshot(presented);
            staged = null; presented = null; geometryCache.clear(); geometryCacheBytes = 0;
        },
    };
}
