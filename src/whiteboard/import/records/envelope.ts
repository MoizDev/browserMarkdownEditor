import { preflightLegacyJson } from '../preflight';
import { ReportBuilder } from '../report';
import { readStoreFields } from './storeFields';

export type LegacyObject = Readonly<Record<string, unknown>>;
export interface LegacyEnvelope {
    readonly records: readonly LegacyObject[];
    readonly session: LegacyObject | null;
    readonly ui: LegacyObject | null;
    readonly paper: LegacyObject | null;
    readonly extras: LegacyObject;
    readonly documentExtras: LegacyObject;
    readonly versions: ReadonlyMap<string, number>;
}
export function object(value: unknown): LegacyObject | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as LegacyObject : null;
}

export const KNOWN_SEQUENCES: Readonly<Record<string, number>> = {
    'shape.draw': 5, 'shape.highlight': 4, 'shape.geo': 14, 'shape.note': 15, 'shape.text': 4, 'shape.arrow': 8,
    'shape.line': 5, 'shape.frame': 1, 'shape.group': 0, 'shape.image': 7, 'shape.video': 6, 'shape.bookmark': 4,
    'shape.embed': 4, 'binding.arrow': 1, 'asset.image': 6, 'asset.video': 5, 'asset.bookmark': 2,
};

function readVersions(schema: LegacyObject): Map<string, number> | null {
    const versions = new Map<string, number>();
    if (schema.schemaVersion === 2) {
        const sequences = object(schema.sequences);
        if (!sequences) return null;
        for (const [key, value] of Object.entries(sequences)) {
            if (key.startsWith('com.tldraw.') && Number.isSafeInteger(value)) versions.set(key.slice(11), value as number);
        }
        return versions;
    }
    if (schema.schemaVersion === 1) {
        const records = object(schema.recordVersions);
        if (!records) return null;
        for (const [family, value] of Object.entries(records)) {
            const entry = object(value);
            if (!entry) continue;
            if (Number.isSafeInteger(entry.version)) versions.set(family, entry.version as number);
            const sub = object(entry.subTypeVersions);
            if (sub) for (const [type, version] of Object.entries(sub)) {
                if (Number.isSafeInteger(version)) versions.set(`${family}.${type}`, version as number);
            }
        }
        return versions;
    }
    return null;
}

export function readLegacyEnvelope(text: string, report: ReportBuilder): LegacyEnvelope | null {
    const empty: LegacyEnvelope = { records: [], session: null, ui: null, paper: null, versions: new Map(),
        extras: Object.create(null) as LegacyObject, documentExtras: Object.create(null) as LegacyObject };
    try { preflightLegacyJson(text); }
    catch (error) { report.refuse(null, error instanceof Error ? error.message : 'Drawing exceeds an import limit'); return null; }
    if (!text.trim()) return empty;
    let root: LegacyObject | null;
    try { root = object(JSON.parse(text.replace(/^\uFEFF/, ''))); }
    catch { report.refuse(null, 'The file is not valid JSON'); return null; }
    if (!root) { report.refuse(null, 'Invalid drawing envelope'); return null; }
    const tldr = !('document' in root) && Array.isArray(root.records) && object(root.schema) !== null;
    const extras: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(root)) {
        if (key === 'document' || (tldr && (key === 'records' || key === 'schema'))) continue;
        extras[key] = value;
        if (key !== 'ui' && key !== 'session' && key !== 'paper' && !(tldr && key === 'tldrawFileFormatVersion')) {
            report.repair(null, `Unknown envelope field ${key} preserved`);
        }
    }
    const document = tldr ? { schema: root.schema } as LegacyObject : object(root.document);
    if (!document) {
        if ('document' in root) { report.refuse(null, 'Invalid document record'); return null; }
        if (Object.keys(root).some(key => key !== 'paper' && key !== 'ui' && key !== 'session')) {
            report.refuse(null, 'It is not a drawing layout this app recognizes'); return null;
        }
        return { ...empty, extras, session: object(root.session), ui: object(root.ui), paper: object(root.paper) };
    }
    const store = tldr ? null : object(document.store), schema = object(document.schema);
    if ((!tldr && !store) || !schema) { report.refuse(null, 'Incomplete drawing document'); return null; }
    const versions = readVersions(schema);
    if (!versions) {
        report.refuse(null, `Drawing uses tldraw schema version ${String(schema.schemaVersion)}, which this app cannot read`);
        return null;
    }
    let entries: readonly (readonly [string | null, unknown])[];
    try { entries = tldr ? (root.records as unknown[]).map(value => [null, value] as const) : readStoreFields(text, store!) ?? Object.entries(store!); }
    catch (error) { report.refuse(null, error instanceof Error ? error.message : 'Invalid record store'); return null; }
    if (entries.length > 200_000) { report.refuse(null, 'Drawing exceeds the record limit'); return null; }
    const records: LegacyObject[] = [];
    for (const [key, value] of entries) {
        const record = object(value);
        if (!record || typeof record.id !== 'string' || typeof record.typeName !== 'string') {
            report.refuse(key, 'Invalid record identity', 'unreadable record');
        } else {
            if (key !== null && record.id !== key) report.repair(record.id, `Record key ${key} did not match its identifier`);
            records.push(record);
        }
    }
    const documentExtras: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(document)) if (key !== 'store') {
        documentExtras[key] = value;
        if (key !== 'schema') report.repair(null, `Unknown document field ${key} preserved`);
    }
    return { records, session: object(root.session), ui: object(root.ui), paper: object(root.paper), extras, documentExtras, versions };
}
