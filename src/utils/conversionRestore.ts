import type { FileTreeNode } from '../types';
import { sniffCanvas } from './canvasFormat';

let restore: ((node: FileTreeNode) => void) | undefined;
export function registerConversionRestore(handler: (node: FileTreeNode) => void): () => void {
    restore = handler;
    return () => { if (restore === handler) restore = undefined; };
}
export function requestConversionRestore(node: FileTreeNode): void { restore?.(node); }

export function conversionDigestFromText(text: string, name: string): string | null {
    if (sniffCanvas(text, name).format !== 'native') return null;
    try {
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const digest = (value as Record<string, unknown>).legacyOriginalSha256;
        return typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest) ? digest : null;
    } catch { return null; }
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export interface ConversionEvidence {
    readonly envelope: Json;
    readonly document: Json;
    readonly shapeIds: readonly string[];
    readonly records: ReadonlyMap<string, Json>;
    readonly distinctive: boolean;
}

const isObject = (value: unknown): value is { readonly [key: string]: Json } =>
    !!value && typeof value === 'object' && !Array.isArray(value);
function sameJson(a: Json | undefined, b: Json | undefined): boolean {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameJson(item, (b as readonly Json[])[index]));
    }
    if (!isObject(a) || !isObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
}

export function startsAsConvertedBoard(start: string, name: string): boolean {
    if (sniffCanvas(start, name).format !== 'native') return false;
    const header = start.split('"records"', 1)[0];
    return /"(legacyDocument|legacyEnvelope|legacyOriginalSha256)":/.test(header) && !/"legacyCopy":/.test(header);
}

export function conversionEvidenceFromText(text: string, name: string): ConversionEvidence | null {
    if (sniffCanvas(text, name).format !== 'native') return null;
    let board: unknown;
    try { board = JSON.parse(text); } catch { return null; }
    if (!isObject(board) || !Array.isArray(board.records) || !('legacyDocument' in board || 'legacyEnvelope' in board) || 'legacyCopy' in board) return null;
    const shapeIds: string[] = [], records = new Map<string, Json>();
    for (const record of board.records) {
        if (!isObject(record) || typeof record.type !== 'string' || typeof record.id !== 'string') continue;
        if (record.type === 'node' && record.id.startsWith('shape:')) shapeIds.push(record.id);
        else if (record.type.startsWith('legacy-') && record.type !== 'legacy-orphan-asset' && !record.id.includes('~duplicate')
            && isObject(record.record)) records.set(record.id, record.record);
    }
    const kept = [...records.keys()].some(id => !id.startsWith('document:') && !id.startsWith('user:') && id !== 'page:page');
    const evidence = { envelope: board.legacyEnvelope ?? {}, document: board.legacyDocument ?? {}, shapeIds, records,
        distinctive: shapeIds.length > 0 || kept };
    return Object.keys(evidence.envelope as object).length || evidence.distinctive ? evidence : null;
}

export function matchesConversionEvidence(evidence: ConversionEvidence, text: string): boolean {
    let root: unknown;
    try { root = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return false; }
    if (!isObject(root)) return false;
    const tldr = !('document' in root) && Array.isArray(root.records) && isObject(root.schema);
    const envelope: Record<string, Json> = {}, document: Record<string, Json> = {};
    for (const [key, value] of Object.entries(root)) {
        if (key !== 'document' && !(tldr && (key === 'records' || key === 'schema'))) envelope[key] = value;
    }
    const store = new Map<string, Json>();
    if (tldr) {
        document.schema = root.schema;
        for (const record of root.records as readonly Json[]) if (isObject(record) && typeof record.id === 'string') store.set(record.id, record);
    } else {
        if (!isObject(root.document) || !isObject(root.document.store)) return false;
        for (const [key, value] of Object.entries(root.document)) if (key !== 'store') document[key] = value;
        for (const record of Object.values(root.document.store)) if (isObject(record) && typeof record.id === 'string') store.set(record.id, record);
    }
    if (!sameJson(evidence.envelope, envelope) || !sameJson(evidence.document, document)) return false;
    for (const id of evidence.shapeIds) if (!store.has(id)) return false;
    for (const [id, record] of evidence.records) if (!sameJson(record, store.get(id))) return false;
    return true;
}
