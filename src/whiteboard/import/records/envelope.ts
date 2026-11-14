import { ReportBuilder } from '../report';
import { readStoreFields } from './storeFields';

export type LegacyObject = Readonly<Record<string, unknown>>;
export interface LegacyEnvelope {
    readonly records: readonly LegacyObject[];
    readonly session: LegacyObject | null;
    readonly ui: LegacyObject | null;
    readonly paper: LegacyObject | null;
}
export function object(value: unknown): LegacyObject | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as LegacyObject : null;
}

// I-3: sequence numbers are a format generation, not a package version.
const SEQUENCES: Readonly<Record<string, number>> = {
    store: 5, asset: 1, camera: 1, document: 2, instance: 26, instance_page_state: 5,
    page: 1, instance_presence: 6, pointer: 1, shape: 4, user: 1,
    'asset.image': 6, 'asset.video': 5, 'asset.bookmark': 2, 'shape.group': 0,
    'shape.text': 4, 'shape.bookmark': 2, 'shape.geo': 11, 'shape.note': 13,
    'shape.line': 5, 'shape.frame': 1, 'shape.arrow': 8, 'shape.highlight': 4,
    'shape.embed': 4, 'shape.video': 4, 'shape.draw': 5, 'shape.image': 5, 'binding.arrow': 1,
};

export function readLegacyEnvelope(text: string, report: ReportBuilder): LegacyEnvelope | null {
    const empty: LegacyEnvelope = { records: [], session: null, ui: null, paper: null };
    if (text.length > 256 * 1024 * 1024) { report.refuse(null, 'Drawing exceeds the import size limit'); return null; }
    if (!text.trim()) return empty;
    let root: LegacyObject | null;
    try { root = object(JSON.parse(text.replace(/^\uFEFF/, ''))); }
    catch { report.refuse(null, 'Not a drawing this app can read'); return null; }
    if (!root) { report.refuse(null, 'Invalid drawing envelope'); return null; }
    const document = object(root.document);
    if (!document) {
        if ('document' in root) { report.refuse(null, 'Invalid document record'); return null; }
        if (Object.keys(root).some(key => key !== 'paper' && key !== 'ui' && key !== 'session')) {
            report.refuse(null, 'Unrecognized drawing envelope'); return null;
        }
        return { ...empty, session: object(root.session), ui: object(root.ui), paper: object(root.paper) };
    }
    const store = object(document.store), schema = object(document.schema);
    if (!store || !schema) { report.refuse(null, 'Incomplete drawing document'); return null; }
    const sequences = object(schema.sequences);
    if (schema.schemaVersion !== 2 || !sequences || Object.keys(sequences).length !== Object.keys(SEQUENCES).length
        || Object.entries(SEQUENCES).some(([key, version]) => sequences[`com.tldraw.${key}`] !== version)) {
        report.refuse(null, `Unsupported record schema ${String(schema.schemaVersion)}`);
    }
    let entries: readonly (readonly [string, unknown])[];
    try { entries = readStoreFields(text) ?? Object.entries(store); }
    catch (error) { report.refuse(null, error instanceof Error ? error.message : 'Invalid record store'); return null; }
    if (entries.length > 200_000) { report.refuse(null, 'Drawing exceeds the record limit'); return null; }
    const records: LegacyObject[] = [];
    for (const [key, value] of entries) {
        const record = object(value);
        if (!record || typeof record.id !== 'string' || typeof record.typeName !== 'string') {
            report.refuse(key, 'Invalid record identity');
        } else {
            if (record.id !== key) report.repair(record.id, `Record key ${key} did not match its identifier`);
            records.push(record);
        }
    }
    return { records, session: object(root.session), ui: object(root.ui), paper: object(root.paper) };
}
