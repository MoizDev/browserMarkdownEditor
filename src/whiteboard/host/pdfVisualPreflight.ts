import { NODE_FILE_FIELDS } from '../model/fileFields';
import type { NodeId } from '../model/ids';
import type { RehydratedLoad } from '../model/loadTypes';
import type { BoardDoc } from '../model/doc';

// Provenance: native raw-token preservation, opaque node and PDF flattening
// contracts; independent conservative model inspection, no third-party source.
export type PdfVisualIssue =
    | Readonly<{ kind: 'opaque-node'; nodeId: NodeId }>
    | Readonly<{ kind: 'node-raw'; nodeId: NodeId; field: string }>
    | Readonly<{ kind: 'node-extension'; nodeId: NodeId; field: string }>
    | Readonly<{ kind: 'unmapped-record'; ordinal: number; reason: string }>
    | Readonly<{ kind: 'preserved-record'; type: string; id: string }>;
export interface PdfVisualPreflight {
    readonly status: 'known' | 'unknown';
    readonly issues: readonly PdfVisualIssue[];
}
const semanticFields = new Set<string>(Object.values(NODE_FILE_FIELDS).flat());
// These native properties do not control pixels or placement. Unrecognized
// fields are never presumed metadata merely because their names sound benign.
const nonvisualRaw = new Set(['locked', 'alt', 'url']);
export async function inspectPdfVisualDoc(doc: BoardDoc, options: {
    readonly signal: AbortSignal;
    cooperate?(): Promise<void>;
}): Promise<PdfVisualPreflight> {
    options.signal.throwIfAborted();
    if (!doc || !doc.nodes || !doc.preserved) throw new TypeError('Invalid board document');
    const issues: PdfVisualIssue[] = [];
    let visits = 0, started = performance.now();
    const tick = async () => {
        options.signal.throwIfAborted();
        await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
        options.signal.throwIfAborted(); started = performance.now();
    };
    const due = () => ++visits % 256 === 0 || performance.now() - started >= 3;
    for (const node of doc.nodes.values()) {
        if (due()) await tick();
        if (node.kind === 'opaque') issues.push({ kind: 'opaque-node', nodeId: node.id });
        if (!node.ext) continue;
        for (const field of node.ext.raw.keys()) {
            if (due()) await tick();
            if (!nonvisualRaw.has(field)) issues.push({ kind: semanticFields.has(field) ? 'node-raw' : 'node-extension', nodeId: node.id, field });
        }
        for (const field of node.ext.fields.keys()) {
            if (due()) await tick();
            issues.push({ kind: 'node-extension', nodeId: node.id, field });
        }
    }
    for (const record of doc.preserved.records) {
        if (due()) await tick();
        issues.push({ kind: 'preserved-record', type: record.type, id: record.id });
    }
    options.signal.throwIfAborted();
    return { status: issues.length ? 'unknown' : 'known', issues: Object.freeze(issues) };
}

export async function inspectPdfVisualModel(load: RehydratedLoad, options: {
    readonly signal: AbortSignal;
    cooperate?(): Promise<void>;
}): Promise<PdfVisualPreflight> {
    options.signal.throwIfAborted();
    if (!load || !load.doc || !Array.isArray(load.unmapped)) throw new TypeError('Invalid admitted board load');
    const result = await inspectPdfVisualDoc(load.doc, options);
    const issues: PdfVisualIssue[] = [...result.issues];
    let visits = 0, started = performance.now();
    for (const record of load.unmapped) {
        options.signal.throwIfAborted();
        if (++visits % 256 === 0 || performance.now() - started >= 3) {
            await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
            options.signal.throwIfAborted(); started = performance.now();
        }
        issues.push({ kind: 'unmapped-record', ordinal: record.position.ordinal, reason: record.reason });
    }
    options.signal.throwIfAborted();
    return { status: issues.length ? 'unknown' : 'known', issues: Object.freeze(issues) };
}
