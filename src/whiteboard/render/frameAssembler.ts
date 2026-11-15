import type { RegionChanges } from '../scene/boundsVersions';
import type { RenderToken } from '../../platform/render/types';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { BoardDoc } from '../model/doc';
import type { Rect } from '../../platform/types';
import { PaintStreamJob } from './paintStream';
import type { PaintItem, PaintNode, PaintNodeSource, PaintSource } from './paintStream';
import { PAINT_WINDOW_ITEMS, PaintWindowBuilder } from './paintWindows';
import type { PaintBand } from './material';
import type { PaintFrameAssembler, PinnedPaintSource, PinnedPaintStream } from './frameTypes';
import type { SessionDenseRasters } from './sessionDenseRasters';
import type { ScenePaintNodeStream } from './scenePaintStream';
import type { ResolvedNodeCache } from './resolvedNodeCache';

const BLOCK_BYTES = 64 * 1024;
// Array capacity and Set bookkeeping are JS-engine dependent; retain conservative per-entry
// estimates, including spare array capacity. The source owns the PaintItem objects themselves.
const REFERENCE_BYTES = 16;
const INK_SET_ENTRY_BYTES = 64;
const FRAME_BASE_BYTES = 256;
// Per-window bookkeeping of a live frame: the window object, its frozen array and its band entry.
const WINDOW_BYTES = 64;
interface Block { readonly owner: MemoryAllocator; readonly lease: ByteLease }

/** What a frame borrows from its source: identity fields read at publication, the pinned
 * release, and whether the scene behind it is still current. */
interface Owner {
    readonly token: RenderToken;
    readonly theme?: 'light' | 'dark';
    readonly sceneRevision: number;
    readonly sourceDoc?: BoardDoc;
    readonly sensitiveNodes?: ReadonlySet<string>;
    readonly sessionRasters?: SessionDenseRasters;
    readonly rasterVariant?: string;
    readonly sourceWorld?: Readonly<Rect>;
    readonly regionChangesSince?: (from: number) => RegionChanges;
    readonly sensitiveMayMeet?: (world: Readonly<Rect>, nodes: ReadonlySet<string>) => boolean;
    readonly mayPaint?: (world: Readonly<Rect>) => boolean;
    readonly occupiedRoot?: Readonly<Rect>;
    readonly openTile?: (world: Readonly<Rect>, signal: AbortSignal, resolved?: ResolvedNodeCache) => Promise<ScenePaintNodeStream>;
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
/** Where staged items go: band arrays for a full frame, bounded windows for a live-only frame. A live frame
 * never builds a whole band array, so its staging holds only the windows already closed plus one open window. */
type StagedItems =
    | { readonly kind: 'arrays'; readonly underlay: PaintItem[]; readonly content: PaintItem[] }
    | { readonly kind: 'windows'; readonly underlay: PaintWindowBuilder; readonly content: PaintWindowBuilder };
interface Staging {
    readonly owner: Owner;
    feed: Feed;
    readonly items: StagedItems;
    /** Live items admitted so far; each window's bookkeeping is charged once per window, not per item. */
    windowed: number;
    readonly inkNodeIds: Set<string>;
    readonly blocks: Block[];
    used: number;
}
interface Published {
    readonly owner: Owner; readonly frame: PaintSource; readonly blocks: Block[];
    borrowers: number;
    retired: boolean;
    releasing: boolean;
}

function syncOwner(pin: PinnedPaintSource): Owner {
    return {
        get token() { return pin.source.token; },
        get theme() { return pin.source.theme; },
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
        get theme() { return stream.theme; },
        get sceneRevision() { return stream.sceneRevision; },
        get sourceDoc() { return stream.sourceDoc; },
        get sensitiveNodes() { return stream.sensitiveNodes; },
        get sessionRasters() { return stream.sessionRasters; },
        get rasterVariant() { return stream.rasterVariant; },
        get sourceWorld() { return stream.sourceWorld; },
        get regionChangesSince() { return stream.regionChangesSince; },
        get sensitiveMayMeet() { return stream.sensitiveMayMeet; },
        get mayPaint() { return stream.mayPaint; },
        get occupiedRoot() { return stream.occupiedRoot; },
        openTile: pin.open ? (world, signal, resolved) => pin.open!(world, signal, resolved) : undefined,
        liveOnly: pin.liveOnly,
        isCurrent: () => pin.isCurrent(),
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
/** Pulls nodes in background slices bounded by the staged blocks and a short time budget, then wakes
 * the host once per slice. A per-node wake would cost one host frame for every scene node. */
function streamFeed(stream: PinnedPaintStream['stream'], add: Add, room: () => boolean, wake: () => void): Feed {
    const SLICE_MS = 4;
    let pumping = false, ended = false, cancelled = false, failure: { error: unknown } | null = null;
    const pump = async () => {
        const started = performance.now();
        try {
            while (!cancelled && !ended && room() && performance.now() - started < SLICE_MS) {
                const node: PaintNode | null = await stream.next();
                if (cancelled) return;
                if (node === null) { ended = true; return; }
                // A node is admitted whole; its items are the only per-node memory, already bounded by the source.
                for (const item of node.underlay ?? []) add(item, 'underlay');
                for (const item of node.content) add(item, 'content');
            }
        } catch (error) { if (!cancelled) failure = { error }; }
        finally {
            pumping = false;
            if (!cancelled) wake();
        }
    };
    return {
        step() {
            if (failure) { const { error } = failure; failure = null; throw error; }
            if (cancelled) return 'cancelled';
            if (pumping) return 'waiting';
            // EOF physically closes the cursor, not the immutable source the finished frame owns.
            if (ended) return 'complete';
            if (!stream.isCurrent()) return 'stale';
            if (!room()) return 'waiting';
            pumping = true;
            void pump();
            return 'waiting';
        },
        get waiting() { return pumping; },
        cancel() { cancelled = true; },
    };
}

/** Stages source commands in bounded slices. A retired frame's source lease remains owned until
 * the backend explicitly drops it; a newer requested revision alone never frees pixels in use. */
export function createPaintFrameAssembler(invalidate: () => void, onError: (error: unknown) => void): PaintFrameAssembler {
    let staging: Staging | null = null, latest: Published | null = null, disposed = false;
    let allocator: MemoryAllocator | null = null, blocked = false, heldBytes = 0;
    const retained = new Map<PaintSource, Published>(), retiring = new Set<Promise<void>>();
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
    const retire = (frame: PaintSource) => {
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
    const start = (owner: Owner, feed: (add: Add, room: () => boolean) => Feed): void => {
        dropStaging();
        const inkNodeIds = new Set<string>(), blocks: Block[] = [];
        const items: StagedItems = owner.liveOnly
            ? { kind: 'windows', underlay: new PaintWindowBuilder(), content: new PaintWindowBuilder() }
            : { kind: 'arrays', underlay: [], content: [] };
        const work: Staging = { owner, feed: IDLE_FEED, items, windowed: 0, inkNodeIds, blocks, used: FRAME_BASE_BYTES };
        const add: Add = (item, band) => {
            if (items.kind === 'arrays') (band === 'underlay' ? items.underlay : items.content).push(item);
            else {
                (band === 'underlay' ? items.underlay : items.content).push(band, item);
                if (work.windowed++ % PAINT_WINDOW_ITEMS === 0) work.used += WINDOW_BYTES;
            }
            work.used += REFERENCE_BYTES;
            if (item.kind === 'ink' && !inkNodeIds.has(item.nodeId)) {
                inkNodeIds.add(item.nodeId); work.used += INK_SET_ENTRY_BYTES;
            }
        };
        work.feed = feed(add, () => !needsBlock(work));
        staging = work;
        invalidate();
    };
    // A denied block waits for a real capacity change; the wake only re-runs the staged build, it never polls.
    const wakeStaged = () => { if (!disposed && staging && blocked) { blocked = false; invalidate(); } };
    const publish = (work: Staging) => {
        const o = work.owner, staged = work.items;
        const root = { token: o.token, sceneRevision: o.sceneRevision,
            theme: o.theme, sourceDoc: o.sourceDoc, sensitiveNodes: o.sensitiveNodes,
            sessionRasters: o.sessionRasters, rasterVariant: o.rasterVariant, sourceWorld: o.sourceWorld, openTile: o.openTile,
            regionChangesSince: o.regionChangesSince, sensitiveMayMeet: o.sensitiveMayMeet, mayPaint: o.mayPaint, occupiedRoot: o.occupiedRoot,
            inkNodeIds: work.inkNodeIds };
        const frame: PaintSource = staged.kind === 'windows'
            ? Object.freeze({ ...root, liveOnly: true as const, windows: Object.freeze([...staged.underlay.finish(), ...staged.content.finish()]) })
            : Object.freeze({ ...root, underlay: Object.freeze(staged.underlay), content: Object.freeze(staged.content) });
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
            start(streamOwner(pin), (add, room) => streamFeed(pin.stream, add, room, () => { if (staging) invalidate(); }));
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
                        if (!lease) { blocked = true; allocator.whenAvailable?.(wakeStaged); return; }
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
        blocked: () => !disposed && blocked && staging !== null,
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
