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
    /** `vectors: false` (a device frame) prepares no outline for path and ink items: the GPU routes draw them from the items
     * themselves, and its CPU route builds its own. Only a canvas2d draw needs them; a prepare that asks for them then (a resize
     * bridge, the first picture) replaces a snapshot without. Built for a device anyway, an old 450-stroke notebook held 110 MB of
     * outlines on the CPU at rest that nothing drew, and the CPU target rose to 141 MB for them. Clips are always prepared: the
     * CPU route clips with them. */
    prepare(view: ViewState, budget: FrameBudget, vectors?: boolean): void;
    /** The complete shared frame actually available to both band wrappers. */
    readyFrame(): PaintSource | null;
    /** Whether the presented snapshot carries outlines (a 2D draw asked for them): a device frame then prepares again, to shed them. */
    outlined?(): boolean;
    /** True while a build for the current frame is staged and unfinished: work only a later prepare advances. */
    building?(): boolean;
    /** Borrow is valid only until the next prepare, release or dispose. */
    borrowPrepared(): PreparedPaint2d | null;
    /** Physical retention for asynchronous fact work: the returned prepared resources, their image
     * leases and (for dense plans) their bitmaps stay alive until release, even after the adapter has
     * moved on. Null when nothing is presented. */
    retainPrepared(): PreparedRetain | null;
    draw2d(ctx: CanvasRenderingContext2D, view: ViewState, band: PaintBand, omitNodes?: ReadonlySet<string>): void;
    /** True when the presented paint holds every picture its items draw. A picture the GPU side released (it draws from its texture) or
     * one being decoded again cannot be drawn on the CPU; a canvas2d pane releases nothing, so there it is true once presented. */
    drawable2d(): boolean;
    /** Asks again for every picture the GPU side released from the presented paint, because a 2D frame (a WebGL2 pane's resize
     * bridge) is about to draw it; each settlement invalidates the frame. Returns how many it asked for. */
    reacquireReleased(): number;
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

/** The GPU side's hold on a picture's decoded bitmap, on the prepared resources of one paint. Once a GPU texture holds the
 * pixels the GPU side releases the bitmap (the provider's lease, the largest copy of the picture), and asks for it again when
 * a draw needs it. Only the GPU side calls it: a canvas2d draw never releases anything, so its output is unchanged. A released
 * picture cannot be drawn from its bitmap, so the GPU side reacquires it before any CPU draw of that picture. */
export interface PaintImageHold {
    /** 'ready': the bitmap is held; 'released': it was given up; 'absent': not held (never requested, or still decoding). */
    imageState(key: string): 'ready' | 'released' | 'absent';
    /** Gives up the bitmap of a held picture; returns true when there was one to give up. */
    releaseImage(key: string): boolean;
    /** The held picture's size and, for a video node, the version of the frame its lease holds (0 for a picture). Null when not held. */
    imageFact(key: string): { readonly width: number; readonly height: number; readonly version: number } | null;
    /** Requests a released or absent picture again; its settlement invalidates the frame. A request already in flight is kept. */
    reacquireImage(key: string): void;
    /** True for a picture this adapter will never hold (its bytes could not be decoded): asking again changes nothing, so the GPU side
     * draws canvas2d's placeholder for it. A picture a memory refusal skipped is not broken: the next snapshot asks for it again. */
    imageBroken(key: string): boolean;
    /** True while a picture this snapshot asked for may still come: its decode is in flight, or a memory refusal skipped it here (the
     * next snapshot asks again). The GPU composer recomposes a tile that left such a picture out once this turns false. */
    imageWaiting(key: string): boolean;
}

export interface PreparedRetain {
    readonly prepared: PreparedPaint2d;
    /** A further borrow of the same resources, taken only while this one is open; null once released. */
    retain(): PreparedRetain | null;
    release(): void;
}

export type PaintProjection2d = (ctx: CanvasRenderingContext2D, view: ViewState, paint: () => void) => void;

type PathJob = Path2dJob | InkCoverageUnionPath2dJob;
type GeometryEntry = { prepared: PreparedPath2d; bytes: number };
/** Path geometry kept across revisions: about a few boards' strokes, far below the CPU grant. */
const GEOMETRY_CACHE_BYTES = 8 * 1024 * 1024;
type Snapshot = {
    frame: PaintSource;
    scale: number;
    /** Whether path and ink outlines are prepared (see CanvasPaintAdapter.prepare); a snapshot without them cannot draw 2D. */
    vectors: boolean;
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
    /** Pictures whose bitmap the GPU side gave up (imageState 'released'); reacquired by requestImage. */
    released: Set<string>;
    /** The pictures this paint's own items draw. The GPU route also requests finer tiles into the snapshot (reacquireImage) that
     * no 2D draw reads: a 2D frame waits on, and asks again for, only these. */
    drawn: Set<string>;
    /** Images a memory refusal skipped in this snapshot: drawn as placeholders now, asked for again by the next snapshot. */
    skipped: Set<string>;
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
/** Pacing of the retry of pictures a memory refusal skipped: a shortage clears as tiles retire, not within a frame. */
const RETRY_SKIPPED_MS = 400;

export function createCanvasPaintAdapter(
    resources: PaintLayerResources, project: PaintProjection2d, onError: (error: unknown) => void,
    /** Items this adapter prepares; an excluded item is skipped in place, so a frame never needs a filtered copy. */
    include?: (item: PaintItem) => boolean,
): CanvasPaintAdapter {
    let staged: Snapshot | null = null, presented: Snapshot | null = null;
    // Pictures whose decode failed (refused memory, unreadable bytes): drawn as a placeholder, never failing the frame, and not asked
    // for again while this adapter lives. One failed picture used to fail the snapshot and, through onError, the whole board
    // ('Could not open canvas: Insufficient memory for full-frame image', measured on a 4000x3000 picture). The image provider
    // reports the failure to the person as the app's own notice.
    const broken = new Set<string>();
    let retryAt = 0;
    // Path geometry by job key (geometry key, item key, scale), least recently used first, up to GEOMETRY_CACHE_BYTES. A key is minted
    // only when a node's geometry is rebuilt and a move keeps it, so a new revision re-uses each path it did not change, and two
    // precisions alternating frame to frame both stay (presentation must not prune the other one: that re-tessellated it every frame).
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
    // Snapshots kept alive only by retainPrepared borrows: their memory is still held and counted.
    const borrowed = new Set<Snapshot>();
    let disposed = false;
    let lastFrameId: number | null = null;

    function start(frame: PaintSource, scale: number, vectors: boolean): Snapshot {
        const windows = windowsOfSource(frame);
        // A full frame's window list duplicates its band arrays, so it is charged; a live frame's list is the frame's own.
        return { frame, scale, vectors, windows, window: 0, finished: false, index: 0, clipIndex: 0, paths: new WeakMap(), prepared: null,
            clips: new Map(), geometry: new Map(), images: new Map(), released: new Set(), drawn: new Set(), skipped: new Set(), borrows: 0, closing: false, abort: new AbortController(),
            pending: 0, failed: false, failure: undefined, complete: false, disposed: false,
            bytes: frame.liveOnly ? 0 : refBytesOf(windows), job: null };
    }
    // A still picture's lease, counted, so two snapshots of one frame can hold it at once. A zoom step starts a snapshot at the new
    // scale, and asking the provider again for a picture the presented snapshot holds settled only a task later: the step presented
    // the old snapshot at the new camera, then the new one when the lease landed (measured, canvas2d, a 4000x3000 picture at DPR 2:
    // 80 presents for 40 wheel steps). A share is taken in the same prepare, so the step's snapshot completes in its own frame.
    const shares = new WeakMap<PaintImageLease, { readonly lease: PaintImageLease; count: number }>();
    function shareHandle(root: { readonly lease: PaintImageLease; count: number }): PaintImageLease {
        let open = true;
        const handle: PaintImageLease = { source: root.lease.source, width: root.lease.width, height: root.lease.height, cpuBytes: root.lease.cpuBytes,
            release() { if (!open) return; open = false; if (--root.count === 0) root.lease.release(); } };
        shares.set(handle, root);
        return handle;
    }
    // A video frame's lease carries the version of its frame, and a new snapshot wants the newest: only stills are shared.
    const counted = (lease: PaintImageLease): PaintImageLease =>
        (lease as { readonly version?: unknown }).version === undefined ? shareHandle({ lease, count: 1 }) : lease;
    function requestImage(s: Snapshot, key: string): void {
        if (s.images.has(key) || broken.has(key) || s.skipped.has(key)) return;
        // A picture whose texture the device already holds starts released, as the GPU route leaves it once uploaded: asked for, it
        // was decoded again at every new snapshot (an edit, a selection) only to be released unread (measured, a 4000x3000 JPEG
        // inserted on a WebGL2 drawing: its stand-in decoded a second time 150 ms after the first). A CPU draw that needs it
        // (a bridge, reacquireReleased) or a texture that is gone (the route's reacquireImage) asks for it again.
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
            // A memory refusal, or a request the residency retired (stale tile, cancelled decode) while this snapshot still lives, is a
            // shortage of this moment: the picture is skipped in this frame (placeholder) and asked for again by the next. Left as it
            // was, a retired request ended this snapshot with no image and painting it failed the board ('Could not open canvas:
            // Missing prepared image', measured on an 8000x6000 JPEG at DPR 2). Any other failure (unreadable bytes) is the
            // picture's own: it stays a placeholder while this adapter lives.
            if (!s.disposed && !s.abort.signal.aborted) {
                const transient = isTransientPictureFailure(error);
                if (transient) s.skipped.add(key); else broken.add(key);
                // A picture tile refused for memory: the next plan of that picture at this zoom takes a coarser level.
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
                if (broken.has(key) || s.skipped.has(key)) return null; // a placeholder; see the requestImage failure path
                const image = s.images.get(key);
                if (image) return image.source;
                throw new Error(s.released.has(key) ? 'Released prepared image' : 'Missing prepared image');
            },
            ...imageHold(s),
        } };
        return s.prepared;
    }
    // The presented paint holds every picture its items draw (see CanvasPaintAdapter.drawable2d).
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
            // A snapshot with outlines serves a frame that needs none; one without cannot serve a 2D draw. An outlined build still in
            // progress is let go by a device frame the presented snapshot already serves: only a 2D draw (a resize bridge since skipped)
            // wanted its outlines, and finished it would only be shed again.
            const presentedServes = !!presented && presented.frame === frame && presented.scale === scale;
            if (staged && (staged.frame !== frame || staged.scale !== scale || (vectors && !staged.vectors) || (!vectors && staged.vectors && presentedServes))) {
                releaseSnapshot(staged); staged = null;
            }
            // A presented snapshot that skipped pictures for want of memory is redone, paced, until they draw: nothing else would ask
            // again while the frame and scale stay the same, and the placeholder stayed for good (measured: 8000x6000 at DPR 2).
            const retry = !staged && !!presented && presented.frame === frame && presented.scale === scale && presented.skipped.size > 0;
            if (retry && performance.now() < retryAt) { resources.wakeAt?.(retryAt); return; }
            // A device frame over a snapshot a 2D draw built with outlines (a resize bridge, the first picture) builds it again without
            // them: kept, a bridge's outlines stayed for good (measured, a notebook beside a drawing, four divider drags: its floor
            // 9.2 -> 22.5 MB and its charge 8.2 -> 21.7 MB, with 3 of the 4 bridges skipped, so the outlines mostly drew nothing).
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
                    // Only an outlined build reads the cached outlines (a clip reads its own snapshot's), so a device's build lets them go
                    // with the bridge's: kept, they stayed counted in memory() and charged to the pane (measured: 8.4 MB a board, both
                    // panes of a two-board resize run, for good). A later bridge builds its outlines again, as one did before the cache.
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
            // Only the pictures the 2D paint draws: re-decoding every GPU-planned finer tile (tens of MB at 400%) into the CPU pool
            // when the bridge is short of it refused the bridge's own frame again (gpu-f2's review).
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
            // Cached geometry that no open snapshot holds is counted here; a snapshot counts the entries it holds.
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
