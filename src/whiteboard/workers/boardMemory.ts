import type { WorkerContext } from '../../platform/workers';

const active = new Map<object, number>();
let announced = -1;

export function reportBoardMemory(context: WorkerContext, owner: object, bytes: number | null): void {
    if (bytes === null) active.delete(owner); else active.set(owner, bytes);
    let heapBytes = 0;
    for (const value of active.values()) heapBytes += value;
    if (heapBytes === announced) return;
    announced = heapBytes;
    context.emit('mem', { heapBytes });
}
