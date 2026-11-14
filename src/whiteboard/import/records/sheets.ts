import { parseJson } from '../../format/jsonRead';
import type { Sheet } from '../../model/doc';
import { sheetId } from '../../model/ids';
import type { ExtBag } from '../../model/json';
import type { LegacyObject } from './envelope';
import { object } from './envelope';

export function preserveMetadata(meta: LegacyObject, excluded: ReadonlySet<string> = new Set()): ExtBag | null {
    const retained: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(meta)) if (!excluded.has(key)) retained[key] = value;
    if (!Object.keys(retained).length) return null;
    const raw = parseJson(JSON.stringify(retained)).raw();
    return { fields: new Map([['legacyMeta', raw]]), raw: new Map() };
}
export function readLegacySheet(record: LegacyObject): Sheet {
    const meta = object(record.meta);
    if (record.typeName !== 'page' || typeof record.id !== 'string' || typeof record.name !== 'string'
        || typeof record.index !== 'string' || !meta) throw new Error('Invalid page record');
    return { id: sheetId(record.id), name: record.name, order: record.index, ext: preserveMetadata(meta) };
}
