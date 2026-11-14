import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { boardWorker } from '../workers/client';
import { validBoardIdentity, type BoardJobIdentity } from '../workers/protocol';

/** The caller holds the owning session job; this does not enqueue another. */
export async function readPrivatePngDensity(options: {
    readonly blob: Blob;
    readonly identity: BoardJobIdentity;
    readonly memory: MemoryAllocator;
    readonly signal: AbortSignal;
    isCurrent(identity: BoardJobIdentity): boolean;
}): Promise<number | null> {
    const { blob, signal } = options;
    signal.throwIfAborted();
    if (!(blob instanceof Blob) || blob.size > 10 * 1024 * 1024 || !validBoardIdentity(options.identity)) throw new TypeError('Invalid private PNG request');
    const identity = Object.freeze({ ...options.identity });
    const check = () => { signal.throwIfAborted(); if (!options.isCurrent(identity)) throw new DOMException('Private PNG request became stale', 'AbortError'); };
    check();
    const lease = options.memory.reserve(blob.size * 2 + 64 * 1024);
    if (!lease) throw new Error('Insufficient memory for private PNG metadata');
    try {
        const copied = new Blob([blob], { type: 'image/png' });
        const value = await boardWorker('decode').request<unknown>('privatePngDensity', { blob: copied }, identity,
            { priority: 0, cpu: 'governed', deadlineMs: 10_000, signal }, options.isCurrent);
        check();
        if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) throw new TypeError('Invalid private PNG density reply');
        return value;
    } finally { options.memory.release(lease); }
}
