import type { WorkerContext } from '../../platform/workers';
import type { BoardJobIdentity } from '../workers/protocol';
import type { OutlinePiece } from './outlinePieces';

export type OutlineStreamReply =
    | { readonly kind: 'reserved' | 'started' | 'closed' | 'done' }
    | { readonly kind: 'item'; readonly item: OutlinePiece }
    | { readonly kind: 'batch'; readonly items: readonly OutlinePiece[]; readonly done: boolean };

type OutlineGenerator = AsyncGenerator<OutlinePiece, void, unknown>;
type GeneratorFactory = (payload: unknown, context: WorkerContext, chunkPaths: boolean) => OutlineGenerator;
interface StreamSlot {
    readonly id: string;
    readonly owner: BoardJobIdentity;
    readonly chunkPaths: boolean;
    readonly proxy: WorkerContext;
    active?: WorkerContext;
    iterator?: OutlineGenerator;
    pending?: OutlinePiece;
    timer?: ReturnType<typeof setTimeout>;
    busy: boolean;
    closing: boolean;
    holds: number;
    /** Resolves when the iterator's finally blocks have run: its native physical retirement. */
    ended?: Promise<void>;
    /** Close requests waiting for an in-flight advance to finish. */
    idle: (() => void)[];
}
interface Admission { resolve(): void }

// Slots hold a cloned paint until the consumer advances or closes the stream. A reservation is
// admitted only when a slot is free, and waits in arrival order until a freed slot wakes it.
const streams = new Map<string, StreamSlot>();
const MAX_STREAMS = 8;
const MAX_BATCH_ITEMS = 64;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const IDLE_MS = 10 * 60_000;
const waiting: Admission[] = [];
/** Reservations admitted but not yet created as slots, so a wake never over-commits capacity. */
let granted = 0;

function itemBytes(item: OutlinePiece): number {
    if (item.kind === 'path') return item.d.length * 64;
    if (item.kind === 'raster') return item.png.byteLength;
    if (item.kind === 'textPathChunk') return item.commands.length * 64;
    if (item.kind === 'textPathStart' || item.kind === 'textPathEnd') return 128;
    throw new TypeError('Unexpected text outline stream item');
}
function transferItem(item: OutlinePiece, context: WorkerContext): void {
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
function capacity(): number { return MAX_STREAMS - streams.size - granted; }
/** Wakes queued reservations in arrival order, and only as many as there is capacity for. */
function grantWaiting(): void {
    while (waiting.length && capacity() > 0) {
        granted++;
        waiting.shift()!.resolve();
    }
}
/** Waits for a real free slot. Nothing polls: a slot being freed is the only wake. */
async function admit(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!waiting.length && capacity() > 0) { granted++; return; }
    await new Promise<void>((resolve, reject) => {
        const entry: Admission = { resolve: () => { signal.removeEventListener('abort', abort); resolve(); } };
        const abort = () => {
            const index = waiting.indexOf(entry);
            // A reservation already granted is consumed by its caller, which hands capacity on.
            if (index >= 0) { waiting.splice(index, 1); reject(signal.reason ?? new DOMException('Text export cancelled', 'AbortError')); }
        };
        waiting.push(entry);
        signal.addEventListener('abort', abort, { once: true });
    });
}
/** Removes the slot, frees its capacity for the next waiter, and ends its iterator. */
function dispose(slot: StreamSlot): Promise<void> {
    if (streams.get(slot.id) === slot) {
        streams.delete(slot.id);
        if (slot.timer !== undefined) clearTimeout(slot.timer);
        slot.timer = undefined;
        grantWaiting();
        slot.ended = slot.iterator ? slot.iterator.return(undefined).then(() => undefined, () => undefined) : Promise.resolve();
    }
    return slot.ended ?? Promise.resolve();
}
function arm(slot: StreamSlot): void {
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    slot.timer = undefined;
    if (!slot.holds) slot.timer = setTimeout(() => { if (!slot.busy && !slot.holds) void dispose(slot); }, IDLE_MS);
}
function whenIdle(slot: StreamSlot): Promise<void> {
    if (!slot.busy) return Promise.resolve();
    return new Promise<void>(resolve => { slot.idle.push(resolve); });
}

/** A worker-local sink holds the stream while it writes; idle collection is only for abandoned clients. */
export function holdOutlineStream(id: string, owner: BoardJobIdentity): () => void {
    const slot = streams.get(id), valid = ownerOf(owner);
    if (!slot || !valid || !sameOwner(slot.owner, valid) || slot.closing) throw new Error('Text outline stream expired');
    slot.holds++;
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    slot.timer = undefined;
    let held = true;
    return () => {
        if (!held) return;
        held = false;
        slot.holds--;
        if (!slot.busy && streams.get(slot.id) === slot) arm(slot);
    };
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
        if (value.chunkPaths !== undefined && typeof value.chunkPaths !== 'boolean') throw new TypeError('Invalid text outline stream mode');
        await admit(context.signal);
        try {
            context.signal.throwIfAborted();
            if (context.cancelled) throw new DOMException('Text export cancelled', 'AbortError');
            if (streams.has(value.id)) throw new Error('Text outline stream already exists');
            const idle: (() => void)[] = [];
            const created = { id: value.id, owner, chunkPaths: value.chunkPaths === true, busy: false, closing: false, holds: 0,
                idle } as StreamSlot;
            (created as { proxy: WorkerContext }).proxy = proxyFor(created);
            streams.set(created.id, created);
            arm(created);
            return { kind: 'reserved' };
        } finally {
            granted--;
            grantWaiting();
        }
    }
    if (!slot) {
        if (value.mode === 'close') return { kind: 'closed' };
        throw new Error('Text outline stream expired');
    }
    if (!sameOwner(slot.owner, owner)) throw new Error('Text outline stream owner changed');
    if (value.mode === 'close') {
        // A close that races an advance waits for it to finish, so its reply means the stream is gone.
        if (slot.busy) { slot.closing = true; await whenIdle(slot); }
        await dispose(slot);
        return { kind: 'closed' };
    }
    if (slot.busy || slot.closing) throw new Error('Text outline stream is already advancing');
    if (value.mode === 'start') {
        if (slot.iterator || !('request' in value)) throw new Error('Invalid text outline stream start');
        slot.iterator = create(value.request, slot.proxy, slot.chunkPaths);
        arm(slot);
        return { kind: 'started' };
    }
    if ((value.mode !== 'next' && value.mode !== 'nextBatch') || !slot.iterator) throw new Error('Invalid text outline stream operation');
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.busy = true;
    slot.active = context;
    try {
        const items: OutlinePiece[] = [];
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
        if (done) void dispose(slot);
        if (transfer) for (const item of items) transferItem(item, context);
        if (value.mode === 'next') return items.length ? { kind: 'item', item: items[0] } : { kind: 'done' };
        return { kind: 'batch', items, done };
    } catch (error) {
        void dispose(slot);
        throw error;
    } finally {
        slot.active = undefined;
        slot.busy = false;
        for (const wake of slot.idle.splice(0)) wake();
        if (streams.get(slot.id) === slot) {
            if (slot.closing) void dispose(slot);
            else arm(slot);
        }
    }
}
