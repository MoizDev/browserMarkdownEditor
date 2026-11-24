import type { FileTreeNode } from '../types';
import { sniffCanvas } from './canvasFormat';

/** The menu stays independent of App's lifetime and memoized tree props. */
let restore: ((node: FileTreeNode) => void) | undefined;
export function registerConversionRestore(handler: (node: FileTreeNode) => void): () => void {
    restore = handler;
    return () => { if (restore === handler) restore = undefined; };
}
export function requestConversionRestore(node: FileTreeNode): void { restore?.(node); }

/** A marker is only a hint: the chosen Trash bytes must still hash to it. */
export function conversionDigestFromText(text: string, name: string): string | null {
    if (sniffCanvas(text, name).format !== 'native') return null;
    try {
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const digest = (value as Record<string, unknown>).legacyOriginalSha256;
        return typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest) ? digest : null;
    } catch { return null; }
}

/* ── Boards an earlier version converted in place ─────────────────────────────
 * For a short while the app converted an old drawing or notebook in place on its first edit, keeping the old file in the
 * Trash of the folder it was in (`.Garbage`, under the board's own name, numbered if taken), but it never wrote the
 * backup's digest into the board. The board does keep, verbatim, what it was made from: the old file's envelope (every
 * field but `document`, in `legacyEnvelope`; `document` but its `store`, in `legacyDocument`), each shape's original id
 * as its node id, and the old records it could not hold as they were (`legacy-*`, whiteboard/format/legacyRecords.ts).
 * A file in Trash that is an old board agreeing with ALL of that is the one it was made from: the envelope holds the old
 * app's camera, selection and tool, and the ids are random. That is the evidence read here; the bytes found are still
 * hashed and re-checked before the copy is restored (FileSystemContext restoreConversionCopy). */

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export interface ConversionEvidence {
    readonly envelope: Json;
    readonly document: Json;
    readonly shapeIds: readonly string[];
    /** The old records the board kept as written, by their original id. */
    readonly records: ReadonlyMap<string, Json>;
    /**
     * Whether anything here is the board's alone: an original shape id, or a kept record with an id of its own. Without
     * one, what is left is the envelope and the `document`/`user` records, which every old board saved unpanned, with
     * nothing selected and the Draw tool chosen shares — so such a board is matched only by where its backup was put
     * (measured: a converted board emptied of its shapes "restored" an unrelated board from the same Trash).
     */
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

/** A board's header names what it was made from in its first line, before its records: a menu question answered from
 * the first bytes of the file, as `startsAsOldBoard` is. */
export function startsAsConvertedBoard(start: string, name: string): boolean {
    if (sniffCanvas(start, name).format !== 'native') return false;
    const header = start.split('"records"', 1)[0];
    // An editable copy of an old board carries the same fields and says it is one (import.ts `legacyCopy`): its old
    // board was never converted, and is beside it or wherever the person put it — not a backup to look for in Trash.
    return /"(legacyDocument|legacyEnvelope|legacyOriginalSha256)":/.test(header) && !/"legacyCopy":/.test(header);
}

/** What a board made from an old one kept of it, or null for a board that was not (or that keeps nothing to go by). */
export function conversionEvidenceFromText(text: string, name: string): ConversionEvidence | null {
    if (sniffCanvas(text, name).format !== 'native') return null;
    let board: unknown;
    try { board = JSON.parse(text); } catch { return null; }
    if (!isObject(board) || !Array.isArray(board.records) || !('legacyDocument' in board || 'legacyEnvelope' in board) || 'legacyCopy' in board) return null;
    const shapeIds: string[] = [], records = new Map<string, Json>();
    for (const record of board.records) {
        if (!isObject(record) || typeof record.type !== 'string' || typeof record.id !== 'string') continue;
        if (record.type === 'node' && record.id.startsWith('shape:')) shapeIds.push(record.id);
        // A kept record wraps the old one as `record`; a picture file no shape used (`orphan-asset`) keeps a note of its
        // own instead, and an id the old file repeated was renamed (`~duplicate`), so neither is compared.
        else if (record.type.startsWith('legacy-') && record.type !== 'legacy-orphan-asset' && !record.id.includes('~duplicate')
            && isObject(record.record)) records.set(record.id, record.record);
    }
    const kept = [...records.keys()].some(id => !id.startsWith('document:') && !id.startsWith('user:') && id !== 'page:page');
    const evidence = { envelope: board.legacyEnvelope ?? {}, document: board.legacyDocument ?? {}, shapeIds, records,
        distinctive: shapeIds.length > 0 || kept };
    return Object.keys(evidence.envelope as object).length || evidence.distinctive ? evidence : null;
}

/** Whether an old board's text is the file `evidence` was made from (see above). */
export function matchesConversionEvidence(evidence: ConversionEvidence, text: string): boolean {
    let root: unknown;
    try { root = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return false; }
    if (!isObject(root)) return false;
    // The two layouts the importer reads (whiteboard/import/records/envelope.ts): this app's former
    // {document: {schema, store}, session, ui, paper} and tldraw's own {tldrawFileFormatVersion, schema, records}.
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
