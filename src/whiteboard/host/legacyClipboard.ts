import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { SECURITY_LIMITS } from '../security/limits';
import { boardWorker } from '../workers/client';
import { closeWorkerResult, validBoardIdentity, type BoardJobIdentity } from '../workers/protocol';
import type { LegacyClipboardReply } from '../workers/legacyClipboard';

// Provenance: legacy clipboard envelope and governed worker contracts;
// decoding follows lz-string 1.5.0 (MIT, pieroxy); tldraw source read: none.
const INPUT_LIMIT = 16_777_216, OUTPUT_LIMIT = 33_554_432;
export class UnsupportedLegacyClipboard extends Error {
    constructor() { super('This clipboard content uses an unsupported board version or format'); this.name = 'UnsupportedLegacyClipboard'; }
}
export interface LegacyClipboardDecodeLease {
    /** Raw decoded JSON and original assets-array JSON; neither has undergone model admission. */
    readonly content: Blob;
    readonly assets: Blob;
    readonly decodedUnits: number;
    readonly shapes: number;
    readonly bindings: number;
    readonly assetCount: number;
    release(): void;
}
export async function decodeLegacyClipboard(options: {
    readonly envelope: Blob;
    readonly memory: MemoryAllocator;
    readonly identity: BoardJobIdentity;
    isCurrent(identity: BoardJobIdentity): boolean;
    readonly signal?: AbortSignal;
}): Promise<LegacyClipboardDecodeLease> {
    const { envelope } = options;
    options.signal?.throwIfAborted();
    if (!(envelope instanceof Blob) || (typeof File !== 'undefined' && envelope instanceof File)
        || envelope.size > SECURITY_LIMITS.clipboardHtmlBytes || !validBoardIdentity(options.identity)) throw new TypeError('Legacy clipboard requires a copied bounded Blob');
    const identity = Object.freeze({ ...options.identity });
    const check = () => { options.signal?.throwIfAborted(); if (!options.isCurrent(identity)) throw new DOMException('Legacy clipboard became stale', 'AbortError'); };
    check();
    // Dictionary is at most four entries per encoded character and two per
    // output unit. Charge both input copies and the maximum bounded output.
    const encodedBound = Math.min(envelope.size, INPUT_LIMIT), codes = Math.min(OUTPUT_LIMIT, 2 * encodedBound + 1);
    const outputBound = Math.min(OUTPUT_LIMIT, codes * (codes + 1) / 2);
    const dictionary = Math.min(4 * encodedBound + 8, 2 * outputBound + 4) * 4;
    const lease = options.memory.reserve(envelope.size * 4 + outputBound * 12 + dictionary);
    if (!lease) throw new Error('Insufficient memory for legacy clipboard decoding');
    let owned = true, value: unknown;
    const release = () => { if (owned) { owned = false; options.memory.release(lease); } };
    try {
        value = await boardWorker('parse').request('legacyClipboard', { envelope }, identity,
            { priority: 0, cpu: 'governed', deadlineMs: 10_000, signal: options.signal }, options.isCurrent);
        check();
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid legacy clipboard worker reply');
        const result = value as Record<string, unknown>;
        if (result.status === 'unsupported') {
            if (Object.keys(result).join(',') !== 'status') throw new TypeError('Invalid legacy clipboard worker reply');
            throw new UnsupportedLegacyClipboard();
        }
        if (Object.keys(result).sort().join(',') !== 'assetCount,assets,bindings,content,decodedUnits,shapes,status'
            || result.status !== 'decoded' || !(result.content instanceof Blob) || !(result.assets instanceof Blob)
            || (typeof File !== 'undefined' && (result.content instanceof File || result.assets instanceof File))
            || !Number.isSafeInteger(result.decodedUnits) || (result.decodedUnits as number) < 0 || (result.decodedUnits as number) > OUTPUT_LIMIT
            || result.content.size > (result.decodedUnits as number) * 3 || result.assets.size > envelope.size
            || !Number.isSafeInteger(result.shapes) || (result.shapes as number) < 0 || (result.shapes as number) > SECURITY_LIMITS.clipboardNodes
            || !Number.isSafeInteger(result.bindings) || (result.bindings as number) < 0 || (result.bindings as number) > SECURITY_LIMITS.clipboardRecords
            || !Number.isSafeInteger(result.assetCount) || (result.assetCount as number) < 0 || (result.assetCount as number) > SECURITY_LIMITS.clipboardRecords) {
            throw new TypeError('Invalid legacy clipboard worker reply');
        }
        const decoded = value as Extract<LegacyClipboardReply, { status: 'decoded' }>;
        check();
        return { content: new Blob([decoded.content], { type: 'application/json' }), assets: new Blob([decoded.assets], { type: 'application/json' }),
            decodedUnits: decoded.decodedUnits, shapes: decoded.shapes, bindings: decoded.bindings, assetCount: decoded.assetCount, release };
    } catch (error) { closeWorkerResult(value); release(); throw error; }
}
