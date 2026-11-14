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
interface Published { readonly pin: PinnedPaintSource; readonly frame: PaintFrame; readonly blocks: Block[] }

/** Stages source commands in bounded slices. A retired frame's source lease remains owned until
 * the backend explicitly drops it; a newer requested revision alone never frees pixels in use. */
export function createPaintFrameAssembler(invalidate: () => void, onError: (error: unknown) => void): PaintFrameAssembler {
    let staging: Staging | null = null, latest: Published | null = null, disposed = false;
    let allocator: MemoryAllocator | null = null, blocked = false, heldBytes = 0;
    const retained = new Map<PaintFrame, Published>();
    const releaseBlocks = (blocks: Block[], errors: unknown[]) => {
        for (const block of blocks.splice(0)) {
            heldBytes -= BLOCK_BYTES;
            try { block.owner.release(block.lease); } catch (error) { errors.push(error); }
        }
    };
    const releasePin = (pin: PinnedPaintSource, errors: unknown[]) => {
        try { pin.release(); } catch (error) { errors.push(error); }
    };
    const throwErrors = (errors: unknown[]) => { if (errors.length) throw new AggregateError(errors, 'Failed to release paint frame resources'); };
    const dropStaging = () => {
        const work = staging; staging = null; blocked = false;
        if (!work) return;
        const errors: unknown[] = [];
        try { work.job.cancel(); } catch (error) { errors.push(error); }
        releasePin(work.pin, errors); releaseBlocks(work.blocks, errors); throwErrors(errors);
    };
    const retire = (frame: PaintFrame) => {
        const entry = retained.get(frame);
        if (!entry || entry === latest) return;
        retained.delete(frame);
        const errors: unknown[] = [];
        releasePin(entry.pin, errors); releaseBlocks(entry.blocks, errors); throwErrors(errors);
    };
    const clear = () => {
        const work = staging; staging = null; latest = null; blocked = false;
        const entries = [...retained.values()]; retained.clear();
        const errors: unknown[] = [];
        if (work) {
            try { work.job.cancel(); } catch (error) { errors.push(error); }
            releasePin(work.pin, errors); releaseBlocks(work.blocks, errors);
        }
        for (const entry of entries) { releasePin(entry.pin, errors); releaseBlocks(entry.blocks, errors); }
        throwErrors(errors);
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
            if (disposed) { pin.release(); return; }
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
                        work.blocks.push({ owner: allocator, lease }); heldBytes += BLOCK_BYTES;
                    }
                    const status = work.job.step(1);
                    if (status === 'pending') continue;
                    if (status !== 'complete') { dropStaging(); return; }
                    const frame: PaintFrame = Object.freeze({ token: work.pin.source.token, sceneRevision: work.pin.source.sceneRevision,
                        underlay: Object.freeze(work.underlay), content: Object.freeze(work.content), inkNodeIds: work.inkNodeIds });
                    const published: Published = { pin: work.pin, frame, blocks: work.blocks };
                    retained.set(frame, published); latest = published; staging = null; invalidate(); return;
                }
            } catch (error) { dropStaging(); onError(error); }
        },
        readFrame: () => disposed ? null : latest?.frame ?? null,
        isCurrent: frame => !disposed && retained.has(frame) && retained.get(frame)!.pin.source.isCurrent(),
        needsFrame: () => !disposed && staging !== null && !blocked,
        presented(frame) {
            if (!retained.has(frame)) throw new Error('Cannot present an unowned paint frame');
        },
        retire,
        clear,
        dispose() {
            if (disposed) return;
            disposed = true; clear();
        },
    };
}
