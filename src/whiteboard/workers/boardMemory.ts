import type { WorkerContext } from '../../platform/workers';

/** Owned bytes of one board worker INCARNATION. The ledger is module state, so it lives exactly as
 * long as the worker that runs it: a recycled worker starts at zero, and the host keys each report
 * by its endpoint, so an old incarnation's late 'mem' event is dropped by the host. Every owner
 * reports an absolute value (or null when it is done), never a delta. */
const active = new Map<object, number>();
let announced = -1;

/** Emits only on a change: owners report from cooperation points, which run far more often than
 * the total moves, and each event is a message the main thread has to process. */
export function reportBoardMemory(context: WorkerContext, owner: object, bytes: number | null): void {
    if (bytes === null) active.delete(owner); else active.set(owner, bytes);
    let heapBytes = 0;
    for (const value of active.values()) heapBytes += value;
    if (heapBytes === announced) return;
    announced = heapBytes;
    context.emit('mem', { heapBytes });
}
