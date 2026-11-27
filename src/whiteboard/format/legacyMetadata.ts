import { parseJson, type JsonSpan } from './jsonRead';
import type { RawJson } from '../model/json';
import { isValidId } from '../model/ids';
import { FORMAT_LIMITS } from './schema';

type RecordData = Readonly<{ type: string; id: string; raw: string }>;
const wrapperKeys = ['type', 'id', 'record', 'schema', 'role'];
const documentKeys = ['id', 'typeName', 'gridSize', 'name', 'meta'];
const userKeys = ['id', 'typeName', 'name', 'color', 'imageUrl', 'meta'];
function closed(span: JsonSpan, keys: readonly string[]): ReadonlyMap<string, JsonSpan> | null {
    if (span.kind !== 'object') return null;
    const fields = span.fieldMap();
    return fields.size === keys.length && keys.every(key => fields.has(key)) ? fields : null;
}
function text(span: JsonSpan | undefined): string | null { return span?.kind === 'string' ? span.string(FORMAT_LIMITS.recordBytes) : null; }

export function isKnownLegacyMetadata(record: RecordData): boolean {
    try {
        if (record.type !== 'legacy-document' && record.type !== 'legacy-user') return false;
        const wrapper = closed(parseJson(record.raw), wrapperKeys);
        if (!wrapper || wrapper.get('schema')!.number() !== 1 || text(wrapper.get('role')) !== 'metadata'
            || text(wrapper.get('type')) !== record.type || text(wrapper.get('id')) !== record.id || !isValidId(record.id)) return false;
        const document = record.type === 'legacy-document';
        const original = closed(wrapper.get('record')!, document ? documentKeys : userKeys);
        if (!original || text(original.get('typeName')) !== (document ? 'document' : 'user')
            || text(original.get('id')) !== record.id || original.get('meta')!.kind !== 'object'
            || text(original.get('name')) === null) return false;
        if (document) return record.id === 'document:document' && Number.isFinite(original.get('gridSize')!.number());
        return record.id.startsWith('user:') && record.id.length > 5 && text(original.get('color')) !== null
            && text(original.get('imageUrl')) !== null;
    } catch { return false; }
}

export function carryLegacyMetadata(record: Readonly<{ type: string; id: string; raw: RawJson }>): RawJson {
    if (record.type !== 'legacy-document' && record.type !== 'legacy-user') return record.raw;
    const source = parseJson(record.raw);
    if (!closed(source, ['type', 'id', 'record'])) return record.raw;
    const candidate = source.raw().slice(0, -1) + ',"schema":1,"role":"metadata"}';
    return isKnownLegacyMetadata({ ...record, raw: candidate }) ? parseJson(candidate).raw() : record.raw;
}
