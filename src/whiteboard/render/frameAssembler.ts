import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { PaintStreamJob } from './paintStream';
import type { PaintFrame, PaintItem } from './paintStream';
import type { PaintFrameAssembler, PinnedPaintSource } from './frameTypes';

const BLOCK_BYTES = 64 * 1024;
// Array capacity and Set bookkeeping are JS-engine dependent; retain conservative per-entry
// estimates, including spare array capacity. The source owns the PaintItem objects themselves.
const REFERENCE_BYTES = 16;
const INK_SET_ENTRY_BYTES = 64;
const FRAME_BASE_BYTES = 256;
interface Block { readonly owner: MemoryAllocator; readonly lease: ByteLease }
interface Staging {
    readonly pin: PinnedPaintSource;
    readonly job: PaintStreamJob;
    readonly underlay: PaintItem[];
    readonly content: PaintItem[];
    readonly inkNodeIds: Set<string>;
    readonly blocks: Block[];
    used: number;
}
interface Published {
    readonly pin: PinnedPaintSource; readonly frame: PaintFrame; readonly blocks: Block[];
    borrowers: number;
    retired: boolean;
    releasing: boolean;
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
    const releaseOwned = (pin: PinnedPaintSource, blocks: Block[], complete?: () => void) => {
        let result: void | Promise<void>;
        try { result = pin.release(); } catch (error) { report(error); result = undefined; }
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
        try { work.job.cancel(); } catch (error) { report(error); }
        releaseOwned(work.pin, work.blocks);
    };
    const freeRetired = (entry: Published) => {
        if (!entry.retired || entry.borrowers || entry.releasing) return;
        entry.releasing = true;
        releaseOwned(entry.pin, entry.blocks, () => { retained.delete(entry.frame); });
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
            try { work.job.cancel(); } catch (error) { report(error); }
            releaseOwned(work.pin, work.blocks);
        }
        for (const entry of retained.values()) { entry.retired = true; freeRetired(entry); }
        notifyRetired();
    };
    const needsBlock = (work: Staging) => work.used + REFERENCE_BYTES + INK_SET_ENTRY_BYTES > work.blocks.length * BLOCK_BYTES;
    return {
        bindMemory(next) {
            if (disposed || allocator === next) return;
            allocator = next;
            if (staging && blocked) { blocked = false; invalidate(); }
        },
        cpuWorkingSet: () => heldBytes + (!disposed && staging && needsBlock(staging) ? BLOCK_BYTES : 0),
        memoryBytes: () => heldBytes,
        request(pin) {
            if (disposed) { releaseOwned(pin, []); return; }
            dropStaging();
            const underlay: PaintItem[] = [], content: PaintItem[] = [], inkNodeIds = new Set<string>();
            const blocks: Block[] = [];
            const work: Staging = { pin, underlay, content, inkNodeIds, blocks, used: FRAME_BASE_BYTES,
                job: new PaintStreamJob(pin.source, (item, band) => {
                    (band === 'underlay' ? underlay : content).push(item);
                    work.used += REFERENCE_BYTES;
                    if (item.kind === 'ink' && !inkNodeIds.has(item.nodeId)) {
                        inkNodeIds.add(item.nodeId); work.used += INK_SET_ENTRY_BYTES;
                    }
                }) };
            staging = work;
            invalidate();
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
                    const status = work.job.step(1);
                    if (status === 'pending') continue;
                    if (status !== 'complete') { dropStaging(); return; }
                    const frame: PaintFrame = Object.freeze({ token: work.pin.source.token, sceneRevision: work.pin.source.sceneRevision,
                        sourceDoc: work.pin.source.sourceDoc, sensitiveNodes: work.pin.source.sensitiveNodes,
                        sessionRasters: work.pin.source.sessionRasters, rasterVariant: work.pin.source.rasterVariant, sourceWorld: work.pin.source.sourceWorld,
                        underlay: Object.freeze(work.underlay), content: Object.freeze(work.content), inkNodeIds: work.inkNodeIds });
                    const published: Published = { pin: work.pin, frame, blocks: work.blocks, borrowers: 0, retired: false, releasing: false };
                    retained.set(frame, published); latest = published; staging = null; invalidate(); return;
                }
            } catch (error) { dropStaging(); report(error); }
        },
        readFrame: () => disposed ? null : latest?.frame ?? null,
        isCurrent: frame => !disposed && retained.has(frame) && !retained.get(frame)!.retired && retained.get(frame)!.pin.source.isCurrent(),
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
        needsFrame: () => !disposed && staging !== null && !blocked,
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
