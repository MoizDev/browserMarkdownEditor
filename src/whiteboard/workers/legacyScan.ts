import type { WorkerContext } from '../../platform/workers';
import { hasNativeMarkerIncremental } from '../format/jsonRead';
import { readLegacyEnvelope } from '../import/records/envelope';
import { decodeInlineAsset } from '../import/records/media';
import { ReportBuilder, type ImportReport } from '../import/report';
import type { BoardKind } from '../model/doc';
import { SECURITY_LIMITS } from '../security/limits';

// Provenance: legacy record admission, SEC-W1/W4 and C5 worker contracts;
// independent extraction only, no third-party source.
export const LEGACY_SCAN_MAX_BYTES = 256 * 1024 * 1024; // import/preflight.ts expanded UTF-8 ceiling
export interface LegacyScanAsset {
    readonly sourceOrdinal: number;
    readonly assetId?: string;
    readonly blob: Blob;
    readonly name: string;
    readonly mimeHint?: string;
}
export interface LegacyScanReply {
    readonly status: 'recognized' | 'unrecognized' | 'refused';
    readonly kind: BoardKind;
    readonly envelope: 'document' | 'appearance' | null;
    readonly recordCount: number;
    readonly assets: readonly LegacyScanAsset[];
    readonly report: ImportReport;
}
export async function legacyScan(payload: unknown, context: WorkerContext): Promise<LegacyScanReply> {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid legacy scan request');
    const { bytes, kind } = payload as { bytes?: unknown; kind?: unknown };
    if (!(bytes instanceof Blob) || (typeof File !== 'undefined' && bytes instanceof File)
        || bytes.size > LEGACY_SCAN_MAX_BYTES || (kind !== 'whiteboard' && kind !== 'notebook' && kind !== 'pdf-ink')) throw new TypeError('Invalid copied legacy source');
    context.signal.throwIfAborted();
    const text = await bytes.text(); context.signal.throwIfAborted();
    if (await hasNativeMarkerIncremental(text, context.slice)) throw new Error('Native format cannot be scanned as legacy');
    context.signal.throwIfAborted();
    const report = new ReportBuilder(), envelope = readLegacyEnvelope(text, report);
    const result = (status: LegacyScanReply['status'], form: LegacyScanReply['envelope'], count = 0, assets: readonly LegacyScanAsset[] = []): LegacyScanReply =>
        ({ status, kind, envelope: form, recordCount: count, assets, report: report.finish() });
    if (!envelope) return result('unrecognized', null);
    const isDocument = Object.hasOwn(envelope.documentExtras, 'schema');
    const isAppearance = Object.keys(envelope.extras).some(key => key === 'paper' || key === 'ui' || key === 'session');
    if (!isDocument && !isAppearance) return result('unrecognized', null);
    const form = isDocument ? 'document' : 'appearance';
    if (report.finish().unrepresentable.some(issue => issue.reason.startsWith('Unsupported record schema'))) return result('refused', form, envelope.records.length);
    const assets: LegacyScanAsset[] = [];
    let expanded = 0;
    for (let i = 0; i < envelope.records.length; i++) {
        if ((i & 31) === 0) { context.signal.throwIfAborted(); await context.slice(); }
        const record = envelope.records[i];
        if (record.typeName !== 'asset' || record.type === 'bookmark') continue;
        const id = typeof record.id === 'string' ? record.id : undefined;
        try {
            const decoded = decodeInlineAsset(record);
            if (decoded.blob.size > SECURITY_LIMITS.inlineMediaBytes - expanded) throw new RangeError('Legacy inline media exceeds the aggregate limit');
            expanded += decoded.blob.size;
            assets.push({ sourceOrdinal: i, ...(id === undefined ? {} : { assetId: id }), blob: decoded.blob,
                name: decoded.name, mimeHint: decoded.mimeHint });
            report.count('inline-asset');
        } catch (error) {
            report.refuse(id ?? null, error instanceof Error ? error.message : 'Invalid inline asset');
        }
    }
    context.signal.throwIfAborted();
    return result('recognized', form, envelope.records.length, assets);
}
