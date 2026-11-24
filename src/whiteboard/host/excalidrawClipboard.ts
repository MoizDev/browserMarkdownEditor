import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { SECURITY_LIMITS } from '../security/limits';
import { boardWorker } from '../workers/client';
import { closeWorkerResult, validBoardIdentity, type BoardJobIdentity } from '../workers/protocol';
import type { ExcalidrawWireDocument } from '../workers/excalidrawClipboard';
import { yieldToHost } from '../../platform/yieldToHost';

// Provenance: public Excalidraw clipboard fields and shared worker admission;
// independent parse host, no upstream engine source.
export interface ExcalidrawWireLease extends ExcalidrawWireDocument { release(): void }
export async function readExcalidrawClipboard(options: {
    readonly bytes: Blob; readonly identity: BoardJobIdentity; readonly memory: MemoryAllocator;
    isCurrent(identity: BoardJobIdentity): boolean; readonly signal?: AbortSignal;
}): Promise<ExcalidrawWireLease> {
    const { bytes } = options;
    options.signal?.throwIfAborted();
    if (!(bytes instanceof Blob) || (typeof File !== 'undefined' && bytes instanceof File) || bytes.size > SECURITY_LIMITS.recordBytes
        || !validBoardIdentity(options.identity)) throw new TypeError('Excalidraw requires bounded copied bytes and a job identity');
    const identity = Object.freeze({ ...options.identity });
    const check = () => { options.signal?.throwIfAborted(); if (!options.isCurrent(identity)) throw new DOMException('Excalidraw request became stale', 'AbortError'); };
    check();
    const lease = options.memory.reserve(16 * 1024 * 1024 + bytes.size * 16);
    if (!lease) throw new Error('Insufficient memory for Excalidraw clipboard');
    let held = true, result: unknown;
    const release = () => { if (held) { held = false; options.memory.release(lease); } };
    try {
        const source = new Blob([bytes], { type: 'application/json' });
        result = await boardWorker('parse').request('excalidrawClipboard', { bytes: source }, identity,
            { priority: 0, cpu: 'governed', deadlineMs: 10_000, signal: options.signal }, options.isCurrent);
        check();
        if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).sort().join(',') !== 'elements,files') throw new TypeError('Invalid Excalidraw parser result');
        const reply = result as { elements?: unknown; files?: unknown };
        if (!Array.isArray(reply.elements) || reply.elements.length > SECURITY_LIMITS.clipboardNodes
            || !Array.isArray(reply.files) || reply.files.length > SECURITY_LIMITS.mediaBatch) throw new TypeError('Invalid Excalidraw parser result');
        let visited = 0, total = 0; const pending: { value: unknown; depth: number }[] = reply.elements.map(value => ({ value, depth: 0 }));
        while (pending.length) {
            const { value, depth } = pending.pop()!;
            if (depth > SECURITY_LIMITS.jsonDepth || ++visited > SECURITY_LIMITS.records) throw new RangeError('Excalidraw parser result exceeds limits');
            if (value === null || typeof value === 'string' || typeof value === 'boolean') { /* scalar */ }
            else if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('Invalid Excalidraw number'); }
            else if (Array.isArray(value)) for (const child of value) pending.push({ value: child, depth: depth + 1 });
            else if (typeof value === 'object') for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
            else throw new TypeError('Invalid Excalidraw parser value');
            if ((visited & 255) === 0) { await yieldToHost(); check(); }
        }
        const elements = reply.elements as Record<string, unknown>[];
        if (elements.some(element => !element || typeof element !== 'object' || Array.isArray(element))) throw new TypeError('Invalid Excalidraw element');
        const files = reply.files.map((item: unknown) => {
            if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'blob,fileId,mimeHint') throw new TypeError('Invalid Excalidraw image');
            const image = item as Record<string, unknown>;
            if (typeof image.fileId !== 'string' || !image.fileId.length || image.fileId.length > SECURITY_LIMITS.idCharacters
                || typeof image.mimeHint !== 'string' || !/^image\/[a-z0-9.+-]+$/.test(image.mimeHint)
                || !(image.blob instanceof Blob) || (typeof File !== 'undefined' && image.blob instanceof File)
                || image.blob.size > SECURITY_LIMITS.mediaBytes || image.blob.size > SECURITY_LIMITS.inlineMediaBytes - total) throw new TypeError('Invalid Excalidraw image');
            total += image.blob.size;
            return Object.freeze({ fileId: image.fileId, mimeHint: image.mimeHint, blob: new Blob([image.blob], { type: image.mimeHint }) });
        });
        check();
        return { elements: Object.freeze(elements), files: Object.freeze(files), release };
    } catch (error) { closeWorkerResult(result); release(); throw error; }
}
