import type { PathCommand, ViewState } from '../../../platform/types';
import type { FrameBudget, GpuReleaseReason } from '../../../platform/render/types';
import type { PaintBand } from '../material';
import type { PaintFrame, PaintItem } from '../paintStream';
import type { PaintImageLease, PaintLayerResources } from '../resources';
import { InkPath2dJob, Path2dJob } from './coverage2d';
import type { PathOrigin2d } from './coverage2d';
import { paintItem2d } from './paint2d';
import type { PaintResources2d, PreparedPath2d } from './paint2d';

export interface CanvasPaintAdapter {
    prepare(view: ViewState, budget: FrameBudget): void;
    /** Only a fully prepared, still-current source frame can be atomically presented. */
    readyFrame(): PaintFrame | null;
    present(frame: PaintFrame): boolean;
    draw2d(ctx: CanvasRenderingContext2D, view: ViewState): void;
    release(reason: GpuReleaseReason): void;
    needsFrame(): boolean;
    memory(): { gpuBytes: number; cpuBytes: number };
    dispose(): void;
}

export type PaintProjection2d = (ctx: CanvasRenderingContext2D, view: ViewState, paint: () => void) => void;

type PathJob = Path2dJob | InkPath2dJob;
type Snapshot = {
    frame: PaintFrame;
    scale: number;
    items: readonly PaintItem[];
    index: number;
    clipIndex: number;
    paths: WeakMap<PaintItem, PreparedPath2d>;
    clips: Map<string, PreparedPath2d>;
    geometry: Map<string, { prepared: PreparedPath2d; bytes: number }>;
    images: Map<string, PaintImageLease | null>;
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

function releaseSnapshot(s: Snapshot): void {
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

/** A band retains its old complete frame until its owner atomically presents both bands. */
export function createCanvasPaintAdapter(
    band: PaintBand, resources: PaintLayerResources, project: PaintProjection2d,
    onError: (error: unknown) => void,
): CanvasPaintAdapter {
    let staged: Snapshot | null = null, presented: Snapshot | null = null;
    let disposed = false;
    let lastScale = 0;

    function start(frame: PaintFrame, scale: number): Snapshot {
        return { frame, scale, items: frame[band], index: 0, clipIndex: 0, paths: new WeakMap(),
            clips: new Map(), geometry: new Map(), images: new Map(), abort: new AbortController(),
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
        if (s.index >= s.items.length) {
            if (!s.pending) s.complete = true;
            return;
        }
        const item = s.items[s.index];
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
        } else {
            const itemScale = scaleFor(item, s.scale);
            const key = `${item.kind}:${item.geometryKey}:${item.kind === 'ink' ? itemScale : ''}`;
            const cached = s.geometry.get(key) ?? presented?.geometry.get(key);
            if (cached) {
                if (!s.geometry.has(key)) { s.geometry.set(key, cached); s.bytes += cached.bytes; }
                s.paths.set(item, cached.prepared);
            } else {
                const path = item.kind === 'ink'
                    ? new InkPath2dJob(item.coverage, itemScale, [item.coverage.boundsLocal.x, item.coverage.boundsLocal.y])
                    : new Path2dJob(item.d, pathOrigin(item.d));
                s.job = { key, item, path };
            }
        }
        s.index++;
        s.clipIndex = 0;
    }
    return {
        prepare(view, budget) {
            if (disposed) return;
            const frame = resources.frames.readFrame();
            const scale = view.camera.z * view.viewport.dpr;
            if (!frame || !resources.frames.isCurrent(frame) || !Number.isFinite(scale) || scale <= 0) return;
            lastScale = scale;
            if (staged && (staged.frame !== frame || staged.scale !== scale)) { releaseSnapshot(staged); staged = null; }
            if (!staged && (!presented || presented.frame !== frame || presented.scale !== scale)) staged = start(frame, scale);
            const s = staged;
            if (!s || s.complete || s.failed) return;
            try {
                while (!budget.shouldYield() && !s.complete && !s.failed) {
                    if (!resources.frames.isCurrent(frame)) { releaseSnapshot(s); staged = null; break; }
                    if (!s.job && s.index >= s.items.length && s.pending) break;
                    step(s);
                }
            } catch (error) { s.failed = true; s.failure = error; releaseSnapshot(s); onError(error); }
        },
        readyFrame() {
            if (disposed) return null;
            if (staged?.complete && staged.scale === lastScale && resources.frames.isCurrent(staged.frame)) return staged.frame;
            if (!staged && presented && presented.scale === lastScale && resources.frames.isCurrent(presented.frame)) return presented.frame;
            return null;
        },
        present(frame) {
            if (disposed || !resources.frames.isCurrent(frame)) return false;
            if (!staged) return presented?.frame === frame && presented.scale === lastScale;
            if (!staged.complete || staged.frame !== frame || staged.scale !== lastScale) return false;
            if (presented) releaseSnapshot(presented);
            presented = staged; staged = null;
            return true;
        },
        draw2d(ctx, view) {
            const s = presented;
            if (disposed || !s) return;
            const prepared: PaintResources2d = {
                path: item => { const path = s.paths.get(item); if (!path) throw new Error('Missing prepared path'); return path; },
                clip: key => { const path = s.clips.get(key); if (!path) throw new Error('Missing prepared clip'); return path; },
                image: key => { const image = s.images.get(key); if (!image) throw new Error('Missing prepared image'); return image.source; },
            };
            project(ctx, view, () => { for (const item of s.items) paintItem2d(ctx, item, prepared); });
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
            if (staged && staged.frame === frame) return !staged.complete && !staged.failed && !(!staged.job && staged.index >= staged.items.length && staged.pending > 0);
            return !presented || presented.frame !== frame;
        },
        memory() { return { gpuBytes: 0, cpuBytes: (staged?.bytes ?? 0) + (presented?.bytes ?? 0) }; },
        dispose() {
            if (disposed) return;
            disposed = true;
            if (staged) releaseSnapshot(staged);
            if (presented) releaseSnapshot(presented);
            staged = null; presented = null;
        },
    };
}
