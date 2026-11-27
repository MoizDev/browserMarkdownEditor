import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { SECURITY_LIMITS } from '../security/limits';
import { boardWorker } from '../workers/client';
import { closeWorkerResult, validBoardIdentity, type BoardJobIdentity } from '../workers/protocol';
import type { ClipboardJsonKind } from '../workers/clipboardJsonKind';

export async function classifyClipboardJson(options: {
    readonly bytes: Blob;
    readonly identity: BoardJobIdentity;
    readonly memory: MemoryAllocator;
    isCurrent(identity: BoardJobIdentity): boolean;
    readonly signal?: AbortSignal;
}): Promise<ClipboardJsonKind> {
    const { bytes } = options;
    options.signal?.throwIfAborted();
    if (!(bytes instanceof Blob) || (typeof File !== 'undefined' && bytes instanceof File) || bytes.size > SECURITY_LIMITS.recordBytes
        || !validBoardIdentity(options.identity)) throw new TypeError('Clipboard JSON requires a copied, bounded Blob and valid identity');
    const identity = Object.freeze({ ...options.identity });
    const check = () => { options.signal?.throwIfAborted(); if (!options.isCurrent(identity)) throw new DOMException('Clipboard JSON request became stale', 'AbortError'); };
    check();
    const lease = options.memory.reserve(8 * 1024 * 1024 + bytes.size * 12);
    if (!lease) throw new Error('Insufficient memory to classify clipboard JSON');
    let value: unknown;
    try {
        const copied = new Blob([bytes], { type: 'application/json' });
        check();
        value = await boardWorker('parse').request('clipboardJsonKind', { bytes: copied }, identity,
            { priority: 0, cpu: 'governed', deadlineMs: 10_000, signal: options.signal }, options.isCurrent);
        check();
        if (value !== null && value !== 'excalidraw' && value !== 'native-records') throw new TypeError('Invalid clipboard JSON worker reply');
        return value;
    } catch (error) { closeWorkerResult(value); throw error; }
    finally { options.memory.release(lease); }
}
