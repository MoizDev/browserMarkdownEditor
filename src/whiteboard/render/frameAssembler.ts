import type { RenderToken } from '../../platform/render/types';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { BoardDoc } from '../model/doc';
import type { Rect } from '../../platform/types';
import { PaintStreamJob } from './paintStream';
import type { PaintFrame, PaintItem, PaintNode, PaintNodeSource } from './paintStream';
import type { PaintBand } from './material';
import type { PaintFrameAssembler, PinnedPaintSource, PinnedPaintStream } from './frameTypes';
import type { SessionDenseRasters } from './sessionDenseRasters';
import type { ScenePaintNodeStream } from './scenePaintStream';

const BLOCK_BYTES = 64 * 1024;
// Array capacity and Set bookkeeping are JS-engine dependent; retain conservative per-entry
// estimates, including spare array capacity. The source owns the PaintItem objects themselves.
const REFERENCE_BYTES = 16;
const INK_SET_ENTRY_BYTES = 64;
const FRAME_BASE_BYTES = 256;
interface Block { readonly owner: MemoryAllocator; readonly lease: ByteLease }

/** What a frame borrows from its source: identity fields read at publication, the pinned
 * release, and whether the scene behind it is still current. */
interface Owner {
    readonly token: RenderToken;
    readonly sceneRevision: number;
    readonly sourceDoc?: BoardDoc;
    readonly sensitiveNodes?: ReadonlySet<string>;
    readonly sessionRasters?: SessionDenseRasters;
    readonly rasterVariant?: string;
    readonly sourceWorld?: Readonly<Rect>;
    readonly openTile?: (world: Readonly<Rect>, signal: AbortSignal) => Promise<ScenePaintNodeStream>;
    readonly liveOnly?: true;
    isCurrent(): boolean;
    release(): void | Promise<void>;
}
type Add = (item: PaintItem, band: PaintBand) => void;
/** One bounded unit of work per step(). 'waiting' means an awaited node has not arrived yet;
 * the feed calls wake() when it does, so the host need not poll. */
interface Feed {
    step(): 'pending' | 'waiting' | 'complete' | 'stale' | 'cancelled';
    readonly waiting: boolean;
    cancel(): void;
}
interface Staging {
    readonly owner: Owner;
    feed: Feed;
    readonly underlay: PaintItem[];
    readonly content: PaintItem[];
    readonly inkNodeIds: Set<string>;
    readonly blocks: Block[];
    used: number;
}
interface Published {
    readonly owner: Owner; readonly frame: PaintFrame; readonly blocks: Block[];
    borrowers: number;
    retired: boolean;
    releasing: boolean;
}

function syncOwner(pin: PinnedPaintSource): Owner {
    return {
        get token() { return pin.source.token; },
        get sceneRevision() { return pin.source.sceneRevision; },
        get sourceDoc() { return pin.source.sourceDoc; },
        get sensitiveNodes() { return pin.source.sensitiveNodes; },
        get sessionRasters() { return (pin.source as PaintNodeSource & { sessionRasters?: SessionDenseRasters }).sessionRasters; },
        get rasterVariant() { return (pin.source as PaintNodeSource & { rasterVariant?: string }).rasterVariant; },
        get sourceWorld() { return (pin.source as PaintNodeSource & { sourceWorld?: Readonly<Rect> }).sourceWorld; },
        isCurrent: () => pin.source.isCurrent(),
        release: () => pin.release(),
    };
}
function streamOwner(pin: PinnedPaintStream): Owner {
    const stream = pin.stream;
    return {
        get token() { return stream.token; },
        get sceneRevision() { return stream.sceneRevision; },
        get sourceDoc() { return stream.sourceDoc; },
        get sensitiveNodes() { return stream.sensitiveNodes; },
        get sessionRasters() { return stream.sessionRasters; },
        get rasterVariant() { return stream.rasterVariant; },
        get sourceWorld() { return stream.sourceWorld; },
        openTile: pin.open ? (world, signal) => pin.open!(world, signal) : undefined,
        liveOnly: pin.liveOnly,
        isCurrent: () => stream.isCurrent(),
        // The stream drains its active next() before the snapshot that pins its sources may go.
        async release() {
            try { await stream.release(); } finally { await pin.release(); }
        },
    };
}
function syncFeed(source: PaintNodeSource, add: Add): Feed {
    const job = new PaintStreamJob(source, add);
    return {
        step: () => job.step(1),
        get waiting() { return false; },
        cancel: () => job.cancel(),
    };
}
const IDLE_FEED: Feed = { step: () => 'cancelled', get waiting() { return false; }, cancel() { /* Nothing staged yet. */ } };
function streamFeed(stream: PinnedPaintStream['stream'], add: Add, wake: () => void): Feed {
    let pending: Promise<void> | null = null, ended = false, cancelled = false, failure: { error: unknown } | null = null;
    return {
        step() {
            if (failure) { const { error } = failure; failure = null; throw error; }
            if (cancelled) return 'cancelled';
            if (!stream.isCurrent()) return 'stale';
            if (pending) return 'waiting';
            if (ended) return 'complete';
            const run: Promise<void> = stream.next().then((node: PaintNode | null) => {
                if (cancelled) return;
                if (node === null) { ended = true; return; }
                // A node is admitted whole; its items are the only per-node memory, already bounded by the source.
                for (const item of node.underlay ?? []) add(item, 'underlay');
                for (const item of node.content) add(item, 'content');
            }, error => { if (!cancelled) failure = { error }; }).finally(() => {
                if (pending === run) pending = null;
                if (!cancelled) wake();
            });
            pending = run;
            return 'waiting';
        },
        get waiting() { return pending !== null; },
        cancel() { cancelled = true; },
    };
}

/** Stages source commands in bounded slices. A retired frame's source lease remains owned until
 * the backend explicitly drops it; a newer requested revision alone never frees pixels in use. */
export function createPaintFrameAssembler(invalidate: () => void, onError: (error: unknown) => void): PaintFrameAssembler {
    let staging: Staging | null = null, latest: Published | null = null, disposed = false;
    let allocator: MemoryAllocator | null = null, blocked = false, heldBytes = 0;
    const retained = new Map<PaintFrame, Published>(), retiring = new Set<Promise<void>>();
    const waiters = new Set<() => void>();
    const report = (error: unknown) => { try { onError(error); } catch { /* Cleanup must still release every lease. */ } };
    const notifyRetired = () => {
        if (retiring.size) return;
        for (const entry of retained.values()) if (entry.retired) return;
        for (const resolve of waiters) resolve();
        waiters.clear();
    };
    const releaseBlocks = (blocks: Block[]) => {
        for (const block of blocks.splice(0)) {
            heldBytes -= block.lease.bytes;
            try { block.owner.release(block.lease); } catch (error) { report(error); }
        }
    };
    const releaseOwned = (owner: Owner, blocks: Block[], complete?: () => void) => {
        let result: void | Promise<void>;
        try { result = owner.release(); } catch (error) { report(error); result = undefined; }
        const pending = Promise.resolve(result).catch(report).then(() => {
            releaseBlocks(blocks); complete?.();
            if (!disposed && staging && blocked) { blocked = false; invalidate(); }
        }).catch(report);
        retiring.add(pending);
        void pending.then(() => { retiring.delete(pending); notifyRetired(); });
    };
    const dropStaging = () => {
        const work = staging; staging = null; blocked = false;
        if (!work) return;
        try { work.feed.cancel(); } catch (error) { report(error); }
        releaseOwned(work.owner, work.blocks);
    };
    const freeRetired = (entry: Published) => {
        if (!entry.retired || entry.borrowers || entry.releasing) return;
        entry.releasing = true;
        releaseOwned(entry.owner, entry.blocks, () => { retained.delete(entry.frame); });
    };
    const retire = (frame: PaintFrame) => {
        const entry = retained.get(frame);
        if (!entry || entry === latest) return;
        entry.retired = true;
        freeRetired(entry); notifyRetired();
    };
    const clear = () => {
        const work = staging; staging = null; latest = null; blocked = false;
        if (work) {
            try { work.feed.cancel(); } catch (error) { report(error); }
            releaseOwned(work.owner, work.blocks);
        }
        for (const entry of retained.values()) { entry.retired = true; freeRetired(entry); }
        notifyRetired();
    };
    const needsBlock = (work: Staging) => work.used + REFERENCE_BYTES + INK_SET_ENTRY_BYTES > work.blocks.length * BLOCK_BYTES;
    const start = (owner: Owner, feed: (add: Add) => Feed): void => {
        dropStaging();
        const underlay: PaintItem[] = [], content: PaintItem[] = [], inkNodeIds = new Set<string>();
        const blocks: Block[] = [];
        const work: Staging = { owner, feed: IDLE_FEED, underlay, content, inkNodeIds, blocks, used: FRAME_BASE_BYTES };
        const add: Add = (item, band) => {
            (band === 'underlay' ? underlay : content).push(item);
            work.used += REFERENCE_BYTES;
            if (item.kind === 'ink' && !inkNodeIds.has(item.nodeId)) {
                inkNodeIds.add(item.nodeId); work.used += INK_SET_ENTRY_BYTES;
            }
        };
        work.feed = feed(add);
        staging = work;
        invalidate();
    };
    const publish = (work: Staging) => {
        const o = work.owner;
        const frame: PaintFrame = Object.freeze({ token: o.token, sceneRevision: o.sceneRevision,
            sourceDoc: o.sourceDoc, sensitiveNodes: o.sensitiveNodes,
            sessionRasters: o.sessionRasters, rasterVariant: o.rasterVariant, sourceWorld: o.sourceWorld, openTile: o.openTile,
            ...(o.liveOnly ? { liveOnly: true as const } : {}),
            underlay: Object.freeze(work.underlay), content: Object.freeze(work.content), inkNodeIds: work.inkNodeIds });
        const published: Published = { owner: o, frame, blocks: work.blocks, borrowers: 0, retired: false, releasing: false };
        retained.set(frame, published); latest = published; staging = null; invalidate();
    };
    return {
        bindMemory(next) {
            if (disposed || allocator === next) return;
            allocator = next;
            if (staging && blocked) { blocked = false; invalidate(); }
        },
        cpuWorkingSet: () => heldBytes + (!disposed && staging && needsBlock(staging) ? BLOCK_BYTES : 0),
        memoryBytes: () => heldBytes,
        request(pin) {
            if (disposed) { releaseOwned(syncOwner(pin), []); return; }
            start(syncOwner(pin), add => syncFeed(pin.source, add));
        },
        requestStream(pin) {
            if (disposed) { releaseOwned(streamOwner(pin), []); return; }
            start(streamOwner(pin), add => streamFeed(pin.stream, add, () => { if (staging) invalidate(); }));
        },
        prepare(budget) {
            const work = staging;
            if (disposed || !work) return;
            blocked = false;
            try {
                while (!budget.shouldYield()) {
                    if (needsBlock(work)) {
                        if (!allocator) { blocked = true; return; }
                        const lease = allocator.reserve(BLOCK_BYTES);
                        if (!lease) { blocked = true; return; }
                        work.blocks.push({ owner: allocator, lease }); heldBytes += lease.bytes;
                    }
                    const status = work.feed.step();
                    if (status === 'pending') continue;
                    if (status === 'waiting') return;
                    if (status !== 'complete') { dropStaging(); return; }
                    publish(work); return;
                }
            } catch (error) { dropStaging(); report(error); }
        },
        readFrame: () => disposed ? null : latest?.frame ?? null,
        isCurrent: frame => !disposed && retained.has(frame) && !retained.get(frame)!.retired && retained.get(frame)!.owner.isCurrent(),
        retain(frame) {
            const entry = retained.get(frame);
            if (disposed || !entry || entry.retired) throw new Error('Cannot retain an unowned paint frame');
            entry.borrowers++;
            let released = false;
            return () => {
                if (released) return;
                released = true; entry.borrowers--;
                freeRetired(entry); notifyRetired();
            };
        },
        needsFrame: () => !disposed && staging !== null && !blocked && !staging.feed.waiting,
        presented(frame) {
            if (!retained.has(frame)) throw new Error('Cannot present an unowned paint frame');
        },
        retire,
        clear,
        whenRetired() {
            if (!retiring.size && ![...retained.values()].some(entry => entry.retired)) return Promise.resolve();
            return new Promise<void>(resolve => { waiters.add(resolve); });
        },
        dispose() {
            if (disposed) return;
            disposed = true; clear();
        },
    };
}
