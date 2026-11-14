import type { BoardKind } from '../model/doc';
import { SECURITY_LIMITS } from '../security/limits';
import { boardWorker, importDeadline } from '../workers/client';
import type { NativeLoadReply } from '../workers/nativeLoad';
import { closeWorkerResult, validBoardIdentity } from '../workers/protocol';
import type { BoardJobIdentity } from '../workers/protocol';
import type { LegacyScanReply } from '../workers/legacyScan';

// Provenance: native format fence, legacy preflight and C5 governed worker
// contracts; independent acquisition client, no third-party source.
const INPUT_LIMIT = 256 * 1024 * 1024; // Same expanded UTF-8 limit as import/preflight.ts.
const RECORD_LIMIT = 200_000;
async function validReply(value: unknown, kind: BoardKind, inputBytes: number, check: () => void): Promise<boolean> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    if ((v.status !== 'recognized' && v.status !== 'unrecognized' && v.status !== 'refused') || v.kind !== kind
        || (v.envelope !== null && v.envelope !== 'document' && v.envelope !== 'appearance')
        || (v.status === 'unrecognized' ? v.envelope !== null : v.envelope === null)
        || !Number.isSafeInteger(v.recordCount) || (v.recordCount as number) < 0 || (v.recordCount as number) > RECORD_LIMIT
        || !Array.isArray(v.assets) || v.assets.length > (v.recordCount as number)
        || (v.status !== 'recognized' && v.assets.length !== 0)
        || !v.report || typeof v.report !== 'object' || Array.isArray(v.report)) return false;
    const report = v.report as Record<string, unknown>;
    if (!report.counts || typeof report.counts !== 'object' || Array.isArray(report.counts)
        || !Array.isArray(report.repairs) || !Array.isArray(report.unrepresentable)
        || report.repairs.length + report.unrepresentable.length > 2 * RECORD_LIMIT + 16) return false;
    let chars = 0, bytes = 0, previous = -1;
    const string = (item: unknown): item is string => {
        if (typeof item !== 'string' || item.length > INPUT_LIMIT || item.length > inputBytes * 4 + 65536 - chars) return false;
        chars += item.length; return true;
    };
    for (const [key, count] of Object.entries(report.counts)) if (!string(key) || !Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > RECORD_LIMIT) return false;
    let visits = 0;
    const yieldToHost = () => new Promise<void>(resolve => setTimeout(resolve, 0));
    for (const issues of [report.repairs, report.unrepresentable]) for (const issue of issues) {
        if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return false;
        const item = issue as Record<string, unknown>;
        if ((item.id !== null && !string(item.id)) || !string(item.reason)) return false;
        if ((++visits & 255) === 0) { await yieldToHost(); check(); }
    }
    for (const asset of v.assets) {
        if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return false;
        const item = asset as Record<string, unknown>;
        if (!Number.isSafeInteger(item.sourceOrdinal) || (item.sourceOrdinal as number) <= previous || (item.sourceOrdinal as number) >= (v.recordCount as number)
            || !(item.blob instanceof Blob) || (typeof File !== 'undefined' && item.blob instanceof File)
            || item.blob.size > SECURITY_LIMITS.mediaBytes || item.blob.size > SECURITY_LIMITS.inlineMediaBytes - bytes
            || !string(item.name) || (item.assetId !== undefined && !string(item.assetId))
            || (item.mimeHint !== undefined && !string(item.mimeHint))) return false;
        previous = item.sourceOrdinal as number; bytes += item.blob.size;
        if ((++visits & 255) === 0) { await yieldToHost(); check(); }
    }
    return bytes <= inputBytes;
}
/** Only the exact copied bytes already classified OTHER by the native reader may enter this path. */
export async function scanLegacyBoard(options: {
    readonly bytes: Blob;
    readonly kind: BoardKind;
    readonly nativeReport: Pick<NativeLoadReply, 'format' | 'complete' | 'bytesRead'>;
    readonly identity: BoardJobIdentity;
    isCurrent(identity: BoardJobIdentity): boolean;
    readonly signal?: AbortSignal;
}): Promise<LegacyScanReply> {
    const { bytes, identity, nativeReport } = options;
    options.signal?.throwIfAborted();
    if (!(bytes instanceof Blob) || (typeof File !== 'undefined' && bytes instanceof File) || bytes.size > INPUT_LIMIT
        || (options.kind !== 'whiteboard' && options.kind !== 'notebook' && options.kind !== 'pdf-ink')
        || !nativeReport || nativeReport.format !== 'other' || !nativeReport.complete || nativeReport.bytesRead !== bytes.size
        || !validBoardIdentity(identity)) throw new TypeError('Legacy scan requires a copied, completely classified OTHER source');
    const pinned = Object.freeze({ ...identity });
    if (!options.isCurrent(pinned)) throw new DOMException('Legacy scan is stale', 'AbortError');
    const value: unknown = await boardWorker('parse').request('legacyScan', { bytes, kind: options.kind }, pinned,
        { priority: 0, cpu: 'governed', deadlineMs: importDeadline(bytes.size), signal: options.signal }, options.isCurrent);
    try {
        options.signal?.throwIfAborted();
        const check = () => { options.signal?.throwIfAborted(); if (!options.isCurrent(pinned)) throw new DOMException('Legacy scan is stale', 'AbortError'); };
        check();
        if (!await validReply(value, options.kind, bytes.size, check)) throw new TypeError('Invalid legacy scan worker reply');
        check();
        return value as LegacyScanReply;
    } catch (error) { closeWorkerResult(value); throw error; }
}
