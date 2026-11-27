import { encodeHeader, encodePen, encodeSheet, encodeView } from '../format/encode';
import { parseJsonIncremental } from '../format/jsonRead';
import { LineTable } from '../format/lineTable';
import { readRecord } from '../format/readModel';
import { FORMAT_LIMITS, NATIVE_VERSION } from '../format/schema';
import { recordKey, utf8LengthAsync, type EncodedRecord, type WriteResult } from '../format/writeTypes';
import { SampleStore } from '../ink/samples';
import type { BoardKind } from '../model/doc';
import { UI_DEFAULTS, VIEW_DEFAULTS } from '../model/defaults';
import { isValidId, type SheetId } from '../model/ids';
import type { SampleLease } from '../model/samples';
import { keyBetween } from '../model/orderKey';
import { SECURITY_LIMITS } from '../security/limits';
import type { BoardPayload } from './snapshot';
import { yieldToHost } from '../../platform/yieldToHost';

function take<T>(result: WriteResult<T>): T {
    if (!result.ok) throw new Error(`Clipboard native record refused: ${result.error.reason}`);
    return result.value;
}
export async function makeClipboardNativeRecords(payload: BoardPayload, options: {
    readonly signal?: AbortSignal;
    cooperate?(): Promise<void>;
} = {}): Promise<{ readonly bytes: Blob; readonly originalSourceKind: BoardKind }> {
    const signal = options.signal, yieldHost = options.cooperate ?? yieldToHost;
    const cooperate = async () => { signal?.throwIfAborted(); await yieldHost(); signal?.throwIfAborted(); };
    signal?.throwIfAborted();
    if (!payload || payload.v !== 1 || !payload.from || !isValidId(payload.from.sheet)
        || (payload.from.kind !== 'whiteboard' && payload.from.kind !== 'notebook' && payload.from.kind !== 'pdf-ink')
        || !Array.isArray(payload.records) || payload.records.length > SECURITY_LIMITS.clipboardRecords) throw new TypeError('Invalid clipboard native payload');
    const sheet = payload.from.sheet as SheetId, lines = new LineTable(), samples = new SampleStore(), identities = new Set<string>();
    const add = async (record: EncodedRecord) => {
        const key = recordKey(record.identity);
        if (identities.has(key)) throw new Error('Duplicate clipboard native record');
        take(await lines.setAsync(record, 0, { signal, cooperate }));
        identities.add(key);
    };
    {
        const preserved = { version: NATIVE_VERSION, fields: new Map(), records: [], end: null };
        take(lines.setHeader(take(encodeHeader('whiteboard', preserved))));
        await add(take(encodePen(UI_DEFAULTS)));
        await add(take(encodeView(VIEW_DEFAULTS, { sheet, x: 0, y: 0, zoom: 1 })));
        await add(take(encodeSheet({ id: sheet, name: 'Clipboard', order: keyBetween(null, null), ext: null })));
        let total = 0;
        for (let ordinal = 0; ordinal < payload.records.length; ordinal++) {
            signal?.throwIfAborted();
            const row = payload.records[ordinal];
            if (typeof row !== 'string') throw new TypeError('Clipboard record is not text');
            const length = take(await utf8LengthAsync(row, FORMAT_LIMITS.recordBytes, { signal, cooperate }));
            if (length > FORMAT_LIMITS.fileBytes - total) throw new RangeError('Clipboard native records exceed the file limit');
            total += length;
            const span = await parseJsonIncremental(row, cooperate);
            if (span.kind !== 'object') throw new TypeError('Clipboard record must be an object');
            let invalid: string | null = null;
            const position = { ordinal, line: ordinal + 1, byteOffset: 0, byteLength: length };
            const recordLeases: SampleLease[] = [];
            let record: Awaited<ReturnType<typeof readRecord>>;
            try {
                record = await readRecord(span, 'whiteboard', { position,
                    options: { signal, cooperate, admitEncoded(pts, header) {
                        const lease = samples.admitEncoded(pts, header); recordLeases.push(lease); return lease.ref;
                    } },
                    issue(issue) { if (issue.readOnly) invalid ??= issue.reason; },
                });
            } finally { for (const lease of recordLeases) lease.release(); }
            if (invalid) throw new Error(`Clipboard native record is invalid: ${invalid}`);
            if (record.category !== 'node' && record.category !== 'media' && record.category !== 'opaque') throw new TypeError('Clipboard contains a forbidden container record');
            if (record.category === 'opaque' && ['root', 'header', 'format'].includes(record.type)) throw new TypeError('Clipboard contains a forbidden root record');
            if (record.category === 'node' && record.value.page !== -1) throw new TypeError('Clipboard nodes must already be world-rooted');
            const identity = record.category === 'opaque' ? { category: 'opaque' as const, type: record.type, id: record.id }
                : { category: record.category, type: record.category, id: record.value.id };
            if (record.category === 'node' && String(record.value.id) === String(sheet)) throw new Error('Clipboard node conflicts with its source sheet');
            await add({ identity, text: row });
            if ((ordinal & 63) === 63) await cooperate();
        }
        signal?.throwIfAborted();
        const bytes = take(await lines.assembleAsync(lines.integrity(), null, { signal, cooperate })).blob;
        signal?.throwIfAborted();
        return { bytes, originalSourceKind: payload.from.kind };
    }
}
