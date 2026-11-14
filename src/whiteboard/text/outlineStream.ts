import type { PageDisplayItem } from '../../platform/types';
import type { WorkerContext } from '../../platform/workers';
import type { BoardJobIdentity } from '../workers/protocol';

export type OutlineStreamReply =
    | { readonly kind: 'reserved' | 'busy' | 'started' | 'closed' | 'done' }
    | { readonly kind: 'item'; readonly item: PageDisplayItem }
    | { readonly kind: 'batch'; readonly items: readonly PageDisplayItem[]; readonly done: boolean };

type OutlineGenerator = AsyncGenerator<PageDisplayItem, void, unknown>;
type GeneratorFactory = (payload: unknown, context: WorkerContext) => OutlineGenerator;
interface StreamSlot {
    readonly id: string;
    readonly owner: BoardJobIdentity;
    readonly proxy: WorkerContext;
    active?: WorkerContext;
    iterator?: OutlineGenerator;
    pending?: PageDisplayItem;
    timer?: ReturnType<typeof setTimeout>;
    busy: boolean;
    closing: boolean;
}

// Slots hold a cloned paint until the consumer advances or closes the stream. Reserve before
// cloning that paint so contention queues on the caller rather than retaining more worker data.
const streams = new Map<string, StreamSlot>();
const MAX_STREAMS = 8;
const MAX_BATCH_ITEMS = 64;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const IDLE_MS = 10 * 60_000;

function itemBytes(item: PageDisplayItem): number {
    if (item.kind === 'path') return item.d.length * 64;
    if (item.kind === 'raster') return item.png.byteLength;
    throw new TypeError('Unexpected text outline stream item');
}
function transferItem(item: PageDisplayItem, context: WorkerContext): void {
    if (item.kind === 'raster' && item.png.buffer instanceof ArrayBuffer
        && item.png.byteOffset === 0 && item.png.byteLength === item.png.buffer.byteLength) context.transfer(item.png.buffer);
}

function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function ownerOf(value: unknown): BoardJobIdentity | null {
    if (!record(value) || typeof value.session !== 'string' || !value.session || value.session.length > 128
        || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 0
        || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return null;
    return { session: value.session, epoch: value.epoch as number, revision: value.revision as number };
}
function sameOwner(a: BoardJobIdentity, b: BoardJobIdentity): boolean {
    return a.session === b.session && a.epoch === b.epoch && a.revision === b.revision;
}
function current(slot: StreamSlot): WorkerContext {
    if (!slot.active) throw new Error('Text outline stream is not advancing');
    return slot.active;
}
function proxyFor(slot: StreamSlot): WorkerContext {
    return {
        get cancelled() { return current(slot).cancelled; },
        get signal() { return current(slot).signal; },
        slice: () => current(slot).slice(),
        heartbeat: () => current(slot).heartbeat(),
        transfer: (...items) => current(slot).transfer(...items),
        emit: (event, data, transfer) => current(slot).emit(event, data, transfer),
    };
}
function dispose(slot: StreamSlot): void {
    if (streams.get(slot.id) !== slot) return;
    streams.delete(slot.id);
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    slot.timer = undefined;
    if (slot.iterator) void slot.iterator.return(undefined).catch(() => undefined);
}
function arm(slot: StreamSlot): void {
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => { if (!slot.busy) dispose(slot); }, IDLE_MS);
}

export function isOutlineStreamRequest(value: unknown): boolean {
    return record(value) && value.outlineStream === 1;
}

/** Each request holds a WorkerHost CPU permit only while the generator advances, never while its sink waits. */
export async function handleOutlineStream(value: unknown, context: WorkerContext, create: GeneratorFactory, transfer = true): Promise<OutlineStreamReply> {
    if (!record(value) || value.outlineStream !== 1 || typeof value.id !== 'string' || !value.id || value.id.length > 128)
        throw new TypeError('Invalid text outline stream request');
    const owner = ownerOf(value.owner);
    if (!owner) throw new TypeError('Invalid text outline stream owner');
    context.signal.throwIfAborted();
    if (context.cancelled) throw new DOMException('Text export cancelled', 'AbortError');
    const slot = streams.get(value.id);
    if (value.mode === 'reserve') {
        if (slot) throw new Error('Text outline stream already exists');
        if (streams.size >= MAX_STREAMS) return { kind: 'busy' };
        const created = { id: value.id, owner, busy: false, closing: false } as StreamSlot;
        (created as { proxy: WorkerContext }).proxy = proxyFor(created);
        streams.set(created.id, created);
        arm(created);
        return { kind: 'reserved' };
    }
    if (!slot) {
        if (value.mode === 'close') return { kind: 'closed' };
        throw new Error('Text outline stream expired');
    }
    if (!sameOwner(slot.owner, owner)) throw new Error('Text outline stream owner changed');
    if (value.mode === 'close') {
        if (slot.busy) slot.closing = true;
        else dispose(slot);
        return { kind: 'closed' };
    }
    if (slot.busy || slot.closing) throw new Error('Text outline stream is already advancing');
    if (value.mode === 'start') {
        if (slot.iterator || !('request' in value)) throw new Error('Invalid text outline stream start');
        slot.iterator = create(value.request, slot.proxy);
        arm(slot);
        return { kind: 'started' };
    }
    if ((value.mode !== 'next' && value.mode !== 'nextBatch') || !slot.iterator) throw new Error('Invalid text outline stream operation');
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.busy = true;
    slot.active = context;
    try {
        const items: PageDisplayItem[] = [];
        let bytes = 0, done = false;
        const maximum = value.mode === 'next' ? 1 : MAX_BATCH_ITEMS;
        while (items.length < maximum) {
            const result = slot.pending ? { done: false as const, value: slot.pending } : await slot.iterator.next();
            slot.pending = undefined;
            context.signal.throwIfAborted();
            if (context.cancelled || slot.closing) throw new DOMException('Text export cancelled', 'AbortError');
            if (result.done) { done = true; break; }
            const size = itemBytes(result.value);
            if (items.length && bytes + size > MAX_BATCH_BYTES) { slot.pending = result.value; break; }
            items.push(result.value); bytes += size;
        }
        if (done) dispose(slot);
        if (transfer) for (const item of items) transferItem(item, context);
        if (value.mode === 'next') return items.length ? { kind: 'item', item: items[0] } : { kind: 'done' };
        return { kind: 'batch', items, done };
    } catch (error) {
        dispose(slot);
        throw error;
    } finally {
        slot.active = undefined;
        slot.busy = false;
        if (streams.get(slot.id) === slot) {
            if (slot.closing) dispose(slot);
            else arm(slot);
        }
    }
}
